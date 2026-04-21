/**
 * Test emitter — turn a crawl bundle into starter Playwright specs.
 *
 * The emitter reads only the JSON artifacts that bundle-creator writes:
 *   - sitemap.json         (flat routes: url, title, statusCode, links, depth)
 *   - forms.json           (FormInfo[] — may be absent when no forms were found)
 *   - api-map.json         (ApiEndpointGroup[] — may be absent)
 *   - flow-graph.mmd       (Mermaid text — not needed; we read navigation
 *                          hints indirectly)
 *   - crawl-summary.json   (targetUrl etc.)
 *
 * Flow information is re-derived from the sitemap itself (adjacency by
 * shared path prefix + same-origin). This is deliberate — the bundle does
 * not ship a structured flow graph file at the moment, and parsing the
 * Mermaid definition is brittle. The heuristic yields flow walks that are
 * still useful as a starter suite (navigate through related pages in
 * breadth-first depth order).
 */

import { readFile, writeFile, mkdir, stat } from 'node:fs/promises';
import { join, resolve, dirname } from 'node:path';

import { EmitError } from '../types/errors.js';
import {
  sanitizeUrlForFilename,
  sanitizeApiPatternForFilename,
} from './sanitize.js';
import {
  renderHeader,
  renderSmokeSpec,
  renderFormSpec,
  renderFlowSpec,
  renderApiSpec,
  type FormTestInput,
  type FormFieldPlaceholder,
  type FlowStepInput,
} from './templates.js';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface EmitOptions {
  bundleDir: string;
  outputDir: string;
  /** Only emit per-flow tests; skip form + API specs. */
  flowsOnly?: boolean;
  /** Only emit per-form tests; skip flow + API specs. */
  formsOnly?: boolean;
  /** Override the bundle's target URL (useful in CI against staging/prod). */
  baseUrl?: string;
  /**
   * If provided, only emit tests for pages where the URL pathname contains
   * any of these tag fragments. An empty array is treated as "no filter".
   */
  filterByTag?: string[];
}

export interface EmittedFile {
  path: string;
  bytes: number;
  kind: 'flow' | 'form' | 'smoke' | 'api';
}

// ---------------------------------------------------------------------------
// Bundle shape (narrow, intentionally partial)
//
// We model only the fields we actually consume so a malformed bundle does
// not crash the emitter — missing keys degrade to "nothing to emit for
// this section".
// ---------------------------------------------------------------------------

interface SitemapEntry {
  url: string;
  title?: string;
  statusCode?: number;
  depth?: number;
  links?: number;
}

interface FormField {
  name?: string;
  type?: string;
  required?: boolean;
  placeholder?: string;
  label?: string;
}

interface FormInfo {
  action?: string;
  method?: string;
  fields?: FormField[];
  submitButtonText?: string;
  id?: string;
  name?: string;
}

interface ApiEndpoint {
  pattern?: string;
  method?: string;
  observedUrls?: string[];
  exampleResponse?: {
    statusCode?: number;
    contentType?: string;
  };
}

interface CrawlSummary {
  targetUrl?: string;
  finishedAt?: string;
}

// ---------------------------------------------------------------------------
// JSON read helpers
// ---------------------------------------------------------------------------

/** Read + parse JSON. Returns `undefined` on missing/unreadable file. */
async function readJsonIfExists<T>(path: string): Promise<T | undefined> {
  try {
    const raw = await readFile(path, 'utf-8');
    return JSON.parse(raw) as T;
  } catch {
    return undefined;
  }
}

