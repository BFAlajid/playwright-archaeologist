/**
 * Unit tests for src/diff-env/diff-env.ts
 *
 * The diff-env module is pure glue around `dig()`, `createBundle()`, and
 * `diffBundles()`. To test it without spinning up Chromium or reading/writing
 * real bundle files, we pass stub implementations via `DiffEnvDeps` and
 * assert on how the glue orchestrates them.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  runDiffEnv,
  evaluateFailOn,
  formatDiffEnvSummary,
  type DiffEnvOptions,
  type DiffEnvDeps,
} from '../../src/diff-env/diff-env.js';
import type { DiffResult, DiffSummary, DigResult, BundleManifest } from '../../src/types/artifacts.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Zero-count DiffSummary — handy as a starting point in tests. */
function emptySummary(): DiffSummary {
  return {
    routes: { added: 0, removed: 0, changed: 0, unchanged: 0 },
    forms: { added: 0, removed: 0, changed: 0, unchanged: 0 },
    api: { added: 0, removed: 0, changed: 0, unchanged: 0 },
    screenshots: { added: 0, removed: 0, changed: 0, unchanged: 0 },
  };
}

/** Build a plausible DigResult for the given output directory. */
function makeDigResult(outputDir: string): DigResult {
  return {
    artifacts: {
      meta: {
        targetUrl: 'https://example.com',
        toolVersion: '0.2.0',
        crawlDate: new Date().toISOString(),
        duration: 0,
        pagesVisited: 0,
        formsFound: 0,
        apiEndpoints: 0,
        screenshotCount: 0,
      },
      routes: [],
      forms: [],
      apiEndpoints: [],
      screenshots: [],
      flowGraph: { nodes: [], edges: [] },
      routeTree: { path: '/', children: [] },
    } as unknown as DigResult['artifacts'],
    outputPaths: { outputDir },
    errors: [],
    completionStatus: 'complete',
  };
}

/** Build a DiffResult with a given summary. */
function makeDiffResult(summary: DiffSummary, overrides?: Partial<DiffResult>): DiffResult {
  return {
    meta: {
      oldBundle: {
        path: '/tmp/a/bundle',
        createdAt: '2026-01-01T00:00:00.000Z',
        targetUrl: 'https://a.example.com',
        toolVersion: '0.2.0',
      },
      newBundle: {
        path: '/tmp/b/bundle',
        createdAt: '2026-01-01T00:00:00.000Z',
        targetUrl: 'https://b.example.com',
        toolVersion: '0.2.0',
      },
      comparedAt: '2026-01-01T00:00:00.000Z',
    },
    hasChanges:
      summary.routes.added + summary.routes.removed + summary.routes.changed +
      summary.forms.added + summary.forms.removed + summary.forms.changed +
      summary.api.added + summary.api.removed + summary.api.changed +
      summary.screenshots.added + summary.screenshots.removed + summary.screenshots.changed > 0,
    sitemap: { added: [], removed: [], changed: [], unchangedCount: summary.routes.unchanged },
    forms: { added: [], removed: [], changed: [], unchangedCount: summary.forms.unchanged },
    api: { added: [], removed: [], changed: [], unchangedCount: summary.api.unchanged },
    screenshots: { added: [], removed: [], changed: [], unchangedCount: summary.screenshots.unchanged },
    summary,
    ...overrides,
  };
}

/** A minimal bundle manifest — returned by the stubbed createBundle. */
function makeManifest(): BundleManifest {
  return {
    version: 1,
    tool: 'playwright-archaeologist',
    toolVersion: '0.2.0',
    createdAt: '2026-01-01T00:00:00.000Z',
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
  };
}

/**
 * Factory that builds a standard `DiffEnvDeps` stub set, returning handles
 * to the spies so individual tests can inspect or override them.
 */
