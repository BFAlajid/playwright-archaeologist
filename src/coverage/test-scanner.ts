/**
 * Playwright test directory scanner.
 *
 * Walks a directory of Playwright `.spec.ts` / `.spec.js` / `.test.ts` /
 * `.test.js` / `.mjs` / `.cjs` files and extracts every URL-bearing call
 * heuristically. The scanner is regex-based on purpose: Playwright tests
 * can use any expression to build the URL, and a full TypeScript parser
 * would not necessarily give us better coverage (we still need to resolve
 * environment variables, template literals, and string concatenation).
 *
 * What we match:
 *   - page.goto('URL'), page.goto("URL"), page.goto(`URL`)
 *   - page.navigate(URL)
 *   - request.get/post/put/patch/delete/head/fetch/options(URL[, ...])
 *   - apiRequestContext.get(...) / apiRequestContext.post(...)
 *
 * What we do with placeholders:
 *   - `${process.env.BASE_URL}` and `${BASE_URL}` are replaced with the
 *     caller-supplied `options.baseUrl` (if provided).
 *   - Anything else inside `${...}` is left as-is in `rawUrl` and stripped
 *     to its post-interpolation prefix in `resolvedUrl`.
 *
 * What we skip:
 *   - Single-line comments (`// ...`) preceding the match on the same line.
 *   - Block comments (`/* ... *\/`) are stripped from the source before
 *     matching so calls commented out with /* page.goto('X') *\/ never
 *     surface.
 */

import { readdir, readFile, stat } from 'node:fs/promises';
import { join, relative } from 'node:path';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/**
 * A single URL reference located in a test file.
 */
export interface TestReference {
  filePath: string;
  lineNumber: number;
  rawUrl: string;
  resolvedUrl: string;
  method: string;
}

