/**
 * Unit tests for src/collectors/page-scanner.ts
 *
 * Tests the scanPage function with mocked Playwright Page objects.
 * Verifies DOM extraction, link classification, timing, and error handling.
 */

import { describe, it, expect, vi } from 'vitest';
import { scanPage } from '../../src/collectors/page-scanner.js';
import type { Page, Response } from 'playwright';

// ---------------------------------------------------------------------------
// Mock helpers
// ---------------------------------------------------------------------------

/**
 * Create a minimal mock Page that returns the given evaluate results.
 * evaluateFn is called for each page.evaluate() invocation in order.
 */
function createMockPage(options: {
  url: string;
  evaluateResults: unknown[];
}): Page {
  let callIndex = 0;
  return {
    url: () => options.url,
    evaluate: vi.fn(async () => {
      const result = options.evaluateResults[callIndex];
      callIndex++;
      return result;
    }),
  } as unknown as Page;
}

function createMockResponse(statusCode: number): Response {
  return {
    status: () => statusCode,
  } as unknown as Response;
}

/** DOM data matching the shape returned by the first page.evaluate call. */
function makeDomData(overrides: Record<string, unknown> = {}) {
  return {
    canonicalHref: null,
    title: 'Test Page',
    metaTags: [],
    headings: [],
    landmarks: [],
    links: [],
    interactiveElements: [],
    contentHash: 'abcd1234',
    hashIndicators: 0,
    ...overrides,
  };
}

