/**
 * Unit tests for src/collectors/form-prober.ts
 *
 * Tests the probeForms function with mocked Playwright Page objects.
 * Verifies form extraction, field metadata, select options, submit buttons,
 * URL resolution, password redaction, and implicit form detection.
 */

import { describe, it, expect, vi } from 'vitest';
import { probeForms } from '../../src/collectors/form-prober.js';
import type { Page, Locator } from 'playwright';

// ---------------------------------------------------------------------------
// Mock helpers
// ---------------------------------------------------------------------------

/**
 * Raw form data shape returned by formLocator.evaluate().
 * Matches the RawFormData interface inside form-prober.ts.
 */
interface MockRawFormData {
  action: string;
  method: string;
  id: string | null;
  name: string | null;
  enctype: string | null;
  ariaLabel: string | null;
  fields: Array<{
    name: string;
    type: string;
    required: boolean;
    pattern: string | null;
    placeholder: string | null;
    label: string | null;
    options: Array<{ value: string; label: string; selected: boolean }> | null;
    min: string | null;
    max: string | null;
    step: string | null;
    maxLength: number | null;
    multiple: boolean;
    accept: string | null;
    defaultValue: string | null;
    isPassword: boolean;
  }>;
  submitButtonText: string | null;
}

function makeRawFormData(
  overrides: Partial<MockRawFormData> = {},
): MockRawFormData {
  return {
    action: '',
    method: 'GET',
    id: null,
    name: null,
    enctype: null,
    ariaLabel: null,
    fields: [],
    submitButtonText: null,
    ...overrides,
  };
}

function makeRawField(
  overrides: Partial<MockRawFormData['fields'][0]> = {},
): MockRawFormData['fields'][0] {
  return {
    name: '',
    type: 'text',
    required: false,
    pattern: null,
    placeholder: null,
    label: null,
    options: null,
    min: null,
    max: null,
    step: null,
    maxLength: null,
    multiple: false,
    accept: null,
    defaultValue: null,
    isPassword: false,
    ...overrides,
  };
}

/**
 * Create a mock Locator that returns a given raw form data from evaluate().
 */
function createMockLocator(rawFormData: MockRawFormData): Locator {
  return {
    evaluate: vi.fn(async () => rawFormData),
  } as unknown as Locator;
}

/**
 * Create a minimal mock Page for form probing.
 *
 * @param formLocators   Array of mock locators (one per explicit form)
 * @param implicitForms  Result of page.evaluate for implicit form detection
 */
function createMockPage(options: {
  formLocators?: Locator[];
  implicitFormsResult?: MockRawFormData[];
}): Page {
  const { formLocators = [], implicitFormsResult = [] } = options;

  return {
    locator: vi.fn(() => ({
      all: vi.fn(async () => formLocators),
    })),
    evaluate: vi.fn(async () => implicitFormsResult),
  } as unknown as Page;
}

// ---------------------------------------------------------------------------
// probeForms — basic form extraction
// ---------------------------------------------------------------------------

