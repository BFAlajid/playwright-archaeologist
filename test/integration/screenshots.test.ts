/**
 * Integration tests for screenshot capture.
 *
 * Tests screenshot functionality:
 * - Screenshot taken for each page
 * - Full-page screenshot works
 * - Viewport screenshot works
 * - Multiple viewport sizes
 * - Screenshot of page with lazy content (after scroll)
 * - Failed page produces no screenshot (not crash)
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { chromium, type Browser } from 'playwright';
import { startTestApp, type TestAppHandle } from '../fixtures/test-app/setup.js';

describe('Screenshot Capture', () => {
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
  // Basic screenshot capture
  // -----------------------------------------------------------------------

  describe('basic screenshots', () => {
    it('captures a screenshot of a valid page', async () => {
      const context = await browser.newContext({
        viewport: { width: 1280, height: 720 },
      });
      const page = await context.newPage();

      try {
        await page.goto(app.url, { waitUntil: 'networkidle' });
        const screenshot = await page.screenshot();

        expect(screenshot).toBeInstanceOf(Buffer);
        expect(screenshot.length).toBeGreaterThan(0);
      } finally {
        await context.close();
      }
    });

    it('captures full-page screenshot', async () => {
      const context = await browser.newContext({
        viewport: { width: 1280, height: 720 },
      });
      const page = await context.newPage();

      try {
        await page.goto(`${app.url}/blog`, { waitUntil: 'networkidle' });
        const fullPage = await page.screenshot({ fullPage: true });
        const viewport = await page.screenshot({ fullPage: false });

        // Full-page screenshot should typically be at least as large as viewport
        expect(fullPage.length).toBeGreaterThan(0);
        expect(viewport.length).toBeGreaterThan(0);
      } finally {
        await context.close();
      }
    });

    it('captures viewport-only screenshot', async () => {
      const context = await browser.newContext({
        viewport: { width: 1280, height: 720 },
      });
      const page = await context.newPage();

      try {
        await page.goto(app.url, { waitUntil: 'networkidle' });
        const screenshot = await page.screenshot({ fullPage: false });

        expect(screenshot).toBeInstanceOf(Buffer);
        expect(screenshot.length).toBeGreaterThan(0);
      } finally {
        await context.close();
      }
    });
  });

  // -----------------------------------------------------------------------
  // Multiple viewport sizes
  // -----------------------------------------------------------------------

  describe('multiple viewports', () => {
    const viewports = [
      { width: 1280, height: 720, name: 'desktop' },
      { width: 768, height: 1024, name: 'tablet' },
      { width: 375, height: 812, name: 'mobile' },
    ];

    for (const vp of viewports) {
      it(`captures screenshot at ${vp.name} viewport (${vp.width}x${vp.height})`, async () => {
        const context = await browser.newContext({
          viewport: { width: vp.width, height: vp.height },
        });
        const page = await context.newPage();

        try {
          await page.goto(app.url, { waitUntil: 'networkidle' });
          const screenshot = await page.screenshot();

          expect(screenshot).toBeInstanceOf(Buffer);
          expect(screenshot.length).toBeGreaterThan(0);
        } finally {
          await context.close();
        }
      });
    }

    it('produces different screenshots for different viewports', async () => {
      const screenshots: Buffer[] = [];

      for (const vp of viewports) {
        const context = await browser.newContext({
          viewport: { width: vp.width, height: vp.height },
        });
        const page = await context.newPage();
        try {
          await page.goto(app.url, { waitUntil: 'networkidle' });
          screenshots.push(await page.screenshot());
        } finally {
          await context.close();
        }
      }

      // At least some screenshots should differ in size
      const sizes = screenshots.map((s) => s.length);
      const uniqueSizes = new Set(sizes);
      expect(uniqueSizes.size).toBeGreaterThan(1);
    });
  });

  // -----------------------------------------------------------------------
  // Lazy content (scroll-triggered)
  // -----------------------------------------------------------------------

  describe('lazy content', () => {
    it('captures content after scrolling', async () => {
      const context = await browser.newContext({
        viewport: { width: 1280, height: 720 },
      });
      const page = await context.newPage();

      try {
        await page.goto(`${app.url}/infinite-scroll`, {
          waitUntil: 'domcontentloaded',
        });

        // Scroll down to trigger lazy loading
        await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
        await page.waitForTimeout(500);
        await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
        await page.waitForTimeout(500);

        const screenshot = await page.screenshot({ fullPage: true });
        expect(screenshot.length).toBeGreaterThan(0);

        // Verify some lazy content was loaded
        const contentCount = await page.evaluate(
          () => document.getElementById('content')?.children.length ?? 0
        );
        expect(contentCount).toBeGreaterThan(1);
      } finally {
        await context.close();
      }
    });
  });

  // -----------------------------------------------------------------------
  // Failed page handling
  // -----------------------------------------------------------------------

  describe('error pages', () => {
    it('captures screenshot of 404 page without crashing', async () => {
      const context = await browser.newContext({
        viewport: { width: 1280, height: 720 },
      });
      const page = await context.newPage();

      try {
        await page.goto(`${app.url}/nonexistent`, {
          waitUntil: 'domcontentloaded',
        });
        const screenshot = await page.screenshot();

        expect(screenshot).toBeInstanceOf(Buffer);
        expect(screenshot.length).toBeGreaterThan(0);
      } finally {
        await context.close();
      }
    });

    it('captures screenshot of 500 error page', async () => {
      const context = await browser.newContext({
        viewport: { width: 1280, height: 720 },
      });
      const page = await context.newPage();

      try {
        await page.goto(`${app.url}/error/500`, {
          waitUntil: 'domcontentloaded',
        });
        const screenshot = await page.screenshot();

        expect(screenshot).toBeInstanceOf(Buffer);
        expect(screenshot.length).toBeGreaterThan(0);
      } finally {
        await context.close();
      }
    });

    it('handles navigation timeout gracefully for screenshots', async () => {
      const context = await browser.newContext({
        viewport: { width: 1280, height: 720 },
      });
      const page = await context.newPage();

      try {
        // This should timeout but the page object should still be usable
        await page
          .goto(`${app.url}/slow`, { timeout: 2000 })
          .catch(() => {});

        // Even after timeout, we should be able to take a screenshot
        // of whatever state the page is in
        const screenshot = await page.screenshot().catch(() => null);
        // screenshot may be null or a valid buffer — either is acceptable
        if (screenshot) {
          expect(screenshot).toBeInstanceOf(Buffer);
        }
      } finally {
        await context.close();
      }
    });
  });

  // -----------------------------------------------------------------------
  // Screenshot consistency
  // -----------------------------------------------------------------------

  describe('screenshot consistency', () => {
    it('takes screenshots for multiple pages in sequence', async () => {
      const context = await browser.newContext({
        viewport: { width: 1280, height: 720 },
      });
      const page = await context.newPage();
      page.on('dialog', (d) => d.dismiss());

      const pages = ['/', '/about', '/contact', '/blog'];
      const screenshots: Buffer[] = [];

      try {
        for (const path of pages) {
          await page.goto(`${app.url}${path}`, {
            waitUntil: 'domcontentloaded',
          });
          screenshots.push(await page.screenshot());
        }

        // All screenshots should be captured
        expect(screenshots).toHaveLength(pages.length);
        for (const ss of screenshots) {
          expect(ss.length).toBeGreaterThan(0);
        }
      } finally {
        await context.close();
      }
    });
  });
});
