/**
 * End-to-end tests for the `pa` CLI binary.
 *
 * These tests spawn `node ./bin/cli.js` with `execa` and assert on exit
 * codes, stdout, and stderr. They exercise the real CLI pipeline:
 * arg parsing, config validation, URL normalization, and subcommand
 * dispatch.
 *
 * Tests that require a real browser (`pa dig` against a fixture server)
 * are gated behind `describe.skipIf(!hasChromium)`.
 *
 * Tests that don't need Chromium (version, help, arg validation, diff
 * against non-existent bundles) always run.
 *
 * Pre-requisite: `npm run build` must have produced `dist/cli.js`. If it
 * has not, these tests fail LOUDLY with a clear message — they do not
 * silently skip. This is intentional: a missing build is a developer
 * error that should surface before CI.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { execa } from 'execa';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { hasChromium } from '../helpers/has-chromium.js';
import { startTestApp, type TestAppHandle } from '../fixtures/test-app/setup.js';

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..', '..');
const CLI_ENTRY = join(ROOT, 'bin', 'cli.js');
const DIST_CLI = join(ROOT, 'dist', 'cli.js');

if (!existsSync(DIST_CLI)) {
  throw new Error(
    `CLI e2e tests require the built CLI at ${DIST_CLI}, but it was not found.\n` +
      "Run `npm run build` first. Do not skip this step — the e2e tests must exercise the real shipped binary.",
  );
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

interface RunResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  combined: string;
}

/**
 * Run the CLI with the given arguments and return its exit code plus
 * captured output. Does NOT throw on non-zero exit — callers assert on
 * `exitCode`.
 */
/** Coerce execa's stdout/stderr (which may be string | Buffer | array) to a string. */
function toStr(v: unknown): string {
  if (typeof v === 'string') return v;
  if (v == null) return '';
  if (Array.isArray(v)) return v.join('\n');
  return String(v);
}

async function runCli(args: string[], opts: { timeout?: number; cwd?: string } = {}): Promise<RunResult> {
  const timeout = opts.timeout ?? 15_000;
  try {
    const res = await execa('node', [CLI_ENTRY, ...args], {
      reject: false,
      timeout,
      cwd: opts.cwd ?? ROOT,
      // Don't pipe our own stdio — collect the child's streams instead.
      stdio: ['ignore', 'pipe', 'pipe'],
      // Avoid inheriting DEBUG etc. from the runner's env that could alter output.
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
    // Timeout or spawn failure lands here with ExecaError.
    const e = err as { exitCode?: number; stdout?: unknown; stderr?: unknown; message?: string };
    const stdout = toStr(e.stdout);
    const stderr = toStr(e.stderr);
    return {
      exitCode: typeof e.exitCode === 'number' ? e.exitCode : 1,
      stdout,
      stderr: stderr || (e.message ?? ''),
      combined: `${stdout}\n${stderr}\n${e.message ?? ''}`,
    };
  }
}

// ---------------------------------------------------------------------------
// Version and help
// ---------------------------------------------------------------------------

describe('CLI — version and help', () => {
  it('pa --version exits 0 and prints version matching package.json', async () => {
    const pkgPath = join(ROOT, 'package.json');
    const pkgContent = await readFile(pkgPath, 'utf-8');
    const pkg = JSON.parse(pkgContent) as { version: string };

    const result = await runCli(['--version']);

    expect(result.exitCode).toBe(0);
    // Commander prints just the bare version on one line.
    expect(result.stdout.trim()).toBe(pkg.version);
  });

  it('pa --help exits 0 and mentions dig, diff, install', async () => {
    const result = await runCli(['--help']);

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toMatch(/dig/);
    expect(result.stdout).toMatch(/diff/);
    expect(result.stdout).toMatch(/install/);
  });
});

// ---------------------------------------------------------------------------
// Argument validation (no browser needed)
// ---------------------------------------------------------------------------

describe('CLI — argument validation', () => {
  it('pa dig (no URL) exits non-zero with a clear error', async () => {
    const result = await runCli(['dig']);

    expect(result.exitCode).not.toBe(0);
    // Commander's standard "missing required argument" message.
    expect(result.combined.toLowerCase()).toMatch(/missing required argument|url/);
  });

  it('pa dig ftp://example.com exits non-zero with a protocol error', async () => {
    // A URL with a non-http(s) protocol should fail normalizeEntryUrl.
    const result = await runCli(['dig', 'ftp://example.com'], { timeout: 10_000 });

    expect(result.exitCode).not.toBe(0);
    expect(result.combined.toLowerCase()).toMatch(/protocol|http/);
  });

  it('pa diff non-existent-a non-existent-b exits non-zero with a clear error', async () => {
    const result = await runCli(['diff', 'non-existent-bundle-a', 'non-existent-bundle-b']);

    expect(result.exitCode).not.toBe(0);
    expect(result.combined.toLowerCase()).toMatch(/bundle|not found|configuration error/);
  });
});

// ---------------------------------------------------------------------------
// SSRF block path (no outbound network needed)
//
// A dig against 127.0.0.1 triggers the SSRF guard inside the crawl loop
// before any real navigation. The crawl completes with 0 pages visited
// and an SSRF-block error, regardless of Chromium availability — but
// Chromium is still needed to launch a browser in dig(), so gate this.
// ---------------------------------------------------------------------------

describe.skipIf(!hasChromium)('CLI — SSRF block', () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'pa-cli-ssrf-'));
  });

  afterAll(async () => {
    if (tmpDir) await rm(tmpDir, { recursive: true, force: true }).catch(() => {});
  });

  it('pa dig https://127.0.0.1:9999 — SSRF guard blocks the URL', async () => {
    const result = await runCli(
      [
        'dig',
        'https://127.0.0.1:9999',
        '--depth', '0',
        '--max-pages', '1',
        '--no-har',
        '--no-screenshots',
        '--output', tmpDir,
      ],
      { timeout: 30_000 },
    );

    // The orchestrator logs the block and continues to finalize artifacts,
    // so exit code can legitimately be 0 when the guard triggers on the
    // entry URL (treated as "crawl ran, all URLs blocked"). What we
    // assert is the SSRF block message appeared — that is the contract.
    expect(result.combined.toLowerCase()).toMatch(/ssrf blocked|private ip|blocked/);
  });
});

// ---------------------------------------------------------------------------
// Real crawl against fixture (Chromium required)
// ---------------------------------------------------------------------------

describe.skipIf(!hasChromium)('CLI — real crawl against fixture', () => {
  let app: TestAppHandle;
  let tmpDir: string;

  beforeAll(async () => {
    app = await startTestApp();
  });

  afterAll(async () => {
    await app?.close();
  });

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'pa-cli-dig-'));
  });

  afterAll(async () => {
    if (tmpDir) await rm(tmpDir, { recursive: true, force: true }).catch(() => {});
  });

  it('pa dig <fixture-url> writes sitemap.json and exits 0', async () => {
    const result = await runCli(
      [
        'dig',
        app.url,
        '--allow-private',
        '--depth', '0',
        '--max-pages', '1',
        '--no-har',
        '--no-screenshots',
        '--output', tmpDir,
      ],
      { timeout: 60_000 },
    );

    expect(result.exitCode).toBe(0);

    // Verify sitemap.json was written and is valid JSON.
    const sitemapPath = join(tmpDir, 'sitemap.json');
    expect(existsSync(sitemapPath)).toBe(true);
    const sitemap = JSON.parse(await readFile(sitemapPath, 'utf-8'));
    expect(Array.isArray(sitemap)).toBe(true);
  });
});
