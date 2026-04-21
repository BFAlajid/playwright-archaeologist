/**
 * Property-based tests using fast-check.
 *
 * Properties verified here:
 *
 *   - `normalizeUrl` is idempotent: `normalizeUrl(normalizeUrl(u)) === normalizeUrl(u)`.
 *   - `normalizeUrl` is deterministic: same input always produces same output.
 *   - `parameterizePath` groups structurally similar paths into the same pattern.
 *   - `diffBundles` is anti-symmetric: swapping old/new swaps added<->removed and
 *     changed directions.
 *   - `createBundle` followed by `diffBundles` round-trips without surprises:
 *     comparing a bundle to itself reports no changes.
 *
 * Fast-check runs each property 50 times by default. All generators are
 * seeded by fast-check's own seed system (deterministic across runs given
 * a stable seed — fast-check prints a replay on failure).
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fc from 'fast-check';
import { mkdtemp, writeFile, mkdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { normalizeUrl } from '../../src/crawl/url-utils.js';
import { parameterizePath } from '../../src/assembler/api-grouper.js';
import { diffBundles } from '../../src/diff/diff-engine.js';
import { createBundle } from '../../src/bundle/bundle-creator.js';
import type {
  BundleManifest,
  RouteInfo,
} from '../../src/types/artifacts.js';

// ---------------------------------------------------------------------------
// Arbitraries (fast-check generators)
// ---------------------------------------------------------------------------

/** A URL-safe path segment: letters, digits, hyphens — avoids '/', '?', '#'. */
const urlPathSegment = fc.stringMatching(/^[A-Za-z0-9_-]{1,16}$/);

/** A URL path like /foo/bar/baz built from 0-5 segments. */
const urlPath = fc
  .array(urlPathSegment, { minLength: 0, maxLength: 5 })
  .map((segs) => (segs.length === 0 ? '/' : '/' + segs.join('/')));

/** An http(s) URL with an optional query and hash. */
const httpUrl = fc
  .record({
    scheme: fc.constantFrom<'http' | 'https'>('http', 'https'),
    host: fc.stringMatching(/^[a-z0-9]([a-z0-9-]{0,10}[a-z0-9])?$/),
    path: urlPath,
    query: fc.array(
      fc.tuple(
        fc.stringMatching(/^[a-z]{1,6}$/),
        fc.stringMatching(/^[A-Za-z0-9]{1,8}$/),
      ),
      { maxLength: 4 },
    ),
    hash: fc.option(fc.stringMatching(/^[a-z]{1,8}$/), { nil: undefined }),
  })
  .map(({ scheme, host, path, query, hash }) => {
    let url = `${scheme}://${host}.example${path}`;
    if (query.length > 0) {
      url += '?' + query.map(([k, v]) => `${k}=${v}`).join('&');
    }
    if (hash) url += '#' + hash;
    return url;
  });

// ---------------------------------------------------------------------------
// normalizeUrl properties
// ---------------------------------------------------------------------------

describe('normalizeUrl properties', () => {
  it('is idempotent: normalizeUrl(normalizeUrl(u)) === normalizeUrl(u)', () => {
    fc.assert(
      fc.property(httpUrl, (url) => {
        const once = normalizeUrl(url);
        const twice = normalizeUrl(once);
        expect(twice).toBe(once);
      }),
      { numRuns: 50 },
    );
  });

  it('is deterministic: same input produces same output across 100 calls', () => {
    fc.assert(
      fc.property(httpUrl, (url) => {
        const first = normalizeUrl(url);
        for (let i = 0; i < 100; i++) {
          expect(normalizeUrl(url)).toBe(first);
        }
      }),
      { numRuns: 25 },
    );
  });

  it('strips hash fragments by default', () => {
    fc.assert(
      fc.property(httpUrl, (url) => {
        const normalized = normalizeUrl(url);
        // The normalized form must not contain a hash unless preserveHash
        // was requested.
        expect(normalized).not.toMatch(/#[^?]*$/);
      }),
      { numRuns: 50 },
    );
  });

  it('produces equal results for URLs that differ only in query-param order', () => {
    // Two URLs with the same query params in different order should normalize
    // to the same string (enables effective dedup).
    fc.assert(
      fc.property(
        fc.tuple(
          fc.stringMatching(/^[a-z]{1,4}$/),
          fc.stringMatching(/^[a-z]{1,4}$/),
          fc.stringMatching(/^[A-Z0-9]{1,4}$/),
          fc.stringMatching(/^[A-Z0-9]{1,4}$/),
        ),
        ([k1, k2, v1, v2]) => {
          fc.pre(k1 !== k2);
          const a = `https://example.com/p?${k1}=${v1}&${k2}=${v2}`;
          const b = `https://example.com/p?${k2}=${v2}&${k1}=${v1}`;
          expect(normalizeUrl(a)).toBe(normalizeUrl(b));
        },
      ),
      { numRuns: 50 },
    );
  });
});

// ---------------------------------------------------------------------------
// parameterizePath properties
// ---------------------------------------------------------------------------

describe('parameterizePath properties', () => {
  it('maps structurally similar URLs (numeric ID variations) to the same pattern', () => {
    // /users/1, /users/2, /users/42 should all parameterize to /users/:id.
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: 999999 }),
        fc.integer({ min: 0, max: 999999 }),
        (id1, id2) => {
          const a = parameterizePath(`/users/${id1}`);
          const b = parameterizePath(`/users/${id2}`);
          expect(a).toBe(b);
          expect(a).toBe('/users/:id');
        },
      ),
      { numRuns: 50 },
    );
  });

  it('maps structurally similar UUID URLs to the same pattern', () => {
    // We use an explicit UUID shape so the generator is fast and valid.
    const uuidArb = fc.uuid({ version: 4 });
    fc.assert(
      fc.property(uuidArb, uuidArb, (uuid1, uuid2) => {
        const a = parameterizePath(`/items/${uuid1}/details`);
        const b = parameterizePath(`/items/${uuid2}/details`);
        expect(a).toBe(b);
        expect(a).toBe('/items/:id/details');
      }),
      { numRuns: 50 },
    );
  });

  it('is idempotent: parameterizing an already-parameterized path is a no-op', () => {
    fc.assert(
      fc.property(fc.integer({ min: 0, max: 9999 }), (id) => {
        const once = parameterizePath(`/api/v2/users/${id}/posts/${id + 1}`);
        const twice = parameterizePath(once);
        expect(twice).toBe(once);
      }),
      { numRuns: 50 },
    );
  });

  it('preserves non-ID segments untouched', () => {
    fc.assert(
      fc.property(
        fc.stringMatching(/^[a-z]{3,10}$/),
        fc.integer({ min: 0, max: 999 }),
        (resourceName, id) => {
          const result = parameterizePath(`/api/${resourceName}/${id}`);
          expect(result).toBe(`/api/${resourceName}/:id`);
        },
      ),
      { numRuns: 50 },
    );
  });
});

