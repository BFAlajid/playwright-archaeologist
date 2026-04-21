/**
 * Diff Engine
 *
 * Compares two bundle directories to detect regressions.
 * Produces a DiffResult with structured change information for:
 *   - Routes (sitemap diff)
 *   - Forms (field-level diff)
 *   - API endpoints (status code, content type, body size diff)
 *   - Screenshots (hash-based change detection)
 *
 * No external diff dependencies -- uses JSON comparison and SHA-256 hashes.
 */

import { readFile, mkdir, access } from 'node:fs/promises';
import { join } from 'node:path';
import type {
  BundleManifest,
  DiffResult,
  DiffSummary,
  SitemapDiff,
  SitemapRouteChange,
  FormDiff,
  FormChange,
  FieldChange,
  ApiDiff,
  ApiEndpointChange,
  ScreenshotDiff,
  ScreenshotChange,
  RouteInfo,
  FormInfo,
  FormField,
  ApiEndpointGroup,
} from '../types/artifacts.js';
import { BundleError, DiffError } from '../types/errors.js';
import { isSafeBundlePath } from '../bundle/bundle-creator.js';
import { diffScreenshotPair } from './screenshot-diff.js';
import { createHash } from 'node:crypto';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Load and parse a JSON file, returning null if it does not exist. */
async function loadJson<T>(filePath: string): Promise<T | null> {
  try {
    const content = await readFile(filePath, 'utf-8');
    return JSON.parse(content) as T;
  } catch {
    return null;
  }
}

/** Load manifest.json from a bundle directory. */
async function loadManifest(bundleDir: string): Promise<BundleManifest> {
  const manifestPath = join(bundleDir, 'manifest.json');
  const manifest = await loadJson<BundleManifest>(manifestPath);
  if (!manifest) {
    throw new DiffError(
      'manifest_invalid',
      `Could not load manifest.json from bundle: ${bundleDir}`,
    );
  }
  if (manifest.version !== 1) {
    throw new DiffError(
      'manifest_invalid',
      `Unsupported manifest version ${manifest.version} in: ${bundleDir}`,
    );
  }
  return manifest;
}

/** Create an identity key for a form (action:method or id). */
function formKey(form: FormInfo): string {
  if (form.id) return `id:${form.id}`;
  return `${form.action}:${form.method}`;
}

/** Create an identity key for an API endpoint (method + pattern). */
function apiKey(endpoint: ApiEndpointGroup): string {
  return `${endpoint.method} ${endpoint.pattern}`;
}

// ---------------------------------------------------------------------------
// Route diffing
// ---------------------------------------------------------------------------

function diffRoutes(
  oldRoutes: RouteInfo[],
  newRoutes: RouteInfo[],
): SitemapDiff {
  const oldByUrl = new Map(oldRoutes.map((r) => [r.url, r]));
  const newByUrl = new Map(newRoutes.map((r) => [r.url, r]));

  const added: RouteInfo[] = [];
  const removed: RouteInfo[] = [];
  const changed: SitemapRouteChange[] = [];
  let unchangedCount = 0;

  // Find added and changed routes
  for (const [url, newRoute] of newByUrl) {
    const oldRoute = oldByUrl.get(url);
    if (!oldRoute) {
      added.push(newRoute);
      continue;
    }

    // Compare for changes
    const changes: SitemapRouteChange['changes'] = {};
    let hasChanges = false;

    if (oldRoute.title !== newRoute.title) {
      changes.title = { old: oldRoute.title, new: newRoute.title };
      hasChanges = true;
    }
    if (oldRoute.statusCode !== newRoute.statusCode) {
      changes.statusCode = { old: oldRoute.statusCode, new: newRoute.statusCode };
      hasChanges = true;
    }
    if (oldRoute.contentHash !== newRoute.contentHash) {
      changes.contentHash = { old: oldRoute.contentHash, new: newRoute.contentHash };
      hasChanges = true;
    }

    if (hasChanges) {
      changed.push({ url, changes });
    } else {
      unchangedCount++;
    }
  }

  // Find removed routes
  for (const [url, oldRoute] of oldByUrl) {
    if (!newByUrl.has(url)) {
      removed.push(oldRoute);
    }
  }

  return { added, removed, changed, unchangedCount };
}

// ---------------------------------------------------------------------------
// Form diffing
// ---------------------------------------------------------------------------

