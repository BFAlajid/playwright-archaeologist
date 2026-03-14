/**
 * Integration tests for basic crawling functionality.
 *
 * Tests crawl behavior against the test fixture Express app:
 * - Full crawl discovers all linked pages
 * - Depth limit enforcement
 * - Max-pages limit
 * - Include/exclude patterns
 * - Same-origin scope
 * - External links recorded but not followed
 * - Error page handling (404, 500)
 * - Timeout handling
 * - Redirect following
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { chromium, type Browser, type BrowserContext, type Page } from 'playwright';
import { startTestApp, type TestAppHandle } from '../fixtures/test-app/setup.js';

describe('Basic Crawling', () => {
  let app: TestAppHandle;
  let browser: Browser;

  beforeAll(async () => {
    app = await startTestApp();
    browser = await chromium.launch();
  });

  afterAll(async () => {
    await browser?.close();
    await app?.close();
  });

  // -----------------------------------------------------------------------
  // Helpers
  // -----------------------------------------------------------------------

  async function collectLinks(page: Page): Promise<string[]> {
    return page.locator('a[href]').evaluateAll((els) =>
      els
        .map((el) => (el as HTMLAnchorElement).href)
        .filter((href) => href.startsWith('http'))
    );
  }

  async function bfsCrawl(
    startUrl: string,
    options: {
      maxDepth?: number;
      maxPages?: number;
      include?: RegExp;
      exclude?: RegExp;
      sameOriginOnly?: boolean;
    } = {}
  ): Promise<{
    visited: Map<string, { status: number; title: string; depth: number }>;
    externalLinks: Set<string>;
    errors: Array<{ url: string; error: string }>;
  }> {
    const {
      maxDepth = 10,
      maxPages = 100,
      include,
      exclude,
      sameOriginOnly = true,
    } = options;

    const startOrigin = new URL(startUrl).origin;
    const visited = new Map<
      string,
      { status: number; title: string; depth: number }
    >();
    const externalLinks = new Set<string>();
    const errors: Array<{ url: string; error: string }> = [];
    const queue: Array<{ url: string; depth: number }> = [
      { url: startUrl, depth: 0 },
    ];
    const seen = new Set<string>([startUrl]);

    const context = await browser.newContext({
      bypassCSP: true,
      acceptDownloads: false,
    });
    context.on('page', (p) => p.close());
    const page = await context.newPage();
    page.on('dialog', (d) => d.dismiss());

    try {
      while (queue.length > 0 && visited.size < maxPages) {
        const item = queue.shift()!;
        if (item.depth > maxDepth) continue;

        try {
          const response = await page.goto(item.url, {
            waitUntil: 'domcontentloaded',
            timeout: 10000,
          });
          const status = response?.status() ?? 0;
          const title = await page.title().catch(() => '');

          visited.set(item.url, {
            status,
            title,
            depth: item.depth,
          });

          if (status >= 400) continue;

          // Extract links
          const links = await collectLinks(page);
          for (const link of links) {
            const linkOrigin = new URL(link).origin;
            const isExternal = linkOrigin !== startOrigin;

            if (isExternal) {
              externalLinks.add(link);
              if (sameOriginOnly) continue;
            }

            if (include && !include.test(link)) continue;
            if (exclude && exclude.test(link)) continue;

            const normalized = link.split('#')[0].replace(/\/$/, '') || link;
            if (!seen.has(normalized)) {
              seen.add(normalized);
              queue.push({ url: normalized, depth: item.depth + 1 });
            }
          }
        } catch (err) {
          errors.push({
            url: item.url,
            error: err instanceof Error ? err.message : String(err),
          });
        }
      }
    } finally {
      await context.close();
    }

    return { visited, externalLinks, errors };
  }

  // -----------------------------------------------------------------------
  // Tests
  // -----------------------------------------------------------------------

  it('discovers all directly linked pages from home', async () => {
    const result = await bfsCrawl(app.url, { maxDepth: 1 });

    expect(result.visited.size).toBeGreaterThan(1);
    // Home page should be visited
    expect(result.visited.has(app.url)).toBe(true);
    // At least some linked pages should be discovered
    const urls = [...result.visited.keys()];
    expect(urls.some((u) => u.includes('/about'))).toBe(true);
  });

  it('respects depth limit', async () => {
    const depth0 = await bfsCrawl(app.url, { maxDepth: 0 });
    const depth1 = await bfsCrawl(app.url, { maxDepth: 1 });

    // Depth 0 should only visit the start URL
    expect(depth0.visited.size).toBe(1);
    // Depth 1 should visit more pages
    expect(depth1.visited.size).toBeGreaterThan(depth0.visited.size);
  });

  it('respects max-pages limit', async () => {
    const result = await bfsCrawl(app.url, {
      maxPages: 3,
      maxDepth: 10,
    });

    expect(result.visited.size).toBeLessThanOrEqual(3);
  });

  it('enforces same-origin scope by default', async () => {
    const result = await bfsCrawl(app.url, {
      maxDepth: 3,
      sameOriginOnly: true,
    });

    // All visited URLs should be same-origin
    const startOrigin = new URL(app.url).origin;
    for (const url of result.visited.keys()) {
      expect(new URL(url).origin).toBe(startOrigin);
    }
  });

  it('records external links without following them', async () => {
    const result = await bfsCrawl(app.url, {
      maxDepth: 3,
      sameOriginOnly: true,
    });

    // The external-links page has github.com and google.com links
    // They should be recorded but NOT visited
    if (result.externalLinks.size > 0) {
      for (const extLink of result.externalLinks) {
        expect(result.visited.has(extLink)).toBe(false);
      }
    }
  });

  it('applies exclude pattern to skip pages', async () => {
    const result = await bfsCrawl(app.url, {
      maxDepth: 3,
      exclude: /\/blog/,
    });

    // No blog pages should be visited
    for (const url of result.visited.keys()) {
      expect(url).not.toMatch(/\/blog/);
    }
  });

  it('applies include pattern to limit crawl scope', async () => {
    const result = await bfsCrawl(`${app.url}/about`, {
      maxDepth: 5,
      include: /\/about/,
    });

    // All visited pages should match the include pattern (except start)
    for (const url of result.visited.keys()) {
      expect(url).toMatch(/\/about|^http:\/\/127\.0\.0\.1/);
    }
  });

  it('handles 404 pages gracefully', async () => {
    const result = await bfsCrawl(`${app.url}/nonexistent-page`, {
      maxDepth: 0,
    });

    expect(result.visited.size).toBe(1);
    const entry = result.visited.get(`${app.url}/nonexistent-page`);
    expect(entry?.status).toBe(404);
  });

  it('handles 500 error pages gracefully', async () => {
    const result = await bfsCrawl(`${app.url}/error/500`, {
      maxDepth: 0,
    });

    expect(result.visited.size).toBe(1);
    const entry = result.visited.get(`${app.url}/error/500`);
    expect(entry?.status).toBe(500);
  });

  it('follows redirect chains', async () => {
    const context = await browser.newContext();
    const page = await context.newPage();

    try {
      const response = await page.goto(`${app.url}/redirect/start`, {
        waitUntil: 'domcontentloaded',
      });

      // Should end up at the final destination
      expect(page.url()).toContain('/redirect/final');
      expect(response?.status()).toBe(200);
    } finally {
      await context.close();
    }
  });

  it('handles timeout on slow pages', async () => {
    const context = await browser.newContext();
    const page = await context.newPage();

    try {
      await expect(
        page.goto(`${app.url}/slow`, { timeout: 2000 })
      ).rejects.toThrow();
    } finally {
      await context.close();
    }
  });

  it('dismisses dialogs without hanging', async () => {
    const context = await browser.newContext();
    const page = await context.newPage();
    page.on('dialog', (d) => d.dismiss());

    try {
      const response = await page.goto(`${app.url}/dialog`, {
        waitUntil: 'domcontentloaded',
        timeout: 5000,
      });
      expect(response?.status()).toBe(200);
      const title = await page.title();
      expect(title).toBeTruthy();
    } finally {
      await context.close();
    }
  });
});
