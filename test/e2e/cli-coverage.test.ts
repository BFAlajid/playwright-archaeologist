/**
 * End-to-end tests for `pa coverage`.
 *
 * These run the compiled CLI against a synthetic bundle on disk (no crawl
 * and no Playwright install) using a small fixture test directory.
 *
 * Pre-requisite: `npm run build` must have produced `dist/cli.js`.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execa } from 'execa';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..', '..');
const CLI_ENTRY = join(ROOT, 'bin', 'cli.js');
const DIST_CLI = join(ROOT, 'dist', 'cli.js');
const FIXTURE_TESTS_DIR = join(ROOT, 'test', 'fixtures', 'coverage-tests');

if (!existsSync(DIST_CLI)) {
  throw new Error(
    `CLI e2e tests require the built CLI at ${DIST_CLI}, but it was not found.\n` +
      "Run `npm run build` first.",
  );
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function toStr(v: unknown): string {
  if (typeof v === 'string') return v;
  if (v == null) return '';
  if (Array.isArray(v)) return v.join('\n');
  return String(v);
}

interface RunResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  combined: string;
}

async function runCli(args: string[], timeout = 15_000): Promise<RunResult> {
  try {
    const res = await execa('node', [CLI_ENTRY, ...args], {
      reject: false,
      timeout,
      cwd: ROOT,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, NO_COLOR: '1' },
    });
    const stdout = toStr(res.stdout);
    const stderr = toStr(res.stderr);
    return {
      exitCode: res.exitCode ?? 0,
      stdout,
      stderr,
      combined: `${stdout}\n${stderr}`,
    };
  } catch (err: unknown) {
    const e = err as { exitCode?: number; stdout?: unknown; stderr?: unknown; message?: string };
    return {
      exitCode: typeof e.exitCode === 'number' ? e.exitCode : 1,
      stdout: toStr(e.stdout),
      stderr: toStr(e.stderr) || (e.message ?? ''),
      combined: `${toStr(e.stdout)}\n${toStr(e.stderr)}\n${e.message ?? ''}`,
    };
  }
}

/**
 * Build a small bundle on disk with 4 routes and 2 API endpoints.
 *   routes: /, /users, /orders, /settings
 *   apis:   GET /api/users, POST /api/orders
 *
 * Fixture test dir (see test/fixtures/coverage-tests) covers:
 *   - / (home.spec.ts)
 *   - /users (home.spec.ts)
 *   - /orders (orders.spec.ts)
 *   - GET /api/users (home.spec.ts)
 * Uncovered: /settings, POST /api/orders
 * Expected overall: 4 / 6 = 66.67%
 */
