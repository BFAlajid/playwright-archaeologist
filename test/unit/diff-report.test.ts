/**
 * Unit tests for src/diff/diff-report.ts
 *
 * Tests the HTML diff report generator: valid HTML output,
 * summary sections, XSS escaping, and empty diff handling.
 */

import { describe, it, expect } from 'vitest';
import { generateDiffReportHtml } from '../../src/diff/diff-report.js';
import type { DiffResult, DiffSummary } from '../../src/types/artifacts.js';

/** Create a minimal DiffResult for testing. */
function makeDiffResult(overrides?: Partial<DiffResult>): DiffResult {
  const summary: DiffSummary = {
    routes: { added: 0, removed: 0, changed: 0, unchanged: 0 },
    forms: { added: 0, removed: 0, changed: 0, unchanged: 0 },
    api: { added: 0, removed: 0, changed: 0, unchanged: 0 },
    screenshots: { added: 0, removed: 0, changed: 0, unchanged: 0 },
  };

  return {
    meta: {
      oldBundle: {
        path: '/old',
        createdAt: '2025-01-01T00:00:00.000Z',
        targetUrl: 'https://example.com',
        toolVersion: '0.1.0',
      },
      newBundle: {
        path: '/new',
        createdAt: '2025-02-01T00:00:00.000Z',
        targetUrl: 'https://example.com',
        toolVersion: '0.1.0',
      },
      comparedAt: '2025-03-01T00:00:00.000Z',
    },
    hasChanges: false,
    sitemap: { added: [], removed: [], changed: [], unchangedCount: 0 },
    forms: { added: [], removed: [], changed: [], unchangedCount: 0 },
    api: { added: [], removed: [], changed: [], unchangedCount: 0 },
    screenshots: { added: [], removed: [], changed: [], unchangedCount: 0 },
    summary,
    ...overrides,
  };
}