function diffFields(oldFields: FormField[], newFields: FormField[]): {
  fieldsAdded: FormField[];
  fieldsRemoved: FormField[];
  fieldsChanged: FieldChange[];
} {
  const oldByName = new Map(oldFields.map((f) => [f.name, f]));
  const newByName = new Map(newFields.map((f) => [f.name, f]));

  const fieldsAdded: FormField[] = [];
  const fieldsRemoved: FormField[] = [];
  const fieldsChanged: FieldChange[] = [];

  for (const [name, newField] of newByName) {
    const oldField = oldByName.get(name);
    if (!oldField) {
      fieldsAdded.push(newField);
      continue;
    }

    const changes: FieldChange['changes'] = {};
    let hasChanges = false;

    if (oldField.type !== newField.type) {
      changes.type = { old: oldField.type, new: newField.type };
      hasChanges = true;
    }
    if (oldField.required !== newField.required) {
      changes.required = { old: oldField.required, new: newField.required };
      hasChanges = true;
    }
    if (oldField.pattern !== newField.pattern) {
      changes.validationPattern = {
        old: oldField.pattern ?? '',
        new: newField.pattern ?? '',
      };
      hasChanges = true;
    }
    if (oldField.placeholder !== newField.placeholder) {
      changes.placeholder = {
        old: oldField.placeholder ?? '',
        new: newField.placeholder ?? '',
      };
      hasChanges = true;
    }

    // Options diff (for select, radio, checkbox)
    if (oldField.options || newField.options) {
      const oldValues = new Set((oldField.options ?? []).map((o) => o.value));
      const newValues = new Set((newField.options ?? []).map((o) => o.value));
      const optionsAdded = [...newValues].filter((v) => !oldValues.has(v));
      const optionsRemoved = [...oldValues].filter((v) => !newValues.has(v));
      if (optionsAdded.length > 0 || optionsRemoved.length > 0) {
        changes.options = { added: optionsAdded, removed: optionsRemoved };
        hasChanges = true;
      }
    }

    if (hasChanges) {
      fieldsChanged.push({ name, changes });
    }
  }

  for (const [name, oldField] of oldByName) {
    if (!newByName.has(name)) {
      fieldsRemoved.push(oldField);
    }
  }

  return { fieldsAdded, fieldsRemoved, fieldsChanged };
}

function diffForms(oldForms: FormInfo[], newForms: FormInfo[]): FormDiff {
  const oldByKey = new Map(oldForms.map((f) => [formKey(f), f]));
  const newByKey = new Map(newForms.map((f) => [formKey(f), f]));

  const added: FormInfo[] = [];
  const removed: FormInfo[] = [];
  const changed: FormChange[] = [];
  let unchangedCount = 0;

  for (const [key, newForm] of newByKey) {
    const oldForm = oldByKey.get(key);
    if (!oldForm) {
      added.push(newForm);
      continue;
    }

    // Compare fields
    const fieldDiff = diffFields(oldForm.fields, newForm.fields);
    const changeEntry: FormChange['changes'] = {};
    let hasChanges = false;

    if (fieldDiff.fieldsAdded.length > 0) {
      changeEntry.fieldsAdded = fieldDiff.fieldsAdded;
      hasChanges = true;
    }
    if (fieldDiff.fieldsRemoved.length > 0) {
      changeEntry.fieldsRemoved = fieldDiff.fieldsRemoved;
      hasChanges = true;
    }
    if (fieldDiff.fieldsChanged.length > 0) {
      changeEntry.fieldsChanged = fieldDiff.fieldsChanged;
      hasChanges = true;
    }
    if (oldForm.action !== newForm.action) {
      changeEntry.actionChanged = { old: oldForm.action, new: newForm.action };
      hasChanges = true;
    }
    if (oldForm.method !== newForm.method) {
      changeEntry.methodChanged = { old: oldForm.method, new: newForm.method };
      hasChanges = true;
    }

    if (hasChanges) {
      changed.push({
        formId: key,
        pageUrl: newForm.action, // best available context
        changes: changeEntry,
      });
    } else {
      unchangedCount++;
    }
  }

  for (const [key, oldForm] of oldByKey) {
    if (!newByKey.has(key)) {
      removed.push(oldForm);
    }
  }

  return { added, removed, changed, unchangedCount };
}

// ---------------------------------------------------------------------------
// API endpoint diffing
// ---------------------------------------------------------------------------