export interface ScanOptions {
  /** Value substituted for `${process.env.BASE_URL}` / `${BASE_URL}` etc. */
  baseUrl?: string;
  /** File extensions to scan. Defaults to the common Playwright set. */
  extensions?: string[];
  /** Maximum recursion depth (safety cap). Default 20. */
  maxDepth?: number;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const DEFAULT_EXTENSIONS = ['.spec.ts', '.spec.js', '.spec.mjs', '.test.ts', '.test.js', '.test.mjs'];

/**
 * Directories never worth descending into. Keeps large monorepos from
 * pulling megabytes of node_modules through the regex loop.
 */
const SKIP_DIRECTORIES = new Set([
  'node_modules',
  '.git',
  'dist',
  'build',
  'coverage',
  '.next',
  '.nuxt',
  '.svelte-kit',
  '.output',
  '.cache',
  '.turbo',
]);

// Method extraction patterns. Order matters: goto/navigate fall back to GET.
// Ordered most-specific first so page.goto() wins over request.get() matches.
interface CallPattern {
  // Regex for `<call>(`
  openerRegex: RegExp;
  // HTTP method reported when this opener matches. Empty string means infer
  // from the call name (request.get -> GET, request.post -> POST).
  method: string;
}

// Each opener regex must end with a capturing paren so we can continue from
// the opening `(` position. The `s` flag lets `.` match newlines for
// multi-line openers.
const CALL_OPENERS: CallPattern[] = [
  { openerRegex: /(?:page|popup|frame|ctx|context|pageOrFrame)\s*\.\s*goto\s*\(/g, method: 'GET' },
  { openerRegex: /(?:page|popup|frame)\s*\.\s*navigate\s*\(/g, method: 'GET' },
  { openerRegex: /(?:request|apiRequest|apiRequestContext|ctx\.request)\s*\.\s*(get|post|put|patch|delete|head|fetch|options)\s*\(/gi, method: '' },
];

// ---------------------------------------------------------------------------
// Regex helpers — stripping comments before matching
// ---------------------------------------------------------------------------

/**
 * Remove block comments from source, preserving line count so line numbers
 * stay accurate. Replaces every character inside the block with a space
 * (except newlines).
 */
function stripBlockComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, (match) => {
    return match.replace(/[^\n]/g, ' ');
  });
}

/**
 * Check whether the opener position falls within the "after //" portion of
 * its source line. Used to skip single-line-commented-out calls.
 */
function isInLineComment(source: string, openerStart: number): boolean {
  // Walk backwards to find the previous newline or start-of-file.
  let lineStart = source.lastIndexOf('\n', openerStart - 1);
  lineStart = lineStart === -1 ? 0 : lineStart + 1;
  const lineBefore = source.slice(lineStart, openerStart);
  // `//` outside of a string literal on the same line means commented-out.
  // We apply a simple heuristic: if we see `//` with no intervening quote
  // opener before the call, treat it as a comment.
  const commentIdx = findLineCommentStart(lineBefore);
  return commentIdx !== -1;
}

/**
 * Locate the position of a `//` that is NOT inside a string literal or
 * template literal within `chunk`. Returns -1 when none is found.
 */
function findLineCommentStart(chunk: string): number {
  let inSingle = false;
  let inDouble = false;
  let inTemplate = false;
  for (let i = 0; i < chunk.length - 1; i++) {
    const c = chunk[i];
    const next = chunk[i + 1];
    if (c === '\\') {
      i++; // skip escaped char
      continue;
    }
    if (inSingle) {
      if (c === "'") inSingle = false;
      continue;
    }
    if (inDouble) {
      if (c === '"') inDouble = false;
      continue;
    }
    if (inTemplate) {
      if (c === '`') inTemplate = false;
      continue;
    }
    if (c === "'") { inSingle = true; continue; }
    if (c === '"') { inDouble = true; continue; }
    if (c === '`') { inTemplate = true; continue; }
    if (c === '/' && next === '/') return i;
  }
  return -1;
}

// ---------------------------------------------------------------------------
// URL argument extraction
// ---------------------------------------------------------------------------

interface ExtractedUrl {
  /** Raw URL literal or template text between the quotes. */
  raw: string;
  /** Whether we observed a valid (closed) string literal. */
  ok: boolean;
}

/**
 * Starting at `pos` (the character immediately after the opening paren),
 * skip leading whitespace and read the first argument if it is a string
 * literal. Supports `'...'`, `"..."`, and template literals `` `...` ``.
 * Other argument shapes (identifiers, conditional expressions) are
 * rejected — we only classify tests by *literal* URLs.
 */
function extractFirstStringArg(source: string, pos: number): ExtractedUrl | null {
  let i = pos;
  // Skip whitespace / newlines.
  while (i < source.length && /\s/.test(source[i])) i++;
  if (i >= source.length) return null;

  const quote = source[i];
  if (quote !== "'" && quote !== '"' && quote !== '`') return null;

  i++; // consume opening quote
  let raw = '';
  while (i < source.length) {
    const c = source[i];
    if (c === '\\') {
      // Preserve escapes verbatim so `\n`, `\t`, `\'` round-trip. We are
      // not trying to interpret them — the raw URL is fine as-is.
      raw += c;
      if (i + 1 < source.length) raw += source[i + 1];
      i += 2;
      continue;
    }
    if (c === quote) {
      return { raw, ok: true };
    }
    raw += c;
    i++;
  }
  return { raw, ok: false };
}

/**
 * Resolve a raw URL string (possibly a template literal) into a concrete URL
 * using the provided base URL for `${process.env.BASE_URL}` /
 * `${BASE_URL}` / `${baseURL}` / `${baseUrl}` substitutions.
 */
export function resolveRawUrl(raw: string, baseUrl: string | undefined): string {
  if (raw.length === 0) return raw;

  // Fast path: no template slots.
  if (!raw.includes('${')) return raw;

  return raw.replace(/\$\{([^}]*)\}/g, (match, expr: string) => {
    const trimmed = expr.trim();
    // Known base-URL references we can substitute deterministically.
    const baseAliases = new Set([
      'process.env.BASE_URL',
      'process.env.BASEURL',
      'process.env.BASE_URL!',
      'process.env.PLAYWRIGHT_BASE_URL',
      'process.env.PW_BASE_URL',
      'BASE_URL',
      'baseURL',
      'baseUrl',
      'base',
    ]);
    if (baseUrl && baseAliases.has(trimmed)) {
      return stripTrailingSlash(baseUrl);
    }
    // Unknown placeholder — leave a marker so downstream URL parsing does
    // not explode. We use a harmless fixed token that the coverage engine
    // can normalise on the pathname.
    return '__PA_TEMPLATE__';
  });
}

function stripTrailingSlash(s: string): string {
  return s.endsWith('/') ? s.slice(0, -1) : s;
}

// ---------------------------------------------------------------------------
// Per-file scanner
// ---------------------------------------------------------------------------

/**
 * Extract every matching call in a single source string.
 * Exported for unit testing — the directory walker calls this.
 */
export function extractReferencesFromSource(
  source: string,
  filePath: string,
  baseUrl: string | undefined,
): TestReference[] {
  const cleaned = stripBlockComments(source);
  const refs: TestReference[] = [];

  // Precompute line offsets once so we can report line numbers without
  // scanning the whole string per match.
  const lineOffsets: number[] = [0];
  for (let i = 0; i < cleaned.length; i++) {
    if (cleaned[i] === '\n') lineOffsets.push(i + 1);
  }

  function lineNumberFor(offset: number): number {
    // Binary search in lineOffsets.
    let lo = 0;
    let hi = lineOffsets.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >>> 1;
      if (lineOffsets[mid] <= offset) lo = mid;
      else hi = mid - 1;
    }
    return lo + 1;
  }

