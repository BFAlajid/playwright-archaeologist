/**
 * Unit tests for src/diff/diff-engine.ts
 *
 * Tests the diff engine: route, form, API, and screenshot diffing.
 * Uses real temp directories with JSON fixtures.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, writeFile, mkdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { diffBundles } from '../../src/diff/diff-engine.js';
import type {
  BundleManifest,
  RouteInfo,
  FormInfo,
  ApiEndpointGroup,
} from '../../src/types/artifacts.js';

let testDir: string;
let oldDir: string;
let newDir: string;

/** Create a minimal valid manifest. */
function makeManifest(overrides?: Partial<BundleManifest>): BundleManifest {
  return {
    version: 1,
    tool: 'playwright-archaeologist',
    toolVersion: '0.1.0',
    createdAt: '2025-01-01T00:00:00.000Z',
    config: {
      targetUrl: 'https://example.com',
      depth: 3,
      viewport: { width: 1280, height: 720 },
      concurrency: 1,
      maxPages: 100,
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

/** Create a minimal RouteInfo. */
function makeRoute(url: string, overrides?: Partial<RouteInfo>): RouteInfo {
  return {
    url,
    title: url,
    statusCode: 200,
    contentHash: 'hash-' + url,
    depth: 0,
    formCount: 0,
    apiCallCount: 0,
    hasScreenshot: false,
    discoveryMethod: 'entry' as const,
    ...overrides,
  };
}

/** Create a minimal FormInfo. */
function makeForm(action: string, method: string, fields: Array<{ name: string; type: string; required: boolean }>): FormInfo {
  return {
    action,
    method,
    isImplicit: false,
    fields: fields.map((f) => ({
      ...f,
      pattern: undefined,
      placeholder: undefined,
      label: undefined,
    })),
    validationMessages: [],
    wasHidden: false,
  };
}

/** Create a minimal ApiEndpointGroup. */
function makeApiEndpoint(
  method: string,
  pattern: string,
  overrides?: Partial<ApiEndpointGroup>,
): ApiEndpointGroup {
  return {
    method,
    pattern,
    classification: 'api' as const,
    observedUrls: [],
    callCount: 1,
    callingPages: [],
    exampleRequest: { url: pattern, headers: {} },
    exampleResponse: {
      statusCode: 200,
      headers: {},
      bodySize: 100,
    },
    observedStatusCodes: [200],
    observedContentTypes: ['application/json'],
    isGraphQL: false,
    ...overrides,
  };
}

/** Write a bundle directory with manifest and data files. */
async function writeBundle(
  dir: string,
  manifest: BundleManifest,
  data: {
    sitemap?: RouteInfo[];
    forms?: FormInfo[];
    apiMap?: ApiEndpointGroup[];
  } = {},
): Promise<void> {
  await mkdir(join(dir, 'data'), { recursive: true });
  await mkdir(join(dir, 'screenshots'), { recursive: true });
  await writeFile(join(dir, 'manifest.json'), JSON.stringify(manifest));
  if (data.sitemap) {
    await writeFile(join(dir, 'data', 'sitemap.json'), JSON.stringify(data.sitemap));
  }
  if (data.forms) {
    await writeFile(join(dir, 'data', 'forms.json'), JSON.stringify(data.forms));
  }
  if (data.apiMap) {
    await writeFile(join(dir, 'data', 'api-map.json'), JSON.stringify(data.apiMap));
  }
}

beforeEach(async () => {
  testDir = await mkdtemp(join(tmpdir(), 'pa-diff-test-'));
  oldDir = join(testDir, 'old');
  newDir = join(testDir, 'new');
});

afterEach(async () => {
  await rm(testDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Route diffing
// ---------------------------------------------------------------------------

describe('route diffing', () => {
  it('detects added routes', async () => {
    await writeBundle(oldDir, makeManifest(), {
      sitemap: [makeRoute('https://example.com/')],
    });
    await writeBundle(newDir, makeManifest(), {
      sitemap: [
        makeRoute('https://example.com/'),
        makeRoute('https://example.com/about'),
      ],
    });

    const result = await diffBundles(oldDir, newDir);

    expect(result.sitemap.added).toHaveLength(1);
    expect(result.sitemap.added[0].url).toBe('https://example.com/about');
    expect(result.summary.routes.added).toBe(1);
  });

  it('detects removed routes', async () => {
    await writeBundle(oldDir, makeManifest(), {
      sitemap: [
        makeRoute('https://example.com/'),
        makeRoute('https://example.com/old-page'),
      ],
    });
    await writeBundle(newDir, makeManifest(), {
      sitemap: [makeRoute('https://example.com/')],
    });

    const result = await diffBundles(oldDir, newDir);

    expect(result.sitemap.removed).toHaveLength(1);
    expect(result.sitemap.removed[0].url).toBe('https://example.com/old-page');
    expect(result.summary.routes.removed).toBe(1);
  });

  it('detects modified routes (content hash changed)', async () => {
    await writeBundle(oldDir, makeManifest(), {
      sitemap: [makeRoute('https://example.com/', { contentHash: 'old-hash' })],
    });
    await writeBundle(newDir, makeManifest(), {
      sitemap: [makeRoute('https://example.com/', { contentHash: 'new-hash' })],
    });

    const result = await diffBundles(oldDir, newDir);

    expect(result.sitemap.changed).toHaveLength(1);
    expect(result.sitemap.changed[0].url).toBe('https://example.com/');
    expect(result.sitemap.changed[0].changes.contentHash).toEqual({
      old: 'old-hash',
      new: 'new-hash',
    });
    expect(result.summary.routes.changed).toBe(1);
  });

  it('detects title changes in routes', async () => {
    await writeBundle(oldDir, makeManifest(), {
      sitemap: [makeRoute('https://example.com/', { title: 'Old Title' })],
    });
    await writeBundle(newDir, makeManifest(), {
      sitemap: [makeRoute('https://example.com/', { title: 'New Title' })],
    });

    const result = await diffBundles(oldDir, newDir);

    expect(result.sitemap.changed).toHaveLength(1);
    expect(result.sitemap.changed[0].changes.title).toEqual({
      old: 'Old Title',
      new: 'New Title',
    });
  });

  it('detects status code changes in routes', async () => {
    await writeBundle(oldDir, makeManifest(), {
      sitemap: [makeRoute('https://example.com/', { statusCode: 200 })],
    });
    await writeBundle(newDir, makeManifest(), {
      sitemap: [makeRoute('https://example.com/', { statusCode: 301 })],
    });

    const result = await diffBundles(oldDir, newDir);

    expect(result.sitemap.changed).toHaveLength(1);
    expect(result.sitemap.changed[0].changes.statusCode).toEqual({
      old: 200,
      new: 301,
    });
  });
});

// ---------------------------------------------------------------------------
// Form diffing
// ---------------------------------------------------------------------------

describe('form diffing', () => {
  it('detects added forms', async () => {
    await writeBundle(oldDir, makeManifest(), { forms: [] });
    await writeBundle(newDir, makeManifest(), {
      forms: [makeForm('/login', 'POST', [{ name: 'email', type: 'email', required: true }])],
    });

    const result = await diffBundles(oldDir, newDir);

    expect(result.forms.added).toHaveLength(1);
    expect(result.forms.added[0].action).toBe('/login');
    expect(result.summary.forms.added).toBe(1);
  });

  it('detects removed forms', async () => {
    await writeBundle(oldDir, makeManifest(), {
      forms: [makeForm('/register', 'POST', [{ name: 'name', type: 'text', required: true }])],
    });
    await writeBundle(newDir, makeManifest(), { forms: [] });

    const result = await diffBundles(oldDir, newDir);

    expect(result.forms.removed).toHaveLength(1);
    expect(result.forms.removed[0].action).toBe('/register');
    expect(result.summary.forms.removed).toBe(1);
  });

  it('detects modified form fields', async () => {
    await writeBundle(oldDir, makeManifest(), {
      forms: [makeForm('/login', 'POST', [
        { name: 'email', type: 'email', required: true },
      ])],
    });
    await writeBundle(newDir, makeManifest(), {
      forms: [makeForm('/login', 'POST', [
        { name: 'email', type: 'email', required: true },
        { name: 'password', type: 'password', required: true },
      ])],
    });

    const result = await diffBundles(oldDir, newDir);

    expect(result.forms.changed).toHaveLength(1);
    expect(result.forms.changed[0].changes.fieldsAdded).toHaveLength(1);
    expect(result.forms.changed[0].changes.fieldsAdded![0].name).toBe('password');
  });
});

// ---------------------------------------------------------------------------
// API endpoint diffing
// ---------------------------------------------------------------------------

describe('API endpoint diffing', () => {
  it('detects added API endpoints', async () => {
    await writeBundle(oldDir, makeManifest(), { apiMap: [] });
    await writeBundle(newDir, makeManifest(), {
      apiMap: [makeApiEndpoint('GET', '/api/users')],
    });

    const result = await diffBundles(oldDir, newDir);

    expect(result.api.added).toHaveLength(1);
    expect(result.api.added[0].pattern).toBe('/api/users');
    expect(result.summary.api.added).toBe(1);
  });

  it('detects removed API endpoints', async () => {
    await writeBundle(oldDir, makeManifest(), {
      apiMap: [makeApiEndpoint('DELETE', '/api/users/:id')],
    });
    await writeBundle(newDir, makeManifest(), { apiMap: [] });

    const result = await diffBundles(oldDir, newDir);

    expect(result.api.removed).toHaveLength(1);
    expect(result.api.removed[0].pattern).toBe('/api/users/:id');
    expect(result.summary.api.removed).toBe(1);
  });

  it('detects modified API endpoints (status codes changed)', async () => {
    await writeBundle(oldDir, makeManifest(), {
      apiMap: [makeApiEndpoint('GET', '/api/users', { observedStatusCodes: [200] })],
    });
    await writeBundle(newDir, makeManifest(), {
      apiMap: [makeApiEndpoint('GET', '/api/users', { observedStatusCodes: [200, 404] })],
    });

    const result = await diffBundles(oldDir, newDir);

    expect(result.api.changed).toHaveLength(1);
    expect(result.api.changed[0].changes.statusCodesAdded).toEqual([404]);
  });

  it('detects API content type changes', async () => {
    await writeBundle(oldDir, makeManifest(), {
      apiMap: [makeApiEndpoint('GET', '/api/data', { observedContentTypes: ['application/json'] })],
    });
    await writeBundle(newDir, makeManifest(), {
      apiMap: [makeApiEndpoint('GET', '/api/data', { observedContentTypes: ['text/xml'] })],
    });

    const result = await diffBundles(oldDir, newDir);

    expect(result.api.changed).toHaveLength(1);
    expect(result.api.changed[0].changes.contentTypeChanged).toEqual({
      old: 'application/json',
      new: 'text/xml',
    });
  });
});

// ---------------------------------------------------------------------------
// Screenshot diffing
// ---------------------------------------------------------------------------

describe('screenshot diffing', () => {
  it('detects changed screenshots (different hash)', async () => {
    const oldManifest = makeManifest({
      files: [
        { path: 'screenshots/home.png', sha256: 'aaaa', size: 100, type: 'screenshot' },
      ],
    });
    const newManifest = makeManifest({
      files: [
        { path: 'screenshots/home.png', sha256: 'bbbb', size: 100, type: 'screenshot' },
      ],
    });

    await writeBundle(oldDir, oldManifest);
    await writeBundle(newDir, newManifest);

    const result = await diffBundles(oldDir, newDir);

    expect(result.screenshots.changed).toHaveLength(1);
    expect(result.screenshots.changed[0].diffPercentage).toBe(100);
    expect(result.summary.screenshots.changed).toBe(1);
  });

  it('detects added screenshots', async () => {
    await writeBundle(oldDir, makeManifest({ files: [] }));
    await writeBundle(newDir, makeManifest({
      files: [
        { path: 'screenshots/new-page.png', sha256: 'cccc', size: 100, type: 'screenshot' },
      ],
    }));

    const result = await diffBundles(oldDir, newDir);

    expect(result.screenshots.added).toHaveLength(1);
    expect(result.summary.screenshots.added).toBe(1);
  });

  it('detects removed screenshots', async () => {
    await writeBundle(oldDir, makeManifest({
      files: [
        { path: 'screenshots/old-page.png', sha256: 'dddd', size: 100, type: 'screenshot' },
      ],
    }));
    await writeBundle(newDir, makeManifest({ files: [] }));

    const result = await diffBundles(oldDir, newDir);

    expect(result.screenshots.removed).toHaveLength(1);
    expect(result.summary.screenshots.removed).toBe(1);
  });

  it('reports unchanged screenshots correctly', async () => {
    const files = [
      { path: 'screenshots/home.png', sha256: 'same-hash', size: 100, type: 'screenshot' as const },
    ];
    await writeBundle(oldDir, makeManifest({ files }));
    await writeBundle(newDir, makeManifest({ files }));

    const result = await diffBundles(oldDir, newDir);

    expect(result.screenshots.changed).toHaveLength(0);
    expect(result.screenshots.unchangedCount).toBe(1);
    expect(result.summary.screenshots.unchanged).toBe(1);
  });

  it('emits a pixel-accurate diffPercentage and heatmap when PNGs exist', async () => {
    const { PNG } = await import('pngjs');
    const makePng = (width: number, height: number, rgba: [number, number, number, number]): Buffer => {
      const png = new PNG({ width, height });
      const [r, g, b, a] = rgba;
      for (let i = 0; i < png.data.length; i += 4) {
        png.data[i] = r;
        png.data[i + 1] = g;
        png.data[i + 2] = b;
        png.data[i + 3] = a;
      }
      return PNG.sync.write(png);
    };

    const files = [
      { path: 'screenshots/home.png', sha256: 'aaaa', size: 100, type: 'screenshot' as const },
    ];
    await writeBundle(oldDir, makeManifest({ files }));
    await writeBundle(newDir, makeManifest({
      files: [{ path: 'screenshots/home.png', sha256: 'bbbb', size: 100, type: 'screenshot' }],
    }));

    await writeFile(join(oldDir, 'screenshots', 'home.png'), makePng(8, 8, [255, 0, 0, 255]));
    await writeFile(join(newDir, 'screenshots', 'home.png'), makePng(8, 8, [0, 0, 255, 255]));

    const heatmapDir = join(testDir, 'heatmaps');
    const result = await diffBundles(oldDir, newDir, { heatmapDir });

    expect(result.screenshots.changed).toHaveLength(1);
    const change = result.screenshots.changed[0];
    expect(change.diffPercentage).toBeGreaterThan(0);
    expect(change.diffPercentage).toBeLessThanOrEqual(100);
    expect(change.diffPixelCount).toBeGreaterThan(0);
    expect(change.totalPixels).toBe(64);
    expect(change.heatmapPath).toBeDefined();
    expect(change.heatmapPath!.startsWith(heatmapDir)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Identical bundles
// ---------------------------------------------------------------------------

describe('identical bundles', () => {
  it('reports zero changes for identical bundles', async () => {
    const routes = [makeRoute('https://example.com/')];
    const forms = [makeForm('/search', 'GET', [{ name: 'q', type: 'text', required: false }])];
    const apiMap = [makeApiEndpoint('GET', '/api/search')];
    const files = [
      { path: 'screenshots/home.png', sha256: 'identical-hash', size: 50, type: 'screenshot' as const },
    ];

    await writeBundle(oldDir, makeManifest({ files }), { sitemap: routes, forms, apiMap });
    await writeBundle(newDir, makeManifest({ files }), { sitemap: routes, forms, apiMap });

    const result = await diffBundles(oldDir, newDir);

    expect(result.hasChanges).toBe(false);
    expect(result.summary.routes.added).toBe(0);
    expect(result.summary.routes.removed).toBe(0);
    expect(result.summary.routes.changed).toBe(0);
    expect(result.summary.routes.unchanged).toBe(1);
    expect(result.summary.forms.unchanged).toBe(1);
    expect(result.summary.api.unchanged).toBe(1);
    expect(result.summary.screenshots.unchanged).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Summary counts
// ---------------------------------------------------------------------------

describe('summary counts', () => {
  it('generates correct summary counts for mixed changes', async () => {
    await writeBundle(oldDir, makeManifest(), {
      sitemap: [
        makeRoute('https://example.com/'),
        makeRoute('https://example.com/removed'),
        makeRoute('https://example.com/changed', { contentHash: 'old' }),
      ],
      forms: [
        makeForm('/old-form', 'POST', [{ name: 'x', type: 'text', required: false }]),
      ],
      apiMap: [
        makeApiEndpoint('GET', '/api/old'),
      ],
    });
    await writeBundle(newDir, makeManifest(), {
      sitemap: [
        makeRoute('https://example.com/'),
        makeRoute('https://example.com/new-page'),
        makeRoute('https://example.com/changed', { contentHash: 'new' }),
      ],
      forms: [
        makeForm('/new-form', 'POST', [{ name: 'y', type: 'text', required: false }]),
      ],
      apiMap: [
        makeApiEndpoint('POST', '/api/new'),
      ],
    });

    const result = await diffBundles(oldDir, newDir);

    expect(result.hasChanges).toBe(true);

    // Routes: 1 unchanged, 1 added, 1 removed, 1 changed
    expect(result.summary.routes.unchanged).toBe(1);
    expect(result.summary.routes.added).toBe(1);
    expect(result.summary.routes.removed).toBe(1);
    expect(result.summary.routes.changed).toBe(1);

    // Forms: 1 added, 1 removed
    expect(result.summary.forms.added).toBe(1);
    expect(result.summary.forms.removed).toBe(1);

    // API: 1 added, 1 removed
    expect(result.summary.api.added).toBe(1);
    expect(result.summary.api.removed).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Error handling
// ---------------------------------------------------------------------------

describe('error handling', () => {
  it('throws DiffError when manifest is missing', async () => {
    await mkdir(oldDir, { recursive: true });
    await writeBundle(newDir, makeManifest());

    await expect(diffBundles(oldDir, newDir)).rejects.toThrow(
      /Could not load manifest\.json/,
    );
  });

  it('handles missing data files gracefully', async () => {
    // Bundles with manifest but no data files
    await writeBundle(oldDir, makeManifest());
    await writeBundle(newDir, makeManifest());

    const result = await diffBundles(oldDir, newDir);

    expect(result.hasChanges).toBe(false);
    expect(result.summary.routes.unchanged).toBe(0);
  });

  it('populates meta section correctly', async () => {
    const oldManifest = makeManifest({
      createdAt: '2025-01-01T00:00:00.000Z',
      config: {
        targetUrl: 'https://old.example.com',
        depth: 3,
        viewport: { width: 1280, height: 720 },
        concurrency: 1,
        maxPages: 100,
        followExternal: false,
        deepClick: false,
      },
    });
    const newManifest = makeManifest({
      createdAt: '2025-02-01T00:00:00.000Z',
      config: {
        targetUrl: 'https://new.example.com',
        depth: 3,
        viewport: { width: 1280, height: 720 },
        concurrency: 1,
        maxPages: 100,
        followExternal: false,
        deepClick: false,
      },
    });

    await writeBundle(oldDir, oldManifest);
    await writeBundle(newDir, newManifest);

    const result = await diffBundles(oldDir, newDir);

    expect(result.meta.oldBundle.targetUrl).toBe('https://old.example.com');
    expect(result.meta.newBundle.targetUrl).toBe('https://new.example.com');
    expect(result.meta.oldBundle.createdAt).toBe('2025-01-01T00:00:00.000Z');
    expect(result.meta.comparedAt).toBeTruthy();
  });
});
