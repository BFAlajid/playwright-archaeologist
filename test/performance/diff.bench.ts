/**
 * Performance benchmarks for the diff engine.
 *
 * Exercises the real shipped modules:
 *   - diffBundles (end-to-end bundle comparison: manifest load + route /
 *     form / API diff + screenshot hash + pixel-diff fan-out)
 *   - diffScreenshotPair (pixelmatch-backed pixel-level screenshot diff)
 *
 * Temp bundle directories are built per run via mkdtempSync. Screenshots
 * are generated in-memory via pngjs so the bench is offline and
 * deterministic. Cleanup happens inside the bench (mkdir is cheap
 * compared to the work being measured, and this keeps the bench
 * self-contained).
 *
 * Run: npx vitest bench test/performance/diff.bench.ts
 */

import { bench, describe } from 'vitest';
import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PNG } from 'pngjs';
import pixelmatch from 'pixelmatch';
import { diffBundles } from '../../src/diff/diff-engine.js';
import { diffScreenshotPair } from '../../src/diff/screenshot-diff.js';
import type {
  BundleManifest,
  RouteInfo,
  FormInfo,
  ApiEndpointGroup,
} from '../../src/types/artifacts.js';

// ---------------------------------------------------------------------------
// Synthetic bundle content generators
// ---------------------------------------------------------------------------

function makeManifest(overrides?: Partial<BundleManifest>): BundleManifest {
  return {
    version: 1,
    tool: 'playwright-archaeologist',
    toolVersion: '0.2.0',
    createdAt: '2026-04-20T00:00:00.000Z',
    config: {
      targetUrl: 'https://example.com',
      depth: 3,
      viewport: { width: 1280, height: 720 },
      concurrency: 3,
      maxPages: 500,
      followExternal: false,
      deepClick: false,
    },
    stats: {
      pagesVisited: 0,
      formsFound: 0,
      apiEndpoints: 0,
      screenshotCount: 0,
      duration: 0,
    },
    files: [],
    ...overrides,
  };
}

function generateRoutes(count: number, startHash = 'a'): RouteInfo[] {
  const routes: RouteInfo[] = [];
  for (let i = 0; i < count; i++) {
    routes.push({
      url: `https://example.com/section-${i % 10}/page-${i}`,
      title: `Page ${i}`,
      statusCode: 200,
      contentHash: `${startHash}-hash-${i}`,
      depth: 1 + (i % 4),
      formCount: i % 5 === 0 ? 1 : 0,
      apiCallCount: 2 + (i % 5),
      hasScreenshot: true,
      discoveryMethod: i === 0 ? 'entry' : 'link',
    });
  }
  return routes;
}

function generateForms(count: number): FormInfo[] {
  const forms: FormInfo[] = [];
  for (let i = 0; i < count; i++) {
    forms.push({
      action: `/api/form-${i}`,
      method: i % 3 === 0 ? 'GET' : 'POST',
      isImplicit: false,
      fields: [
        { name: `field_${i}_name`, type: 'text', required: true },
        { name: `field_${i}_email`, type: 'email', required: true },
        { name: `field_${i}_note`, type: 'text', required: false },
      ],
      validationMessages: [],
      wasHidden: false,
    });
  }
  return forms;
}

function generateApiEndpoints(count: number): ApiEndpointGroup[] {
  const endpoints: ApiEndpointGroup[] = [];
  const methods = ['GET', 'POST', 'PUT', 'DELETE', 'PATCH'] as const;
  for (let i = 0; i < count; i++) {
    const method = methods[i % methods.length];
    endpoints.push({
      method,
      pattern: `/api/v2/resource-${i % 50}/:id`,
      classification: 'api',
      observedUrls: [`https://example.com/api/v2/resource-${i % 50}/${i}`],
      callCount: 1 + (i % 3),
      callingPages: [`https://example.com/section-${i % 10}/page-${i}`],
      exampleRequest: {
        url: `https://example.com/api/v2/resource-${i % 50}/${i}`,
        headers: { 'content-type': 'application/json' },
        contentType: 'application/json',
      },
      exampleResponse: {
        statusCode: method === 'DELETE' ? 204 : 200,
        headers: { 'content-type': 'application/json' },
        contentType: 'application/json',
        bodySize: 500 + (i % 200),
      },
      observedStatusCodes: [method === 'DELETE' ? 204 : 200],
      observedContentTypes: ['application/json'],
      isGraphQL: false,
    });
  }
  return endpoints;
}