function diffApi(
  oldEndpoints: ApiEndpointGroup[],
  newEndpoints: ApiEndpointGroup[],
): ApiDiff {
  const oldByKey = new Map(oldEndpoints.map((e) => [apiKey(e), e]));
  const newByKey = new Map(newEndpoints.map((e) => [apiKey(e), e]));

  const added: ApiEndpointGroup[] = [];
  const removed: ApiEndpointGroup[] = [];
  const changed: ApiEndpointChange[] = [];
  let unchangedCount = 0;

  for (const [key, newEp] of newByKey) {
    const oldEp = oldByKey.get(key);
    if (!oldEp) {
      added.push(newEp);
      continue;
    }

    const changes: ApiEndpointChange['changes'] = {};
    let hasChanges = false;

    // Status codes diff
    const oldStatuses = new Set(oldEp.observedStatusCodes);
    const newStatuses = new Set(newEp.observedStatusCodes);
    const statusCodesAdded = [...newStatuses].filter((s) => !oldStatuses.has(s));
    const statusCodesRemoved = [...oldStatuses].filter((s) => !newStatuses.has(s));
    if (statusCodesAdded.length > 0) {
      changes.statusCodesAdded = statusCodesAdded;
      hasChanges = true;
    }
    if (statusCodesRemoved.length > 0) {
      changes.statusCodesRemoved = statusCodesRemoved;
      hasChanges = true;
    }

    // Content type diff
    const oldContentTypes = oldEp.observedContentTypes;
    const newContentTypes = newEp.observedContentTypes;
    if (
      oldContentTypes.length > 0 &&
      newContentTypes.length > 0 &&
      oldContentTypes[0] !== newContentTypes[0]
    ) {
      changes.contentTypeChanged = {
        old: oldContentTypes[0],
        new: newContentTypes[0],
      };
      hasChanges = true;
    }

    // Body size comparison
    const oldSize = oldEp.exampleResponse.bodySize;
    const newSize = newEp.exampleResponse.bodySize;
    if (oldSize > 0 && newSize > 0) {
      const percentChange = Math.abs(((newSize - oldSize) / oldSize) * 100);
      if (percentChange > 10) {
        changes.bodySizeChange = {
          old: oldSize,
          new: newSize,
          percentChange: Math.round(percentChange * 100) / 100,
        };
        hasChanges = true;
      }
    }

    if (hasChanges) {
      changed.push({ endpointId: key, changes });
    } else {
      unchangedCount++;
    }
  }

  for (const [key, oldEp] of oldByKey) {
    if (!newByKey.has(key)) {
      removed.push(oldEp);
    }
  }

  return { added, removed, changed, unchangedCount };
}

// ---------------------------------------------------------------------------
// Screenshot diffing (hash-based, no pixel comparison)
// ---------------------------------------------------------------------------

interface ScreenshotEntry {
  url: string;
  sha256: string;
  path: string;
}

/** Concurrency cap for pixel diffs — pixelmatch is CPU-bound and synchronous. */
const PIXEL_DIFF_CONCURRENCY = 8;

/** Short, filesystem-safe slug derived from a URL for heatmap filenames. */
function urlToFilenameSlug(url: string): string {
  const hash = createHash('sha256').update(url).digest('hex').slice(0, 12);
  return `heatmap-${hash}.png`;
}

/**
 * Run a bounded-concurrency map. Avoids a new dependency for a 20-line helper.
 */
async function parallelMap<T, R>(
  items: T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let cursor = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (true) {
      const index = cursor++;
      if (index >= items.length) return;
      results[index] = await fn(items[index], index);
    }
  });
  await Promise.all(workers);
  return results;
}

