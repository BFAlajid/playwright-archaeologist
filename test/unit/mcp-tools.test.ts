/**
 * Unit tests for src/mcp/tools.ts — pure query functions over a loaded
 * bundle. No SDK or stdio here; server.ts wires these into the MCP
 * registration layer and is covered by a separate integration test.
 */

import { describe, it, expect } from 'vitest';
import {
  findFormsWithoutCsrf,
  getApiEndpoint,
  listAccessibilityViolations,
  listBrokenRoutes,
  listForms,
  searchRoutes,
} from '../../src/mcp/tools.js';
import type { LoadedBundle } from '../../src/mcp/bundle-loader.js';
import type {
  ApiEndpointGroup,
  BundleManifest,
  FormField,
  FormInfo,
  RouteInfo,
} from '../../src/types/artifacts.js';

// ---------------------------------------------------------------------------
// Fixture helpers
// ---------------------------------------------------------------------------

function route(partial: Partial<RouteInfo> & Pick<RouteInfo, 'url'>): RouteInfo {
  return {
    url: partial.url,
    title: partial.title ?? 'Untitled',
    statusCode: partial.statusCode ?? 200,
    contentHash: partial.contentHash ?? 'hash',
    depth: partial.depth ?? 0,
    formCount: partial.formCount ?? 0,
    apiCallCount: partial.apiCallCount ?? 0,
    hasScreenshot: partial.hasScreenshot ?? false,
    discoveryMethod: partial.discoveryMethod ?? 'entry',
  };
}

function field(partial: Partial<FormField> & Pick<FormField, 'name' | 'type'>): FormField {
  return {
    name: partial.name,
    type: partial.type,
    required: partial.required ?? false,
    pattern: partial.pattern,
    placeholder: partial.placeholder,
    label: partial.label,
    options: partial.options,
    min: partial.min,
    max: partial.max,
    step: partial.step,
    maxLength: partial.maxLength,
    multiple: partial.multiple,
    accept: partial.accept,
    defaultValue: partial.defaultValue,
  };
}

function form(partial: Partial<FormInfo> & { method: string; fields: FormField[] }): FormInfo {
  return {
    action: partial.action ?? '/submit',
    method: partial.method,
    id: partial.id,
    name: partial.name,
    isImplicit: partial.isImplicit ?? false,
    fields: partial.fields,
    submitButtonText: partial.submitButtonText,
    enctype: partial.enctype,
    validationMessages: partial.validationMessages ?? [],
    ariaLabel: partial.ariaLabel,
    wasHidden: partial.wasHidden ?? false,
  };
}

function apiGroup(pattern: string, method: string): ApiEndpointGroup {
  return {
    pattern,
    method,
    classification: 'api',
    observedUrls: [],
    callCount: 0,
    callingPages: [],
    exampleRequest: { url: pattern, headers: {} },
    exampleResponse: { statusCode: 200, headers: {}, bodySize: 0 },
    observedStatusCodes: [200],
    observedContentTypes: ['application/json'],
    isGraphQL: false,
  };
}

function emptyManifest(): BundleManifest {
  return {
    version: 1,
    tool: 'playwright-archaeologist',
    toolVersion: '0.0.0-test',
    createdAt: new Date().toISOString(),
    config: {
      targetUrl: 'https://example.com',
      depth: 1,
      viewport: { width: 1280, height: 720 },
      concurrency: 1,
      maxPages: 100,
      followExternal: false,
      deepClick: false,
    },
    stats: {
      pagesVisited: 0,
      formsFound: 0,
      apiEndpoints: 0,
      screenshotCount: 0,
      duration: 0,
    },
    files: [],
  };
}

function bundle(overrides: Partial<LoadedBundle> = {}): LoadedBundle {
  return {
    bundleDir: '/tmp/bundle',
    manifest: emptyManifest(),
    sitemap: overrides.sitemap ?? [],
    forms: overrides.forms ?? [],
    apiMap: overrides.apiMap ?? [],
    flowGraphMermaid: overrides.flowGraphMermaid ?? '',
    accessibility: overrides.accessibility ?? null,
  };
}

// ---------------------------------------------------------------------------
// searchRoutes
// ---------------------------------------------------------------------------