async function buildBundle(bundleDir: string): Promise<void> {
  const dataDir = join(bundleDir, 'data');
  await mkdir(dataDir, { recursive: true });

  await writeFile(
    join(dataDir, 'sitemap.json'),
    JSON.stringify([
      { url: 'https://app.example.com/', title: 'Home', statusCode: 200, contentHash: '', depth: 0, formCount: 0, apiCallCount: 0, hasScreenshot: false, discoveryMethod: 'entry' },
      { url: 'https://app.example.com/users', title: 'Users', statusCode: 200, contentHash: '', depth: 1, formCount: 0, apiCallCount: 0, hasScreenshot: false, discoveryMethod: 'link' },
      { url: 'https://app.example.com/orders', title: 'Orders', statusCode: 200, contentHash: '', depth: 1, formCount: 0, apiCallCount: 0, hasScreenshot: false, discoveryMethod: 'link' },
      { url: 'https://app.example.com/settings', title: 'Settings', statusCode: 200, contentHash: '', depth: 1, formCount: 0, apiCallCount: 0, hasScreenshot: false, discoveryMethod: 'link' },
    ]),
  );
  await writeFile(
    join(dataDir, 'crawl-summary.json'),
    JSON.stringify({ targetUrl: 'https://app.example.com/' }),
  );
  await writeFile(
    join(dataDir, 'api-map.json'),
    JSON.stringify([
      {
        pattern: '/api/users',
        method: 'GET',
        classification: 'api',
        observedUrls: ['https://app.example.com/api/users'],
        callCount: 1,
        callingPages: [],
        exampleRequest: { url: 'https://app.example.com/api/users', headers: {} },
        exampleResponse: { statusCode: 200, headers: {}, bodySize: 0 },
        observedStatusCodes: [200],
        observedContentTypes: ['application/json'],
        isGraphQL: false,
      },
      {
        pattern: '/api/orders',
        method: 'POST',
        classification: 'api',
        observedUrls: ['https://app.example.com/api/orders'],
        callCount: 1,
        callingPages: [],
        exampleRequest: { url: 'https://app.example.com/api/orders', headers: {} },
        exampleResponse: { statusCode: 201, headers: {}, bodySize: 0 },
        observedStatusCodes: [201],
        observedContentTypes: ['application/json'],
        isGraphQL: false,
      },
    ]),
  );
  await writeFile(
    join(bundleDir, 'manifest.json'),
    JSON.stringify({
      version: 1,
      tool: 'playwright-archaeologist',
      toolVersion: '0.0.0-test',
      createdAt: '2026-04-21T00:00:00Z',
      config: {
        targetUrl: 'https://app.example.com/',
        depth: 1,
        viewport: { width: 1280, height: 720 },
        concurrency: 1,
        maxPages: 10,
        followExternal: false,
        deepClick: false,
      },
      stats: {
        pagesVisited: 4,
        formsFound: 0,
        apiEndpoints: 2,
        screenshotCount: 0,
        duration: 0,
      },
      files: [],
    }),
  );
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

let tempRoot: string;

beforeEach(async () => {
  tempRoot = await mkdtemp(join(tmpdir(), 'pa-cli-coverage-'));
});

afterEach(async () => {
  await rm(tempRoot, { recursive: true, force: true }).catch(() => { /* noop */ });
});

describe('pa coverage', () => {
  it('exits 0 by default and writes an HTML report', async () => {
    const bundleDir = join(tempRoot, 'bundle');
    await buildBundle(bundleDir);
    const outPath = join(tempRoot, 'coverage.html');

    const result = await runCli([
      'coverage',
      bundleDir,
      '--tests',
      FIXTURE_TESTS_DIR,
      '-o',
      outPath,
    ]);

    expect(result.exitCode).toBe(0);
    expect(existsSync(outPath)).toBe(true);
    const html = await readFile(outPath, 'utf-8');
    expect(html).toContain('Test Coverage Report');
    expect(html).toContain('/settings'); // uncovered
    expect(html).toContain('/api/orders'); // uncovered
  });

  it('exits 1 when --fail-on threshold exceeds observed coverage', async () => {
    const bundleDir = join(tempRoot, 'bundle');
    await buildBundle(bundleDir);
    const outPath = join(tempRoot, 'coverage.html');

    const result = await runCli([
      'coverage',
      bundleDir,
      '--tests',
      FIXTURE_TESTS_DIR,
      '-o',
      outPath,
      '--fail-on',
      '90',
    ]);

    expect(result.exitCode).toBe(1);
    expect(result.combined.toLowerCase()).toContain('below threshold');
  });

  it('exits 0 when --fail-on threshold is met', async () => {
    const bundleDir = join(tempRoot, 'bundle');
    await buildBundle(bundleDir);
    const outPath = join(tempRoot, 'coverage.html');

    const result = await runCli([
      'coverage',
      bundleDir,
      '--tests',
      FIXTURE_TESTS_DIR,
      '-o',
      outPath,
      '--fail-on',
      '50',
    ]);

    expect(result.exitCode).toBe(0);
  });

  it('writes JSON when --format json is passed', async () => {
    const bundleDir = join(tempRoot, 'bundle');
    await buildBundle(bundleDir);
    const outPath = join(tempRoot, 'coverage.json');

    const result = await runCli([
      'coverage',
      bundleDir,
      '--tests',
      FIXTURE_TESTS_DIR,
      '-o',
      outPath,
      '--format',
      'json',
    ]);

    expect(result.exitCode).toBe(0);
    const json = JSON.parse(await readFile(outPath, 'utf-8'));
    expect(json.summary.routesTotal).toBe(4);
    expect(json.summary.apisTotal).toBe(2);
    expect(json.summary.overallPercentage).toBeGreaterThan(0);
  });

  it('honors --ignore patterns and reports them in the output', async () => {
    const bundleDir = join(tempRoot, 'bundle');
    await buildBundle(bundleDir);
    const outPath = join(tempRoot, 'coverage.json');

    const result = await runCli([
      'coverage',
      bundleDir,
      '--tests',
      FIXTURE_TESTS_DIR,
      '-o',
      outPath,
      '--format',
      'json',
      '--ignore',
      '**/settings',
    ]);

    expect(result.exitCode).toBe(0);
    const json = JSON.parse(await readFile(outPath, 'utf-8'));
    // /settings should have been dropped from totals.
    expect(json.summary.routesTotal).toBe(3);
    expect(json.ignoredPatterns).toEqual(['**/settings']);
  });

  it('exits with a clear error when --tests points at a missing directory', async () => {
    const bundleDir = join(tempRoot, 'bundle');
    await buildBundle(bundleDir);

    const result = await runCli([
      'coverage',
      bundleDir,
      '--tests',
      join(tempRoot, 'no-such-tests'),
      '-o',
      join(tempRoot, 'coverage.html'),
    ]);

    expect(result.exitCode).not.toBe(0);
    expect(result.combined.toLowerCase()).toMatch(/test directory|not found|coverage error/);
  });

  it('emits JUnit XML when --format junit is passed', async () => {
    const bundleDir = join(tempRoot, 'bundle');
    await buildBundle(bundleDir);
    const outPath = join(tempRoot, 'coverage.xml');

    const result = await runCli([
      'coverage',
      bundleDir,
      '--tests',
      FIXTURE_TESTS_DIR,
      '-o',
      outPath,
      '--format',
      'junit',
    ]);

    expect(result.exitCode).toBe(0);
    const xml = await readFile(outPath, 'utf-8');
    expect(xml.startsWith('<?xml version=')).toBe(true);
    expect(xml).toContain('<testsuite');
    expect(xml).toContain('coverage.routes');
  });
});