async function loadBundle(bundleDir: string): Promise<{
  sitemap: SitemapEntry[];
  forms: FormInfo[];
  apiEndpoints: ApiEndpoint[];
  summary: CrawlSummary;
}> {
  // A bundle has artifacts under `data/`. Tolerate either layout (data/ or
  // root) because the emitter can also be pointed at a raw crawl output
  // dir, which is handy for users who did not create a bundle.
  const roots = [join(bundleDir, 'data'), bundleDir];

  async function findFile(name: string): Promise<string | undefined> {
    for (const root of roots) {
      const candidate = join(root, name);
      try {
        const st = await stat(candidate);
        if (st.isFile()) return candidate;
      } catch {
        // continue
      }
    }
    return undefined;
  }

  const sitemapPath = await findFile('sitemap.json');
  if (!sitemapPath) {
    throw new EmitError(
      'bundle_malformed',
      `Bundle is missing sitemap.json (searched: ${roots.join(', ')}).`,
      bundleDir,
    );
  }

  const sitemap = (await readJsonIfExists<SitemapEntry[]>(sitemapPath)) ?? [];
  if (!Array.isArray(sitemap)) {
    throw new EmitError(
      'bundle_malformed',
      `sitemap.json at ${sitemapPath} is not a JSON array.`,
      bundleDir,
    );
  }

  const formsPath = await findFile('forms.json');
  const apiPath = await findFile('api-map.json');
  const summaryPath = await findFile('crawl-summary.json');

  const forms = (formsPath ? await readJsonIfExists<FormInfo[]>(formsPath) : undefined) ?? [];
  const apiEndpoints = (apiPath ? await readJsonIfExists<ApiEndpoint[]>(apiPath) : undefined) ?? [];
  const summary = (summaryPath ? await readJsonIfExists<CrawlSummary>(summaryPath) : undefined) ?? {};

  return {
    sitemap: Array.isArray(sitemap) ? sitemap : [],
    forms: Array.isArray(forms) ? forms : [],
    apiEndpoints: Array.isArray(apiEndpoints) ? apiEndpoints : [],
    summary,
  };
}

// ---------------------------------------------------------------------------
// Placeholder values for form fields
// ---------------------------------------------------------------------------

function placeholderForField(field: FormField): string {
  const type = (field.type ?? 'text').toLowerCase();
  switch (type) {
    case 'email':
      return 'test@example.com';
    case 'password':
      return 'test-password-123';
    case 'tel':
    case 'phone':
      return '+1-555-0100';
    case 'number':
    case 'range':
      return '1';
    case 'url':
      return 'https://example.com';
    case 'date':
      return '2026-01-01';
    case 'time':
      return '12:00';
    case 'search':
      return 'test-query';
    case 'textarea':
      return 'test message';
    case 'checkbox':
    case 'radio':
      return 'on';
    default:
      return 'test-input';
  }
}

// ---------------------------------------------------------------------------
// URL rewriting for --base-url
// ---------------------------------------------------------------------------

/**
 * Rewrite a URL's origin to match `baseUrl`. When either is not a valid
 * URL we return the input unchanged. This keeps the emitter tolerant of
 * odd bundle contents (e.g. hash-only URLs from SPAs).
 */
function rewriteOrigin(url: string, sourceOrigin: string, baseUrl?: string): string {
  if (!baseUrl) return url;
  try {
    const u = new URL(url);
    const base = new URL(baseUrl);
    // Only swap origins when the URL was on the source origin we crawled.
    if (u.origin !== sourceOrigin) return url;
    u.protocol = base.protocol;
    u.host = base.host;
    // Strip default port when protocol port matches.
    return u.toString();
  } catch {
    return url;
  }
}

// ---------------------------------------------------------------------------
// Filtering helpers
// ---------------------------------------------------------------------------

function matchesTagFilter(url: string, tags: string[] | undefined): boolean {
  if (!tags || tags.length === 0) return true;
  try {
    const pathname = new URL(url).pathname.toLowerCase();
    return tags.some((t) => pathname.includes(t.toLowerCase()));
  } catch {
    return tags.some((t) => url.toLowerCase().includes(t.toLowerCase()));
  }
}

// ---------------------------------------------------------------------------
// Flow heuristic
// ---------------------------------------------------------------------------

/**
 * Build flows from the sitemap using path-prefix adjacency.
 *
 * Bundles ship flow-graph.mmd (Mermaid text, not JSON) but parsing Mermaid
 * is brittle and the input shape will change. Instead we derive "flows" by
 * grouping routes that share a first path segment. Each group becomes one
 * flow walking through its pages in BFS depth order, yielding a minimal
 * starter suite that still crosses multiple pages.
 *
 * This is a deliberate compromise — noted at the end of the task.
 */
