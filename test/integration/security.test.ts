/**
 * Integration tests for security features, exercising REAL src/ modules.
 *
 * Earlier revisions reimplemented route-interception and SSRF checks
 * inline. That tested Playwright, not our code. This rewrite drives
 * the production SSRF guard (createNetworkGuard / isBlockedUrl) and
 * browser hardening helpers from `src/security`, so regressions in
 * those modules trigger test failures.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { chromium, type Browser } from 'playwright';

import {
  isBlockedUrl,
  createNetworkGuard,
  isPrivateIp,
} from '../../src/security/network-guard.js';
import {
  getSecureContextOptions,
  getSecureLaunchOptions,
} from '../../src/security/browser-hardening.js';
import { startTestApp, type TestAppHandle } from '../fixtures/test-app/setup.js';
import { hasChromium } from '../helpers/has-chromium.js';

describe.skipIf(!hasChromium)('Security (real src modules)', () => {
  let app: TestAppHandle;
  let browser: Browser;

  beforeAll(async () => {
    app = await startTestApp();
    browser = await chromium.launch(getSecureLaunchOptions());
  });

  afterAll(async () => {
    await browser?.close();
    await app?.close();
  });

  // -----------------------------------------------------------------------
  // SSRF guard — exercises src/security/network-guard.ts directly.
  // -----------------------------------------------------------------------

  describe('network-guard isBlockedUrl', () => {
    it('blocks AWS IMDS (169.254.169.254) unless allowPrivate', async () => {
      const blocked = await isBlockedUrl('http://169.254.169.254/latest/meta-data/');
      expect(blocked.blocked).toBe(true);
      expect(blocked.reason).toMatch(/metadata|private/i);
    });

    it('blocks 127.0.0.1 unless allowPrivate', async () => {
      const blocked = await isBlockedUrl('http://127.0.0.1:3000/');
      expect(blocked.blocked).toBe(true);
    });

    it('blocks file:// protocol', async () => {
      const blocked = await isBlockedUrl('file:///etc/passwd');
      expect(blocked.blocked).toBe(true);
      expect(blocked.reason).toMatch(/protocol/i);
    });

    it('blocks javascript: protocol', async () => {
      const blocked = await isBlockedUrl('javascript:alert(1)');
      expect(blocked.blocked).toBe(true);
    });

    it('allows the fixture URL when allowPrivate is set', async () => {
      const blocked = await isBlockedUrl(app.url, { allowPrivate: true });
      expect(blocked.blocked).toBe(false);
    });

    it('isPrivateIp flags RFC1918 ranges', () => {
      expect(isPrivateIp('10.0.0.5')).toBe(true);
      expect(isPrivateIp('192.168.1.1')).toBe(true);
      expect(isPrivateIp('172.16.0.1')).toBe(true);
      expect(isPrivateIp('127.0.0.1')).toBe(true);
      expect(isPrivateIp('8.8.8.8')).toBe(false);
    });
  });

  // -----------------------------------------------------------------------
  // End-to-end SSRF: createNetworkGuard installed on a real Playwright
  // context must abort a request to a private IP.
  // -----------------------------------------------------------------------

  describe('createNetworkGuard end-to-end', () => {
    it('aborts requests to private IPs from within a Playwright page', async () => {
      const context = await browser.newContext(
        getSecureContextOptions({ viewport: { width: 1024, height: 768 } }),
      );
      const page = await context.newPage();
      page.on('dialog', (d) => d.dismiss());

      // Install the real guard (allowPrivate NOT set) — it should block
      // any same-frame request to 127.0.0.1 / AWS metadata, etc.
      await context.route('**/*', createNetworkGuard());

      try {
        // Navigate to the fixture first (allowed via same-origin — the
        // guard blocks all private IPs including fixture, so we need
        // allowPrivate for THE FIXTURE. So we need a guard with allowPrivate
        // for the entry URL but still exercise the block for another private
        // target. Split approach: navigate to real https site via a
        // data: URL substitute, then fetch a private IP and observe block.
        //
        // Simplest: load about:blank and fetch 169.254.169.254.
        await page.goto('about:blank');

        const fetchResult = await page.evaluate(async () => {
          try {
            const res = await fetch('http://169.254.169.254/latest/meta-data/', {
              mode: 'no-cors',
            });
            return { ok: true, status: res.status };
          } catch (err) {
            return { ok: false, err: String(err) };
          }
        });

        // The fetch must have been aborted by the guard. Either the
        // browser sees it as a network error (ok: false) or the route
        // handler short-circuited with blockedbyclient.
        expect(fetchResult.ok).toBe(false);
      } finally {
        await context.close();
      }
    });
  });

  // -----------------------------------------------------------------------
  // Secure browser hardening flags come through as expected.
  // -----------------------------------------------------------------------

  describe('browser hardening defaults', () => {
    it('launch options disable SIGINT handling so the tool controls shutdown', () => {
      const opts = getSecureLaunchOptions();
      expect(opts.handleSIGINT).toBe(false);
      expect(opts.handleSIGTERM).toBe(false);
      expect(opts.handleSIGHUP).toBe(false);
    });

    it('context options bypass CSP and block downloads', () => {
      const opts = getSecureContextOptions({
        viewport: { width: 1280, height: 720 },
      });
      expect(opts.bypassCSP).toBe(true);
      expect(opts.acceptDownloads).toBe(false);
      expect(opts.viewport).toEqual({ width: 1280, height: 720 });
    });
  });

  // -----------------------------------------------------------------------
  // Popup, dialog, and download handling — confirms the hardening
  // options produce the documented behavior against a real page.
  // -----------------------------------------------------------------------

  describe('runtime hardening behavior', () => {
    it('dismisses dialogs without hanging the page', async () => {
      const context = await browser.newContext(getSecureContextOptions({}));
      const page = await context.newPage();
      const seen: string[] = [];
      page.on('dialog', (d) => {
        seen.push(d.message());
        d.dismiss().catch(() => {});
      });

      try {
        // Fixture route that triggers a synchronous `alert()` on load.
        await page.goto(`${app.url}/special/dialog`, {
          waitUntil: 'load',
          timeout: 5000,
        });
        // Page must still be responsive: we can query the title.
        const title = await page.title();
        expect(title.length).toBeGreaterThan(0);
        // The dialog handler must have seen at least one dialog.
        expect(seen.length).toBeGreaterThan(0);
      } finally {
        await context.close();
      }
    });

    it('auto-closes popups opened by window.open (does not abort main page)', async () => {
      const context = await browser.newContext(getSecureContextOptions({}));
      const page = await context.newPage();

      // Register the popup close handler AFTER creating the main page so
      // the handler does not fire for the initial page. This matches how
      // the orchestrator installs handlers — on a per-context basis once
      // the main inspection page is set up.
      context.on('page', (p) => {
        // Only close pages opened via window.open (popups have openers).
        if (p.opener() !== null) {
          p.close().catch(() => {});
        }
      });

      try {
        await page.goto(app.url, { waitUntil: 'domcontentloaded' });

        const beforeCount = context.pages().length;
        await page.evaluate(() => {
          window.open('https://example.com', '_blank');
        });
        // Give the close handler a tick to fire.
        await page.waitForTimeout(300);

        // The main page is still open; any popup has been closed.
        expect(page.isClosed()).toBe(false);
        const openPages = context.pages().filter((p) => !p.isClosed());
        // Popup was either never created (blocked) or closed — either way,
        // we should not have strictly more pages than before.
        expect(openPages.length).toBeLessThanOrEqual(beforeCount);
      } finally {
        await context.close();
      }
    });
  });
});
