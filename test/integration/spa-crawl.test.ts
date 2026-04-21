/**
 * Integration tests for SPA crawling against the fixture app.
 *
 * These tests drive the REAL orchestrator (src/crawl/orchestrator.ts)
 * against the SPA fixtures (/spa, /hash-app). Earlier revisions wrote
 * an inline pushState interceptor — that's the same code we ship in
 * src/instrumentation/init-script.ts, just duplicated. Now we run
 * the real init script through `dig()` and inspect the produced
 * artifacts.
 *
 * Gated on Chromium via `describe.skipIf(!hasChromium)`.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { dig } from '../../src/crawl/orchestrator.js';
import { resolveConfig } from '../../src/types/config.js';
import { startTestApp, type TestAppHandle } from '../fixtures/test-app/setup.js';
import { hasChromium } from '../helpers/has-chromium.js';

describe.skipIf(!hasChromium)('SPA Crawling (real orchestrator)', () => {
  let app: TestAppHandle;

  beforeAll(async () => {
    app = await startTestApp();
  });

  afterAll(async () => {
    await app?.close();
  });

  let outDir: string;

  beforeEach(async () => {
    outDir = await mkdtemp(join(tmpdir(), 'pa-int-spa-'));
  });

  afterAll(async () => {
    if (outDir) await rm(outDir, { recursive: true, force: true }).catch(() => {});
  });

  async function crawl(
    targetPath: string,
    overrides: Record<string, unknown> = {},
  ): Promise<{
    result: Awaited<ReturnType<typeof dig>>;
    sitemap: Array<{ url: string; statusCode?: number }>;
  }> {
    const config = resolveConfig({
      targetUrl: `${app.url}${targetPath}`,
      outputDir: outDir,
      depth: 1,
      maxPages: 10,
      concurrency: 1,
      noHar: true,
      noScreenshots: true,
      allowPrivate: true,
      deepClick: true,
      ...overrides,
    });
    const result = await dig(config);
    const sitemap = JSON.parse(
      await readFile(join(outDir, 'sitemap.json'), 'utf-8'),
    );
    return { result, sitemap };
  }

  // -----------------------------------------------------------------------
  // Hash-routed SPA
  //
  // The /hash-app fixture has links like <a href="#/settings">. The real
  // orchestrator should detect hash routes and record at least the entry
  // URL successfully.
  // -----------------------------------------------------------------------

  describe('hash-routed SPA', () => {
    it('crawls /hash-app and writes a valid sitemap', async () => {
      const { result, sitemap } = await crawl('/hash-app');
      expect(result.completionStatus).toMatch(/^(complete|max_pages_reached)$/);
      expect(Array.isArray(sitemap)).toBe(true);
      expect(sitemap.length).toBeGreaterThanOrEqual(1);
      // At least one entry corresponds to the hash-app origin.
      expect(sitemap.some((r) => r.url.includes('/hash-app'))).toBe(true);
    });
  });

  // -----------------------------------------------------------------------
  // pushState SPA
  //
  // The /spa fixture uses pushState via button clicks. With deep-click
  // enabled the orchestrator clicks non-link interactive elements; we
  // assert the crawl produces a sitemap and does not crash.
  // -----------------------------------------------------------------------

  describe('pushState SPA', () => {
    it('crawls /spa without crashing', async () => {
      const { result, sitemap } = await crawl('/spa');
      expect(result.completionStatus).toMatch(/^(complete|max_pages_reached)$/);
      expect(Array.isArray(sitemap)).toBe(true);
      expect(sitemap.length).toBeGreaterThanOrEqual(1);
    });
  });

  // -----------------------------------------------------------------------
  // The real init-script must inject into pages without breaking them.
  // We assert that the crawl-summary reflects a successful crawl of at
  // least the entry page (errors may be present for other reasons, but
  // the root page visit should work).
  // -----------------------------------------------------------------------

  describe('init-script injection', () => {
    it('does not break page loads on a static page', async () => {
      const { result } = await crawl('/about', { depth: 0, maxPages: 1 });
      const summary = JSON.parse(
        await readFile(join(outDir, 'crawl-summary.json'), 'utf-8'),
      );
      expect(summary.pagesVisited).toBeGreaterThanOrEqual(1);
      expect(result.completionStatus).toMatch(/^(complete|max_pages_reached)$/);
    });
  });
});
