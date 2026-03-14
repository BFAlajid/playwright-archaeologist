/**
 * Unit tests for src/report/html/template.ts
 *
 * Validates the HTML report generator: structure, security (CSP, escaping),
 * section rendering, dark mode, print styles, search, and JSON data block.
 */

import { describe, it, expect } from 'vitest';
import {
  generateReportHtml,
  type ReportInput,
  type ReportPage,
  type ReportForm,
  type ReportApiEndpoint,
  type ReportScreenshot,
} from '../../src/report/html/template.js';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function minimalInput(): ReportInput {
  return {
    targetUrl: 'https://example.com',
    crawlDate: '2026-03-09T12:00:00Z',
    duration: 42,
    pagesVisited: 10,
    errors: 1,
    forms: [],
    apiEndpoints: [],
  };
}

function fullInput(): ReportInput {
  const pages: ReportPage[] = [
    { url: 'https://example.com/', title: 'Home', status: 200 },
    { url: 'https://example.com/about', title: 'About Us', status: 200, depth: 1 },
    { url: 'https://example.com/about/team', title: 'Team', status: 200, depth: 2, contentHash: 'abc123' },
    { url: 'https://example.com/missing', title: 'Not Found', status: 404 },
    { url: 'https://example.com/redirect', title: 'Moved', status: 301 },
    { url: 'https://example.com/error', title: 'Server Error', status: 500 },
  ];

  const forms: ReportForm[] = [
    {
      url: 'https://example.com/login',
      action: '/api/login',
      method: 'POST',
      fields: [
        { name: 'username', type: 'text', required: true },
        { name: 'password', type: 'password', required: true },
        { name: 'remember', type: 'checkbox', required: false },
      ],
    },
    {
      url: 'https://example.com/search',
      action: '/api/search',
      method: 'GET',
      fields: [{ name: 'q', type: 'text', required: false }],
    },
  ];

  const apiEndpoints: ReportApiEndpoint[] = [
    { pattern: '/api/users', method: 'GET', status: 200 },
    {
      pattern: '/api/users/:id',
      method: 'PUT',
      examples: [
        { url: '/api/users/1', status: 200 },
        { url: '/api/users/999', status: 404 },
      ],
    },
    { url: '/api/session', method: 'DELETE', status: 204 },
    { pattern: '/api/items', method: 'PATCH', status: 200 },
    { pattern: '/api/items', method: 'POST', status: 201 },
  ];

  const screenshots: ReportScreenshot[] = [
    {
      url: 'https://example.com/',
      thumbnailBase64: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk',
      fullPath: 'screenshots/home.png',
    },
    {
      url: 'https://example.com/about',
      thumbnailBase64: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk',
      fullPath: 'screenshots/about.png',
    },
  ];

  const flowDiagramSvg = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><circle cx="50" cy="50" r="40"/></svg>';

  return {
    title: 'My Test Report',
    targetUrl: 'https://example.com',
    crawlDate: '2026-03-09T12:00:00Z',
    duration: 125.5,
    pagesVisited: 6,
    errors: 2,
    pages,
    forms,
    apiEndpoints,
    screenshots,
    flowDiagramSvg,
  };
}

// ---------------------------------------------------------------------------
// Basic structure
// ---------------------------------------------------------------------------