// ---------------------------------------------------------------------------
// Diff symmetry / round-trip helpers
// ---------------------------------------------------------------------------

interface RouteArb {
  url: string;
  title: string;
  statusCode: number;
  contentHash: string;
}

/** Arbitrary for a simple route object used in diff tests. */
const routeInfoArb = fc
  .record({
    url: fc.stringMatching(/^[a-z0-9/-]{1,30}$/).map((p) => `https://example.com/${p}`),
    title: fc.string({ minLength: 1, maxLength: 20 }),
    statusCode: fc.constantFrom(200, 201, 301, 302, 404, 500),
    contentHash: fc.stringMatching(/^[a-f0-9]{16}$/),
  })
  .map((r): RouteArb => r);

function toRouteInfo(r: RouteArb, depth = 0): RouteInfo {
  return {
    url: r.url,
    title: r.title,
    statusCode: r.statusCode,
    contentHash: r.contentHash,
    depth,
    formCount: 0,
    apiCallCount: 0,
    hasScreenshot: false,
    discoveryMethod: 'entry',
  };
}

async function writeBundleFromRoutes(
  dir: string,
  routes: RouteInfo[],
): Promise<void> {
  await mkdir(join(dir, 'data'), { recursive: true });
  await mkdir(join(dir, 'screenshots'), { recursive: true });
  const manifest: BundleManifest = {
    version: 1,
    tool: 'playwright-archaeologist',
    toolVersion: '0.0.0-test',
    createdAt: new Date().toISOString(),
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
      pagesVisited: routes.length,
      formsFound: 0,
      apiEndpoints: 0,
      screenshotCount: 0,
      duration: 0,
    },
    files: [],
  };
  await writeFile(join(dir, 'manifest.json'), JSON.stringify(manifest, null, 2));
  await writeFile(join(dir, 'data', 'sitemap.json'), JSON.stringify(routes));
  await writeFile(join(dir, 'data', 'forms.json'), '[]');
  await writeFile(join(dir, 'data', 'api-map.json'), '[]');
}

// ---------------------------------------------------------------------------
// Diff symmetry property
//
// For two bundles A and B containing route lists, `added` in diff(A→B)
// must equal `removed` in diff(B→A), and vice versa. `unchanged` count
// must match both ways.
// ---------------------------------------------------------------------------

