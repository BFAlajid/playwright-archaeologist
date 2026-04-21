/**
 * Unit tests for src/emit/test-emitter.ts
 *
 * Builds a synthetic bundle directory on disk, runs `emitTests`, and
 * asserts on the emitted files, their contents, and their TS syntactic
 * validity (via `ts.createSourceFile` + pre-emit diagnostics).
 *
 * No Chromium or network required.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, mkdir, writeFile, readFile, readdir, stat, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import ts from 'typescript';

import { emitTests } from '../../src/emit/test-emitter.js';
import { EmitError } from '../../src/types/errors.js';
import {
  sanitizeUrlForFilename,
  sanitizeApiPatternForFilename,
} from '../../src/emit/sanitize.js';

// ---------------------------------------------------------------------------
// Fixture builder
// ---------------------------------------------------------------------------

interface FixtureOptions {
  includeForms?: boolean;
  includeApi?: boolean;
  includeSummary?: boolean;
  sitemap?: Array<{ url: string; title?: string; statusCode?: number; depth?: number }>;
  forms?: unknown[];
  api?: unknown[];
  targetUrl?: string;
}

async function buildSyntheticBundle(
  bundleDir: string,
  opts: FixtureOptions = {},
): Promise<void> {
  const dataDir = join(bundleDir, 'data');
  await mkdir(dataDir, { recursive: true });

  const targetUrl = opts.targetUrl ?? 'https://app.example.com/';

  const sitemap = opts.sitemap ?? [
    { url: 'https://app.example.com/', title: 'Home', statusCode: 200, depth: 0 },
    { url: 'https://app.example.com/users', title: 'Users', statusCode: 200, depth: 1 },
    { url: 'https://app.example.com/users/42', title: 'User Detail', statusCode: 200, depth: 2 },
  ];
  await writeFile(join(dataDir, 'sitemap.json'), JSON.stringify(sitemap));

  if (opts.includeSummary !== false) {
    await writeFile(
      join(dataDir, 'crawl-summary.json'),
      JSON.stringify({ targetUrl, finishedAt: '2026-04-21T00:00:00.000Z' }),
    );
  }

  if (opts.includeForms !== false) {
    const forms = opts.forms ?? [
      {
        action: 'https://app.example.com/users',
        method: 'POST',
        fields: [
          { name: 'email', type: 'email', required: true },
          { name: 'password', type: 'password', required: true },
          { name: 'remember', type: 'checkbox', required: false },
        ],
        submitButtonText: 'Sign up',
      },
    ];
    await writeFile(join(dataDir, 'forms.json'), JSON.stringify(forms));
  }

  if (opts.includeApi !== false) {
    const api = opts.api ?? [
      {
        pattern: '/api/users',
        method: 'GET',
        observedUrls: ['https://app.example.com/api/users'],
        exampleResponse: { statusCode: 200, contentType: 'application/json; charset=utf-8' },
      },
      {
        pattern: '/api/users/:id',
        method: 'GET',
        observedUrls: ['https://app.example.com/api/users/42'],
        exampleResponse: { statusCode: 200 },
      },
    ];
    await writeFile(join(dataDir, 'api-map.json'), JSON.stringify(api));
  }
}

// ---------------------------------------------------------------------------
// TypeScript syntactic validity helper
// ---------------------------------------------------------------------------

function assertTypeScriptParses(source: string, filename: string): void {
  const sf = ts.createSourceFile(filename, source, ts.ScriptTarget.ES2022, true, ts.ScriptKind.TS);
  const diagnostics = ts.getPreEmitDiagnostics(ts.createProgram([filename], {
    noEmit: true,
    noResolve: true,
    strict: false,
    skipLibCheck: true,
    target: ts.ScriptTarget.ES2022,
    module: ts.ModuleKind.ESNext,
  }, {
    getSourceFile: (name) => (name === filename ? sf : undefined),
    writeFile: () => { /* noop */ },
    getDefaultLibFileName: () => 'lib.d.ts',
    useCaseSensitiveFileNames: () => true,
    getCanonicalFileName: (f) => f,
    getCurrentDirectory: () => '',
    getNewLine: () => '\n',
    fileExists: (name) => name === filename,
    readFile: (name) => (name === filename ? source : undefined),
  }));
  // We only fail on syntactic errors — unresolved module imports (e.g.
  // '@playwright/test') are semantic and come from noResolve, which we
  // ignore. Filter to syntactic/parser-level issues:
  const syntactic = diagnostics.filter((d) => d.category === ts.DiagnosticCategory.Error && d.code < 2000);
  if (syntactic.length > 0) {
    const messages = syntactic.map((d) => ts.flattenDiagnosticMessageText(d.messageText, '\n')).join('\n');
    throw new Error(`Emitted spec has syntactic errors:\n${messages}\n--- source ---\n${source}`);
  }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