async function diffScreenshots(
  oldScreenshots: ScreenshotEntry[],
  newScreenshots: ScreenshotEntry[],
  oldDir: string,
  newDir: string,
  options: { heatmapDir?: string } = {},
): Promise<ScreenshotDiff> {
  const oldByUrl = new Map(oldScreenshots.map((s) => [s.url, s]));
  const newByUrl = new Map(newScreenshots.map((s) => [s.url, s]));

  const added: ScreenshotDiff['added'] = [];
  const removed: ScreenshotDiff['removed'] = [];
  let unchangedCount = 0;

  // Pair up the screenshots that appear in BOTH bundles and differ by hash.
  // Hash equality still short-circuits the expensive pixel diff.
  const candidatePairs: Array<{ url: string; oldSs: ScreenshotEntry; newSs: ScreenshotEntry }> = [];
  for (const [url, newSs] of newByUrl) {
    const oldSs = oldByUrl.get(url);
    if (!oldSs) {
      added.push({ url, screenshotPath: join(newDir, newSs.path) });
      continue;
    }
    if (oldSs.sha256 === newSs.sha256) {
      unchangedCount++;
      continue;
    }
    candidatePairs.push({ url, oldSs, newSs });
  }
  for (const [url] of oldByUrl) {
    if (!newByUrl.has(url)) removed.push({ url });
  }

  // Ensure heatmap dir exists once (rather than on each pair).
  if (options.heatmapDir) {
    try {
      await mkdir(options.heatmapDir, { recursive: true });
    } catch {
      // If the heatmap dir can't be created we still run the diff — we just
      // won't emit heatmaps.
    }
  }

  const changed = await parallelMap(candidatePairs, PIXEL_DIFF_CONCURRENCY, async ({ url, oldSs, newSs }): Promise<ScreenshotChange> => {
    const oldPath = join(oldDir, oldSs.path);
    const newPath = join(newDir, newSs.path);

    // If either file is missing, fall back to hash-only reporting.
    try {
      await Promise.all([access(oldPath), access(newPath)]);
    } catch {
      return {
        url,
        diffPercentage: 100,
        diffPixelCount: 0,
        totalPixels: 0,
        diffImagePath: '',
        oldScreenshotPath: oldPath,
        newScreenshotPath: newPath,
        diffUnavailableReason: 'One or both screenshot files are missing on disk',
      };
    }

    const heatmapPath = options.heatmapDir
      ? join(options.heatmapDir, urlToFilenameSlug(url))
      : undefined;

    const result = await diffScreenshotPair(oldPath, newPath, {
      emitHeatmapTo: heatmapPath,
    });

    // NaN percentage means the diff could not run (dimension mismatch,
    // non-PNG input, etc.). Fall back to the legacy "hash changed => 100%"
    // signal so the report still surfaces the change.
    if (!Number.isFinite(result.percentage)) {
      return {
        url,
        diffPercentage: 100,
        diffPixelCount: 0,
        totalPixels: 0,
        diffImagePath: '',
        oldScreenshotPath: oldPath,
        newScreenshotPath: newPath,
        diffUnavailableReason: result.mismatchReason,
      };
    }

    return {
      url,
      diffPercentage: Math.round(result.percentage * 100) / 100,
      diffPixelCount: result.differentPixels,
      totalPixels: result.totalPixels,
      diffImagePath: result.heatmapPath ?? '',
      heatmapPath: result.heatmapPath,
      oldScreenshotPath: oldPath,
      newScreenshotPath: newPath,
    };
  });

  return { added, removed, changed, unchangedCount };
}

// ---------------------------------------------------------------------------
// Screenshot manifest loading
// ---------------------------------------------------------------------------

/**
 * Extract screenshot entries from bundle manifest and screenshot-manifest.json.
 * Falls back to manifest file entries if screenshot-manifest.json is not available.
 *
 * Every `path` emitted here is validated against `bundleDir` via
 * `isSafeBundlePath`. A malicious bundle that lists
 * `../../etc/passwd` or `/etc/passwd` is rejected with a BundleError —
 * otherwise the downstream screenshot diff would read and hash arbitrary
 * files on the host.
 */
async function loadScreenshotEntries(
  bundleDir: string,
  manifest: BundleManifest,
): Promise<ScreenshotEntry[]> {
  // Try loading screenshot-manifest.json for URL mapping
  const screenshotManifest = await loadJson<
    Array<{ url: string; fullPageHash: string; fullPagePath: string }>
  >(join(bundleDir, 'data', 'screenshot-manifest.json'));

  if (screenshotManifest && Array.isArray(screenshotManifest)) {
    return screenshotManifest.map((s) => {
      if (!isSafeBundlePath(s.fullPagePath, bundleDir)) {
        throw new BundleError(
          'integrity_check_failed',
          `Unsafe screenshot path in screenshot-manifest.json: ${s.fullPagePath}`,
          bundleDir,
        );
      }
      return {
        url: s.url,
        sha256: s.fullPageHash,
        path: s.fullPagePath,
      };
    });
  }

  // Fallback: use manifest file entries for screenshots (URL unknown, use path)
  return manifest.files
    .filter((f) => f.type === 'screenshot')
    .map((f) => {
      if (!isSafeBundlePath(f.path, bundleDir)) {
        throw new BundleError(
          'integrity_check_failed',
          `Unsafe file path in bundle manifest: ${f.path}`,
          bundleDir,
        );
      }
      return {
        url: f.path, // best available identifier
        sha256: f.sha256,
        path: f.path,
      };
    });
}

// ---------------------------------------------------------------------------
// Main diff function
// ---------------------------------------------------------------------------