describe('generateReportHtml', () => {
  describe('document structure', () => {
    it('generates valid HTML with DOCTYPE', () => {
      const html = generateReportHtml(minimalInput());
      expect(html).toMatch(/^<!DOCTYPE html>/);
      expect(html).toContain('<html lang="en">');
      expect(html).toContain('</html>');
      expect(html).toContain('<head>');
      expect(html).toContain('</head>');
      expect(html).toContain('<body>');
      expect(html).toContain('</body>');
    });

    it('sets charset and viewport meta tags', () => {
      const html = generateReportHtml(minimalInput());
      expect(html).toContain('<meta charset="UTF-8">');
      expect(html).toContain('viewport');
    });

    it('uses custom title when provided', () => {
      const input = fullInput();
      const html = generateReportHtml(input);
      expect(html).toContain('<title>My Test Report</title>');
    });

    it('falls back to default title with target URL', () => {
      const html = generateReportHtml(minimalInput());
      expect(html).toContain('<title>Archaeologist Report: https://example.com</title>');
    });
  });

  // ---------------------------------------------------------------------------
  // CSP
  // ---------------------------------------------------------------------------

  describe('security', () => {
    it('includes CSP meta tag', () => {
      const html = generateReportHtml(minimalInput());
      expect(html).toContain('Content-Security-Policy');
      expect(html).toContain("default-src 'none'");
      expect(html).toContain("style-src 'unsafe-inline'");
      expect(html).toContain("script-src 'unsafe-inline'");
      expect(html).toContain('img-src data:');
    });

    it('escapes all user-provided data in target URL', () => {
      const input = minimalInput();
      input.targetUrl = 'https://evil.com/<script>alert(1)</script>';
      const html = generateReportHtml(input);
      // Should not contain raw <script> tag from user data
      // (The report has its own <script> blocks, so we check the targetUrl context)
      expect(html).toContain('&lt;script&gt;');
      expect(html).not.toContain('alert(1)</script>');
    });

    it('escapes user-provided title', () => {
      const input = minimalInput();
      input.title = '<img src=x onerror=alert(1)>';
      const html = generateReportHtml(input);
      expect(html).not.toContain('<img src=x');
      expect(html).toContain('&lt;img');
    });

    it('escapes page titles and URLs', () => {
      const input = minimalInput();
      input.pages = [
        { url: 'https://example.com/"><script>alert(1)</script>', title: '<b>XSS</b>', status: 200 },
      ];
      const html = generateReportHtml(input);
      expect(html).not.toContain('<b>XSS</b>');
      expect(html).toContain('&lt;b&gt;XSS&lt;/b&gt;');
    });

    it('escapes form data', () => {
      const input = minimalInput();
      input.forms = [{
        url: 'https://example.com/"onmouseover="alert(1)',
        action: '"><script>alert(1)</script>',
        method: 'POST',
        fields: [{ name: '<script>', type: 'text', required: false }],
      }];
      const html = generateReportHtml(input);
      expect(html).not.toContain('"onmouseover=');
      expect(html).toContain('&lt;script&gt;');
    });

    it('escapes API endpoint data', () => {
      const input = minimalInput();
      input.apiEndpoints = [{
        pattern: '<img/src=x onerror=alert(1)>',
        method: 'GET',
      }];
      const html = generateReportHtml(input);
      expect(html).not.toContain('<img/src=x');
      expect(html).toContain('&lt;img');
    });
  });

  // ---------------------------------------------------------------------------
  // Navigation
  // ---------------------------------------------------------------------------

  describe('navigation bar', () => {
    it('includes navigation bar', () => {
      const html = generateReportHtml(fullInput());
      expect(html).toContain('<nav');
      expect(html).toContain('class="nav"');
    });

    it('includes section links for populated sections', () => {
      const html = generateReportHtml(fullInput());
      expect(html).toContain('href="#sitemap"');
      expect(html).toContain('href="#forms"');
      expect(html).toContain('href="#api"');
      expect(html).toContain('href="#screenshots"');
      expect(html).toContain('href="#flow"');
    });

    it('omits section links for empty sections', () => {
      const html = generateReportHtml(minimalInput());
      expect(html).not.toContain('href="#sitemap"');
      expect(html).not.toContain('href="#forms"');
      expect(html).not.toContain('href="#api"');
      expect(html).not.toContain('href="#screenshots"');
      expect(html).not.toContain('href="#flow"');
    });

    it('shows brand text', () => {
      const html = generateReportHtml(minimalInput());
      expect(html).toContain('Archaeologist');
    });
  });

  // ---------------------------------------------------------------------------
  // Stats bar
  // ---------------------------------------------------------------------------

  describe('stats bar', () => {
    it('displays target URL', () => {
      const html = generateReportHtml(minimalInput());
      expect(html).toContain('example.com');
    });

    it('displays crawl date', () => {
      const html = generateReportHtml(minimalInput());
      expect(html).toContain('2026-03-09T12:00:00Z');
    });

    it('displays duration', () => {
      const input = fullInput();
      const html = generateReportHtml(input);
      // 125.5s = 2m 6s
      expect(html).toContain('2m');
    });

    it('displays pages visited count', () => {
      const html = generateReportHtml(minimalInput());
      expect(html).toContain('10');
    });

    it('displays error count', () => {
      const html = generateReportHtml(minimalInput());
      expect(html).toContain('Errors');
    });
  });

  // ---------------------------------------------------------------------------
  // Sitemap section
  // ---------------------------------------------------------------------------

  describe('sitemap section', () => {
    it('renders sitemap section with pages', () => {
      const html = generateReportHtml(fullInput());
      expect(html).toContain('id="sitemap"');
      expect(html).toContain('Sitemap');
      expect(html).toContain('sitemap-tree');
    });

    it('uses details/summary for collapsible tree', () => {
      const html = generateReportHtml(fullInput());
      // Check within the sitemap section
      expect(html).toContain('<details open>');
      expect(html).toContain('<summary>Page Tree</summary>');
    });

    it('renders tree structure with nested ul', () => {
      const html = generateReportHtml(fullInput());
      // The tree should have nested <ul> for path segments
      expect(html).toContain('class="sitemap-tree"');
    });

    it('color-codes HTTP status: 2xx green', () => {
      const html = generateReportHtml(fullInput());
      expect(html).toContain('class="status-2xx"');
    });

    it('color-codes HTTP status: 3xx blue', () => {
      const html = generateReportHtml(fullInput());
      expect(html).toContain('class="status-3xx"');
    });

    it('color-codes HTTP status: 4xx orange', () => {
      const html = generateReportHtml(fullInput());
      expect(html).toContain('class="status-4xx"');
    });

    it('color-codes HTTP status: 5xx red', () => {
      const html = generateReportHtml(fullInput());
      expect(html).toContain('class="status-5xx"');
    });

    it('omits sitemap section when no pages', () => {
      const html = generateReportHtml(minimalInput());
      expect(html).not.toContain('id="sitemap"');
    });

    it('uses sitemap field when pages not provided', () => {
      const input = minimalInput();
      input.sitemap = [
        { url: 'https://example.com/', title: 'Home', status: 200 },
      ];
      const html = generateReportHtml(input);
      expect(html).toContain('id="sitemap"');
      expect(html).toContain('Home');
    });
  });

  // ---------------------------------------------------------------------------
  // Forms section
  // ---------------------------------------------------------------------------

  describe('forms section', () => {
    it('renders forms table', () => {
      const html = generateReportHtml(fullInput());
      expect(html).toContain('id="forms"');
      expect(html).toContain('Page URL');
      expect(html).toContain('Action');
      expect(html).toContain('Method');
      expect(html).toContain('Fields');
    });

    it('shows form method as badge', () => {
      const html = generateReportHtml(fullInput());
      expect(html).toContain('badge-post');
      expect(html).toContain('POST');
    });

    it('shows field type badges', () => {
      const html = generateReportHtml(fullInput());
      expect(html).toContain('username: text');
      expect(html).toContain('password: password');
    });

    it('marks required fields differently', () => {
      const html = generateReportHtml(fullInput());
      expect(html).toContain('badge-required');
    });

    it('has searchable rows', () => {
      const html = generateReportHtml(fullInput());
      // Forms section should have data-searchable on rows
      expect(html).toContain('data-searchable');
    });

    it('omits forms section when empty', () => {
      const html = generateReportHtml(minimalInput());
      expect(html).not.toContain('id="forms"');
    });
  });

  // ---------------------------------------------------------------------------
  // API Endpoints section
  // ---------------------------------------------------------------------------

  describe('API endpoints section', () => {
    it('renders API endpoint table', () => {
      const html = generateReportHtml(fullInput());
      expect(html).toContain('id="api"');
      expect(html).toContain('API Endpoints');
    });

    it('renders method badges with correct classes', () => {
      const html = generateReportHtml(fullInput());
      expect(html).toContain('badge-get');
      expect(html).toContain('badge-put');
      expect(html).toContain('badge-delete');
      expect(html).toContain('badge-patch');
      expect(html).toContain('badge-post');
    });

    it('shows pattern column', () => {
      const html = generateReportHtml(fullInput());
      expect(html).toContain('/api/users');
      expect(html).toContain('/api/users/:id');
    });

    it('shows expandable examples', () => {
      const html = generateReportHtml(fullInput());
      expect(html).toContain('2 example(s)');
      expect(html).toContain('/api/users/1');
      expect(html).toContain('/api/users/999');
    });

    it('omits API section when empty', () => {
      const html = generateReportHtml(minimalInput());
      expect(html).not.toContain('id="api"');
    });
  });

  // ---------------------------------------------------------------------------
  // Screenshots section
  // ---------------------------------------------------------------------------

  describe('screenshots section', () => {
    it('renders screenshot gallery when screenshots provided', () => {
      const html = generateReportHtml(fullInput());
      expect(html).toContain('id="screenshots"');
      expect(html).toContain('screenshot-grid');
      expect(html).toContain('screenshot-card');
    });

    it('inlines base64 thumbnails', () => {
      const html = generateReportHtml(fullInput());
      expect(html).toContain('data:image/jpeg;base64,');
      expect(html).toContain('iVBORw0KGgo');
    });

    it('uses lazy loading on images', () => {
      const html = generateReportHtml(fullInput());
      expect(html).toContain('loading="lazy"');
    });

    it('shows route labels on thumbnails', () => {
      const html = generateReportHtml(fullInput());
      expect(html).toContain('class="screenshot-label"');
    });

    it('includes dialog lightbox', () => {
      const html = generateReportHtml(fullInput());
      expect(html).toContain('<dialog');
      expect(html).toContain('id="screenshot-dialog"');
      expect(html).toContain('id="dialog-close"');
    });

    it('stores full path in data attribute', () => {
      const html = generateReportHtml(fullInput());
      expect(html).toContain('data-full=');
      expect(html).toContain('screenshots');
    });

    it('omits screenshot section when no screenshots', () => {
      const html = generateReportHtml(minimalInput());
      expect(html).not.toContain('id="screenshots"');
      // CSS may contain .screenshot-grid class definition, but no actual grid element
      expect(html).not.toContain('<div class="screenshot-grid">');
      expect(html).not.toContain('<dialog');
    });

    it('omits screenshot section when screenshots array is empty', () => {
      const input = fullInput();
      input.screenshots = [];
      const html = generateReportHtml(input);
      expect(html).not.toContain('id="screenshots"');
    });
  });

  // ---------------------------------------------------------------------------
  // Flow diagram section
  // ---------------------------------------------------------------------------

  describe('flow diagram section', () => {
    it('renders flow diagram SVG when provided', () => {
      const html = generateReportHtml(fullInput());
      expect(html).toContain('id="flow"');
      expect(html).toContain('Flow Diagram');
      expect(html).toContain('<svg');
      expect(html).toContain('circle');
    });

    it('wraps SVG in collapsible details', () => {
      const html = generateReportHtml(fullInput());
      expect(html).toContain('flow-svg-container');
    });

    it('omits flow section when no SVG provided', () => {
      const html = generateReportHtml(minimalInput());
      expect(html).not.toContain('id="flow"');
      // CSS may contain .flow-svg-container class definition, but no actual element
      expect(html).not.toContain('<div class="flow-svg-container">');
    });
  });

  // ---------------------------------------------------------------------------
  // Search
  // ---------------------------------------------------------------------------

  describe('search functionality', () => {
    it('includes search input', () => {
      const html = generateReportHtml(minimalInput());
      expect(html).toContain('id="report-search"');
      expect(html).toContain('type="text"');
      expect(html).toContain('placeholder=');
    });

    it('includes search filter JS', () => {
      const html = generateReportHtml(fullInput());
      expect(html).toContain('report-search');
      expect(html).toContain('data-searchable');
    });

    it('has aria-label on search input', () => {
      const html = generateReportHtml(minimalInput());
      expect(html).toContain('aria-label="Search report"');
    });
  });

  // ---------------------------------------------------------------------------
  // Dark mode
  // ---------------------------------------------------------------------------

  describe('dark mode CSS', () => {
    it('includes dark mode CSS with prefers-color-scheme', () => {
      const html = generateReportHtml(minimalInput());
      expect(html).toContain('prefers-color-scheme: dark');
    });

    it('uses CSS custom properties for theming', () => {
      const html = generateReportHtml(minimalInput());
      expect(html).toContain(':root');
      expect(html).toContain('--bg:');
      expect(html).toContain('--text:');
    });
  });

  // ---------------------------------------------------------------------------
  // Print stylesheet
  // ---------------------------------------------------------------------------

  describe('print stylesheet', () => {
    it('includes print stylesheet', () => {
      const html = generateReportHtml(minimalInput());
      expect(html).toContain('@media print');
    });

    it('hides nav in print', () => {
      const html = generateReportHtml(minimalInput());
      // Check that .nav is set to display:none in print
      expect(html).toContain('.nav { display: none; }');
    });

    it('hides search bar in print', () => {
      const html = generateReportHtml(minimalInput());
      expect(html).toContain('.search-bar { display: none; }');
    });

    it('expands all details in print', () => {
      const html = generateReportHtml(minimalInput());
      // Details content should be forced visible in print
      expect(html).toContain('details:not([open]) > :not(summary)');
      expect(html).toContain('display: block !important');
    });
  });

  // ---------------------------------------------------------------------------
  // JSON data block
  // ---------------------------------------------------------------------------

  describe('JSON data block', () => {
    it('includes JSON data block with correct id', () => {
      const html = generateReportHtml(minimalInput());
      expect(html).toContain('<script type="application/json" id="report-data">');
    });

    it('contains report metadata in JSON', () => {
      const html = generateReportHtml(minimalInput());
      const match = html.match(/<script type="application\/json" id="report-data">([\s\S]*?)<\/script>/);
      expect(match).toBeTruthy();
      const json = JSON.parse(match![1]);
      expect(json.targetUrl).toBe('https://example.com');
      expect(json.crawlDate).toBe('2026-03-09T12:00:00Z');
      expect(json.pagesVisited).toBe(10);
      expect(json.errors).toBe(1);
    });

    it('escapes dangerous content in JSON block', () => {
      const input = minimalInput();
      input.targetUrl = 'https://example.com/</script><script>alert(1)</script>';
      const html = generateReportHtml(input);
      // The raw </script> inside the JSON block should be escaped
      const match = html.match(/<script type="application\/json" id="report-data">([\s\S]*?)<\/script>/);
      expect(match).toBeTruthy();
      // The JSON block should not contain raw </script>
      expect(match![1]).not.toContain('</script>');
    });
  });

  // ---------------------------------------------------------------------------
  // Edge cases
  // ---------------------------------------------------------------------------

  describe('edge cases', () => {
    it('handles empty forms and endpoints gracefully', () => {
      const html = generateReportHtml(minimalInput());
      expect(html).toBeTruthy();
      expect(html).toContain('<!DOCTYPE html>');
    });

    it('handles pages with no title', () => {
      const input = minimalInput();
      input.pages = [
        { url: 'https://example.com/untitled', title: '', status: 200 },
      ];
      const html = generateReportHtml(input);
      expect(html).toContain('id="sitemap"');
    });

    it('handles very long URLs', () => {
      const input = minimalInput();
      input.targetUrl = 'https://example.com/' + 'a'.repeat(500);
      const html = generateReportHtml(input);
      expect(html).toBeTruthy();
    });

    it('handles duration formatting for short durations', () => {
      const input = minimalInput();
      input.duration = 5.3;
      const html = generateReportHtml(input);
      expect(html).toContain('5.3s');
    });

    it('handles duration formatting for long durations', () => {
      const input = minimalInput();
      input.duration = 185;
      const html = generateReportHtml(input);
      expect(html).toContain('3m');
    });
  });
});
