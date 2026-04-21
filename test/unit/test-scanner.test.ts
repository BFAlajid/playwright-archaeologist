/**
 * Unit tests for the Playwright test scanner.
 *
 * Covers regex-based extraction of:
 *   - page.goto / page.navigate with string, double-quoted, and template
 *     literal arguments
 *   - request.get / request.post / request.put / request.patch /
 *     request.delete / request.head / request.fetch / request.options
 *   - apiRequestContext.<verb>
 *   - process.env.BASE_URL substitution via options.baseUrl
 *   - commented-out lines are ignored
 *   - multi-line call patterns
 *   - .mjs / .spec.ts / .test.ts file extensions are all walked
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  extractReferencesFromSource,
  resolveRawUrl,
  scanTestDirectory,
} from '../../src/coverage/test-scanner.js';

// ---------------------------------------------------------------------------
// extractReferencesFromSource
// ---------------------------------------------------------------------------

describe('extractReferencesFromSource', () => {
  it('matches page.goto with single, double, and template literals', () => {
    const src = `
      import { test } from '@playwright/test';
      test('a', async ({ page }) => {
        await page.goto('https://app.example.com/users');
        await page.goto("https://app.example.com/orders");
        await page.goto(\`https://app.example.com/settings\`);
      });
    `;
    const refs = extractReferencesFromSource(src, 'a.spec.ts', undefined);
    expect(refs.map((r) => r.resolvedUrl)).toEqual([
      'https://app.example.com/users',
      'https://app.example.com/orders',
      'https://app.example.com/settings',
    ]);
    for (const r of refs) {
      expect(r.method).toBe('GET');
      expect(r.filePath).toBe('a.spec.ts');
    }
  });

  it('extracts HTTP methods from request.get / request.post / etc.', () => {
    const src = `
      await request.get('https://api.example.com/users');
      await request.post('https://api.example.com/users', { data: { x: 1 } });
      await request.put('https://api.example.com/users/1');
      await request.patch('https://api.example.com/users/1');
      await request.delete('https://api.example.com/users/1');
      await request.head('https://api.example.com/healthz');
      await request.options('https://api.example.com/users');
      await request.fetch('https://api.example.com/pets');
    `;
    const refs = extractReferencesFromSource(src, 'api.spec.ts', undefined);
    const methods = refs.map((r) => `${r.method} ${r.resolvedUrl}`);
    expect(methods).toEqual([
      'GET https://api.example.com/users',
      'POST https://api.example.com/users',
      'PUT https://api.example.com/users/1',
      'PATCH https://api.example.com/users/1',
      'DELETE https://api.example.com/users/1',
      'HEAD https://api.example.com/healthz',
      'OPTIONS https://api.example.com/users',
      'GET https://api.example.com/pets',
    ]);
  });

  it('matches apiRequestContext aliases', () => {
    const src = `
      await apiRequestContext.get('https://api.example.com/orders');
      await apiRequest.post('https://api.example.com/orders');
    `;
    const refs = extractReferencesFromSource(src, 'api.spec.ts', undefined);
    expect(refs).toHaveLength(2);
    expect(refs[0].method).toBe('GET');
    expect(refs[1].method).toBe('POST');
  });

  it('substitutes ${process.env.BASE_URL} when baseUrl is provided', () => {
    const src = 'await page.goto(`${process.env.BASE_URL}/users`);';
    const refs = extractReferencesFromSource(src, 'a.spec.ts', 'https://prod.example.com/');
    expect(refs).toHaveLength(1);
    expect(refs[0].rawUrl).toBe('${process.env.BASE_URL}/users');
    expect(refs[0].resolvedUrl).toBe('https://prod.example.com/users');
  });

  it('substitutes ${BASE_URL} / ${baseURL} / ${baseUrl} aliases', () => {
    const src = `
      await page.goto(\`\${BASE_URL}/a\`);
      await page.goto(\`\${baseURL}/b\`);
      await page.goto(\`\${baseUrl}/c\`);
    `;
    const refs = extractReferencesFromSource(src, 'a.spec.ts', 'https://prod.example.com');
    expect(refs.map((r) => r.resolvedUrl)).toEqual([
      'https://prod.example.com/a',
      'https://prod.example.com/b',
      'https://prod.example.com/c',
    ]);
  });

  it('leaves unknown ${...} placeholders as a marker token', () => {
    const src = 'await page.goto(`https://app.example.com/users/${userId}`);';
    const refs = extractReferencesFromSource(src, 'a.spec.ts', 'https://prod.example.com');
    expect(refs).toHaveLength(1);
    // Unknown placeholder -> __PA_TEMPLATE__ marker
    expect(refs[0].resolvedUrl).toBe('https://app.example.com/users/__PA_TEMPLATE__');
  });

  it('skips single-line commented-out calls', () => {
    const src = `
      // await page.goto('https://skip-me.example.com/');
      await page.goto('https://keep.example.com/');
      /* await request.get('https://block-comment-skip.example.com/'); */
      await request.get('https://keep-api.example.com/');
    `;
    const refs = extractReferencesFromSource(src, 'a.spec.ts', undefined);
    expect(refs.map((r) => r.resolvedUrl)).toEqual([
      'https://keep.example.com/',
      'https://keep-api.example.com/',
    ]);
  });

  it('handles multi-line page.goto calls', () => {
    const src = `
      await page.goto(
        'https://app.example.com/multiline-route'
      );
    `;
    const refs = extractReferencesFromSource(src, 'a.spec.ts', undefined);
    expect(refs).toHaveLength(1);
    expect(refs[0].resolvedUrl).toBe('https://app.example.com/multiline-route');
  });

  it('records accurate line numbers', () => {
    const src = [
      '// line 1',
      'import { test } from "@playwright/test";',
      '',
      'test("a", async ({ page }) => {',
      "  await page.goto('https://app.example.com/page-on-line-5');",
      '});',
    ].join('\n');
    const refs = extractReferencesFromSource(src, 'a.spec.ts', undefined);
    expect(refs).toHaveLength(1);
    expect(refs[0].lineNumber).toBe(5);
  });

  it('skips calls with non-literal URL arguments', () => {
    const src = `
      const url = 'https://dynamic.example.com/';
      await page.goto(url);
      await request.get(buildUrl());
    `;
    const refs = extractReferencesFromSource(src, 'a.spec.ts', undefined);
    expect(refs).toHaveLength(0);
  });

  it('deduplicates overlapping regex matches on the same line', () => {
    // page.goto is always matched — the duplicate regex patterns should
    // not produce two refs for the same call.
    const src = "await page.goto('https://app.example.com/x');";
    const refs = extractReferencesFromSource(src, 'a.spec.ts', undefined);
    expect(refs).toHaveLength(1);
  });

  it('does not leak quotes when the string contains escaped chars', () => {
    const src = "await page.goto('https://app.example.com/users?q=hi\\n');";
    const refs = extractReferencesFromSource(src, 'a.spec.ts', undefined);
    expect(refs).toHaveLength(1);
    // The raw URL preserves the escape sequence as-written.
    expect(refs[0].rawUrl).toContain('\\n');
  });

  it('matches page.navigate as a GET', () => {
    const src = `await page.navigate('https://app.example.com/via-navigate');`;
    const refs = extractReferencesFromSource(src, 'a.spec.ts', undefined);
    expect(refs).toHaveLength(1);
    expect(refs[0].method).toBe('GET');
  });
});

// ---------------------------------------------------------------------------
// resolveRawUrl
// ---------------------------------------------------------------------------

describe('resolveRawUrl', () => {
  it('returns the raw URL unchanged when there are no placeholders', () => {
    expect(resolveRawUrl('https://x/y', 'https://base')).toBe('https://x/y');
  });

  it('strips trailing slash from the baseUrl when substituting', () => {
    expect(resolveRawUrl('${BASE_URL}/x', 'https://base.example.com/')).toBe(
      'https://base.example.com/x',
    );
  });

  it('leaves baseUrl substitution out when baseUrl is not provided', () => {
    const out = resolveRawUrl('${BASE_URL}/x', undefined);
    // With no baseUrl, BASE_URL is treated as an unknown placeholder
    // and substituted with the marker token.
    expect(out).toContain('__PA_TEMPLATE__');
  });
});

// ---------------------------------------------------------------------------
// scanTestDirectory — integration-style with a tmp directory
// ---------------------------------------------------------------------------

describe('scanTestDirectory', () => {
  let tmpRoot: string;

  beforeEach(async () => {
    tmpRoot = await mkdtemp(join(tmpdir(), 'pa-test-scanner-'));
  });

  afterEach(async () => {
    await rm(tmpRoot, { recursive: true, force: true });
  });

  it('walks nested directories and extracts references from multiple extensions', async () => {
    await mkdir(join(tmpRoot, 'a', 'nested'), { recursive: true });

    await writeFile(
      join(tmpRoot, 'a.spec.ts'),
      "await page.goto('https://x/a');",
    );
    await writeFile(
      join(tmpRoot, 'a', 'b.test.ts'),
      "await page.goto('https://x/b');",
    );
    await writeFile(
      join(tmpRoot, 'a', 'nested', 'c.spec.mjs'),
      "await page.goto('https://x/c');",
    );
    // File that should not be picked up.
    await writeFile(
      join(tmpRoot, 'a', 'not-a-spec.txt'),
      "await page.goto('https://x/skip');",
    );

    const refs = await scanTestDirectory(tmpRoot);
    const urls = refs.map((r) => r.resolvedUrl).sort();
    expect(urls).toEqual(['https://x/a', 'https://x/b', 'https://x/c']);
  });

  it('skips node_modules and .git directories', async () => {
    await mkdir(join(tmpRoot, 'node_modules', 'pkg'), { recursive: true });
    await mkdir(join(tmpRoot, '.git'), { recursive: true });

    await writeFile(
      join(tmpRoot, 'node_modules', 'pkg', 'leak.spec.ts'),
      "await page.goto('https://x/leak');",
    );
    await writeFile(
      join(tmpRoot, '.git', 'leak.spec.ts'),
      "await page.goto('https://x/leak');",
    );
    await writeFile(
      join(tmpRoot, 'keep.spec.ts'),
      "await page.goto('https://x/keep');",
    );

    const refs = await scanTestDirectory(tmpRoot);
    expect(refs.map((r) => r.resolvedUrl)).toEqual(['https://x/keep']);
  });

  it('returns an empty array when no test files are present', async () => {
    await writeFile(join(tmpRoot, 'README.md'), 'no tests here');
    const refs = await scanTestDirectory(tmpRoot);
    expect(refs).toEqual([]);
  });

  it('throws when the path is not a directory', async () => {
    await expect(
      scanTestDirectory(join(tmpRoot, 'does-not-exist')),
    ).rejects.toThrow();
  });
});