/**
 * Options that influence how diffs are computed.
 * These used to live on CrawlConfigSchema; they belong to the diff pipeline only.
 */
export interface DiffBundlesOptions {
  /** Pixel diff threshold (0-1 scale, lower = more sensitive). Reserved for future pixel diffing. */
  diffThreshold?: number;
  /** Maximum diff ratio (0-100%) before a screenshot is marked changed. Reserved for future pixel diffing. */
  diffMaxRatio?: number;
  /** Fields to ignore during API diff. Reserved for future detailed-mode value comparisons. */
  diffIgnoreFields?: string[];
  /**
   * Directory the diff engine writes pixel-diff heatmaps to. Created
   * on demand. When omitted, pixel diffs still run but no heatmap PNG
   * is emitted.
   */
  heatmapDir?: string;
}

/**
 * Compare two bundle directories and produce a DiffResult.
 *
 * @param oldDir - Path to the older bundle directory
 * @param newDir - Path to the newer bundle directory
 * @param options - Optional diff tuning (currently accepted but not consumed by the hash-based diff engine)
 * @returns Structured diff result
 */
export async function diffBundles(
  oldDir: string,
  newDir: string,
  options?: DiffBundlesOptions,
): Promise<DiffResult> {
  // Load manifests
  const [oldManifest, newManifest] = await Promise.all([
    loadManifest(oldDir),
    loadManifest(newDir),
  ]);

  // Load data files for comparison
  const [oldSitemap, newSitemap] = await Promise.all([
    loadJson<RouteInfo[]>(join(oldDir, 'data', 'sitemap.json')),
    loadJson<RouteInfo[]>(join(newDir, 'data', 'sitemap.json')),
  ]);

  const [oldForms, newForms] = await Promise.all([
    loadJson<FormInfo[]>(join(oldDir, 'data', 'forms.json')),
    loadJson<FormInfo[]>(join(newDir, 'data', 'forms.json')),
  ]);

  const [oldApiMap, newApiMap] = await Promise.all([
    loadJson<ApiEndpointGroup[]>(join(oldDir, 'data', 'api-map.json')),
    loadJson<ApiEndpointGroup[]>(join(newDir, 'data', 'api-map.json')),
  ]);

  // Load screenshot entries
  const [oldScreenshotEntries, newScreenshotEntries] = await Promise.all([
    loadScreenshotEntries(oldDir, oldManifest),
    loadScreenshotEntries(newDir, newManifest),
  ]);

  // Perform diffs
  const sitemap = diffRoutes(oldSitemap ?? [], newSitemap ?? []);
  const forms = diffForms(oldForms ?? [], newForms ?? []);
  const api = diffApi(oldApiMap ?? [], newApiMap ?? []);
  const screenshots = await diffScreenshots(
    oldScreenshotEntries,
    newScreenshotEntries,
    oldDir,
    newDir,
    { heatmapDir: options?.heatmapDir },
  );

  // Build summary
  const summary: DiffSummary = {
    routes: {
      added: sitemap.added.length,
      removed: sitemap.removed.length,
      changed: sitemap.changed.length,
      unchanged: sitemap.unchangedCount,
    },
    forms: {
      added: forms.added.length,
      removed: forms.removed.length,
      changed: forms.changed.length,
      unchanged: forms.unchangedCount,
    },
    api: {
      added: api.added.length,
      removed: api.removed.length,
      changed: api.changed.length,
      unchanged: api.unchangedCount,
    },
    screenshots: {
      added: screenshots.added.length,
      removed: screenshots.removed.length,
      changed: screenshots.changed.length,
      unchanged: screenshots.unchangedCount,
    },
  };

  const hasChanges =
    summary.routes.added + summary.routes.removed + summary.routes.changed +
    summary.forms.added + summary.forms.removed + summary.forms.changed +
    summary.api.added + summary.api.removed + summary.api.changed +
    summary.screenshots.added + summary.screenshots.removed + summary.screenshots.changed > 0;

  return {
    meta: {
      oldBundle: {
        path: oldDir,
        createdAt: oldManifest.createdAt,
        targetUrl: oldManifest.config.targetUrl,
        toolVersion: oldManifest.toolVersion,
      },
      newBundle: {
        path: newDir,
        createdAt: newManifest.createdAt,
        targetUrl: newManifest.config.targetUrl,
        toolVersion: newManifest.toolVersion,
      },
      comparedAt: new Date().toISOString(),
    },
    hasChanges,
    sitemap,
    forms,
    api,
    screenshots,
    summary,
  };
}