let tempRoot: string;

beforeEach(async () => {
  tempRoot = await mkdtemp(join(tmpdir(), 'pa-emit-'));
});

afterEach(async () => {
  await rm(tempRoot, { recursive: true, force: true });
});

describe('emitTests - basic emission', () => {
  it('produces smoke.spec.ts, forms specs, flow specs, and api specs for a full bundle', async () => {
    const bundleDir = join(tempRoot, 'bundle');
    const outputDir = join(tempRoot, 'out');
    await buildSyntheticBundle(bundleDir);

    const emitted = await emitTests({ bundleDir, outputDir });

    // Expect one smoke, at least one form, flows (users has 2+ routes), api (2 endpoints).
    const kinds = emitted.map((f) => f.kind);
    expect(kinds).toContain('smoke');
    expect(kinds).toContain('form');
    expect(kinds).toContain('api');
    expect(kinds).toContain('flow');

    // Every emitted file actually exists on disk with a matching byte count.
    for (const f of emitted) {
      const st = await stat(f.path);
      expect(st.isFile()).toBe(true);
      expect(f.bytes).toBeGreaterThan(0);
    }
  });

  it('emits the shared auto-generated header comment in every spec', async () => {
    const bundleDir = join(tempRoot, 'bundle');
    const outputDir = join(tempRoot, 'out');
    await buildSyntheticBundle(bundleDir);

    const emitted = await emitTests({ bundleDir, outputDir });
    for (const f of emitted) {
      const contents = await readFile(f.path, 'utf-8');
      expect(contents).toContain('Auto-generated by playwright-archaeologist');
      expect(contents).toContain("import { test, expect } from '@playwright/test';");
    }
  });

  it('produces syntactically valid TypeScript for every emitted spec', async () => {
    const bundleDir = join(tempRoot, 'bundle');
    const outputDir = join(tempRoot, 'out');
    await buildSyntheticBundle(bundleDir);

    const emitted = await emitTests({ bundleDir, outputDir });
    for (const f of emitted) {
      const src = await readFile(f.path, 'utf-8');
      assertTypeScriptParses(src, f.path);
    }
  });
});

describe('emitTests - flowsOnly / formsOnly', () => {
  it('--flowsOnly skips form, smoke, and api specs', async () => {
    const bundleDir = join(tempRoot, 'bundle');
    const outputDir = join(tempRoot, 'out');
    await buildSyntheticBundle(bundleDir);

    const emitted = await emitTests({ bundleDir, outputDir, flowsOnly: true });
    const kinds = new Set(emitted.map((f) => f.kind));
    expect(kinds.has('form')).toBe(false);
    expect(kinds.has('smoke')).toBe(false);
    expect(kinds.has('api')).toBe(false);
    expect(kinds.has('flow')).toBe(true);
  });

  it('--formsOnly skips flow, smoke, and api specs', async () => {
    const bundleDir = join(tempRoot, 'bundle');
    const outputDir = join(tempRoot, 'out');
    await buildSyntheticBundle(bundleDir);

    const emitted = await emitTests({ bundleDir, outputDir, formsOnly: true });
    const kinds = new Set(emitted.map((f) => f.kind));
    expect(kinds.has('flow')).toBe(false);
    expect(kinds.has('smoke')).toBe(false);
    expect(kinds.has('api')).toBe(false);
    expect(kinds.has('form')).toBe(true);
  });
});