describe('probeForms', () => {
  it('extracts basic form with action and method', async () => {
    const formData = makeRawFormData({
      action: 'https://example.com/submit',
      method: 'POST',
      id: 'login-form',
      name: 'login',
    });

    const page = createMockPage({
      formLocators: [createMockLocator(formData)],
    });

    const result = await probeForms(page, 'https://example.com/');

    expect(result.pageUrl).toBe('https://example.com/');
    expect(result.forms).toHaveLength(1);
    expect(result.forms[0].action).toBe('https://example.com/submit');
    expect(result.forms[0].method).toBe('POST');
    expect(result.forms[0].id).toBe('login-form');
    expect(result.forms[0].name).toBe('login');
    expect(result.forms[0].isImplicit).toBe(false);
  });

  it('extracts multiple forms from one page', async () => {
    const form1 = makeRawFormData({
      action: 'https://example.com/search',
      method: 'GET',
      id: 'search-form',
    });
    const form2 = makeRawFormData({
      action: 'https://example.com/login',
      method: 'POST',
      id: 'login-form',
    });

    const page = createMockPage({
      formLocators: [createMockLocator(form1), createMockLocator(form2)],
    });

    const result = await probeForms(page, 'https://example.com/');

    expect(result.forms).toHaveLength(2);
    expect(result.forms[0].id).toBe('search-form');
    expect(result.forms[1].id).toBe('login-form');
  });

  // ---------------------------------------------------------------------------
  // Field metadata
  // ---------------------------------------------------------------------------

  it('extracts field metadata (name, type, required, placeholder)', async () => {
    const formData = makeRawFormData({
      action: 'https://example.com/register',
      method: 'POST',
      fields: [
        makeRawField({
          name: 'username',
          type: 'text',
          required: true,
          placeholder: 'Enter username',
          label: 'Username',
        }),
        makeRawField({
          name: 'email',
          type: 'email',
          required: true,
          placeholder: 'your@email.com',
          pattern: '[a-z]+@[a-z]+\\.[a-z]+',
          label: 'Email Address',
        }),
        makeRawField({
          name: 'age',
          type: 'number',
          required: false,
          min: '0',
          max: '150',
          step: '1',
        }),
      ],
    });

    const page = createMockPage({
      formLocators: [createMockLocator(formData)],
    });

    const result = await probeForms(page, 'https://example.com/');
    const fields = result.forms[0].fields;

    expect(fields).toHaveLength(3);

    expect(fields[0].name).toBe('username');
    expect(fields[0].type).toBe('text');
    expect(fields[0].required).toBe(true);
    expect(fields[0].placeholder).toBe('Enter username');
    expect(fields[0].label).toBe('Username');

    expect(fields[1].name).toBe('email');
    expect(fields[1].pattern).toBe('[a-z]+@[a-z]+\\.[a-z]+');

    expect(fields[2].name).toBe('age');
    expect(fields[2].min).toBe('0');
    expect(fields[2].max).toBe('150');
    expect(fields[2].step).toBe('1');
    expect(fields[2].required).toBe(false);
  });

  // ---------------------------------------------------------------------------
  // Select options
  // ---------------------------------------------------------------------------

  it('extracts select options', async () => {
    const formData = makeRawFormData({
      action: 'https://example.com/preferences',
      method: 'POST',
      fields: [
        makeRawField({
          name: 'country',
          type: 'select',
          options: [
            { value: '', label: 'Select a country', selected: true },
            { value: 'us', label: 'United States', selected: false },
            { value: 'uk', label: 'United Kingdom', selected: false },
            { value: 'ca', label: 'Canada', selected: false },
          ],
        }),
      ],
    });

    const page = createMockPage({
      formLocators: [createMockLocator(formData)],
    });

    const result = await probeForms(page, 'https://example.com/');
    const field = result.forms[0].fields[0];

    expect(field.type).toBe('select');
    expect(field.options).toHaveLength(4);
    expect(field.options![0]).toEqual({
      value: '',
      label: 'Select a country',
      selected: true,
    });
    expect(field.options![1]).toEqual({
      value: 'us',
      label: 'United States',
      selected: false,
    });
  });

  // ---------------------------------------------------------------------------
  // Submit button text
  // ---------------------------------------------------------------------------

  it('detects submit button text', async () => {
    const formData = makeRawFormData({
      action: 'https://example.com/login',
      method: 'POST',
      submitButtonText: 'Sign In',
    });

    const page = createMockPage({
      formLocators: [createMockLocator(formData)],
    });

    const result = await probeForms(page, 'https://example.com/');

    expect(result.forms[0].submitButtonText).toBe('Sign In');
  });

  it('omits submitButtonText when no submit button exists', async () => {
    const formData = makeRawFormData({
      action: 'https://example.com/api',
      method: 'POST',
      submitButtonText: null,
    });

    const page = createMockPage({
      formLocators: [createMockLocator(formData)],
    });

    const result = await probeForms(page, 'https://example.com/');

    expect(result.forms[0].submitButtonText).toBeUndefined();
  });

  // ---------------------------------------------------------------------------
  // URL resolution
  // ---------------------------------------------------------------------------

  it('resolves relative action URLs to absolute', async () => {
    const formData = makeRawFormData({
      action: 'https://example.com/api/submit',
      method: 'POST',
    });

    const page = createMockPage({
      formLocators: [createMockLocator(formData)],
    });

    const result = await probeForms(page, 'https://example.com/forms/contact');

    // The evaluate function inside the browser resolves URLs, so the mock
    // returns the already-resolved URL.
    expect(result.forms[0].action).toBe('https://example.com/api/submit');
  });

  // ---------------------------------------------------------------------------
  // No action attribute
  // ---------------------------------------------------------------------------

  it('handles form with no action attribute', async () => {
    const formData = makeRawFormData({
      action: '',
      method: 'POST',
    });

    const page = createMockPage({
      formLocators: [createMockLocator(formData)],
    });

    const result = await probeForms(page, 'https://example.com/');

    expect(result.forms[0].action).toBe('');
  });

  // ---------------------------------------------------------------------------
  // Password redaction
  // ---------------------------------------------------------------------------

  it('redacts password defaultValue', async () => {
    const formData = makeRawFormData({
      action: 'https://example.com/login',
      method: 'POST',
      fields: [
        makeRawField({
          name: 'username',
          type: 'text',
          defaultValue: 'admin',
          isPassword: false,
        }),
        makeRawField({
          name: 'password',
          type: 'password',
          defaultValue: 'secret123',
          isPassword: true,
        }),
      ],
    });

    const page = createMockPage({
      formLocators: [createMockLocator(formData)],
    });

    const result = await probeForms(page, 'https://example.com/');
    const fields = result.forms[0].fields;

    expect(fields[0].defaultValue).toBe('admin');
    expect(fields[1].defaultValue).toBe('[REDACTED]');
  });

  it('does not set defaultValue for password with no value', async () => {
    const formData = makeRawFormData({
      action: 'https://example.com/login',
      method: 'POST',
      fields: [
        makeRawField({
          name: 'password',
          type: 'password',
          defaultValue: null,
          isPassword: true,
        }),
      ],
    });

    const page = createMockPage({
      formLocators: [createMockLocator(formData)],
    });

    const result = await probeForms(page, 'https://example.com/');

    expect(result.forms[0].fields[0].defaultValue).toBeUndefined();
  });

  // ---------------------------------------------------------------------------
  // Implicit forms
  // ---------------------------------------------------------------------------

  it('detects implicit forms (orphaned inputs)', async () => {
    const implicitForm = makeRawFormData({
      action: '',
      method: 'GET',
      fields: [
        makeRawField({
          name: 'search',
          type: 'text',
          placeholder: 'Search...',
        }),
      ],
      submitButtonText: 'Go',
    });

    const page = createMockPage({
      formLocators: [], // no explicit forms
      implicitFormsResult: [implicitForm],
    });

    const result = await probeForms(page, 'https://example.com/');

    expect(result.forms).toHaveLength(1);
    expect(result.forms[0].isImplicit).toBe(true);
    expect(result.forms[0].action).toBe('');
    expect(result.forms[0].fields[0].name).toBe('search');
    expect(result.forms[0].submitButtonText).toBe('Go');
  });

  it('includes both explicit and implicit forms', async () => {
    const explicitForm = makeRawFormData({
      action: 'https://example.com/login',
      method: 'POST',
      id: 'login',
    });

    const implicitForm = makeRawFormData({
      action: '',
      method: 'GET',
      fields: [
        makeRawField({
          name: 'q',
          type: 'text',
        }),
      ],
    });

    const page = createMockPage({
      formLocators: [createMockLocator(explicitForm)],
      implicitFormsResult: [implicitForm],
    });

    const result = await probeForms(page, 'https://example.com/');

    expect(result.forms).toHaveLength(2);
    expect(result.forms[0].isImplicit).toBe(false);
    expect(result.forms[0].id).toBe('login');
    expect(result.forms[1].isImplicit).toBe(true);
  });

  // ---------------------------------------------------------------------------
  // No forms on page
  // ---------------------------------------------------------------------------

  it('handles page with no forms (returns empty array)', async () => {
    const page = createMockPage({
      formLocators: [],
      implicitFormsResult: [],
    });

    const result = await probeForms(page, 'https://example.com/');

    expect(result.pageUrl).toBe('https://example.com/');
    expect(result.forms).toEqual([]);
  });

  // ---------------------------------------------------------------------------
  // Optional form attributes
  // ---------------------------------------------------------------------------

  it('extracts enctype and ariaLabel when present', async () => {
    const formData = makeRawFormData({
      action: 'https://example.com/upload',
      method: 'POST',
      enctype: 'multipart/form-data',
      ariaLabel: 'File upload form',
    });

    const page = createMockPage({
      formLocators: [createMockLocator(formData)],
    });

    const result = await probeForms(page, 'https://example.com/');

    expect(result.forms[0].enctype).toBe('multipart/form-data');
    expect(result.forms[0].ariaLabel).toBe('File upload form');
  });

  it('omits enctype and ariaLabel when null', async () => {
    const formData = makeRawFormData({
      action: '',
      method: 'GET',
    });

    const page = createMockPage({
      formLocators: [createMockLocator(formData)],
    });

    const result = await probeForms(page, 'https://example.com/');

    expect(result.forms[0].enctype).toBeUndefined();
    expect(result.forms[0].ariaLabel).toBeUndefined();
  });

  // ---------------------------------------------------------------------------
  // File input accept attribute
  // ---------------------------------------------------------------------------

  it('extracts accept attribute for file inputs', async () => {
    const formData = makeRawFormData({
      action: 'https://example.com/upload',
      method: 'POST',
      enctype: 'multipart/form-data',
      fields: [
        makeRawField({
          name: 'avatar',
          type: 'file',
          accept: 'image/png,image/jpeg',
          multiple: true,
        }),
      ],
    });

    const page = createMockPage({
      formLocators: [createMockLocator(formData)],
    });

    const result = await probeForms(page, 'https://example.com/');
    const field = result.forms[0].fields[0];

    expect(field.type).toBe('file');
    expect(field.accept).toBe('image/png,image/jpeg');
    expect(field.multiple).toBe(true);
  });

  // ---------------------------------------------------------------------------
  // Validation messages and wasHidden defaults
  // ---------------------------------------------------------------------------

  it('returns empty validationMessages and wasHidden false', async () => {
    const formData = makeRawFormData({
      action: 'https://example.com/submit',
      method: 'POST',
    });

    const page = createMockPage({
      formLocators: [createMockLocator(formData)],
    });

    const result = await probeForms(page, 'https://example.com/');

    expect(result.forms[0].validationMessages).toEqual([]);
    expect(result.forms[0].wasHidden).toBe(false);
  });

  // ---------------------------------------------------------------------------
  // Error handling / graceful degradation
  // ---------------------------------------------------------------------------

  it('skips a form that throws during extraction', async () => {
    const failingLocator = {
      evaluate: vi.fn(async () => {
        throw new Error('element detached');
      }),
    } as unknown as Locator;

    const goodForm = makeRawFormData({
      action: 'https://example.com/ok',
      method: 'GET',
      id: 'good-form',
    });

    const page = createMockPage({
      formLocators: [failingLocator, createMockLocator(goodForm)],
    });

    const result = await probeForms(page, 'https://example.com/');

    expect(result.forms).toHaveLength(1);
    expect(result.forms[0].id).toBe('good-form');
  });

  it('returns empty forms when implicit form detection throws', async () => {
    const page = {
      locator: vi.fn(() => ({
        all: vi.fn(async () => []),
      })),
      evaluate: vi.fn(async () => {
        throw new Error('page crashed');
      }),
    } as unknown as Page;

    const result = await probeForms(page, 'https://example.com/');

    expect(result.forms).toEqual([]);
  });

  // ---------------------------------------------------------------------------
  // MaxLength extraction
  // ---------------------------------------------------------------------------

  it('extracts maxLength for text fields', async () => {
    const formData = makeRawFormData({
      action: '',
      method: 'GET',
      fields: [
        makeRawField({
          name: 'bio',
          type: 'textarea',
          maxLength: 500,
        }),
      ],
    });

    const page = createMockPage({
      formLocators: [createMockLocator(formData)],
    });

    const result = await probeForms(page, 'https://example.com/');

    expect(result.forms[0].fields[0].maxLength).toBe(500);
  });

  // ---------------------------------------------------------------------------
  // Default method
  // ---------------------------------------------------------------------------

  it('preserves default GET method', async () => {
    const formData = makeRawFormData({
      action: 'https://example.com/search',
      method: 'GET',
    });

    const page = createMockPage({
      formLocators: [createMockLocator(formData)],
    });

    const result = await probeForms(page, 'https://example.com/');

    expect(result.forms[0].method).toBe('GET');
  });
});
