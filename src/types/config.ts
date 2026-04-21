/**
 * playwright-archaeologist configuration schema.
 *
 * Validated with Zod at CLI entry before any crawl work begins.
 * ConfigError is thrown for all validation failures with a clear
 * user-facing message indicating which field failed and why.
 *
 * Validation rules and edge cases:
 *   --depth 0              Valid (crawl only the entry URL)
 *   --depth -1             Invalid: must be >= 0
 *   --depth 999999         Valid but warn: clamped to 100 with warning
 *   --concurrency 0        Invalid: must be >= 1
 *   --concurrency 100      Valid but warn: clamped to 20 with warning
 *   --viewport invalid     Invalid: must match /^\d+x\d+$/
 *   --viewport 100x100     Valid
 *   --output /nonexistent  Validated at startup: parent dir must exist and be writable
 *   --auth missing.ts      AuthError('script_not_found')
 *   --cookies bad.json     AuthError('cookie_file_malformed')
 *   URL without protocol   Auto-prepend https:// with warning
 *   --timeout 0            Invalid: must be >= 1000
 *   --max-time 0           Invalid: must be >= 10
 *   --delay -1             Invalid: must be >= 0
 *   --max-pages 0          Invalid: must be >= 1
 *
 * The Zod schema produces a strongly-typed CrawlConfig object that is
 * passed to the Orchestrator and threaded through to all collectors.
 */

import * as path from 'node:path';
import { z } from 'zod';

import { stripAuthInfo } from '../crawl/url-utils.js';
import type { Collector } from '../plugins/types.js';

// ---------------------------------------------------------------------------
// Viewport
// ---------------------------------------------------------------------------

export const ViewportSchema = z.object({
  width: z.number().int().min(320, 'Viewport width must be >= 320').max(7680, 'Viewport width must be <= 7680'),
  height: z.number().int().min(240, 'Viewport height must be >= 240').max(4320, 'Viewport height must be <= 4320'),
});

export type Viewport = z.infer<typeof ViewportSchema>;

/**
 * Parse a "WxH" string into a Viewport object.
 * Returns null if the format is invalid.
 */
export function parseViewport(input: string): Viewport | null {
  const match = input.match(/^(\d+)x(\d+)$/);
  if (!match) return null;
  const width = parseInt(match[1], 10);
  const height = parseInt(match[2], 10);
  const result = ViewportSchema.safeParse({ width, height });
  return result.success ? result.data : null;
}

// ---------------------------------------------------------------------------
// Output format
// ---------------------------------------------------------------------------

export const OutputFormatSchema = z.enum(['html', 'json', 'openapi', 'both']);
export type OutputFormat = z.infer<typeof OutputFormatSchema>;

// ---------------------------------------------------------------------------
// URL normalization for the entry URL
// ---------------------------------------------------------------------------

/**
 * Normalize the user-provided entry URL.
 * - Prepend https:// if no protocol is provided
 * - Validate it is http or https
 * Returns { url, warnings } where warnings contains any auto-corrections.
 */
export function normalizeEntryUrl(raw: string): { url: string; warnings: string[] } {
  const warnings: string[] = [];
  let url = raw.trim();

  // Strip trailing slash for consistency
  // (the crawler will add it back for the root)

  // Auto-prepend https:// if no protocol
  if (!/^https?:\/\//i.test(url)) {
    if (/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(url)) {
      // Has a protocol but it's not http/https -- reject
      throw new Error(`Unsupported protocol in URL: ${url}. Only http and https are allowed.`);
    }
    url = `https://${url}`;
    warnings.push(`No protocol specified. Using https://${raw.trim()}`);
  }

  // Validate the URL can be parsed
  try {
    const parsed = new URL(url);
    // Block non-http(s) protocols
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      throw new Error(`Unsupported protocol "${parsed.protocol}". Only http: and https: are allowed.`);
    }
    // Block obviously invalid hostnames
    if (!parsed.hostname || parsed.hostname.length === 0) {
      throw new Error('URL has no hostname.');
    }
    // Strip embedded credentials (user:pass@) to avoid leaking them into
    // outputs, logs, and bundles. Warn the user when this occurs.
    if (parsed.username || parsed.password) {
      warnings.push(
        'Embedded credentials (user:pass@) were stripped from the URL before crawling.',
      );
      url = stripAuthInfo(url);
    }
  } catch (err) {
    if (err instanceof TypeError) {
      throw new Error(`Invalid URL: ${url}`);
    }
    throw err;
  }

  return { url, warnings };
}

// ---------------------------------------------------------------------------
// Main config schema
// ---------------------------------------------------------------------------

