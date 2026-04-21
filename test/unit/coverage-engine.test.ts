/**
 * Unit tests for the coverage engine.
 *
 * Covers:
 *   - Basic coverage computation (covered/uncovered percentages).
 *   - Pattern matching: test hitting /users/42 covers /users/:id endpoint.
 *   - ignorePatterns filters both routes and APIs before totals are taken.
 *   - Empty inputs produce sane defaults (100% trivially).
 *   - Summary percentages match hand-computed values.
 */

import { describe, it, expect } from 'vitest';

import { computeCoverage } from '../../src/coverage/coverage-engine.js';
import type { TestReference } from '../../src/coverage/test-scanner.js';
import type { ApiEndpointGroup, RouteInfo } from '../../src/types/artifacts.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function route(url: string, overrides: Partial<RouteInfo> = {}): RouteInfo {
  return {
    url,
    title: overrides.title ?? '',
    statusCode: overrides.statusCode ?? 200,
    contentHash: overrides.contentHash ?? '',
    depth: overrides.depth ?? 0,
    formCount: overrides.formCount ?? 0,
    apiCallCount: overrides.apiCallCount ?? 0,
    hasScreenshot: overrides.hasScreenshot ?? false,
    discoveryMethod: overrides.discoveryMethod ?? 'link',
  };
}

function api(
  method: string,
  pattern: string,
  overrides: Partial<ApiEndpointGroup> = {},
): ApiEndpointGroup {
  return {
    pattern,
    method,
    classification: overrides.classification ?? 'api',
    observedUrls: overrides.observedUrls ?? [`https://app.example.com${pattern}`],
    callCount: overrides.callCount ?? 1,
    callingPages: overrides.callingPages ?? [],
    exampleRequest: overrides.exampleRequest ?? { url: '', headers: {} },
    exampleResponse: overrides.exampleResponse ?? { statusCode: 200, headers: {}, bodySize: 0 },
    observedStatusCodes: overrides.observedStatusCodes ?? [200],
    observedContentTypes: overrides.observedContentTypes ?? ['application/json'],
    isGraphQL: overrides.isGraphQL ?? false,
    graphqlOperations: overrides.graphqlOperations,
  };
}

function ref(
  resolvedUrl: string,
  method = 'GET',
  opts: Partial<TestReference> = {},
): TestReference {
  return {
    filePath: opts.filePath ?? 'test.spec.ts',
    lineNumber: opts.lineNumber ?? 1,
    rawUrl: opts.rawUrl ?? resolvedUrl,
    resolvedUrl,
    method,
  };
}

const BUNDLE_CTX = { bundleTarget: 'https://app.example.com', testDir: '/tests' };

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('computeCoverage — routes', () => {
  it('covers 7 of 10 routes when tests hit 7 of them', () => {
    const routes: RouteInfo[] = [
      route('https://app.example.com/page1'),
      route('https://app.example.com/page2'),
      route('https://app.example.com/page3'),
      route('https://app.example.com/page4'),
      route('https://app.example.com/page5'),
      route('https://app.example.com/page6'),
      route('https://app.example.com/page7'),
      route('https://app.example.com/page8'),
      route('https://app.example.com/page9'),
      route('https://app.example.com/page10'),
    ];
    const tests: TestReference[] = [
      ref('https://app.example.com/page1'),
      ref('https://app.example.com/page2'),
      ref('https://app.example.com/page3'),
      ref('https://app.example.com/page4'),
      ref('https://app.example.com/page5'),
      ref('https://app.example.com/page6'),
      ref('https://app.example.com/page7'),
    ];

    const report = computeCoverage({ ...BUNDLE_CTX, routes, apis: [] }, tests);
    expect(report.summary.routesTotal).toBe(10);
    expect(report.summary.routesCovered).toBe(7);
    expect(report.summary.routesPercentage).toBe(70);
    const uncovered = report.routes.filter((r) => !r.covered).map((r) => r.url);
    expect(uncovered).toEqual([
      'https://app.example.com/page8',
      'https://app.example.com/page9',
      'https://app.example.com/page10',
    ]);
  });

  it('covers routes that share a pathname regardless of query string', () => {
    // Different query strings are considered the same logical route for
    // coverage purposes — a test against ?q=foo also covers ?q=bar. The
    // URL catalog still distinguishes them, but "is there a Playwright
    // test exercising this page?" is pathname-level.
    const routes = [
      route('https://app.example.com/search?q=foo'),
      route('https://app.example.com/search?q=bar'),
    ];
    const tests = [ref('https://app.example.com/search?q=foo')];
    const report = computeCoverage({ ...BUNDLE_CTX, routes, apis: [] }, tests);
    expect(report.summary.routesCovered).toBe(2);
  });

  it('ignores patterns that match via matchesGlob', () => {
    const routes = [
      route('https://app.example.com/'),
      route('https://app.example.com/admin/users'),
      route('https://app.example.com/admin/settings'),
      route('https://app.example.com/public'),
    ];
    const tests = [ref('https://app.example.com/')];
    const report = computeCoverage(
      { ...BUNDLE_CTX, routes, apis: [] },
      tests,
      { ignorePatterns: ['**/admin/**'] },
    );
    // Only root + /public remain after ignoring admin/**.
    expect(report.summary.routesTotal).toBe(2);
    expect(report.summary.routesCovered).toBe(1);
    expect(report.summary.routesPercentage).toBe(50);
    expect(report.ignoredPatterns).toEqual(['**/admin/**']);
  });

  it('returns 100% when there are zero routes', () => {
    const report = computeCoverage(
      { ...BUNDLE_CTX, routes: [], apis: [] },
      [],
    );
    expect(report.summary.routesPercentage).toBe(100);
    expect(report.summary.apisPercentage).toBe(100);
    expect(report.summary.overallPercentage).toBe(100);
  });
});