function makeDeps(diffResult: DiffResult): {
  deps: DiffEnvDeps;
  digCalls: Array<{ targetUrl: string; outputDir: string; startedAt: number; finishedAt: number }>;
  diffCalls: Array<{ oldDir: string; newDir: string }>;
  bundleCalls: Array<{ sourceDir: string; bundleDir: string }>;
  /** Resolve/reject per env — default resolves immediately. */
  resolveA?: () => void;
  resolveB?: () => void;
} {
  const digCalls: Array<{ targetUrl: string; outputDir: string; startedAt: number; finishedAt: number }> = [];
  const diffCalls: Array<{ oldDir: string; newDir: string }> = [];
  const bundleCalls: Array<{ sourceDir: string; bundleDir: string }> = [];

  const deps: DiffEnvDeps = {
    digImpl: async (config) => {
      const startedAt = Date.now();
      // Short sleep so parallel/sequential timing is observable.
      await new Promise((r) => setTimeout(r, 20));
      const finishedAt = Date.now();
      digCalls.push({
        targetUrl: config.targetUrl,
        outputDir: config.outputDir,
        startedAt,
        finishedAt,
      });
      return makeDigResult(config.outputDir);
    },
    createBundleImpl: async (sourceDir, bundleDir) => {
      bundleCalls.push({ sourceDir, bundleDir });
      return makeManifest();
    },
    diffBundlesImpl: async (oldDir, newDir) => {
      diffCalls.push({ oldDir, newDir });
      return diffResult;
    },
  };

  return { deps, digCalls, diffCalls, bundleCalls };
}

// ---------------------------------------------------------------------------
// Test lifecycle
// ---------------------------------------------------------------------------

let tmpDir: string;

beforeEach(async () => {
  tmpDir = await mkdtemp(join(tmpdir(), 'pa-diff-env-test-'));
});

afterEach(async () => {
  await rm(tmpDir, { recursive: true, force: true }).catch(() => {});
});

// ---------------------------------------------------------------------------
// evaluateFailOn — pure function, exhaustive policy tests
// ---------------------------------------------------------------------------

