/**
 * Integration tests for SPA crawling.
 *
 * Tests client-side navigation detection:
 * - pushState navigation
 * - replaceState navigation
 * - Hash routing detection and following
 * - Click-based navigation in nav elements
 * - DOM state changes after interaction
 * - Back/forward navigation
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { chromium, type Browser, type BrowserContext, type Page } from 'playwright';
import { startTestApp, type TestAppHandle } from '../fixtures/test-app/setup.js';

describe('SPA Crawling', () => {
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

  async function createInstrumentedPage(context: BrowserContext): Promise<{
    page: Page;
    navigations: Array<{ url: string; type: string }>;
  }> {
    const navigations: Array<{ url: string; type: string }> = [];

    const page = await context.newPage();
    page.on('dialog', (d) => d.dismiss());

    // Expose navigation reporter before adding init script
    await context.exposeFunction(
      '__pa_testNavigation',
      (data: { url: string; type: string }) => {
        navigations.push(data);
      }
    );

    // Inject navigation interception
    await context.addInitScript(() => {
      const report = (window as any).__pa_testNavigation;
      if (!report) return;

      const origPush = history.pushState.bind(history);
      const origReplace = history.replaceState.bind(history);

      history.pushState = function (...args: any[]) {
        origPush(...args);
        const url = args[2]
          ? new URL(args[2] as string, location.href).href
          : location.href;
        report({ url, type: 'pushState' });
      };

      history.replaceState = function (...args: any[]) {
        origReplace(...args);
        const url = args[2]
          ? new URL(args[2] as string, location.href).href
          : location.href;
        report({ url, type: 'replaceState' });
      };

      window.addEventListener('hashchange', () => {
        report({ url: location.href, type: 'hashchange' });
      });

      window.addEventListener('popstate', () => {
        report({ url: location.href, type: 'popstate' });
      });
    });

    return { page, navigations };
  }

  // -----------------------------------------------------------------------
  // pushState navigation
  // -----------------------------------------------------------------------

  describe('pushState navigation', () => {
    it('detects pushState navigation via button clicks', async () => {
      const context = await browser.newContext({ bypassCSP: true });
      try {
        const { page, navigations } = await createInstrumentedPage(context);
        await page.goto(`${app.url}/spa`, {
          waitUntil: 'domcontentloaded',
        });

        // Click a SPA navigation button
        await page.click('button:has-text("Page A")');
        await page.waitForTimeout(500);

        // pushState should have been intercepted
        expect(navigations.length).toBeGreaterThan(0);
        expect(
          navigations.some((n) => n.type === 'pushState' && n.url.includes('/spa/page-a'))
        ).toBe(true);
      } finally {
        await context.close();
      }
    });

    it('detects URL change after pushState', async () => {
      const context = await browser.newContext({ bypassCSP: true });
      try {
        const { page } = await createInstrumentedPage(context);
        await page.goto(`${app.url}/spa`, {
          waitUntil: 'domcontentloaded',
        });

        const urlBefore = page.url();
        await page.click('button:has-text("Page A")');
        await page.waitForTimeout(300);

        expect(page.url()).not.toBe(urlBefore);
        expect(page.url()).toContain('/spa/page-a');
      } finally {
        await context.close();
      }
    });

    it('detects multiple pushState navigations', async () => {
      const context = await browser.newContext({ bypassCSP: true });
      try {
        const { page, navigations } = await createInstrumentedPage(context);
        await page.goto(`${app.url}/spa`, {
          waitUntil: 'domcontentloaded',
        });

        await page.click('button:has-text("Page A")');
        await page.waitForTimeout(300);
        await page.click('button:has-text("Page B")');
        await page.waitForTimeout(300);

        const pushStates = navigations.filter(
          (n) => n.type === 'pushState'
        );
        expect(pushStates.length).toBeGreaterThanOrEqual(2);
      } finally {
        await context.close();
      }
    });
  });

  // -----------------------------------------------------------------------
  // Hash routing
  // -----------------------------------------------------------------------

  describe('hash routing', () => {
    it('detects hash route changes', async () => {
      const context = await browser.newContext({ bypassCSP: true });
      try {
        const { page, navigations } = await createInstrumentedPage(context);
        await page.goto(`${app.url}/hash-app`, {
          waitUntil: 'domcontentloaded',
        });

        await page.click('a[href="#/settings"]');
        await page.waitForTimeout(300);

        expect(
          navigations.some((n) => n.type === 'hashchange')
        ).toBe(true);
        expect(page.url()).toContain('#/settings');
      } finally {
        await context.close();
      }
    });

    it('discovers multiple hash routes', async () => {
      const context = await browser.newContext({ bypassCSP: true });
      try {
        const { page, navigations } = await createInstrumentedPage(context);
        await page.goto(`${app.url}/hash-app`, {
          waitUntil: 'domcontentloaded',
        });

        // Click through all hash routes
        const hashLinks = await page
          .locator('a[href^="#/"]')
          .all();
        for (const link of hashLinks) {
          await link.click();
          await page.waitForTimeout(200);
        }

        const hashChanges = navigations.filter(
          (n) => n.type === 'hashchange'
        );
        expect(hashChanges.length).toBeGreaterThanOrEqual(3);
      } finally {
        await context.close();
      }
    });

    it('extracts unique hash routes from links', async () => {
      const context = await browser.newContext();
      const page = await context.newPage();

      try {
        await page.goto(`${app.url}/hash-app`, {
          waitUntil: 'domcontentloaded',
        });

        const hashLinks = await page
          .locator('a[href^="#/"]')
          .evaluateAll((els) =>
            els.map((el) => (el as HTMLAnchorElement).getAttribute('href'))
          );

        expect(hashLinks.length).toBeGreaterThanOrEqual(3);
        expect(hashLinks).toContain('#/home');
        expect(hashLinks).toContain('#/settings');
        expect(hashLinks).toContain('#/profile');
      } finally {
        await context.close();
      }
    });
  });

  // -----------------------------------------------------------------------
  // Click-based navigation in nav elements
  // -----------------------------------------------------------------------

  describe('nav element clicking', () => {
    it('discovers pages through nav link clicking', async () => {
      const context = await browser.newContext();
      const page = await context.newPage();

      try {
        await page.goto(app.url, {
          waitUntil: 'domcontentloaded',
        });

        // Extract all nav links
        const navLinks = await page
          .locator('nav a[href]')
          .evaluateAll((els) =>
            els.map((el) => (el as HTMLAnchorElement).href)
          );

        expect(navLinks.length).toBeGreaterThan(3);
        // Should include standard pages
        expect(navLinks.some((l) => l.includes('/about'))).toBe(true);
        expect(navLinks.some((l) => l.includes('/contact'))).toBe(true);
      } finally {
        await context.close();
      }
    });
  });

  // -----------------------------------------------------------------------
  // DOM state changes
  // -----------------------------------------------------------------------

  describe('DOM state changes', () => {
    it('detects DOM content change after SPA navigation', async () => {
      const context = await browser.newContext({ bypassCSP: true });
      try {
        const { page } = await createInstrumentedPage(context);
        await page.goto(`${app.url}/spa`, {
          waitUntil: 'domcontentloaded',
        });

        const contentBefore = await page
          .locator('#spa-content')
          .innerHTML();
        await page.click('button:has-text("Page A")');
        await page.waitForTimeout(500);
        const contentAfter = await page
          .locator('#spa-content')
          .innerHTML();

        expect(contentAfter).not.toBe(contentBefore);
        expect(contentAfter).toContain('/spa/page-a');
      } finally {
        await context.close();
      }
    });
  });

  // -----------------------------------------------------------------------
  // Back/forward navigation
  // -----------------------------------------------------------------------

  describe('back/forward navigation', () => {
    it('handles back navigation via popstate', async () => {
      const context = await browser.newContext({ bypassCSP: true });
      try {
        const { page, navigations } = await createInstrumentedPage(context);
        await page.goto(`${app.url}/spa`, {
          waitUntil: 'domcontentloaded',
        });

        // Navigate forward
        await page.click('button:has-text("Page A")');
        await page.waitForTimeout(300);

        // Navigate back
        await page.goBack();
        await page.waitForTimeout(300);

        expect(
          navigations.some((n) => n.type === 'popstate')
        ).toBe(true);
      } finally {
        await context.close();
      }
    });
  });
});