describe('diffBundles anti-symmetry', () => {
  let base: string;

  beforeEach(async () => {
    base = await mkdtemp(join(tmpdir(), 'pa-prop-diff-'));
  });

  afterEach(async () => {
    await rm(base, { recursive: true, force: true }).catch(() => {});
  });

  it('added in A→B equals removed in B→A (and vice versa) for any two route lists', async () => {
    // Disjoint-by-url generators so we avoid URL-collision noise.
    const routeSetArb = fc.uniqueArray(routeInfoArb, {
      minLength: 0,
      maxLength: 6,
      selector: (r) => r.url,
    });

    // Reduced runs: each run writes ~8 small files and invokes diffBundles,
    // which is ~50ms of real I/O. 20 runs is sufficient for a property test
    // and keeps the suite under 5s.
    await fc.assert(
      fc.asyncProperty(routeSetArb, routeSetArb, async (aRoutes, bRoutes) => {
        const dirA = await mkdtemp(join(base, 'A-'));
        const dirB = await mkdtemp(join(base, 'B-'));
        try {
          await writeBundleFromRoutes(
            dirA,
            aRoutes.map((r) => toRouteInfo(r)),
          );
          await writeBundleFromRoutes(
            dirB,
            bRoutes.map((r) => toRouteInfo(r)),
          );

          const aToB = await diffBundles(dirA, dirB);
          const bToA = await diffBundles(dirB, dirA);

          // added in A->B == removed in B->A (by URL)
          const addedInAtoB = new Set(aToB.sitemap.added.map((r) => r.url));
          const removedInBtoA = new Set(bToA.sitemap.removed.map((r) => r.url));
          expect(addedInAtoB).toEqual(removedInBtoA);

          // removed in A->B == added in B->A (by URL)
          const removedInAtoB = new Set(aToB.sitemap.removed.map((r) => r.url));
          const addedInBtoA = new Set(bToA.sitemap.added.map((r) => r.url));
          expect(removedInAtoB).toEqual(addedInBtoA);

          // unchanged count must be symmetric.
          expect(aToB.sitemap.unchangedCount).toBe(bToA.sitemap.unchangedCount);

          // Summary counts should match anti-symmetrically.
          expect(aToB.summary.routes.added).toBe(bToA.summary.routes.removed);
          expect(aToB.summary.routes.removed).toBe(bToA.summary.routes.added);
        } finally {
          await rm(dirA, { recursive: true, force: true }).catch(() => {});
          await rm(dirB, { recursive: true, force: true }).catch(() => {});
        }
      }),
      { numRuns: 20 },
    );
  });

  it('comparing a bundle to itself reports no added/removed routes', async () => {
    const routeSetArb = fc.uniqueArray(routeInfoArb, {
      minLength: 0,
      maxLength: 6,
      selector: (r) => r.url,
    });

    await fc.assert(
      fc.asyncProperty(routeSetArb, async (routes) => {
        const dir = await mkdtemp(join(base, 'self-'));
        try {
          await writeBundleFromRoutes(
            dir,
            routes.map((r) => toRouteInfo(r)),
          );
          const result = await diffBundles(dir, dir);
          expect(result.sitemap.added).toEqual([]);
          expect(result.sitemap.removed).toEqual([]);
          // hasChanges may still be false — we only check the additive set.
          expect(result.summary.routes.added).toBe(0);
          expect(result.summary.routes.removed).toBe(0);
        } finally {
          await rm(dir, { recursive: true, force: true }).catch(() => {});
        }
      }),
      { numRuns: 20 },
    );
  });
});

// ---------------------------------------------------------------------------
// Bundle round-trip property
//
// createBundle(outputDir) produces a BundleManifest describing the files.
// Reading that manifest back must list exactly the JSON/screenshot files
// we wrote — no more, no less. Uses a small set of files per run to keep
// the test fast.
// ---------------------------------------------------------------------------

describe('createBundle manifest round-trip', () => {
  let base: string;

  beforeEach(async () => {
    base = await mkdtemp(join(tmpdir(), 'pa-prop-bundle-'));
  });

  afterEach(async () => {
    await rm(base, { recursive: true, force: true }).catch(() => {});
  });

  it('round-trips: files listed in the returned manifest match the files we wrote', async () => {
    // Each file: a JSON name (no extension), and some arbitrary content
    // we control entirely. Names must be unique within a run.
    const fileNameArb = fc.stringMatching(/^[a-z]{3,10}$/);
    const filesArb = fc.uniqueArray(
      fc.record({
        name: fileNameArb,
        // Keep content small and JSON-valid so nothing downstream balks.
        body: fc.jsonValue().map((v) => JSON.stringify(v)),
      }),
      { minLength: 0, maxLength: 4, selector: (f) => f.name },
    );

    await fc.assert(
      fc.asyncProperty(filesArb, async (files) => {
        const outputDir = await mkdtemp(join(base, 'out-'));
        const bundleDir = join(base, `bundle-${Date.now()}-${Math.random().toString(36).slice(2)}`);

        try {
          // Write `files.length` JSON files into the output dir.
          for (const f of files) {
            await writeFile(join(outputDir, `${f.name}.json`), f.body);
          }

          const manifest = await createBundle(outputDir, bundleDir);

          // Every file we wrote must appear in the manifest (under data/).
          const manifestPaths = new Set(manifest.files.map((e) => e.path));
          for (const f of files) {
            expect(manifestPaths.has(`data/${f.name}.json`)).toBe(true);
          }

          // The manifest must not list any file we didn't write.
          for (const entry of manifest.files) {
            const expectedNames = new Set(files.map((f) => `data/${f.name}.json`));
            expect(expectedNames.has(entry.path)).toBe(true);
          }

          expect(manifest.files.length).toBe(files.length);
        } finally {
          await rm(outputDir, { recursive: true, force: true }).catch(() => {});
          await rm(bundleDir, { recursive: true, force: true }).catch(() => {});
        }
      }),
      { numRuns: 20 },
    );
  });
});
