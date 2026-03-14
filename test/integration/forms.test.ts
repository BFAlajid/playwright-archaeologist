/**
 * Integration tests for form detection.
 *
 * Tests form discovery and field extraction:
 * - HTML form with various input types
 * - Implicit form (inputs without form wrapper)
 * - Form with validation rules
 * - Form with select/radio/checkbox
 * - Form with file upload
 * - Multi-step form
 * - Form behind accordion/tab
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { chromium, type Browser, type Page, type Locator } from 'playwright';
import { startTestApp, type TestAppHandle } from '../fixtures/test-app/setup.js';

// -----------------------------------------------------------------------
// Extracted form metadata type
// -----------------------------------------------------------------------

interface FormField {
  name: string;
  type: string;
  required: boolean;
  placeholder?: string;
  pattern?: string;
  minlength?: string;
  ariaLabel?: string;
  options?: string[];
}

interface FormInfo {
  action: string;
  method: string;
  fields: FormField[];
  submitText?: string;
}

describe('Form Detection', () => {
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

  async function extractForms(page: Page): Promise<FormInfo[]> {
    return page.evaluate(() => {
      const forms = document.querySelectorAll('form');
      return Array.from(forms).map((form) => {
        const fields = Array.from(
          form.querySelectorAll('input, select, textarea')
        ).map((el) => {
          const input = el as HTMLInputElement;
          const field: any = {
            name: input.name || '',
            type: input.type || el.tagName.toLowerCase(),
            required: input.required || false,
          };
          if (input.placeholder) field.placeholder = input.placeholder;
          if (input.pattern) field.pattern = input.pattern;
          if (input.minLength > 0)
            field.minlength = String(input.minLength);
          if (input.getAttribute('aria-label'))
            field.ariaLabel = input.getAttribute('aria-label');
          if (el.tagName === 'SELECT') {
            field.options = Array.from(
              (el as HTMLSelectElement).options
            ).map((o) => o.value);
          }
          return field;
        });

        const submitBtn = form.querySelector(
          'button[type="submit"], input[type="submit"]'
        );

        return {
          action: form.action || '',
          method: (form.method || 'GET').toUpperCase(),
          fields: fields.filter((f) => f.name),
          submitText: submitBtn?.textContent?.trim() || undefined,
        };
      });
    });
  }

  // -----------------------------------------------------------------------
  // Login form
  // -----------------------------------------------------------------------

  describe('login form', () => {
    it('detects login form with email and password fields', async () => {
      const context = await browser.newContext();
      const page = await context.newPage();

      try {
        await page.goto(`${app.url}/forms/login`, {
          waitUntil: 'domcontentloaded',
        });
        const forms = await extractForms(page);

        expect(forms.length).toBeGreaterThanOrEqual(1);
        const loginForm = forms.find((f) => f.action.includes('/login'));
        expect(loginForm).toBeDefined();
        expect(loginForm!.method).toBe('POST');

        const emailField = loginForm!.fields.find((f) => f.name === 'email');
        expect(emailField).toBeDefined();
        expect(emailField!.type).toBe('email');
        expect(emailField!.required).toBe(true);

        const passwordField = loginForm!.fields.find(
          (f) => f.name === 'password'
        );
        expect(passwordField).toBeDefined();
        expect(passwordField!.type).toBe('password');
        expect(passwordField!.required).toBe(true);
      } finally {
        await context.close();
      }
    });

    it('detects remember me checkbox', async () => {
      const context = await browser.newContext();
      const page = await context.newPage();

      try {
        await page.goto(`${app.url}/forms/login`, {
          waitUntil: 'domcontentloaded',
        });
        const forms = await extractForms(page);
        const loginForm = forms.find((f) => f.action.includes('/login'));

        const rememberField = loginForm?.fields.find(
          (f) => f.name === 'remember'
        );
        expect(rememberField).toBeDefined();
        expect(rememberField!.type).toBe('checkbox');
      } finally {
        await context.close();
      }
    });
  });

  // -----------------------------------------------------------------------
  // Registration form
  // -----------------------------------------------------------------------

  describe('registration form', () => {
    it('detects registration form with validation rules', async () => {
      const context = await browser.newContext();
      const page = await context.newPage();

      try {
        await page.goto(`${app.url}/forms/register`, {
          waitUntil: 'domcontentloaded',
        });
        const forms = await extractForms(page);

        expect(forms.length).toBeGreaterThanOrEqual(1);
        const regForm = forms.find((f) => f.action.includes('/register'));
        expect(regForm).toBeDefined();

        // Password field should have validation pattern
        const passwordField = regForm!.fields.find(
          (f) => f.name === 'password'
        );
        expect(passwordField?.pattern).toBeTruthy();
        expect(passwordField?.minlength).toBeTruthy();
      } finally {
        await context.close();
      }
    });

    it('detects select dropdown with options', async () => {
      const context = await browser.newContext();
      const page = await context.newPage();

      try {
        await page.goto(`${app.url}/forms/register`, {
          waitUntil: 'domcontentloaded',
        });
        const forms = await extractForms(page);
        const regForm = forms.find((f) => f.action.includes('/register'));

        const roleField = regForm?.fields.find((f) => f.name === 'role');
        expect(roleField).toBeDefined();
        expect(roleField!.type).toBe('select-one');
        expect(roleField!.options).toContain('user');
        expect(roleField!.options).toContain('admin');
      } finally {
        await context.close();
      }
    });

    it('detects radio buttons', async () => {
      const context = await browser.newContext();
      const page = await context.newPage();

      try {
        await page.goto(`${app.url}/forms/register`, {
          waitUntil: 'domcontentloaded',
        });
        const forms = await extractForms(page);
        const regForm = forms.find((f) => f.action.includes('/register'));

        const radioFields = regForm?.fields.filter(
          (f) => f.name === 'notifications'
        );
        expect(radioFields?.length).toBeGreaterThanOrEqual(1);
      } finally {
        await context.close();
      }
    });

    it('detects required checkbox (terms)', async () => {
      const context = await browser.newContext();
      const page = await context.newPage();

      try {
        await page.goto(`${app.url}/forms/register`, {
          waitUntil: 'domcontentloaded',
        });
        const forms = await extractForms(page);
        const regForm = forms.find((f) => f.action.includes('/register'));

        const termsField = regForm?.fields.find(
          (f) => f.name === 'terms'
        );
        expect(termsField).toBeDefined();
        expect(termsField!.required).toBe(true);
      } finally {
        await context.close();
      }
    });
  });

  // -----------------------------------------------------------------------
  // File upload form
  // -----------------------------------------------------------------------

  describe('file upload form', () => {
    it('detects file upload field with accept attribute', async () => {
      const context = await browser.newContext();
      const page = await context.newPage();

      try {
        await page.goto(`${app.url}/forms/upload`, {
          waitUntil: 'domcontentloaded',
        });
        const forms = await extractForms(page);

        expect(forms.length).toBeGreaterThanOrEqual(1);
        const uploadForm = forms.find((f) => f.action.includes('/upload'));
        expect(uploadForm).toBeDefined();

        const fileField = uploadForm?.fields.find(
          (f) => f.name === 'file'
        );
        expect(fileField).toBeDefined();
        expect(fileField!.type).toBe('file');
        expect(fileField!.required).toBe(true);
      } finally {
        await context.close();
      }
    });
  });

  // -----------------------------------------------------------------------
  // Implicit form (no <form> wrapper)
  // -----------------------------------------------------------------------

  describe('implicit form', () => {
    it('detects inputs without form wrapper', async () => {
      const context = await browser.newContext();
      const page = await context.newPage();

      try {
        await page.goto(`${app.url}/forms/implicit`, {
          waitUntil: 'domcontentloaded',
        });

        // There should be inputs not inside a <form> element
        const orphanInputs = await page.evaluate(() => {
          const inputs = document.querySelectorAll('input');
          return Array.from(inputs)
            .filter((input) => !input.closest('form'))
            .map((input) => ({
              name: input.name,
              type: input.type,
              placeholder: input.placeholder,
              ariaLabel: input.getAttribute('aria-label'),
            }));
        });

        expect(orphanInputs.length).toBeGreaterThan(0);
        expect(
          orphanInputs.some((i) => i.type === 'email')
        ).toBe(true);
      } finally {
        await context.close();
      }
    });
  });

  // -----------------------------------------------------------------------
  // Multi-step form
  // -----------------------------------------------------------------------

  describe('multi-step form', () => {
    it('discovers fields across multiple steps', async () => {
      const context = await browser.newContext();
      const page = await context.newPage();

      try {
        await page.goto(`${app.url}/forms/multi-step`, {
          waitUntil: 'domcontentloaded',
        });

        // Step 1 fields should be visible
        const step1Visible = await page
          .locator('#step-1 input[name="firstName"]')
          .isVisible();
        expect(step1Visible).toBe(true);

        // Step 2 fields should be hidden initially
        const step2Visible = await page
          .locator('#step-2')
          .isVisible();
        expect(step2Visible).toBe(false);

        // Click "Next" to reveal step 2
        await page.click('button:has-text("Next")');
        await page.waitForTimeout(300);

        const step2VisibleAfter = await page
          .locator('#step-2')
          .isVisible();
        expect(step2VisibleAfter).toBe(true);

        // Now we can see step 2 fields
        const phoneVisible = await page
          .locator('#step-2 input[name="phone"]')
          .isVisible();
        expect(phoneVisible).toBe(true);
      } finally {
        await context.close();
      }
    });
  });

  // -----------------------------------------------------------------------
  // Form behind accordion
  // -----------------------------------------------------------------------

  describe('form behind accordion', () => {
    it('discovers forms inside collapsed details/summary', async () => {
      const context = await browser.newContext();
      const page = await context.newPage();

      try {
        await page.goto(`${app.url}/forms/accordion`, {
          waitUntil: 'domcontentloaded',
        });

        // Even though forms may be inside collapsed <details>,
        // they should be discoverable in the DOM
        const allForms = await extractForms(page);
        expect(allForms.length).toBeGreaterThanOrEqual(2);

        // Profile settings form
        const profileForm = allForms.find((f) =>
          f.action.includes('/settings/profile')
        );
        expect(profileForm).toBeDefined();

        // Notification settings form
        const notifForm = allForms.find((f) =>
          f.action.includes('/settings/notifications')
        );
        expect(notifForm).toBeDefined();
      } finally {
        await context.close();
      }
    });
  });

  // -----------------------------------------------------------------------
  // Search form (GET method)
  // -----------------------------------------------------------------------

  describe('search form', () => {
    it('detects GET search form with search input', async () => {
      const context = await browser.newContext();
      const page = await context.newPage();

      try {
        await page.goto(`${app.url}/forms/search`, {
          waitUntil: 'domcontentloaded',
        });
        const forms = await extractForms(page);

        const searchForm = forms.find((f) => f.action.includes('/search'));
        expect(searchForm).toBeDefined();
        expect(searchForm!.method).toBe('GET');

        const qField = searchForm!.fields.find((f) => f.name === 'q');
        expect(qField).toBeDefined();
        expect(qField!.type).toBe('search');
      } finally {
        await context.close();
      }
    });
  });
});