/**
 * Mutate a subset of routes so diffBundles sees content-hash changes,
 * plus add some new routes and drop some. Produces a realistic 10%-changed
 * "new" bundle state from an "old" baseline.
 */
function mutateRoutes(original: RouteInfo[], changePercent: number): RouteInfo[] {
  const mutated = original.map((r) => ({ ...r }));
  const changeCount = Math.floor(mutated.length * (changePercent / 100));

  for (let i = 0; i < changeCount; i++) {
    mutated[i].contentHash = `b-hash-${i}-modified`;
    if (i % 3 === 0) mutated[i].title = `${mutated[i].title} (updated)`;
  }

  // Drop the last few — realistic "removed routes" signal.
  const removed = Math.floor(changeCount * 0.1);
  for (let i = 0; i < removed; i++) mutated.pop();

  // Add a handful of new routes at the end.
  const added = Math.floor(changeCount * 0.2);
  for (let i = 0; i < added; i++) {
    mutated.push({
      url: `https://example.com/new-section/new-page-${i}`,
      title: `New Page ${i}`,
      statusCode: 200,
      contentHash: `new-hash-${i}`,
      depth: 2,
      formCount: 0,
      apiCallCount: 1,
      hasScreenshot: false,
      discoveryMethod: 'link',
    });
  }
  return mutated;
}

// ---------------------------------------------------------------------------
// Bundle directory writer
// ---------------------------------------------------------------------------

/**
 * Synchronously write a bundle directory. Synchronous I/O keeps the bench
 * body free of `await`, which Vitest bench does not support cleanly.
 */
function writeBundleSync(
  dir: string,
  manifest: BundleManifest,
  data: {
    sitemap?: RouteInfo[];
    forms?: FormInfo[];
    apiMap?: ApiEndpointGroup[];
  },
): void {
  mkdirSync(join(dir, 'data'), { recursive: true });
  mkdirSync(join(dir, 'screenshots'), { recursive: true });
  writeFileSync(join(dir, 'manifest.json'), JSON.stringify(manifest));
  if (data.sitemap) {
    writeFileSync(join(dir, 'data', 'sitemap.json'), JSON.stringify(data.sitemap));
  }
  if (data.forms) {
    writeFileSync(join(dir, 'data', 'forms.json'), JSON.stringify(data.forms));
  }
  if (data.apiMap) {
    writeFileSync(join(dir, 'data', 'api-map.json'), JSON.stringify(data.apiMap));
  }
}

// ---------------------------------------------------------------------------
// PNG helpers
// ---------------------------------------------------------------------------

/**
 * Build a solid-colour PNG. Deterministic for a given (width, height, rgba).
 */
function makePng(
  width: number,
  height: number,
  rgba: [number, number, number, number],
): Buffer {
  const png = new PNG({ width, height });
  const [r, g, b, a] = rgba;
  for (let i = 0; i < png.data.length; i += 4) {
    png.data[i] = r;
    png.data[i + 1] = g;
    png.data[i + 2] = b;
    png.data[i + 3] = a;
  }
  return PNG.sync.write(png);
}

/**
 * Build a PNG that differs from the solid-colour baseline in a small
 * rectangular region. Used to produce a realistic (non-zero, <100%)
 * pixel-diff result.
 */
function makePngWithPatch(
  width: number,
  height: number,
  base: [number, number, number, number],
  patch: [number, number, number, number],
  patchWidth: number,
  patchHeight: number,
): Buffer {
  const png = new PNG({ width, height });
  const [br, bg, bb, ba] = base;
  const [pr, pg, pb, pa] = patch;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const idx = (y * width + x) * 4;
      const inPatch = x < patchWidth && y < patchHeight;
      png.data[idx] = inPatch ? pr : br;
      png.data[idx + 1] = inPatch ? pg : bg;
      png.data[idx + 2] = inPatch ? pb : bb;
      png.data[idx + 3] = inPatch ? pa : ba;
    }
  }
  return PNG.sync.write(png);
}

// ---------------------------------------------------------------------------
// Pre-generated bundle content (generated once; reused across iterations)
// ---------------------------------------------------------------------------