function buildFlows(sitemap: SitemapEntry[]): FlowStepInput[][] {
  // Filter to successful pages so the walk is not full of 404s.
  const pages = sitemap.filter((p) => {
    if (!p.url) return false;
    if (typeof p.statusCode === 'number' && p.statusCode >= 400) return false;
    return true;
  });

  if (pages.length < 2) return [];

  // Group by first path segment. Entries without a segment ("/") are
  // lumped under a "_root" cluster but not made into their own flow.
  const groups = new Map<string, SitemapEntry[]>();
  for (const page of pages) {
    let segment = '_root';
    try {
      const segs = new URL(page.url).pathname.split('/').filter(Boolean);
      if (segs.length > 0) segment = segs[0];
    } catch {
      // fallthrough
    }
    let bucket = groups.get(segment);
    if (!bucket) {
      bucket = [];
      groups.set(segment, bucket);
    }
    bucket.push(page);
  }

  const flows: FlowStepInput[][] = [];
  for (const [segment, bucket] of groups) {
    if (bucket.length < 2) continue;
    if (segment === '_root') continue; // Root is covered by smoke spec.

    // Sort by (depth asc, url asc) for a deterministic walk.
    bucket.sort((a, b) => {
      const dA = typeof a.depth === 'number' ? a.depth : 0;
      const dB = typeof b.depth === 'number' ? b.depth : 0;
      if (dA !== dB) return dA - dB;
      return a.url.localeCompare(b.url);
    });

    const steps: FlowStepInput[] = [];
    for (let i = 0; i < bucket.length - 1; i++) {
      steps.push({
        from: bucket[i].url,
        to: bucket[i + 1].url,
        trigger: 'link',
        triggerText: bucket[i + 1].title ?? '',
      });
    }
    if (steps.length > 0) flows.push(steps);
  }

  return flows;
}

// ---------------------------------------------------------------------------
// Per-page form grouping
// ---------------------------------------------------------------------------

/**
 * Forms in forms.json do not carry their host page URL — the crawl
 * serializer writes FormInfo[] without pageUrl. We key by the form's
 * `action` and fall back to the target URL when no action is set. For
 * emission that is enough: the test navigates to the grouped URL and
 * probes any form rendered there. When multiple forms share the same
 * page they are emitted together.
 */
function groupFormsByPage(forms: FormInfo[], fallbackUrl: string): Map<string, FormInfo[]> {
  const byPage = new Map<string, FormInfo[]>();
  for (const form of forms) {
    // Treat `action` as a candidate page URL. If it's empty or relative,
    // use the fallback (target URL) so the test still runs.
    let pageUrl = fallbackUrl;
    const action = form.action?.trim();
    if (action && /^https?:\/\//.test(action)) {
      pageUrl = action;
    }
    let bucket = byPage.get(pageUrl);
    if (!bucket) {
      bucket = [];
      byPage.set(pageUrl, bucket);
    }
    bucket.push(form);
  }
  return byPage;
}

// ---------------------------------------------------------------------------
// Public entry point
// ---------------------------------------------------------------------------

/**
 * Read a bundle, generate Playwright spec files, and write them to disk.
 *
 * Errors raised:
 *   - EmitError('bundle_not_found')        when the bundle dir does not exist
 *   - EmitError('bundle_malformed')        when sitemap.json is missing or invalid
 *   - EmitError('output_dir_not_writable') when outputDir cannot be created
 *   - EmitError('write_failed')            when an individual file write fails
 */