  // Deduplicate by (line, raw, method) so overlapping regexes for the same
  // call don't produce duplicate references.
  const seen = new Set<string>();

  for (const pattern of CALL_OPENERS) {
    // Reset lastIndex in case the regex is shared across invocations.
    pattern.openerRegex.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = pattern.openerRegex.exec(cleaned)) !== null) {
      const openerStart = match.index;
      const openerEnd = pattern.openerRegex.lastIndex; // position just after `(`
      if (isInLineComment(cleaned, openerStart)) continue;

      const extracted = extractFirstStringArg(cleaned, openerEnd);
      if (!extracted || !extracted.ok || extracted.raw.length === 0) continue;

      const method = pattern.method !== ''
        ? pattern.method
        : inferMethodFromOpener(match[0]);
      const rawUrl = extracted.raw;
      const resolvedUrl = resolveRawUrl(rawUrl, baseUrl);

      const key = `${lineNumberFor(openerStart)}|${method}|${rawUrl}`;
      if (seen.has(key)) continue;
      seen.add(key);

      refs.push({
        filePath,
        lineNumber: lineNumberFor(openerStart),
        rawUrl,
        resolvedUrl,
        method,
      });
    }
  }

  return refs;
}

/**
 * Given an opener like `request.post(`, return `POST`.
 */
function inferMethodFromOpener(opener: string): string {
  const m = opener.match(/\.\s*(get|post|put|patch|delete|head|fetch|options)\s*\(/i);
  if (!m) return 'GET';
  const verb = m[1].toUpperCase();
  // `fetch` is method-agnostic — treat it like GET unless the caller proves
  // otherwise. Most fetch() calls in Playwright tests are GETs.
  if (verb === 'FETCH') return 'GET';
  return verb;
}

// ---------------------------------------------------------------------------
// Directory walking
// ---------------------------------------------------------------------------

function matchesExtension(name: string, extensions: string[]): boolean {
  const lower = name.toLowerCase();
  return extensions.some((ext) => lower.endsWith(ext.toLowerCase()));
}

async function walkDirectory(
  rootDir: string,
  current: string,
  depth: number,
  maxDepth: number,
  extensions: string[],
  baseUrl: string | undefined,
  out: TestReference[],
): Promise<void> {
  if (depth > maxDepth) return;

  let entries;
  try {
    entries = await readdir(current, { withFileTypes: true });
  } catch {
    return;
  }

  for (const entry of entries) {
    const full = join(current, entry.name);
    if (entry.isDirectory()) {
      if (SKIP_DIRECTORIES.has(entry.name)) continue;
      await walkDirectory(rootDir, full, depth + 1, maxDepth, extensions, baseUrl, out);
      continue;
    }
    if (!entry.isFile()) continue;
    if (!matchesExtension(entry.name, extensions)) continue;

    let source: string;
    try {
      source = await readFile(full, 'utf-8');
    } catch {
      continue;
    }

    // Report paths relative to rootDir for readability in reports, but
    // fall back to absolute if the relative form escapes the tree (which
    // it shouldn't, but let's be defensive).
    const rel = relative(rootDir, full);
    const reportPath = rel.startsWith('..') ? full : rel;

    const refs = extractReferencesFromSource(source, reportPath, baseUrl);
    out.push(...refs);
  }
}

// ---------------------------------------------------------------------------
// Public entry point
// ---------------------------------------------------------------------------

/**
 * Recursively scan `dir` for Playwright test files and return every URL
 * reference found. Missing / unreadable files are skipped silently so that
 * bad permissions on one leaf do not poison the whole scan.
 *
 * Throws if `dir` itself does not exist (callers should validate before
 * invoking this function).
 */
export async function scanTestDirectory(
  dir: string,
  options: ScanOptions = {},
): Promise<TestReference[]> {
  const st = await stat(dir);
  if (!st.isDirectory()) {
    throw new Error(`Test path is not a directory: ${dir}`);
  }

  const extensions = options.extensions ?? DEFAULT_EXTENSIONS;
  const maxDepth = options.maxDepth ?? 20;
  const out: TestReference[] = [];

  await walkDirectory(dir, dir, 0, maxDepth, extensions, options.baseUrl, out);
  return out;
}