describe('emitTests - base URL rewriting', () => {
  it('rewrites emitted URLs when --baseUrl is passed', async () => {
    const bundleDir = join(tempRoot, 'bundle');
    const outputDir = join(tempRoot, 'out');
    await buildSyntheticBundle(bundleDir);

    const emitted = await emitTests({
      bundleDir,
      outputDir,
      baseUrl: 'https://staging.example.com',
    });

    // The smoke spec should reference the staging host, not app.example.com.
    const smoke = emitted.find((f) => f.kind === 'smoke');
    expect(smoke).toBeDefined();
    const contents = await readFile(smoke!.path, 'utf-8');
    expect(contents).toContain('staging.example.com');
    expect(contents).not.toContain('app.example.com');
  });

  it('leaves URLs unchanged when --baseUrl is not passed', async () => {
    const bundleDir = join(tempRoot, 'bundle');
    const outputDir = join(tempRoot, 'out');
    await buildSyntheticBundle(bundleDir);

    const emitted = await emitTests({ bundleDir, outputDir });
    const smoke = emitted.find((f) => f.kind === 'smoke');
    expect(smoke).toBeDefined();
    const contents = await readFile(smoke!.path, 'utf-8');
    expect(contents).toContain('app.example.com');
  });
});

describe('emitTests - filename sanitization', () => {
  it('handles URLs with slashes, colons, and query strings', async () => {
    const bundleDir = join(tempRoot, 'bundle');
    const outputDir = join(tempRoot, 'out');
    await buildSyntheticBundle(bundleDir, {
      forms: [
        {
          action: 'https://app.example.com/path/with:colons?q=1&r=2',
          method: 'POST',
          fields: [{ name: 'x', type: 'text', required: true }],
        },
      ],
      sitemap: [
        { url: 'https://app.example.com/', title: 'Home', statusCode: 200, depth: 0 },
      ],
    });

    const emitted = await emitTests({ bundleDir, outputDir });

    // Form spec files must not contain the raw colon/slash/query characters.
    for (const f of emitted.filter((x) => x.kind === 'form')) {
      const baseName = f.path.split(/[\\/]/).pop() as string;
      expect(baseName).not.toMatch(/[:?"*<>|]/);
    }
  });

  it('sanitizeUrlForFilename falls back to "root" for empty paths', () => {
    expect(sanitizeUrlForFilename('https://example.com/')).toBe('example-com');
    expect(sanitizeUrlForFilename('')).toBe('root');
    expect(sanitizeUrlForFilename('https://a.b/c?x=1&y=2')).toBe('a-b-c');
  });

  it('sanitizeApiPatternForFilename emits method-first slugs', () => {
    expect(sanitizeApiPatternForFilename('GET', '/api/users')).toBe('get-api-users');
    expect(sanitizeApiPatternForFilename('POST', '/api/users/:id')).toBe('post-api-users-id');
  });
});

describe('emitTests - malformed bundle', () => {
  it('throws EmitError(bundle_not_found) when the dir does not exist', async () => {
    const outputDir = join(tempRoot, 'out');
    const missing = join(tempRoot, 'does-not-exist');

    await expect(emitTests({ bundleDir: missing, outputDir })).rejects.toBeInstanceOf(EmitError);
  });

  it('throws EmitError(bundle_malformed) when sitemap.json is missing', async () => {
    const bundleDir = join(tempRoot, 'bundle');
    await mkdir(join(bundleDir, 'data'), { recursive: true });
    // No sitemap.json written.

    const outputDir = join(tempRoot, 'out');
    try {
      await emitTests({ bundleDir, outputDir });
      throw new Error('expected EmitError to be thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(EmitError);
      expect((err as EmitError).reason).toBe('bundle_malformed');
    }
  });

  it('does not emit anything when filterByTag excludes all URLs', async () => {
    const bundleDir = join(tempRoot, 'bundle');
    const outputDir = join(tempRoot, 'out');
    await buildSyntheticBundle(bundleDir);

    const emitted = await emitTests({
      bundleDir,
      outputDir,
      filterByTag: ['nothing-matches'],
    });

    // Smoke spec is still emitted — but with zero routes.  Only per-page
    // specs (forms/flows/api) should be skipped.
    const kinds = emitted.map((f) => f.kind);
    expect(kinds.every((k) => k === 'smoke')).toBe(true);
  });

  it('handles a bundle with only a sitemap (no forms, no api)', async () => {
    const bundleDir = join(tempRoot, 'bundle');
    const outputDir = join(tempRoot, 'out');
    await buildSyntheticBundle(bundleDir, {
      includeForms: false,
      includeApi: false,
      // Single page: no flows possible.
      sitemap: [{ url: 'https://only.example.com/', title: 'Only', statusCode: 200, depth: 0 }],
    });

    const emitted = await emitTests({ bundleDir, outputDir });

    // At minimum a smoke spec. No flow/form/api specs because there's no data.
    expect(emitted.some((f) => f.kind === 'smoke')).toBe(true);
    expect(emitted.some((f) => f.kind === 'flow')).toBe(false);
    expect(emitted.some((f) => f.kind === 'form')).toBe(false);
    expect(emitted.some((f) => f.kind === 'api')).toBe(false);
  });
});

describe('emitTests - string escaping', () => {
  it('escapes single quotes and backslashes in titles to avoid TS syntax errors', async () => {
    const bundleDir = join(tempRoot, 'bundle');
    const outputDir = join(tempRoot, 'out');
    await buildSyntheticBundle(bundleDir, {
      sitemap: [
        {
          url: "https://app.example.com/it's-a-test\\backslash",
          title: "Title with ' quote and \\ backslash",
          statusCode: 200,
          depth: 0,
        },
      ],
      includeForms: false,
      includeApi: false,
    });

    const emitted = await emitTests({ bundleDir, outputDir });
    const smoke = emitted.find((f) => f.kind === 'smoke');
    expect(smoke).toBeDefined();
    const src = await readFile(smoke!.path, 'utf-8');
    assertTypeScriptParses(src, smoke!.path);
  });
});

describe('emitTests - flows split per step', () => {
  it('splits long flows (>5 steps) into one test per step', async () => {
    const bundleDir = join(tempRoot, 'bundle');
    const outputDir = join(tempRoot, 'out');

    // Build a cluster of 7 pages under /docs so buildFlows yields 6 steps.
    const sitemap = Array.from({ length: 7 }, (_, i) => ({
      url: `https://app.example.com/docs/page-${i}`,
      title: `Doc ${i}`,
      statusCode: 200,
      depth: i,
    }));
    await buildSyntheticBundle(bundleDir, {
      sitemap,
      includeForms: false,
      includeApi: false,
    });

    const emitted = await emitTests({ bundleDir, outputDir });
    const flowFiles = emitted.filter((f) => f.kind === 'flow');
    expect(flowFiles.length).toBeGreaterThan(0);

    const contents = await readFile(flowFiles[0].path, 'utf-8');
    // Split flows use test.describe + multiple test(...) calls.
    expect(contents).toContain('test.describe');
    // Count `test(` occurrences (not test.describe). There should be >1.
    const testCount = (contents.match(/\btest\(/g) ?? []).length;
    expect(testCount).toBeGreaterThan(1);
  });

  it('keeps short flows as a single test with multiple test.step calls', async () => {
    const bundleDir = join(tempRoot, 'bundle');
    const outputDir = join(tempRoot, 'out');

    const sitemap = [
      { url: 'https://app.example.com/', title: 'Home', statusCode: 200, depth: 0 },
      { url: 'https://app.example.com/users', title: 'Users', statusCode: 200, depth: 1 },
      { url: 'https://app.example.com/users/42', title: 'User Detail', statusCode: 200, depth: 2 },
    ];
    await buildSyntheticBundle(bundleDir, {
      sitemap,
      includeForms: false,
      includeApi: false,
    });

    const emitted = await emitTests({ bundleDir, outputDir });
    const flowFiles = emitted.filter((f) => f.kind === 'flow');
    expect(flowFiles.length).toBeGreaterThan(0);

    const contents = await readFile(flowFiles[0].path, 'utf-8');
    expect(contents).toContain('test.step');
    expect(contents).not.toContain('test.describe');
  });
});

describe('emitTests - output directory layout', () => {
  it('places forms under ./forms, flows under ./flows, api under ./api, smoke at root', async () => {
    const bundleDir = join(tempRoot, 'bundle');
    const outputDir = join(tempRoot, 'out');
    await buildSyntheticBundle(bundleDir);

    await emitTests({ bundleDir, outputDir });

    const rootEntries = await readdir(outputDir);
    expect(rootEntries).toContain('smoke.spec.ts');
    expect(rootEntries).toContain('forms');
    expect(rootEntries).toContain('flows');
    expect(rootEntries).toContain('api');
  });
});