export const CrawlConfigSchema = z.object({
  // ---- Target ----
  /**
   * Entry URL to start crawling. Must be http or https. Embedded
   * credentials (user:pass@) are stripped by normalizeEntryUrl() before
   * reaching this schema — any remaining auth info indicates a caller
   * that bypassed normalization.
   */
  targetUrl: z.string().url('Target URL must be a valid URL'),

  // ---- Discovery ----
  /** Maximum crawl depth from the entry URL. 0 = entry URL only. */
  depth: z
    .number()
    .int()
    .min(0, 'Depth must be >= 0')
    .max(100, 'Depth is clamped to 100')
    .default(5),

  /** Maximum total pages to visit. */
  maxPages: z
    .number()
    .int()
    .min(1, 'Max pages must be >= 1')
    .max(100_000, 'Max pages is clamped to 100,000')
    .default(1000),

  /** URL glob patterns to include. Only URLs matching at least one pattern are crawled. */
  include: z.array(z.string()).default([]),

  /** URL glob patterns to exclude. URLs matching any pattern are skipped. */
  exclude: z.array(z.string()).default([]),

  /** Whether to follow links to external origins. Default: false (same-origin only). */
  followExternal: z.boolean().default(false),

  /** Enable Tier 3 clicking: click non-link interactive elements to discover SPA states. */
  deepClick: z.boolean().default(false),

  /** Crawl cross-origin iframe content. Default: false (record URL only). */
  includeIframes: z.boolean().default(false),

  // ---- Performance ----
  /** Number of parallel browser contexts. */
  concurrency: z
    .number()
    .int()
    .min(1, 'Concurrency must be >= 1')
    .max(20, 'Concurrency is clamped to 20')
    .default(3),

  /** Delay in milliseconds between page visits per context. */
  delay: z
    .number()
    .int()
    .min(0, 'Delay must be >= 0')
    .max(60_000, 'Delay must be <= 60000ms')
    .default(0),

  /** Per-page navigation timeout in milliseconds. */
  timeout: z
    .number()
    .int()
    .min(1000, 'Timeout must be >= 1000ms')
    .max(300_000, 'Timeout must be <= 300000ms')
    .default(30_000),

  /** Global crawl timeout in seconds. 0 = no limit. */
  maxTime: z
    .number()
    .int()
    .min(0, 'Max time must be >= 0')
    .max(86_400, 'Max time must be <= 86400s (24 hours)')
    .default(3600),

  // ---- Auth ----
  /** Path to auth script (.ts or .js) exporting a default async function. */
  authScript: z.string().optional(),

  /** Path to cookies JSON file for session injection. */
  cookiesFile: z.string().optional(),

  /** Include cookies/auth headers in output (default: scrubbed). */
  includeCookies: z.boolean().default(false),

  // ---- Output ----
  /** Output directory path. Created if it does not exist. Parent must exist. */
  outputDir: z.string().default('.archaeologist'),

  /** Output format(s). */
  format: OutputFormatSchema.default('both'),

  /** Skip screenshot capture entirely. */
  noScreenshots: z.boolean().default(false),

  /**
   * Format for full-page screenshots. Default: 'jpeg' at quality 80.
   * JPEG is 3-5x smaller than PNG for typical screenshots; the quality
   * loss is imperceptible for regression-diff purposes. Viewport screenshots
   * remain PNG (small and crisp).
   */
  screenshotFormat: z.enum(['jpeg', 'png']).default('jpeg'),

  /** Skip HAR recording entirely. */
  noHar: z.boolean().default(false),

  /**
   * Pretty-print JSON artifacts (sitemap.json, forms.json, api-map.json, etc.).
   * Default false — minified output is 30-50% smaller and eliminates a
   * blocking pass through JSON.stringify on large crawls.
   */
  prettyJson: z.boolean().default(false),

  /**
   * Include response bodies in HAR output. Off by default — bodies frequently
   * contain credentials that the scrubber cannot always detect. Opt in with
   * --har-include-bodies when debugging response content specifically.
   */
  harIncludeBodies: z.boolean().default(false),

  // ---- Display ----
  /** Primary viewport dimensions. */
  viewport: ViewportSchema.default({ width: 1280, height: 720 }),

  /** Additional viewports for responsive screenshots (empty = primary only). */
  additionalViewports: z.array(ViewportSchema).default([]),

  // ---- Resume ----
  /** Resume from last checkpoint in the output directory. */
  resume: z.boolean().default(false),

  /** Skip confirmation prompts (auth script execution, etc.). */
  yes: z.boolean().default(false),

  // ---- Security ----
  /** Allow crawling private/internal IP ranges (SSRF protection bypass). */
  allowPrivate: z.boolean().default(false),

  /**
   * Opt in to running an auth script that fails static analysis
   * (imports `fs`, `child_process`, uses `eval`, etc.). Without this flag,
   * an auth script with any warnings is rejected before import.
   */
  allowAuthScript: z.boolean().default(false),

  /**
   * Capture JavaScript response bodies in the network log. Off by default —
   * raw JS bundles frequently contain hardcoded API keys and tokens.
   */
  captureJsBodies: z.boolean().default(false),
});