describe('generateDiffReportHtml', () => {
  it('generates valid HTML with doctype and closing tags', () => {
    const html = generateDiffReportHtml(makeDiffResult());

    expect(html).toContain('<!DOCTYPE html>');
    expect(html).toContain('<html');
    expect(html).toContain('</html>');
    expect(html).toContain('<head>');
    expect(html).toContain('</head>');
    expect(html).toContain('<body>');
    expect(html).toContain('</body>');
  });

  it('includes Content-Security-Policy meta tag', () => {
    const html = generateDiffReportHtml(makeDiffResult());

    expect(html).toContain('Content-Security-Policy');
    expect(html).toContain("default-src 'none'");
  });

  it('includes summary section with card counts', () => {
    const html = generateDiffReportHtml(
      makeDiffResult({
        hasChanges: true,
        summary: {
          routes: { added: 2, removed: 1, changed: 3, unchanged: 10 },
          forms: { added: 0, removed: 0, changed: 0, unchanged: 5 },
          api: { added: 1, removed: 0, changed: 0, unchanged: 3 },
          screenshots: { added: 0, removed: 0, changed: 1, unchanged: 8 },
        },
      }),
    );

    expect(html).toContain('Routes');
    expect(html).toContain('Forms');
    expect(html).toContain('API Endpoints');
    expect(html).toContain('Screenshots');
  });

  it('shows no-changes notice for empty diff', () => {
    const html = generateDiffReportHtml(makeDiffResult({ hasChanges: false }));

    expect(html).toContain('No changes detected between bundles');
  });

  it('does not show no-changes notice when there are changes', () => {
    const html = generateDiffReportHtml(
      makeDiffResult({
        hasChanges: true,
        sitemap: {
          added: [
            {
              url: 'https://example.com/new',
              title: 'New Page',
              statusCode: 200,
              contentHash: 'abc',
              depth: 1,
              formCount: 0,
              apiCallCount: 0,
              hasScreenshot: false,
              discoveryMethod: 'link' as const,
            },
          ],
          removed: [],
          changed: [],
          unchangedCount: 0,
        },
        summary: {
          routes: { added: 1, removed: 0, changed: 0, unchanged: 0 },
          forms: { added: 0, removed: 0, changed: 0, unchanged: 0 },
          api: { added: 0, removed: 0, changed: 0, unchanged: 0 },
          screenshots: { added: 0, removed: 0, changed: 0, unchanged: 0 },
        },
      }),
    );

    expect(html).not.toContain('No changes detected between bundles');
  });

  it('escapes user content to prevent XSS', () => {
    const html = generateDiffReportHtml(
      makeDiffResult({
        hasChanges: true,
        sitemap: {
          added: [
            {
              url: 'https://example.com/<script>alert(1)</script>',
              title: '<img onerror=alert(1) src=x>',
              statusCode: 200,
              contentHash: 'abc',
              depth: 1,
              formCount: 0,
              apiCallCount: 0,
              hasScreenshot: false,
              discoveryMethod: 'link' as const,
            },
          ],
          removed: [],
          changed: [],
          unchangedCount: 0,
        },
        summary: {
          routes: { added: 1, removed: 0, changed: 0, unchanged: 0 },
          forms: { added: 0, removed: 0, changed: 0, unchanged: 0 },
          api: { added: 0, removed: 0, changed: 0, unchanged: 0 },
          screenshots: { added: 0, removed: 0, changed: 0, unchanged: 0 },
        },
      }),
    );

    // Script tag should be escaped
    expect(html).not.toContain('<script>alert(1)</script>');
    expect(html).toContain('&lt;script&gt;');

    // IMG tag should be escaped
    expect(html).not.toContain('<img');
    expect(html).toContain('&lt;img');
  });

  it('escapes meta section content', () => {
    const html = generateDiffReportHtml(
      makeDiffResult({
        meta: {
          oldBundle: {
            path: '/old',
            createdAt: '2025-01-01',
            targetUrl: '<script>alert("xss")</script>',
            toolVersion: '0.1.0',
          },
          newBundle: {
            path: '/new',
            createdAt: '2025-02-01',
            targetUrl: 'https://example.com',
            toolVersion: '0.1.0',
          },
          comparedAt: '2025-03-01',
        },
      }),
    );

    expect(html).not.toContain('<script>alert("xss")</script>');
    expect(html).toContain('&lt;script&gt;');
  });

  it('renders added routes section', () => {
    const html = generateDiffReportHtml(
      makeDiffResult({
        hasChanges: true,
        sitemap: {
          added: [
            {
              url: 'https://example.com/new-page',
              title: 'New Page',
              statusCode: 200,
              contentHash: 'hash',
              depth: 1,
              formCount: 0,
              apiCallCount: 0,
              hasScreenshot: false,
              discoveryMethod: 'link' as const,
            },
          ],
          removed: [],
          changed: [],
          unchangedCount: 5,
        },
        summary: {
          routes: { added: 1, removed: 0, changed: 0, unchanged: 5 },
          forms: { added: 0, removed: 0, changed: 0, unchanged: 0 },
          api: { added: 0, removed: 0, changed: 0, unchanged: 0 },
          screenshots: { added: 0, removed: 0, changed: 0, unchanged: 0 },
        },
      }),
    );

    expect(html).toContain('Added Routes');
    expect(html).toContain('https://example.com/new-page');
    expect(html).toContain('New Page');
  });

  it('renders modified routes with change details', () => {
    const html = generateDiffReportHtml(
      makeDiffResult({
        hasChanges: true,
        sitemap: {
          added: [],
          removed: [],
          changed: [
            {
              url: 'https://example.com/',
              changes: {
                title: { old: 'Old Title', new: 'New Title' },
                statusCode: { old: 200, new: 301 },
              },
            },
          ],
          unchangedCount: 0,
        },
        summary: {
          routes: { added: 0, removed: 0, changed: 1, unchanged: 0 },
          forms: { added: 0, removed: 0, changed: 0, unchanged: 0 },
          api: { added: 0, removed: 0, changed: 0, unchanged: 0 },
          screenshots: { added: 0, removed: 0, changed: 0, unchanged: 0 },
        },
      }),
    );

    expect(html).toContain('Modified Routes');
    expect(html).toContain('Old Title');
    expect(html).toContain('New Title');
    expect(html).toContain('200');
    expect(html).toContain('301');
  });

  it('renders forms section with added and removed forms', () => {
    const html = generateDiffReportHtml(
      makeDiffResult({
        hasChanges: true,
        forms: {
          added: [
            {
              action: '/signup',
              method: 'POST',
              isImplicit: false,
              fields: [{ name: 'email', type: 'email', required: true }],
              validationMessages: [],
              wasHidden: false,
            },
          ],
          removed: [],
          changed: [],
          unchangedCount: 0,
        },
        summary: {
          routes: { added: 0, removed: 0, changed: 0, unchanged: 0 },
          forms: { added: 1, removed: 0, changed: 0, unchanged: 0 },
          api: { added: 0, removed: 0, changed: 0, unchanged: 0 },
          screenshots: { added: 0, removed: 0, changed: 0, unchanged: 0 },
        },
      }),
    );

    expect(html).toContain('Added Forms');
    expect(html).toContain('/signup');
    expect(html).toContain('POST');
    expect(html).toContain('email');
  });

  it('renders API endpoint section', () => {
    const html = generateDiffReportHtml(
      makeDiffResult({
        hasChanges: true,
        api: {
          added: [
            {
              method: 'GET',
              pattern: '/api/users',
              classification: 'api' as const,
              observedUrls: [],
              callCount: 1,
              callingPages: [],
              exampleRequest: { url: '/api/users', headers: {} },
              exampleResponse: { statusCode: 200, headers: {}, bodySize: 100 },
              observedStatusCodes: [200],
              observedContentTypes: ['application/json'],
              isGraphQL: false,
            },
          ],
          removed: [],
          changed: [],
          unchangedCount: 0,
        },
        summary: {
          routes: { added: 0, removed: 0, changed: 0, unchanged: 0 },
          forms: { added: 0, removed: 0, changed: 0, unchanged: 0 },
          api: { added: 1, removed: 0, changed: 0, unchanged: 0 },
          screenshots: { added: 0, removed: 0, changed: 0, unchanged: 0 },
        },
      }),
    );

    expect(html).toContain('Added Endpoints');
    expect(html).toContain('/api/users');
  });

  it('renders screenshot section with changes', () => {
    const html = generateDiffReportHtml(
      makeDiffResult({
        hasChanges: true,
        screenshots: {
          added: [],
          removed: [],
          changed: [
            {
              url: 'https://example.com/',
              diffPercentage: 100,
              diffPixelCount: 0,
              totalPixels: 0,
              diffImagePath: '',
              oldScreenshotPath: '/old/screenshots/home.png',
              newScreenshotPath: '/new/screenshots/home.png',
            },
          ],
          unchangedCount: 5,
        },
        summary: {
          routes: { added: 0, removed: 0, changed: 0, unchanged: 0 },
          forms: { added: 0, removed: 0, changed: 0, unchanged: 0 },
          api: { added: 0, removed: 0, changed: 0, unchanged: 0 },
          screenshots: { added: 0, removed: 0, changed: 1, unchanged: 5 },
        },
      }),
    );

    expect(html).toContain('Changed Screenshots');
    expect(html).toContain('100% changed');
  });

  it('handles empty diff with no changes in any section', () => {
    const html = generateDiffReportHtml(makeDiffResult());

    expect(html).toContain('No route changes detected');
    expect(html).toContain('No form changes detected');
    expect(html).toContain('No API endpoint changes detected');
    expect(html).toContain('No screenshot changes detected');
  });

  it('includes title in document', () => {
    const html = generateDiffReportHtml(makeDiffResult());

    expect(html).toContain('<title>Diff Report');
  });

  it('includes inline styles (self-contained report)', () => {
    const html = generateDiffReportHtml(makeDiffResult());

    expect(html).toContain('<style>');
    expect(html).toContain('font-family');
  });
});