describe('searchRoutes', () => {
  const b = bundle({
    sitemap: [
      route({ url: 'https://example.com/', title: 'Home' }),
      route({ url: 'https://example.com/about', title: 'About Us' }),
      route({ url: 'https://example.com/contact', title: 'Contact', statusCode: 404 }),
      route({ url: 'https://example.com/admin/users', title: 'Admin — Users' }),
    ],
  });

  it('matches URL substring', () => {
    const r = searchRoutes(b, { query: 'admin' });
    expect(r.total).toBe(1);
    expect(r.matches[0].url).toContain('/admin/');
  });

  it('matches title substring (case-insensitive)', () => {
    const r = searchRoutes(b, { query: 'ABOUT' });
    expect(r.total).toBe(1);
    expect(r.matches[0].title).toBe('About Us');
  });

  it('empty query returns everything', () => {
    const r = searchRoutes(b, { query: '' });
    expect(r.total).toBe(4);
  });

  it('status filter', () => {
    const r = searchRoutes(b, { query: '', status: 404 });
    expect(r.total).toBe(1);
    expect(r.matches[0].statusCode).toBe(404);
  });

  it('honours limit and reports hasMore', () => {
    const r = searchRoutes(b, { query: '', limit: 2 });
    expect(r.matches).toHaveLength(2);
    expect(r.hasMore).toBe(true);
    expect(r.total).toBe(4);
  });

  it('limit above the cap is clamped', () => {
    const r = searchRoutes(b, { query: '', limit: 5000 });
    expect(r.matches).toHaveLength(4);
  });
});

// ---------------------------------------------------------------------------
// listForms
// ---------------------------------------------------------------------------