const oldRoutes100 = generateRoutes(100, 'a');
const newRoutes100 = mutateRoutes(oldRoutes100, 10);
const oldForms100 = generateForms(30);
const newForms100 = generateForms(30); // same — forms diff will be noop
const oldApi100 = generateApiEndpoints(300);
const newApi100 = generateApiEndpoints(300);

const oldRoutes500 = generateRoutes(500, 'a');
const newRoutes500 = mutateRoutes(oldRoutes500, 10);
const oldForms500 = generateForms(150);
const newForms500 = generateForms(150);
const oldApi500 = generateApiEndpoints(1500);
const newApi500 = generateApiEndpoints(1500);

// Pre-serialize PNG fixtures so each bench iteration doesn't re-encode.
const small100x100Red = makePng(100, 100, [255, 0, 0, 255]);
const small100x100Patch = makePngWithPatch(
  100, 100,
  [255, 0, 0, 255],
  [0, 0, 255, 255],
  10, 10, // 10x10 patch = 1% of 100x100
);
const large1000x1000Red = makePng(1000, 1000, [255, 0, 0, 255]);
const large1000x1000Patch = makePngWithPatch(
  1000, 1000,
  [255, 0, 0, 255],
  [0, 0, 255, 255],
  100, 100, // 100x100 patch = 1% of 1000x1000
);

// ---------------------------------------------------------------------------
// diffBundles (full-pipeline, real module)
// ---------------------------------------------------------------------------

describe('diffBundles (end-to-end bundle comparison)', () => {
  // Note: we create the bundle dirs *inside* the bench so the hot path
  // includes the fs work. This is representative of the production diff
  // call, which opens a bundle fresh from disk.

  bench('diffTotal100Pages: diffBundles on pre-built 100-page bundles', async () => {
    const tmp = mkdtempSync(join(tmpdir(), 'pa-diff-bench-100-'));
    try {
      const oldDir = join(tmp, 'old');
      const newDir = join(tmp, 'new');
      writeBundleSync(oldDir, makeManifest(), {
        sitemap: oldRoutes100,
        forms: oldForms100,
        apiMap: oldApi100,
      });
      writeBundleSync(newDir, makeManifest(), {
        sitemap: newRoutes100,
        forms: newForms100,
        apiMap: newApi100,
      });
      await diffBundles(oldDir, newDir);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  bench('diffTotal500Pages: diffBundles on pre-built 500-page bundles', async () => {
    const tmp = mkdtempSync(join(tmpdir(), 'pa-diff-bench-500-'));
    try {
      const oldDir = join(tmp, 'old');
      const newDir = join(tmp, 'new');
      writeBundleSync(oldDir, makeManifest(), {
        sitemap: oldRoutes500,
        forms: oldForms500,
        apiMap: oldApi500,
      });
      writeBundleSync(newDir, makeManifest(), {
        sitemap: newRoutes500,
        forms: newForms500,
        apiMap: newApi500,
      });
      await diffBundles(oldDir, newDir);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// diffScreenshotPair (pixelmatch-backed pixel diff, real module)
// ---------------------------------------------------------------------------

describe('diffScreenshotPair (pixelmatch-backed)', () => {
  bench('pixelDiff100x100: one 100x100 pair with a 1% patch, no heatmap', async () => {
    const tmp = mkdtempSync(join(tmpdir(), 'pa-ssdiff-bench-sm-'));
    try {
      const oldPath = join(tmp, 'old.png');
      const newPath = join(tmp, 'new.png');
      writeFileSync(oldPath, small100x100Red);
      writeFileSync(newPath, small100x100Patch);
      await diffScreenshotPair(oldPath, newPath);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  bench('pixelDiff1000x1000: one 1000x1000 pair with a 1% patch + heatmap emit', async () => {
    const tmp = mkdtempSync(join(tmpdir(), 'pa-ssdiff-bench-lg-'));
    try {
      const oldPath = join(tmp, 'old.png');
      const newPath = join(tmp, 'new.png');
      const heatmapPath = join(tmp, 'heatmap.png');
      writeFileSync(oldPath, large1000x1000Red);
      writeFileSync(newPath, large1000x1000Patch);
      await diffScreenshotPair(oldPath, newPath, { emitHeatmapTo: heatmapPath });
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});

// Silence unused-import lint warning: pixelmatch is re-exported via the
// screenshot-diff module we exercise above. We keep the import visible so
// that a reader sees the bench is measuring pixelmatch through its real
// call site rather than calling it directly.
void pixelmatch;