export type CrawlConfig = z.infer<typeof CrawlConfigSchema>;

// ---------------------------------------------------------------------------
// Diff subcommand config
// ---------------------------------------------------------------------------

export const DiffConfigSchema = z.object({
  /** Path to the "old" .archaeologist bundle. */
  oldBundle: z.string(),

  /** Path to the "new" .archaeologist bundle. */
  newBundle: z.string(),

  /** Output directory for diff report and artifacts. */
  outputDir: z.string().default('.archaeologist'),

  /** Pixel diff threshold (0-1 scale, lower = more sensitive). */
  diffThreshold: z
    .number()
    .min(0, 'Diff threshold must be >= 0')
    .max(1, 'Diff threshold must be <= 1')
    .default(0.1),

  /** Maximum diff ratio (0-100%) before a screenshot is considered "changed". */
  diffMaxRatio: z
    .number()
    .min(0, 'Diff max ratio must be >= 0')
    .max(100, 'Diff max ratio must be <= 100')
    .default(0.5),

  /** Fields to ignore during API response diff. */
  diffIgnoreFields: z.array(z.string()).default([
    'timestamp', 'createdAt', 'updatedAt', 'date',
    'requestId', 'traceId', 'correlationId',
    'token', 'nonce', 'csrf',
    'etag', 'lastModified',
  ]),

  /** Normalize dynamic values (UUIDs, timestamps, JWTs) before diffing. */
  normalizeDynamicValues: z.boolean().default(false),

  /** Show detailed value-level diffs (default: schema-level only). */
  detailed: z.boolean().default(false),

  /** Output formats for the diff report. */
  outputFormats: z.object({
    html: z.string().optional(),
    json: z.string().optional(),
    junit: z.string().optional(),
    markdown: z.string().optional(),
  }).default({}),
});

export type DiffConfig = z.infer<typeof DiffConfigSchema>;

// ---------------------------------------------------------------------------
// Resolved runtime config (after validation, path resolution, etc.)
// ---------------------------------------------------------------------------

/**
 * ResolvedConfig is the fully validated and resolved config passed to
 * the Orchestrator. All paths are absolute, all defaults are applied,
 * and the entry URL is normalized.
 */
export interface ResolvedConfig extends CrawlConfig {
  /** Absolute path to the resolved output directory. */
  outputDir: string;
  /** Absolute path to the auth script, if provided. */
  authScript?: string;
  /** Absolute path to the cookies file, if provided. */
  cookiesFile?: string;
  /** Warnings generated during config resolution (e.g. auto-prepended https://). */
  warnings: string[];
  /**
   * Optional list of per-page collector plugins. Run after the built-in
   * collectors on each visited page. Results are surfaced under
   * `PageVisitResult.pluginData` keyed by the collector name. This is a
   * programmatic-API-only knob; the CLI registers a vetted subset of
   * plugins via dedicated flags (e.g. `--with-a11y`).
   */
  collectors?: Collector[];
}

/**
 * Resolve a raw programmatic config into a ResolvedConfig that can be passed
 * directly to `dig()`. This is the canonical public helper for library use:
 *
 *   import { dig, resolveConfig } from 'playwright-archaeologist';
 *   const result = await dig(resolveConfig({ targetUrl: 'https://example.com' }));
 *
 * Steps performed:
 *  1. Normalize the entry URL (auto-prepend https:// when protocol is missing).
 *  2. Validate via Zod and apply defaults.
 *  3. Resolve `outputDir`, `authScript`, `cookiesFile` to absolute paths.
 *  4. Initialize the `warnings` array with any URL normalization warnings.
 *
 * Throws a standard Error if validation fails or the entry URL is invalid.
 */
export function resolveConfig(raw: Record<string, unknown>): ResolvedConfig {
  const input = { ...raw };
  let urlWarnings: string[] = [];

  // Normalize target URL if provided (auto-prepend https://, reject other protocols).
  if (typeof input.targetUrl === 'string') {
    const { url, warnings } = normalizeEntryUrl(input.targetUrl);
    input.targetUrl = url;
    urlWarnings = warnings;
  }

  const parseResult = CrawlConfigSchema.safeParse(input);
  if (!parseResult.success) {
    const issues = parseResult.error.issues
      .map((issue) => `${issue.path.join('.') || 'config'}: ${issue.message}`)
      .join('; ');
    throw new Error(`Invalid configuration: ${issues}`);
  }

  const validated = parseResult.data;

  return {
    ...validated,
    outputDir: path.resolve(validated.outputDir),
    authScript: validated.authScript ? path.resolve(validated.authScript) : undefined,
    cookiesFile: validated.cookiesFile ? path.resolve(validated.cookiesFile) : undefined,
    warnings: urlWarnings,
  };
}