export async function emitTests(options: EmitOptions): Promise<EmittedFile[]> {
  const bundleDir = resolve(options.bundleDir);
  const outputDir = resolve(options.outputDir);

  // Validate the bundle directory exists and is a directory.
  try {
    const st = await stat(bundleDir);
    if (!st.isDirectory()) {
      throw new EmitError(
        'bundle_not_found',
        `Bundle path is not a directory: ${bundleDir}`,
        bundleDir,
      );
    }
  } catch (err) {
    if (err instanceof EmitError) throw err;
    throw new EmitError(
      'bundle_not_found',
      `Bundle directory not found: ${bundleDir}`,
      bundleDir,
      { cause: err instanceof Error ? err : undefined },
    );
  }

  const { sitemap, forms, apiEndpoints, summary } = await loadBundle(bundleDir);

  // Determine the source origin we crawled (needed so --base-url only
  // rewrites URLs on the original host).
  let sourceOrigin = '';
  try {
    const target = summary.targetUrl ?? sitemap[0]?.url ?? '';
    sourceOrigin = target ? new URL(target).origin : '';
  } catch {
    sourceOrigin = '';
  }

  const targetUrl = options.baseUrl
    ?? summary.targetUrl
    ?? sitemap[0]?.url
    ?? '';

  // Ensure the output directory tree exists.
  try {
    await mkdir(outputDir, { recursive: true });
  } catch (err) {
    throw new EmitError(
      'output_dir_not_writable',
      `Cannot create output directory: ${outputDir}`,
      bundleDir,
      { cause: err instanceof Error ? err : undefined },
    );
  }

  const header = renderHeader({
    bundlePath: bundleDir,
    generatedAt: new Date().toISOString(),
  });

  const emitted: EmittedFile[] = [];

  const shouldEmitSmoke = !options.flowsOnly && !options.formsOnly;
  const shouldEmitForms = !options.flowsOnly;
  const shouldEmitFlows = !options.formsOnly;
  const shouldEmitApi = !options.flowsOnly && !options.formsOnly;

  // -------------------------------------------------------------------------
  // Smoke spec (always unless --flows-only OR --forms-only)
  // -------------------------------------------------------------------------
  if (shouldEmitSmoke) {
    const routes = sitemap
      .filter((p) => !!p.url && typeof p.statusCode === 'number')
      .filter((p) => matchesTagFilter(p.url, options.filterByTag))
      .map((p) => ({
        url: rewriteOrigin(p.url, sourceOrigin, options.baseUrl),
        statusCode: p.statusCode ?? 200,
        title: p.title ?? '',
      }));

    const rewrittenTarget = rewriteOrigin(targetUrl, sourceOrigin, options.baseUrl);
    const homePage = sitemap.find((p) => p.url === targetUrl) ?? sitemap[0];
    const homeTitle = homePage?.title ?? '';

    const body = renderSmokeSpec({
      header,
      targetUrl: rewrittenTarget,
      title: homeTitle,
      routes,
    });
    const outPath = join(outputDir, 'smoke.spec.ts');
    const bytes = await writeSpec(outPath, body, bundleDir);
    emitted.push({ path: outPath, bytes, kind: 'smoke' });
  }

  // -------------------------------------------------------------------------
  // Form specs — one file per page with forms
  // -------------------------------------------------------------------------
  if (shouldEmitForms && forms.length > 0) {
    const formsDir = join(outputDir, 'forms');
    try {
      await mkdir(formsDir, { recursive: true });
    } catch (err) {
      throw new EmitError(
        'output_dir_not_writable',
        `Cannot create forms output directory: ${formsDir}`,
        bundleDir,
        { cause: err instanceof Error ? err : undefined },
      );
    }

    const byPage = groupFormsByPage(forms, targetUrl);
    for (const [pageUrlRaw, pageForms] of byPage) {
      const pageUrl = rewriteOrigin(pageUrlRaw, sourceOrigin, options.baseUrl);

      if (!matchesTagFilter(pageUrlRaw, options.filterByTag)) continue;

      // Skip forms with NO fields AND NO action — they are unusable.
      const useable = pageForms.filter((f) => {
        if (!f.action && (!f.fields || f.fields.length === 0)) return false;
        // Skip forms with no action string at all — can't click submit reliably.
        // We still emit when an action exists but no fields (some legacy
        // search forms) so reviewers can fill in.
        return true;
      });
      if (useable.length === 0) continue;

      const formInputs: FormTestInput[] = useable.map((f, idx) => {
        const requiredFields: FormFieldPlaceholder[] = (f.fields ?? [])
          .filter((fld) => fld.required === true)
          .map((fld) => ({
            name: fld.name ?? '',
            type: fld.type ?? 'text',
            value: placeholderForField(fld),
          }));

        const method = (f.method ?? 'GET').toUpperCase();
        const actionDisplay = f.action || '(no action)';
        const name = `submit form ${idx + 1}: ${method} ${actionDisplay}`;

        return {
          name,
          pageUrl,
          action: f.action ?? '',
          method,
          fields: requiredFields,
          submitButtonText: f.submitButtonText,
        };
      });

      const body = renderFormSpec({ header, pageUrl, forms: formInputs });
      const filename = `${sanitizeUrlForFilename(pageUrlRaw)}.spec.ts`;
      const outPath = join(formsDir, filename);
      const bytes = await writeSpec(outPath, body, bundleDir);
      emitted.push({ path: outPath, bytes, kind: 'form' });
    }
  }

  // -------------------------------------------------------------------------
  // Flow specs — one file per path-segment cluster with >=2 pages
  // -------------------------------------------------------------------------
  if (shouldEmitFlows) {
    const flowsDir = join(outputDir, 'flows');
    const flows = buildFlows(sitemap.filter((p) => matchesTagFilter(p.url, options.filterByTag)));

    if (flows.length > 0) {
      try {
        await mkdir(flowsDir, { recursive: true });
      } catch (err) {
        throw new EmitError(
          'output_dir_not_writable',
          `Cannot create flows output directory: ${flowsDir}`,
          bundleDir,
          { cause: err instanceof Error ? err : undefined },
        );
      }

      for (let i = 0; i < flows.length; i++) {
        const steps = flows[i].map((step) => ({
          ...step,
          from: rewriteOrigin(step.from, sourceOrigin, options.baseUrl),
          to: rewriteOrigin(step.to, sourceOrigin, options.baseUrl),
        }));

        const label = `flow ${i + 1}`;
        const splitPerStep = steps.length > 5;
        const body = renderFlowSpec({ header, label, steps, splitPerStep });

        const filename = `${String(i + 1).padStart(3, '0')}.spec.ts`;
        const outPath = join(flowsDir, filename);
        const bytes = await writeSpec(outPath, body, bundleDir);
        emitted.push({ path: outPath, bytes, kind: 'flow' });
      }
    }
  }

  // -------------------------------------------------------------------------
  // API specs — one file per endpoint group
  // -------------------------------------------------------------------------
  if (shouldEmitApi && apiEndpoints.length > 0) {
    const apiDir = join(outputDir, 'api');
    try {
      await mkdir(apiDir, { recursive: true });
    } catch (err) {
      throw new EmitError(
        'output_dir_not_writable',
        `Cannot create api output directory: ${apiDir}`,
        bundleDir,
        { cause: err instanceof Error ? err : undefined },
      );
    }

    for (const ep of apiEndpoints) {
      const method = (ep.method ?? 'GET').toUpperCase();
      const pattern = ep.pattern ?? '/';
      const firstUrl = ep.observedUrls?.[0];
      if (!firstUrl) continue;

      // Tag filtering applies on the endpoint pattern.
      if (!matchesTagFilter(pattern, options.filterByTag) && !matchesTagFilter(firstUrl, options.filterByTag)) {
        continue;
      }

      const exampleUrl = rewriteOrigin(firstUrl, sourceOrigin, options.baseUrl);
      const expectedStatus = ep.exampleResponse?.statusCode ?? 200;
      const contentType = ep.exampleResponse?.contentType;

      const body = renderApiSpec({
        header,
        endpoints: [{ method, exampleUrl, expectedStatus, contentType }],
      });

      const filename = `${sanitizeApiPatternForFilename(method, pattern)}.spec.ts`;
      const outPath = join(apiDir, filename);
      const bytes = await writeSpec(outPath, body, bundleDir);
      emitted.push({ path: outPath, bytes, kind: 'api' });
    }
  }

  return emitted;
}

/**
 * Write a spec file to disk, creating parent directories as needed, and
 * return the byte count. Throws EmitError with 'write_failed' on I/O error.
 */
async function writeSpec(path: string, body: string, bundleDir: string): Promise<number> {
  try {
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, body, 'utf-8');
    return Buffer.byteLength(body, 'utf-8');
  } catch (err) {
    throw new EmitError(
      'write_failed',
      `Failed to write spec file: ${path}`,
      bundleDir,
      { cause: err instanceof Error ? err : undefined },
    );
  }
}