describe('listForms', () => {
  const loginForm = form({
    method: 'POST',
    action: '/login',
    fields: [field({ name: 'email', type: 'email' }), field({ name: 'password', type: 'password' })],
  });
  const searchForm = form({
    method: 'GET',
    action: '/search',
    fields: [field({ name: 'q', type: 'text' })],
  });
  const b = bundle({ forms: [loginForm, searchForm] });

  it('filters by has_password=true', () => {
    const r = listForms(b, { hasPassword: true });
    expect(r.total).toBe(1);
    expect(r.forms[0].action).toBe('/login');
  });

  it('filters by has_password=false', () => {
    const r = listForms(b, { hasPassword: false });
    expect(r.total).toBe(1);
    expect(r.forms[0].action).toBe('/search');
  });

  it('filters by method case-insensitively', () => {
    const r = listForms(b, { method: 'post' });
    expect(r.total).toBe(1);
    expect(r.forms[0].method).toBe('POST');
  });

  it('returns everything when no filter', () => {
    const r = listForms(b, {});
    expect(r.total).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// findFormsWithoutCsrf
// ---------------------------------------------------------------------------

describe('findFormsWithoutCsrf', () => {
  it('flags a POST form that has no token field', () => {
    const f = form({
      method: 'POST',
      action: '/comments',
      fields: [field({ name: 'body', type: 'text' })],
    });
    expect(findFormsWithoutCsrf(bundle({ forms: [f] }))).toEqual([f]);
  });

  it('accepts Laravel-style _token', () => {
    const f = form({
      method: 'POST',
      action: '/comments',
      fields: [
        field({ name: '_token', type: 'hidden' }),
        field({ name: 'body', type: 'text' }),
      ],
    });
    expect(findFormsWithoutCsrf(bundle({ forms: [f] }))).toHaveLength(0);
  });

  it('accepts Rails-style authenticity_token', () => {
    const f = form({
      method: 'POST',
      action: '/comments',
      fields: [field({ name: 'authenticity_token', type: 'hidden' })],
    });
    expect(findFormsWithoutCsrf(bundle({ forms: [f] }))).toHaveLength(0);
  });

  it('accepts Angular-style xsrf', () => {
    const f = form({
      method: 'POST',
      action: '/api',
      fields: [field({ name: 'X-XSRF-TOKEN', type: 'hidden' })],
    });
    expect(findFormsWithoutCsrf(bundle({ forms: [f] }))).toHaveLength(0);
  });

  it('accepts plain csrf', () => {
    const f = form({
      method: 'POST',
      action: '/api',
      fields: [field({ name: 'csrf', type: 'hidden' })],
    });
    expect(findFormsWithoutCsrf(bundle({ forms: [f] }))).toHaveLength(0);
  });

  it('ignores GET forms even if they lack a token', () => {
    const f = form({
      method: 'GET',
      action: '/search',
      fields: [field({ name: 'q', type: 'text' })],
    });
    expect(findFormsWithoutCsrf(bundle({ forms: [f] }))).toHaveLength(0);
  });

  it('does not treat password fields as CSRF tokens', () => {
    // A field named `password_token` is user-controlled, not anti-CSRF.
    const f = form({
      method: 'POST',
      action: '/login',
      fields: [field({ name: 'csrf_token', type: 'password' })],
    });
    // password-typed field cannot satisfy the heuristic → still flagged.
    expect(findFormsWithoutCsrf(bundle({ forms: [f] }))).toHaveLength(1);
  });

  it('matches the token via the label when name is blank', () => {
    const f = form({
      method: 'POST',
      action: '/api',
      fields: [field({ name: '', type: 'hidden', label: 'CSRF protection' })],
    });
    expect(findFormsWithoutCsrf(bundle({ forms: [f] }))).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// getApiEndpoint
// ---------------------------------------------------------------------------

describe('getApiEndpoint', () => {
  const b = bundle({
    apiMap: [
      apiGroup('/api/users/:id', 'GET'),
      apiGroup('/api/posts', 'POST'),
    ],
  });

  it('matches on exact method + pattern', () => {
    const ep = getApiEndpoint(b, { method: 'GET', pattern: '/api/users/:id' });
    expect(ep?.pattern).toBe('/api/users/:id');
  });

  it('is case-insensitive for method', () => {
    const ep = getApiEndpoint(b, { method: 'get', pattern: '/api/users/:id' });
    expect(ep).not.toBeNull();
  });

  it('parameterizes numeric IDs and matches fuzzy', () => {
    const ep = getApiEndpoint(b, { method: 'GET', pattern: '/api/users/42' });
    expect(ep?.pattern).toBe('/api/users/:id');
  });

  it('parameterizes UUIDs', () => {
    const ep = getApiEndpoint(b, {
      method: 'GET',
      pattern: '/api/users/550e8400-e29b-41d4-a716-446655440000',
    });
    expect(ep?.pattern).toBe('/api/users/:id');
  });

  it('strips origin from full URLs before matching', () => {
    const ep = getApiEndpoint(b, {
      method: 'GET',
      pattern: 'https://example.com/api/users/123',
    });
    expect(ep?.pattern).toBe('/api/users/:id');
  });

  it('returns null when no match', () => {
    expect(getApiEndpoint(b, { method: 'DELETE', pattern: '/api/users/:id' })).toBeNull();
    expect(getApiEndpoint(b, { method: 'GET', pattern: '/nowhere' })).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// listAccessibilityViolations
// ---------------------------------------------------------------------------

describe('listAccessibilityViolations', () => {
  it('returns present=false when no a11y data', () => {
    const r = listAccessibilityViolations(bundle(), {});
    expect(r.present).toBe(false);
    expect(r.violations).toEqual([]);
    expect(r.total).toBe(0);
  });

  it('flattens and sorts by impact severity', () => {
    const b = bundle({
      accessibility: {
        totalViolations: 3,
        byImpact: { minor: 1, critical: 1, serious: 1 },
        perPage: [
          {
            url: 'https://example.com/',
            violations: [
              { id: 'color-contrast', impact: 'serious', nodes: 2, help: 'help', helpUrl: 'u' },
              { id: 'alt-text', impact: 'critical', nodes: 1, help: 'help', helpUrl: 'u' },
            ],
          },
          {
            url: 'https://example.com/about',
            violations: [
              { id: 'heading-order', impact: 'minor', nodes: 1, help: 'help', helpUrl: 'u' },
            ],
          },
        ],
      },
    });
    const r = listAccessibilityViolations(b, {});
    expect(r.present).toBe(true);
    expect(r.total).toBe(3);
    // Critical first, then serious, then minor
    expect(r.violations.map((v) => v.impact)).toEqual(['critical', 'serious', 'minor']);
  });

  it('filters by impact', () => {
    const b = bundle({
      accessibility: {
        totalViolations: 2,
        byImpact: { minor: 1, critical: 1 },
        perPage: [
          {
            url: 'https://example.com/',
            violations: [
              { id: 'a', impact: 'critical', nodes: 1, help: '', helpUrl: '' },
              { id: 'b', impact: 'minor', nodes: 1, help: '', helpUrl: '' },
            ],
          },
        ],
      },
    });
    const r = listAccessibilityViolations(b, { impact: 'critical' });
    expect(r.total).toBe(1);
    expect(r.violations[0].impact).toBe('critical');
  });
});

// ---------------------------------------------------------------------------
// listBrokenRoutes
// ---------------------------------------------------------------------------

describe('listBrokenRoutes', () => {
  const b = bundle({
    sitemap: [
      route({ url: 'https://example.com/', statusCode: 200 }),
      route({ url: 'https://example.com/404', statusCode: 404 }),
      route({ url: 'https://example.com/500', statusCode: 500 }),
      route({ url: 'https://example.com/502', statusCode: 502 }),
    ],
  });

  it('filters to status >= 400 by default', () => {
    const r = listBrokenRoutes(b, {});
    expect(r.total).toBe(3);
  });

  it('sorts by status desc', () => {
    const r = listBrokenRoutes(b, {});
    expect(r.routes.map((x) => x.statusCode)).toEqual([502, 500, 404]);
  });

  it('honours min_status override', () => {
    const r = listBrokenRoutes(b, { minStatus: 500 });
    expect(r.total).toBe(2);
    expect(r.routes.every((x) => x.statusCode >= 500)).toBe(true);
  });

  it('honours limit', () => {
    const r = listBrokenRoutes(b, { limit: 1 });
    expect(r.routes).toHaveLength(1);
    expect(r.hasMore).toBe(true);
  });
});