describe('computeCoverage — APIs', () => {
  it('covers 3 of 5 API endpoints when tests hit 3 of them', () => {
    const apis: ApiEndpointGroup[] = [
      api('GET', '/api/users'),
      api('POST', '/api/users'),
      api('GET', '/api/orders'),
      api('GET', '/api/invoices'),
      api('DELETE', '/api/users/:id'),
    ];
    const tests: TestReference[] = [
      ref('https://app.example.com/api/users', 'GET'),
      ref('https://app.example.com/api/users', 'POST'),
      ref('https://app.example.com/api/orders', 'GET'),
    ];
    const report = computeCoverage({ ...BUNDLE_CTX, routes: [], apis }, tests);
    expect(report.summary.apisTotal).toBe(5);
    expect(report.summary.apisCovered).toBe(3);
    expect(report.summary.apisPercentage).toBe(60);
  });

  it('matches :id parameter in API pattern against concrete test URL', () => {
    const apis = [api('GET', '/api/users/:id')];
    // Test hits /users/42 — should cover the parameterised pattern.
    const tests = [ref('https://app.example.com/api/users/42', 'GET')];
    const report = computeCoverage({ ...BUNDLE_CTX, routes: [], apis }, tests);
    expect(report.summary.apisCovered).toBe(1);
    expect(report.apis[0].coveringTests).toHaveLength(1);
  });

  it('does not match when method differs', () => {
    const apis = [api('POST', '/api/users')];
    const tests = [ref('https://app.example.com/api/users', 'GET')];
    const report = computeCoverage({ ...BUNDLE_CTX, routes: [], apis }, tests);
    expect(report.summary.apisCovered).toBe(0);
  });

  it('ignore patterns on API endpoints drop them from totals', () => {
    const apis = [
      api('GET', '/api/users'),
      api('GET', '/api/internal/metrics', {
        observedUrls: ['https://app.example.com/api/internal/metrics'],
      }),
    ];
    const tests = [ref('https://app.example.com/api/users', 'GET')];
    const report = computeCoverage(
      { ...BUNDLE_CTX, routes: [], apis },
      tests,
      { ignorePatterns: ['**/api/internal/**'] },
    );
    expect(report.summary.apisTotal).toBe(1);
    expect(report.summary.apisCovered).toBe(1);
    expect(report.summary.apisPercentage).toBe(100);
  });
});

describe('computeCoverage — overall summary', () => {
  it('computes an overall percentage across routes + APIs', () => {
    const routes = [route('https://app.example.com/a'), route('https://app.example.com/b')];
    const apis = [api('GET', '/api/c'), api('GET', '/api/d')];
    const tests = [
      ref('https://app.example.com/a'),
      ref('https://app.example.com/api/c', 'GET'),
    ];
    const report = computeCoverage({ ...BUNDLE_CTX, routes, apis }, tests);
    expect(report.summary.routesCovered).toBe(1);
    expect(report.summary.apisCovered).toBe(1);
    // 2 of 4 total -> 50%
    expect(report.summary.overallPercentage).toBe(50);
  });

  it('populates coveringTests with accurate file + line metadata', () => {
    const routes = [route('https://app.example.com/x')];
    const tests = [
      ref('https://app.example.com/x', 'GET', {
        filePath: 'specs/first.spec.ts',
        lineNumber: 42,
      }),
      ref('https://app.example.com/x', 'GET', {
        filePath: 'specs/second.spec.ts',
        lineNumber: 7,
      }),
    ];
    const report = computeCoverage({ ...BUNDLE_CTX, routes, apis: [] }, tests);
    expect(report.routes[0].coveringTests).toHaveLength(2);
    const first = report.routes[0].coveringTests[0];
    expect(first.filePath).toBe('specs/first.spec.ts');
    expect(first.lineNumber).toBe(42);
  });

  it('carries through bundleTarget and testDir in the report', () => {
    const report = computeCoverage(
      {
        routes: [],
        apis: [],
        bundleTarget: 'https://prod.example.com',
        testDir: '/home/user/tests',
      },
      [],
      { scannedAt: '2026-04-21T00:00:00Z' },
    );
    expect(report.bundleTarget).toBe('https://prod.example.com');
    expect(report.testDir).toBe('/home/user/tests');
    expect(report.scannedAt).toBe('2026-04-21T00:00:00Z');
  });
});
