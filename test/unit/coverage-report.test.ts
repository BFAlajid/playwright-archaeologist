/**
 * Unit tests for the coverage report renderers.
 *
 * These do not validate visual output — they check:
 *   - HTML: contains CSP meta tag, summary percentages, route rows, API
 *     rows, and escapes user-controlled strings.
 *   - JSON: round-trips through JSON.parse with the same shape.
 *   - Markdown: includes summary table and uncovered lists.
 *   - JUnit: is well-formed XML, totals match failure count.
 */

import { describe, it, expect } from 'vitest';

import {
  generateCoverageReportHtml,
  generateCoverageReportJson,
  generateCoverageReportMarkdown,
  generateCoverageReportJUnit,
} from '../../src/coverage/coverage-report.js';
import type { CoverageReport } from '../../src/coverage/coverage-engine.js';

// ---------------------------------------------------------------------------
// Fixture
// ---------------------------------------------------------------------------

function fixture(overrides: Partial<CoverageReport> = {}): CoverageReport {
  return {
    summary: {
      routesTotal: 3,
      routesCovered: 2,
      routesPercentage: 66.67,
      apisTotal: 2,
      apisCovered: 1,
      apisPercentage: 50,
      overallPercentage: 60,
    },
    routes: [
      {
        url: 'https://app.example.com/a',
        method: 'GET',
        covered: true,
        coveringTests: [
          { filePath: 'a.spec.ts', lineNumber: 3, rawUrl: 'https://app.example.com/a', resolvedUrl: 'https://app.example.com/a', method: 'GET' },
        ],
      },
      {
        url: 'https://app.example.com/b',
        method: 'GET',
        covered: true,
        coveringTests: [
          { filePath: 'b.spec.ts', lineNumber: 4, rawUrl: 'https://app.example.com/b', resolvedUrl: 'https://app.example.com/b', method: 'GET' },
        ],
      },
      {
        url: 'https://app.example.com/c',
        method: 'GET',
        covered: false,
        coveringTests: [],
      },
    ],
    apis: [
      {
        method: 'GET',
        pattern: '/api/users',
        covered: true,
        coveringTests: [
          { filePath: 'api.spec.ts', lineNumber: 10, rawUrl: 'https://api.example.com/users', resolvedUrl: 'https://api.example.com/users', method: 'GET' },
        ],
      },
      {
        method: 'POST',
        pattern: '/api/orders',
        covered: false,
        coveringTests: [],
      },
    ],
    bundleTarget: 'https://app.example.com',
    testDir: '/tests',
    scannedAt: '2026-04-21T00:00:00.000Z',
    ignoredPatterns: [],
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// HTML
// ---------------------------------------------------------------------------

describe('generateCoverageReportHtml', () => {
  it('renders CSP meta, summary, and route/api tables', () => {
    const html = generateCoverageReportHtml(fixture());
    expect(html).toContain('Content-Security-Policy');
    expect(html).toContain('60%'); // overall pct
    expect(html).toContain('https://app.example.com/a');
    expect(html).toContain('https://app.example.com/c');
    expect(html).toContain('/api/users');
    expect(html).toContain('/api/orders');
    expect(html).toContain('badge-covered');
    expect(html).toContain('badge-uncovered');
  });

  it('escapes HTML metacharacters in URLs', () => {
    const html = generateCoverageReportHtml(
      fixture({
        routes: [
          {
            url: 'https://app.example.com/<script>alert(1)</script>',
            method: 'GET',
            covered: false,
            coveringTests: [],
          },
        ],
      }),
    );
    expect(html).not.toContain('<script>alert(1)</script>');
    expect(html).toContain('&lt;script&gt;');
  });

  it('reveals ignoredPatterns when set', () => {
    const html = generateCoverageReportHtml(
      fixture({ ignoredPatterns: ['**/admin/**', '**/_next/**'] }),
    );
    expect(html).toContain('Ignored patterns');
    expect(html).toContain('**/admin/**');
    expect(html).toContain('**/_next/**');
  });
});

// ---------------------------------------------------------------------------
// JSON
// ---------------------------------------------------------------------------

describe('generateCoverageReportJson', () => {
  it('round-trips through JSON.parse', () => {
    const json = generateCoverageReportJson(fixture());
    const parsed = JSON.parse(json);
    expect(parsed.summary.overallPercentage).toBe(60);
    expect(parsed.routes).toHaveLength(3);
    expect(parsed.apis).toHaveLength(2);
    expect(parsed.bundleTarget).toBe('https://app.example.com');
  });

  it('pretty-prints by default', () => {
    const pretty = generateCoverageReportJson(fixture());
    const compact = generateCoverageReportJson(fixture(), false);
    expect(pretty.length).toBeGreaterThan(compact.length);
    expect(pretty).toContain('\n');
  });
});

// ---------------------------------------------------------------------------
// Markdown
// ---------------------------------------------------------------------------

describe('generateCoverageReportMarkdown', () => {
  it('includes summary table and uncovered lists', () => {
    const md = generateCoverageReportMarkdown(fixture());
    expect(md).toContain('# Playwright Coverage Report');
    expect(md).toContain('| Category | Covered | Total | Percentage |');
    expect(md).toContain('## Uncovered routes (1)');
    expect(md).toContain('https://app.example.com/c');
    expect(md).toContain('## Uncovered API endpoints (1)');
    expect(md).toContain('POST /api/orders');
  });

  it('renders "_None._" when no uncovered items exist', () => {
    const md = generateCoverageReportMarkdown(
      fixture({
        routes: [
          {
            url: 'https://app.example.com/a',
            method: 'GET',
            covered: true,
            coveringTests: [],
          },
        ],
        apis: [],
        summary: {
          routesTotal: 1,
          routesCovered: 1,
          routesPercentage: 100,
          apisTotal: 0,
          apisCovered: 0,
          apisPercentage: 100,
          overallPercentage: 100,
        },
      }),
    );
    expect(md).toContain('## Uncovered routes (0)');
    expect(md).toContain('_None._');
  });
});

// ---------------------------------------------------------------------------
// JUnit
// ---------------------------------------------------------------------------

describe('generateCoverageReportJUnit', () => {
  it('emits one testcase per route and api, with failures for uncovered entries', () => {
    const xml = generateCoverageReportJUnit(fixture());
    // 3 routes + 2 apis = 5 tests, 1 uncovered route + 1 uncovered api = 2 failures.
    expect(xml).toContain('tests="5"');
    expect(xml).toContain('failures="2"');
    expect(xml).toContain('<testsuite');
    expect(xml).toContain('classname="coverage.routes"');
    expect(xml).toContain('classname="coverage.apis"');
    // Uncovered endpoint should have a <failure> child.
    const failureCount = (xml.match(/<failure/g) || []).length;
    expect(failureCount).toBe(2);
  });

  it('escapes XML special characters in URLs', () => {
    const xml = generateCoverageReportJUnit(
      fixture({
        routes: [
          {
            url: 'https://app.example.com/?q=<&>"\'',
            method: 'GET',
            covered: false,
            coveringTests: [],
          },
        ],
        apis: [],
        summary: {
          routesTotal: 1,
          routesCovered: 0,
          routesPercentage: 0,
          apisTotal: 0,
          apisCovered: 0,
          apisPercentage: 100,
          overallPercentage: 0,
        },
      }),
    );
    expect(xml).not.toContain('<&>"');
    expect(xml).toContain('&lt;');
    expect(xml).toContain('&gt;');
    expect(xml).toContain('&amp;');
    expect(xml).toContain('&quot;');
    expect(xml).toContain('&apos;');
  });

  it('emits well-formed XML prolog and single root element', () => {
    const xml = generateCoverageReportJUnit(fixture());
    expect(xml.startsWith('<?xml version="1.0" encoding="UTF-8"?>')).toBe(true);
    expect(xml.match(/<\/testsuite>/g)).toHaveLength(1);
  });
});