/** Timing data matching the shape returned by the second page.evaluate call. */
function makeTimingData(overrides: Record<string, unknown> = {}) {
  return {
    loadTime: 500,
    domContentLoaded: 300,
    firstContentfulPaint: null,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// scanPage — basic extraction
// ---------------------------------------------------------------------------

describe('scanPage', () => {
  it('returns the page URL and status code', async () => {
    const page = createMockPage({
      url: 'https://example.com/page',
      evaluateResults: [makeDomData(), makeTimingData()],
    });
    const response = createMockResponse(200);

    const result = await scanPage(page, 'https://example.com', response);

    expect(result.url).toBe('https://example.com/page');
    expect(result.statusCode).toBe(200);
  });

  it('defaults statusCode to 200 when no response is provided', async () => {
    const page = createMockPage({
      url: 'https://example.com/',
      evaluateResults: [makeDomData(), makeTimingData()],
    });

    const result = await scanPage(page, 'https://example.com');

    expect(result.statusCode).toBe(200);
  });

  it('extracts the page title', async () => {
    const page = createMockPage({
      url: 'https://example.com/',
      evaluateResults: [makeDomData({ title: 'Hello World' }), makeTimingData()],
    });

    const result = await scanPage(page, 'https://example.com');

    expect(result.title).toBe('Hello World');
  });

  it('extracts the canonical URL when present', async () => {
    const page = createMockPage({
      url: 'https://example.com/page?ref=123',
      evaluateResults: [
        makeDomData({ canonicalHref: 'https://example.com/page' }),
        makeTimingData(),
      ],
    });

    const result = await scanPage(page, 'https://example.com');

    expect(result.canonicalUrl).toBe('https://example.com/page');
  });

  it('omits canonicalUrl when not present', async () => {
    const page = createMockPage({
      url: 'https://example.com/',
      evaluateResults: [makeDomData({ canonicalHref: null }), makeTimingData()],
    });

    const result = await scanPage(page, 'https://example.com');

    expect(result.canonicalUrl).toBeUndefined();
  });

  // ---------------------------------------------------------------------------
  // Meta tags
  // ---------------------------------------------------------------------------

  it('extracts meta tags', async () => {
    const metaTags = [
      { name: 'description', content: 'A test page' },
      { property: 'og:title', content: 'Test Page OG' },
    ];
    const page = createMockPage({
      url: 'https://example.com/',
      evaluateResults: [makeDomData({ metaTags }), makeTimingData()],
    });

    const result = await scanPage(page, 'https://example.com');

    expect(result.metaTags).toEqual(metaTags);
  });

  // ---------------------------------------------------------------------------
  // Headings
  // ---------------------------------------------------------------------------

  it('extracts heading hierarchy', async () => {
    const headings = [
      { level: 1, text: 'Main Title' },
      { level: 2, text: 'Subtitle' },
      { level: 3, text: 'Sub-subtitle' },
    ];
    const page = createMockPage({
      url: 'https://example.com/',
      evaluateResults: [makeDomData({ headings }), makeTimingData()],
    });

    const result = await scanPage(page, 'https://example.com');

    expect(result.headings).toEqual(headings);
  });

  // ---------------------------------------------------------------------------
  // Landmarks
  // ---------------------------------------------------------------------------

  it('extracts landmark elements', async () => {
    const landmarks = [
      { role: 'navigation', tagName: 'nav', label: 'Main navigation' },
      { role: 'main', tagName: 'main' },
      { role: 'contentinfo', tagName: 'footer' },
    ];
    const page = createMockPage({
      url: 'https://example.com/',
      evaluateResults: [makeDomData({ landmarks }), makeTimingData()],
    });

    const result = await scanPage(page, 'https://example.com');

    expect(result.landmarks).toEqual(landmarks);
  });

  // ---------------------------------------------------------------------------
  // Links — internal/external classification
  // ---------------------------------------------------------------------------

  it('classifies same-origin links as internal', async () => {
    const links = [
      { href: 'https://example.com/about', text: 'About', rel: null },
    ];
    const page = createMockPage({
      url: 'https://example.com/',
      evaluateResults: [makeDomData({ links }), makeTimingData()],
    });

    const result = await scanPage(page, 'https://example.com');

    expect(result.links).toHaveLength(1);
    expect(result.links[0].isExternal).toBe(false);
    expect(result.links[0].href).toBe('https://example.com/about');
  });

  it('classifies cross-origin links as external', async () => {
    const links = [
      { href: 'https://other.com/page', text: 'Other Site', rel: 'nofollow' },
    ];
    const page = createMockPage({
      url: 'https://example.com/',
      evaluateResults: [makeDomData({ links }), makeTimingData()],
    });

    const result = await scanPage(page, 'https://example.com');

    expect(result.links).toHaveLength(1);
    expect(result.links[0].isExternal).toBe(true);
    expect(result.links[0].rel).toBe('nofollow');
  });

  it('resolves relative URLs in links against the page URL', async () => {
    const links = [
      { href: '/contact', text: 'Contact', rel: null },
    ];
    const page = createMockPage({
      url: 'https://example.com/about',
      evaluateResults: [makeDomData({ links }), makeTimingData()],
    });

    const result = await scanPage(page, 'https://example.com');

    // resolveUrl('/contact', 'https://example.com/about') -> 'https://example.com/contact'
    expect(result.links[0].href).toBe('https://example.com/contact');
    expect(result.links[0].isExternal).toBe(false);
  });

  it('omits rel when null', async () => {
    const links = [
      { href: 'https://example.com/page', text: 'Page', rel: null },
    ];
    const page = createMockPage({
      url: 'https://example.com/',
      evaluateResults: [makeDomData({ links }), makeTimingData()],
    });

    const result = await scanPage(page, 'https://example.com');

    expect(result.links[0].rel).toBeUndefined();
  });

  // ---------------------------------------------------------------------------
  // Interactive elements
  // ---------------------------------------------------------------------------

  it('extracts interactive elements with optional fields', async () => {
    const interactiveElements = [
      {
        tagName: 'button',
        type: 'submit',
        text: 'Submit',
        role: null,
        ariaLabel: 'Submit form',
        selector: 'button#submit-btn',
      },
      {
        tagName: 'input',
        type: 'text',
        text: 'Enter name',
        role: null,
        ariaLabel: null,
        selector: 'input[name="username"]',
      },
    ];
    const page = createMockPage({
      url: 'https://example.com/',
      evaluateResults: [makeDomData({ interactiveElements }), makeTimingData()],
    });

    const result = await scanPage(page, 'https://example.com');

    expect(result.interactiveElements).toHaveLength(2);

    // First element: has type, ariaLabel
    expect(result.interactiveElements[0].tagName).toBe('button');
    expect(result.interactiveElements[0].type).toBe('submit');
    expect(result.interactiveElements[0].ariaLabel).toBe('Submit form');
    expect(result.interactiveElements[0].role).toBeUndefined(); // null -> omitted

    // Second element: no ariaLabel
    expect(result.interactiveElements[1].tagName).toBe('input');
    expect(result.interactiveElements[1].ariaLabel).toBeUndefined();
  });

  // ---------------------------------------------------------------------------
  // Timing
  // ---------------------------------------------------------------------------

  it('extracts navigation timing data', async () => {
    const page = createMockPage({
      url: 'https://example.com/',
      evaluateResults: [
        makeDomData(),
        makeTimingData({ loadTime: 1200, domContentLoaded: 800, firstContentfulPaint: 400 }),
      ],
    });

    const result = await scanPage(page, 'https://example.com');

    expect(result.timing.loadTime).toBe(1200);
    expect(result.timing.domContentLoaded).toBe(800);
    expect(result.timing.firstContentfulPaint).toBe(400);
  });

  it('omits firstContentfulPaint when null', async () => {
    const page = createMockPage({
      url: 'https://example.com/',
      evaluateResults: [
        makeDomData(),
        makeTimingData({ firstContentfulPaint: null }),
      ],
    });

    const result = await scanPage(page, 'https://example.com');

    expect(result.timing.firstContentfulPaint).toBeUndefined();
  });

  // ---------------------------------------------------------------------------
  // Content hash
  // ---------------------------------------------------------------------------

  it('returns content hash from DOM extraction', async () => {
    const page = createMockPage({
      url: 'https://example.com/',
      evaluateResults: [makeDomData({ contentHash: 'deadbeef' }), makeTimingData()],
    });

    const result = await scanPage(page, 'https://example.com');

    expect(result.contentHash).toBe('deadbeef');
  });

  // ---------------------------------------------------------------------------
  // Hash routing detection
  // ---------------------------------------------------------------------------

  it('detects hash routing when 3+ hash-style links exist', async () => {
    const page = createMockPage({
      url: 'https://example.com/',
      evaluateResults: [makeDomData({ hashIndicators: 5 }), makeTimingData()],
    });

    const result = await scanPage(page, 'https://example.com');

    expect(result.hashRoutingDetected).toBe(true);
  });

  it('does not flag hash routing with fewer than 3 indicators', async () => {
    const page = createMockPage({
      url: 'https://example.com/',
      evaluateResults: [makeDomData({ hashIndicators: 2 }), makeTimingData()],
    });

    const result = await scanPage(page, 'https://example.com');

    expect(result.hashRoutingDetected).toBe(false);
  });

  // ---------------------------------------------------------------------------
  // Error handling
  // ---------------------------------------------------------------------------

  it('returns partial data when DOM extraction fails', async () => {
    let callIndex = 0;
    const page = {
      url: () => 'https://example.com/',
      evaluate: vi.fn(async () => {
        callIndex++;
        if (callIndex === 1) {
          throw new Error('page crashed');
        }
        // Second call (timing) succeeds
        return makeTimingData();
      }),
    } as unknown as Page;

    const result = await scanPage(page, 'https://example.com');

    // Should still return a valid result with fallback DOM data
    expect(result.url).toBe('https://example.com/');
    expect(result.title).toBe('');
    expect(result.metaTags).toEqual([]);
    expect(result.links).toEqual([]);
    expect(result.contentHash).toBe('00000000');
  });

  it('returns zero timing when timing extraction fails', async () => {
    let callIndex = 0;
    const page = {
      url: () => 'https://example.com/',
      evaluate: vi.fn(async () => {
        callIndex++;
        if (callIndex === 1) {
          return makeDomData();
        }
        // Second call (timing) fails
        throw new Error('timing API not available');
      }),
    } as unknown as Page;

    const result = await scanPage(page, 'https://example.com');

    expect(result.timing.loadTime).toBe(0);
    expect(result.timing.domContentLoaded).toBe(0);
    expect(result.timing.firstContentfulPaint).toBeUndefined();
  });

  // ---------------------------------------------------------------------------
  // HTTP status codes
  // ---------------------------------------------------------------------------

  it('captures non-200 HTTP status codes', async () => {
    const page = createMockPage({
      url: 'https://example.com/missing',
      evaluateResults: [makeDomData({ title: 'Not Found' }), makeTimingData()],
    });
    const response = createMockResponse(404);

    const result = await scanPage(page, 'https://example.com', response);

    expect(result.statusCode).toBe(404);
    expect(result.title).toBe('Not Found');
  });

  // ---------------------------------------------------------------------------
  // Multiple links with mixed origins
  // ---------------------------------------------------------------------------

  it('handles a mix of internal and external links', async () => {
    const links = [
      { href: 'https://example.com/about', text: 'About', rel: null },
      { href: 'https://cdn.example.com/asset', text: 'CDN Asset', rel: null },
      { href: 'https://example.com/contact', text: 'Contact', rel: 'noopener' },
      { href: 'https://github.com/repo', text: 'GitHub', rel: 'nofollow noopener' },
    ];
    const page = createMockPage({
      url: 'https://example.com/',
      evaluateResults: [makeDomData({ links }), makeTimingData()],
    });

    const result = await scanPage(page, 'https://example.com');

    expect(result.links).toHaveLength(4);
    expect(result.links[0].isExternal).toBe(false); // same origin
    expect(result.links[1].isExternal).toBe(true);  // different subdomain
    expect(result.links[2].isExternal).toBe(false); // same origin, has rel
    expect(result.links[2].rel).toBe('noopener');
    expect(result.links[3].isExternal).toBe(true);  // completely different domain
    expect(result.links[3].rel).toBe('nofollow noopener');
  });
});
