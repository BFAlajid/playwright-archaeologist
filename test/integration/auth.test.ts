/**
 * Integration tests for authentication.
 *
 * Tests authenticated crawling:
 * - Auth script executes and enables access
 * - Cookie injection works
 * - Storage state shared across contexts
 * - Auth failure detected
 * - 401 response triggers clear error
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { chromium, type Browser, type BrowserContext } from 'playwright';
import { startTestApp, type TestAppHandle } from '../fixtures/test-app/setup.js';

describe('Authentication', () => {
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
  // Auth via login flow (simulating auth script)
  // -----------------------------------------------------------------------

  describe('auth script execution', () => {
    it('accesses protected page after login', async () => {
      const context = await browser.newContext();
      const page = await context.newPage();

      try {
        // Simulate auth script: navigate to login, fill form, submit
        await page.goto(`${app.url}/forms/login`, {
          waitUntil: 'domcontentloaded',
        });

        // Fill login form
        await page.fill('input[name="email"]', 'admin@example.com');
        await page.fill('input[name="password"]', 'password123');

        // Submit via API directly (simulating programmatic login)
        const loginResult = await page.evaluate(async (baseUrl) => {
          const res = await fetch(`${baseUrl}/api/login`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              email: 'admin@example.com',
              password: 'password123',
            }),
          });
          return { status: res.status, body: await res.json() };
        }, app.url);

        expect(loginResult.status).toBe(200);
        expect(loginResult.body.success).toBe(true);

        // Now access the protected page
        const response = await page.goto(`${app.url}/dashboard`, {
          waitUntil: 'domcontentloaded',
        });

        expect(response?.status()).toBe(200);
        const title = await page.title();
        expect(title).toContain('Dashboard');
      } finally {
        await context.close();
      }
    });
  });

  // -----------------------------------------------------------------------
  // Cookie injection
  // -----------------------------------------------------------------------

  describe('cookie injection', () => {
    it('accesses protected page with injected session cookie', async () => {
      const context = await browser.newContext();

      // Inject session cookie
      await context.addCookies([
        {
          name: 'session',
          value: 'test-session-token-abc123',
          domain: '127.0.0.1',
          path: '/',
          httpOnly: true,
          secure: false,
          sameSite: 'Lax',
        },
      ]);

      const page = await context.newPage();

      try {
        const response = await page.goto(`${app.url}/dashboard`, {
          waitUntil: 'domcontentloaded',
        });

        expect(response?.status()).toBe(200);
        const title = await page.title();
        expect(title).toContain('Dashboard');
      } finally {
        await context.close();
      }
    });

    it('crawls multiple protected pages with shared cookies', async () => {
      const context = await browser.newContext();

      await context.addCookies([
        {
          name: 'session',
          value: 'test-session-token-abc123',
          domain: '127.0.0.1',
          path: '/',
          httpOnly: true,
          secure: false,
          sameSite: 'Lax',
        },
      ]);

      const page = await context.newPage();

      try {
        // Visit multiple protected pages
        const protectedPages = [
          '/dashboard',
          '/dashboard/settings',
          '/dashboard/analytics',
        ];

        for (const path of protectedPages) {
          const response = await page.goto(`${app.url}${path}`, {
            waitUntil: 'domcontentloaded',
          });
          expect(response?.status()).toBe(200);
        }
      } finally {
        await context.close();
      }
    });
  });

  // -----------------------------------------------------------------------
  // Storage state sharing across contexts
  // -----------------------------------------------------------------------

  describe('storage state sharing', () => {
    it('shares auth state between multiple browser contexts', async () => {
      // First context: perform login
      const authContext = await browser.newContext();
      const authPage = await authContext.newPage();

      try {
        // Login
        await authPage.evaluate(async (baseUrl) => {
          await fetch(`${baseUrl}/api/login`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              email: 'admin@example.com',
              password: 'password123',
            }),
          });
        }, app.url);

        // Save storage state
        const storageState = await authContext.storageState();

        // Create new context with saved state
        const newContext = await browser.newContext({ storageState });
        const newPage = await newContext.newPage();

        try {
          const response = await newPage.goto(`${app.url}/dashboard`, {
            waitUntil: 'domcontentloaded',
          });

          expect(response?.status()).toBe(200);
        } finally {
          await newContext.close();
        }
      } finally {
        await authContext.close();
      }
    });
  });

  // -----------------------------------------------------------------------
  // Auth failure detection
  // -----------------------------------------------------------------------

  describe('auth failure', () => {
    it('detects 401 when accessing protected page without auth', async () => {
      const context = await browser.newContext();
      const page = await context.newPage();

      try {
        const response = await page.goto(`${app.url}/dashboard`, {
          waitUntil: 'domcontentloaded',
        });

        expect(response?.status()).toBe(401);
      } finally {
        await context.close();
      }
    });

    it('detects failed login attempt', async () => {
      const context = await browser.newContext();
      const page = await context.newPage();

      try {
        await page.goto(app.url, { waitUntil: 'domcontentloaded' });

        const result = await page.evaluate(async (baseUrl) => {
          const res = await fetch(`${baseUrl}/api/login`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              email: 'wrong@example.com',
              password: 'wrongpassword',
            }),
          });
          return { status: res.status, body: await res.json() };
        }, app.url);

        expect(result.status).toBe(401);
        expect(result.body.success).toBe(false);
      } finally {
        await context.close();
      }
    });

    it('returns 401 with clear error message', async () => {
      const context = await browser.newContext();
      const page = await context.newPage();

      try {
        const response = await page.goto(`${app.url}/dashboard`, {
          waitUntil: 'domcontentloaded',
        });

        expect(response?.status()).toBe(401);

        const bodyText = await page.textContent('body');
        expect(bodyText).toContain('Unauthorized');
      } finally {
        await context.close();
      }
    });
  });

  // -----------------------------------------------------------------------
  // Session persistence
  // -----------------------------------------------------------------------

  describe('session persistence', () => {
    it('maintains session across page navigations', async () => {
      const context = await browser.newContext();

      await context.addCookies([
        {
          name: 'session',
          value: 'test-session-token-abc123',
          domain: '127.0.0.1',
          path: '/',
          httpOnly: true,
          secure: false,
          sameSite: 'Lax',
        },
      ]);

      const page = await context.newPage();

      try {
        // Navigate to dashboard
        await page.goto(`${app.url}/dashboard`, {
          waitUntil: 'domcontentloaded',
        });
        expect(await page.title()).toContain('Dashboard');

        // Navigate to settings
        await page.goto(`${app.url}/dashboard/settings`, {
          waitUntil: 'domcontentloaded',
        });
        expect(await page.title()).toContain('Settings');

        // Navigate back to dashboard
        await page.goto(`${app.url}/dashboard`, {
          waitUntil: 'domcontentloaded',
        });
        expect(await page.title()).toContain('Dashboard');
      } finally {
        await context.close();
      }
    });
  });
});
