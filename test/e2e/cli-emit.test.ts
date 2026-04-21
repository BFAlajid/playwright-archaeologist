/**
 * End-to-end tests for `pa emit-tests`.
 *
 * These tests run the compiled CLI binary against a synthetic bundle on
 * disk. No browser is launched — `emit-tests` is pure filesystem work —
 * so these run in any environment where `dist/cli.js` exists.
 *
 * Pre-requisite: `npm run build` must have produced `dist/cli.js`, the
 * same contract as `test/e2e/cli.test.ts`.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execa } from 'execa';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..', '..');
const CLI_ENTRY = join(ROOT, 'bin', 'cli.js');
const DIST_CLI = join(ROOT, 'dist', 'cli.js');

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

async function buildBundle(bundleDir: string): Promise<void> {
  const dataDir = join(bundleDir, 'data');
  await mkdir(dataDir, { recursive: true });

  await writeFile(
    join(dataDir, 'sitemap.json'),
    JSON.stringify([
      { url: 'https://app.example.com/', title: 'Home', statusCode: 200, depth: 0 },
      { url: 'https://app.example.com/users', title: 'Users', statusCode: 200, depth: 1 },
    ]),
  );
  await writeFile(
    join(dataDir, 'crawl-summary.json'),
    JSON.stringify({ targetUrl: 'https://app.example.com/' }),
  );
  await writeFile(
    join(dataDir, 'forms.json'),
    JSON.stringify([
      {
        action: 'https://app.example.com/login',
        method: 'POST',
        fields: [
          { name: 'email', type: 'email', required: true },
          { name: 'password', type: 'password', required: true },
        ],
        submitButtonText: 'Log in',
      },
    ]),
  );
  await writeFile(
    join(dataDir, 'api-map.json'),
    JSON.stringify([
      {
        pattern: '/api/users',
        method: 'GET',
        observedUrls: ['https://app.example.com/api/users'],
        exampleResponse: { statusCode: 200, contentType: 'application/json' },
      },
    ]),
  );
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

let tempRoot: string;

beforeEach(async () => {
  tempRoot = await mkdtemp(join(tmpdir(), 'pa-cli-emit-'));
});

afterEach(async () => {
  await rm(tempRoot, { recursive: true, force: true }).catch(() => { /* noop */ });
});

describe('pa emit-tests', () => {
  it('exits 0 and emits expected spec files for a valid bundle', async () => {
    const bundleDir = join(tempRoot, 'bundle');
    const outputDir = join(tempRoot, 'out');
    await buildBundle(bundleDir);

    const result = await runCli(['emit-tests', bundleDir, '-o', outputDir], 30_000);

    expect(result.exitCode).toBe(0);
    expect(result.combined.toLowerCase()).toContain('emitted');

    const rootEntries = await readdir(outputDir);
    expect(rootEntries).toContain('smoke.spec.ts');
    expect(rootEntries).toContain('forms');
    expect(rootEntries).toContain('api');
  });

  it('exits non-zero with a clear error when the bundle dir is missing', async () => {
    const outputDir = join(tempRoot, 'out');
    const missing = join(tempRoot, 'no-such-bundle');

    const result = await runCli(['emit-tests', missing, '-o', outputDir]);

    expect(result.exitCode).not.toBe(0);
    expect(result.combined.toLowerCase()).toMatch(/bundle|not found|emit error/);
  });

  it('exits non-zero when --flows-only and --forms-only are combined', async () => {
    const bundleDir = join(tempRoot, 'bundle');
    const outputDir = join(tempRoot, 'out');
    await buildBundle(bundleDir);

    const result = await runCli([
      'emit-tests',
      bundleDir,
      '-o',
      outputDir,
      '--flows-only',
      '--forms-only',
    ]);

    expect(result.exitCode).not.toBe(0);
    expect(result.combined.toLowerCase()).toMatch(/mutually exclusive|configuration/);
  });
});