describe('evaluateFailOn', () => {
  it('returns false for "none" regardless of summary contents', () => {
    const s = emptySummary();
    s.routes.added = 5;
    s.forms.changed = 2;
    expect(evaluateFailOn(s, 'none')).toBe(false);
  });

  it('returns false for "any" when summary is empty', () => {
    expect(evaluateFailOn(emptySummary(), 'any')).toBe(false);
  });

  it('returns true for "any" when anything changed', () => {
    const s = emptySummary();
    s.screenshots.changed = 1;
    expect(evaluateFailOn(s, 'any')).toBe(true);
  });

  it('returns true for "routes-removed" only when routes were removed', () => {
    const s = emptySummary();
    s.routes.added = 99;
    s.routes.changed = 99;
    // added + changed should not trigger routes-removed
    expect(evaluateFailOn(s, 'routes-removed')).toBe(false);
    s.routes.removed = 1;
    expect(evaluateFailOn(s, 'routes-removed')).toBe(true);
  });

  it('returns true for "forms" only when a form changed', () => {
    const s = emptySummary();
    s.routes.added = 5;
    expect(evaluateFailOn(s, 'forms')).toBe(false);
    s.forms.added = 1;
    expect(evaluateFailOn(s, 'forms')).toBe(true);
  });

  it('returns true for "api" only when an API endpoint changed', () => {
    const s = emptySummary();
    s.forms.added = 1;
    expect(evaluateFailOn(s, 'api')).toBe(false);
    s.api.changed = 1;
    expect(evaluateFailOn(s, 'api')).toBe(true);
  });

  it('returns true for "screenshots" only when a screenshot changed', () => {
    const s = emptySummary();
    s.routes.added = 1;
    expect(evaluateFailOn(s, 'screenshots')).toBe(false);
    s.screenshots.removed = 1;
    expect(evaluateFailOn(s, 'screenshots')).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// runDiffEnv — orchestration against stubs
// ---------------------------------------------------------------------------

describe('runDiffEnv', () => {
  it('calls dig() for both envs, bundles each, then diffs the two bundles', async () => {
    const diff = makeDiffResult(emptySummary());
    const { deps, digCalls, bundleCalls, diffCalls } = makeDeps(diff);

    const opts: DiffEnvOptions = {
      envAUrl: 'https://staging.example.com',
      envBUrl: 'https://prod.example.com',
      outputDir: tmpDir,
    };

    const result = await runDiffEnv(opts, deps);

    // dig was called twice — once per env, into subdirs a/ and b/.
    expect(digCalls).toHaveLength(2);
    const targets = digCalls.map((c) => c.targetUrl).sort();
    expect(targets).toEqual(['https://prod.example.com', 'https://staging.example.com']);

    // Output dirs: one under a/, one under b/.
    const outputDirs = digCalls.map((c) => c.outputDir).sort();
    expect(outputDirs[0]).toContain(`${tmpDir}`);
    expect(outputDirs.some((d) => d.endsWith('a') || d.endsWith(join('', 'a')))).toBe(true);
    expect(outputDirs.some((d) => d.endsWith('b') || d.endsWith(join('', 'b')))).toBe(true);

    // Each env's raw output was bundled into a `bundle/` subdir.
    expect(bundleCalls).toHaveLength(2);

    // diffBundles received bundle paths (not raw output dirs).
    expect(diffCalls).toHaveLength(1);
    expect(diffCalls[0].oldDir).toBe(result.bundleAPath);
    expect(diffCalls[0].newDir).toBe(result.bundleBPath);
    expect(diffCalls[0].oldDir).toContain('bundle');
    expect(diffCalls[0].newDir).toContain('bundle');
  });

  it('runs both crawls in parallel (Promise.all semantics)', async () => {
    // Two stubs that each sleep 200ms. If called in parallel, wall time is
    // ~200ms. If called sequentially, it's ~400ms. Give a generous margin
    // for CI slowness — 350ms is still well above the serial threshold.
    const SLEEP_MS = 200;
    const digCalls: Array<{ targetUrl: string; start: number; end: number }> = [];
    const deps: DiffEnvDeps = {
      digImpl: async (config) => {
        const start = Date.now();
        await new Promise((r) => setTimeout(r, SLEEP_MS));
        const end = Date.now();
        digCalls.push({ targetUrl: config.targetUrl, start, end });
        return makeDigResult(config.outputDir);
      },
      createBundleImpl: async () => makeManifest(),
      diffBundlesImpl: async () => makeDiffResult(emptySummary()),
    };

    const t0 = Date.now();
    await runDiffEnv(
      {
        envAUrl: 'https://a.example.com',
        envBUrl: 'https://b.example.com',
        outputDir: tmpDir,
      },
      deps,
    );
    const elapsed = Date.now() - t0;

    // Parallel threshold: well under 2x the sleep time.
    expect(elapsed).toBeLessThan(SLEEP_MS * 1.75);
    expect(digCalls).toHaveLength(2);

    // Observable overlap: call A started before call B finished.
    const [a, b] = digCalls;
    const overlap = Math.max(0, Math.min(a.end, b.end) - Math.max(a.start, b.start));
    expect(overlap).toBeGreaterThan(0);
  });

  it('propagates errors from env A with a clear prefix', async () => {
    const deps: DiffEnvDeps = {
      digImpl: async (config) => {
        if (config.targetUrl.includes('fail')) {
          throw new Error('browser crashed');
        }
        return makeDigResult(config.outputDir);
      },
      createBundleImpl: async () => makeManifest(),
      diffBundlesImpl: async () => makeDiffResult(emptySummary()),
    };

    await expect(
      runDiffEnv(
        {
          envAUrl: 'https://fail-a.example.com',
          envBUrl: 'https://ok-b.example.com',
          outputDir: tmpDir,
        },
        deps,
      ),
    ).rejects.toThrow(/crawl of env A.*browser crashed/i);
  });

  it('propagates errors from env B with a clear prefix', async () => {
    const deps: DiffEnvDeps = {
      digImpl: async (config) => {
        if (config.targetUrl.includes('fail')) {
          throw new Error('timeout');
        }
        return makeDigResult(config.outputDir);
      },
      createBundleImpl: async () => makeManifest(),
      diffBundlesImpl: async () => makeDiffResult(emptySummary()),
    };

    await expect(
      runDiffEnv(
        {
          envAUrl: 'https://ok.example.com',
          envBUrl: 'https://fail.example.com',
          outputDir: tmpDir,
        },
        deps,
      ),
    ).rejects.toThrow(/crawl of env B.*timeout/i);
  });

  it('shouldFail is true when failOn="any" and diff has changes', async () => {
    const summary = emptySummary();
    summary.routes.added = 1;
    const { deps } = makeDeps(makeDiffResult(summary));

    const result = await runDiffEnv(
      {
        envAUrl: 'https://a.example.com',
        envBUrl: 'https://b.example.com',
        outputDir: tmpDir,
        failOn: 'any',
      },
      deps,
    );

    expect(result.shouldFail).toBe(true);
  });

  it('shouldFail is false when failOn="none" regardless of diff', async () => {
    const summary = emptySummary();
    summary.routes.added = 99;
    summary.screenshots.changed = 99;
    const { deps } = makeDeps(makeDiffResult(summary));

    const result = await runDiffEnv(
      {
        envAUrl: 'https://a.example.com',
        envBUrl: 'https://b.example.com',
        outputDir: tmpDir,
        failOn: 'none',
      },
      deps,
    );

    expect(result.shouldFail).toBe(false);
  });

  it('shouldFail is false when failOn="forms" and only routes changed', async () => {
    const summary = emptySummary();
    summary.routes.added = 5;
    summary.routes.removed = 2;
    const { deps } = makeDeps(makeDiffResult(summary));

    const result = await runDiffEnv(
      {
        envAUrl: 'https://a.example.com',
        envBUrl: 'https://b.example.com',
        outputDir: tmpDir,
        failOn: 'forms',
      },
      deps,
    );

    expect(result.shouldFail).toBe(false);
  });

  it('shouldFail is true when failOn="forms" and forms changed', async () => {
    const summary = emptySummary();
    summary.forms.changed = 1;
    const { deps } = makeDeps(makeDiffResult(summary));

    const result = await runDiffEnv(
      {
        envAUrl: 'https://a.example.com',
        envBUrl: 'https://b.example.com',
        outputDir: tmpDir,
        failOn: 'forms',
      },
      deps,
    );

    expect(result.shouldFail).toBe(true);
  });

  it('defaults labelA / labelB from URL hostnames', async () => {
    const { deps } = makeDeps(makeDiffResult(emptySummary()));

    const result = await runDiffEnv(
      {
        envAUrl: 'https://staging.example.com/app',
        envBUrl: 'https://prod.example.com/app',
        outputDir: tmpDir,
      },
      deps,
    );

    expect(result.labelA).toBe('staging.example.com');
    expect(result.labelB).toBe('prod.example.com');
  });

  it('honors explicit labelA / labelB overrides', async () => {
    const { deps } = makeDeps(makeDiffResult(emptySummary()));

    const result = await runDiffEnv(
      {
        envAUrl: 'https://a.example.com',
        envBUrl: 'https://b.example.com',
        outputDir: tmpDir,
        labelA: 'Staging',
        labelB: 'Production',
      },
      deps,
    );

    expect(result.labelA).toBe('Staging');
    expect(result.labelB).toBe('Production');
  });

  it('writes an HTML report by default', async () => {
    const { deps } = makeDeps(makeDiffResult(emptySummary()));

    const result = await runDiffEnv(
      {
        envAUrl: 'https://a.example.com',
        envBUrl: 'https://b.example.com',
        outputDir: tmpDir,
      },
      deps,
    );

    expect(result.diffReportPath.endsWith('report.html')).toBe(true);
    const body = await readFile(result.diffReportPath, 'utf-8');
    expect(body).toContain('<html');
  });

  it('writes a JSON report when format is "json"', async () => {
    const summary = emptySummary();
    summary.routes.added = 1;
    const { deps } = makeDeps(makeDiffResult(summary));

    const result = await runDiffEnv(
      {
        envAUrl: 'https://a.example.com',
        envBUrl: 'https://b.example.com',
        outputDir: tmpDir,
        format: 'json',
      },
      deps,
    );

    expect(result.diffReportPath.endsWith('report.json')).toBe(true);
    const body = JSON.parse(await readFile(result.diffReportPath, 'utf-8'));
    expect(body.hasChanges).toBe(true);
    expect(body.summary.routes.added).toBe(1);
  });

  it('writes a Markdown report when format is "markdown"', async () => {
    const summary = emptySummary();
    summary.forms.added = 2;
    const { deps } = makeDeps(makeDiffResult(summary));

    const result = await runDiffEnv(
      {
        envAUrl: 'https://a.example.com',
        envBUrl: 'https://b.example.com',
        outputDir: tmpDir,
        format: 'markdown',
        labelA: 'Staging',
        labelB: 'Prod',
      },
      deps,
    );

    expect(result.diffReportPath.endsWith('report.md')).toBe(true);
    const body = await readFile(result.diffReportPath, 'utf-8');
    expect(body).toContain('# Diff: Staging vs Prod');
    expect(body).toContain('| Routes |');
    expect(body).toContain('_Changes detected._');
  });

  it('writes a JUnit report when format is "junit"', async () => {
    const summary = emptySummary();
    summary.api.changed = 1;
    const { deps } = makeDeps(makeDiffResult(summary));

    const result = await runDiffEnv(
      {
        envAUrl: 'https://a.example.com',
        envBUrl: 'https://b.example.com',
        outputDir: tmpDir,
        format: 'junit',
      },
      deps,
    );

    expect(result.diffReportPath.endsWith('report.xml')).toBe(true);
    const body = await readFile(result.diffReportPath, 'utf-8');
    expect(body).toContain('<?xml');
    expect(body).toContain('<testsuite');
    // api was the failing category.
    expect(body).toContain('<failure');
    expect(body).toMatch(/<testcase name="api"/);
  });

  it('writes JUnit with no failures when there are no changes', async () => {
    const { deps } = makeDeps(makeDiffResult(emptySummary()));

    const result = await runDiffEnv(
      {
        envAUrl: 'https://a.example.com',
        envBUrl: 'https://b.example.com',
        outputDir: tmpDir,
        format: 'junit',
      },
      deps,
    );

    const body = await readFile(result.diffReportPath, 'utf-8');
    expect(body).toContain('failures="0"');
    expect(body).not.toContain('<failure');
  });

  it('forwards diffOptions to diffBundles', async () => {
    const diff = makeDiffResult(emptySummary());
    let receivedOptions: unknown = null;

    const deps: DiffEnvDeps = {
      digImpl: async (config) => makeDigResult(config.outputDir),
      createBundleImpl: async () => makeManifest(),
      diffBundlesImpl: async (_oldDir, _newDir, options) => {
        receivedOptions = options;
        return diff;
      },
    };

    await runDiffEnv(
      {
        envAUrl: 'https://a.example.com',
        envBUrl: 'https://b.example.com',
        outputDir: tmpDir,
        diffOptions: {
          diffThreshold: 0.05,
          diffMaxRatio: 0.2,
          diffIgnoreFields: ['timestamp', 'nonce'],
        },
      },
      deps,
    );

    const opts = receivedOptions as {
      diffThreshold?: number;
      diffMaxRatio?: number;
      diffIgnoreFields?: string[];
      heatmapDir?: string;
    };
    expect(opts.diffThreshold).toBe(0.05);
    expect(opts.diffMaxRatio).toBe(0.2);
    expect(opts.diffIgnoreFields).toEqual(['timestamp', 'nonce']);
    // heatmapDir should be auto-set under diff/heatmaps when not provided.
    expect(opts.heatmapDir).toContain('heatmaps');
  });

  it('throws ConfigError when envAUrl is empty', async () => {
    const { deps } = makeDeps(makeDiffResult(emptySummary()));
    await expect(
      runDiffEnv(
        {
          envAUrl: '',
          envBUrl: 'https://b.example.com',
          outputDir: tmpDir,
        },
        deps,
      ),
    ).rejects.toThrow(/envAUrl/);
  });

  it('throws when envBUrl is missing', async () => {
    const { deps } = makeDeps(makeDiffResult(emptySummary()));
    await expect(
      runDiffEnv(
        {
          envAUrl: 'https://a.example.com',
          envBUrl: '',
          outputDir: tmpDir,
        },
        deps,
      ),
    ).rejects.toThrow(/envBUrl/);
  });
});

// ---------------------------------------------------------------------------
// formatDiffEnvSummary
// ---------------------------------------------------------------------------

describe('formatDiffEnvSummary', () => {
  it('renders the one-line CI summary with labels and counts', () => {
    const summary = emptySummary();
    summary.routes.added = 2;
    summary.routes.removed = 1;
    summary.routes.changed = 3;
    summary.forms.changed = 1;
    summary.api.added = 2;
    summary.api.changed = 1;

    const s = formatDiffEnvSummary({
      summary,
      shouldFail: true,
      bundleAPath: '/tmp/a/bundle',
      bundleBPath: '/tmp/b/bundle',
      diffReportPath: '/tmp/diff/report.html',
      diff: makeDiffResult(summary),
      labelA: 'staging',
      labelB: 'prod',
    });

    expect(s).toContain('A=staging');
    expect(s).toContain('B=prod');
    expect(s).toContain('+2 routes');
    expect(s).toContain('-1 routes');
    expect(s).toContain('~3 changed');
    // forms (added+removed+changed) = 1
    expect(s).toContain('1 forms changed');
    // api (added+removed+changed) = 3
    expect(s).toContain('3 APIs changed');
  });
});
