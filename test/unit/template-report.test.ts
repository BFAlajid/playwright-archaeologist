/**
 * Unit tests for src/report/html/template.ts
 *
 * Validates the HTML report generator: structure, security (CSP, escaping),
 * section rendering, dark mode, print styles, search, and JSON data block.
 */

import { describe, it, expect } from 'vitest';
import {
  generateReportHtml,
  generateMermaidSvgString,
  computeAnomalyCounts,
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
    // duration is in milliseconds
    duration: 42_000,
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
    // duration is in milliseconds — 125.5s -> 125_500ms
    duration: 125_500,
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
      // 5.3 seconds in ms
      input.duration = 5_300;
      const html = generateReportHtml(input);
      expect(html).toContain('5.3s');
    });

    it('handles duration formatting for long durations', () => {
      const input = minimalInput();
      // 185 seconds = 3m 5s, in ms
      input.duration = 185_000;
      const html = generateReportHtml(input);
      expect(html).toContain('3m');
    });
  });

  // ---------------------------------------------------------------------------
  // Form rendering — field name + badge classification
  // ---------------------------------------------------------------------------

  describe('form field rendering', () => {
    it('shows (unnamed) fallback when form field name is empty', () => {
      const input = minimalInput();
      input.forms = [{
        url: 'https://example.com/contact',
        action: '',
        method: 'GET',
        fields: [
          { name: '', type: 'text', required: true },
          { name: '', type: 'email', required: true },
        ],
      }];
      const html = generateReportHtml(input);
      expect(html).toContain('(unnamed): text');
      expect(html).toContain('(unnamed): email');
    });

    it('applies badge-required to required fields only', () => {
      const input = minimalInput();
      input.forms = [{
        url: 'https://example.com/login',
        action: '/login',
        method: 'POST',
        fields: [
          { name: 'user', type: 'text', required: true },
          { name: 'remember', type: 'checkbox', required: false },
        ],
      }];
      const html = generateReportHtml(input);
      // Required text field gets badge-required; optional checkbox gets badge-field.
      expect(html).toMatch(/badge badge-required[^"]*">user: text/);
      expect(html).toMatch(/badge badge-field[^"]*">remember: checkbox/);
    });

    it('applies badge-sensitive to non-required sensitive types', () => {
      const input = minimalInput();
      input.forms = [{
        url: 'https://example.com/signup',
        action: '/signup',
        method: 'POST',
        fields: [
          // Not required, but sensitive type -> badge-sensitive
          { name: 'email', type: 'email', required: false },
          { name: 'phone', type: 'tel', required: false },
          { name: 'pw', type: 'password', required: false },
        ],
      }];
      const html = generateReportHtml(input);
      expect(html).toMatch(/badge badge-sensitive[^"]*">email: email/);
      expect(html).toMatch(/badge badge-sensitive[^"]*">phone: tel/);
      expect(html).toMatch(/badge badge-sensitive[^"]*">pw: password/);
    });

    it('prefers badge-required over badge-sensitive when both apply', () => {
      const input = minimalInput();
      input.forms = [{
        url: 'https://example.com/login',
        action: '/login',
        method: 'POST',
        fields: [
          { name: 'pw', type: 'password', required: true },
        ],
      }];
      const html = generateReportHtml(input);
      expect(html).toMatch(/badge badge-required[^"]*">pw: password/);
      expect(html).not.toMatch(/badge badge-sensitive[^"]*">pw: password/);
    });

    it('renders a legend explaining the badge colors', () => {
      const input = minimalInput();
      input.forms = [{
        url: 'https://example.com/',
        action: '',
        method: 'GET',
        fields: [{ name: 'x', type: 'text', required: false }],
      }];
      const html = generateReportHtml(input);
      expect(html).toContain('class="form-legend"');
      expect(html).toContain('Red = required');
      expect(html).toContain('Yellow = sensitive');
    });
  });
});

// ---------------------------------------------------------------------------
// generateMermaidSvgString fallback
// ---------------------------------------------------------------------------

describe('generateMermaidSvgString', () => {
  it('wraps the Mermaid definition in a <pre> block', () => {
    const out = generateMermaidSvgString('graph TD\n  A-->B');
    expect(out).toContain('<pre class="mermaid-source">');
    expect(out).toContain('graph TD');
    expect(out).toContain('A--&gt;B');
  });

  it('escapes HTML entities inside the definition', () => {
    const out = generateMermaidSvgString('graph TD\n  A["<script>alert(1)</script>"]');
    expect(out).not.toContain('<script>alert');
    expect(out).toContain('&lt;script&gt;');
  });

  it('returns empty string for empty definition', () => {
    expect(generateMermaidSvgString('')).toBe('');
    expect(generateMermaidSvgString('   \n  ')).toBe('');
  });
});

// ---------------------------------------------------------------------------
// Anomaly summary row (Fix A)
// ---------------------------------------------------------------------------

describe('executive summary anomaly row', () => {
  it('renders the anomaly labels in the second stat row', () => {
    const html = generateReportHtml(minimalInput());
    expect(html).toContain('4xx Routes');
    expect(html).toContain('5xx Routes');
    expect(html).toContain('POST Endpoints');
    expect(html).toContain('Forms With Password');
    expect(html).toContain('Auth-Gated Pages');
  });

  it('counts 4xx and 5xx routes and links them to #sitemap', () => {
    const input: ReportInput = {
      ...minimalInput(),
      pages: [
        { url: 'https://ex.com/a', title: 'A', status: 200 },
        { url: 'https://ex.com/b', title: 'B', status: 404 },
        { url: 'https://ex.com/c', title: 'C', status: 403 },
        { url: 'https://ex.com/d', title: 'D', status: 500 },
        { url: 'https://ex.com/e', title: 'E', status: 502 },
      ],
    };
    const anomalies = computeAnomalyCounts(input);
    expect(anomalies.status4xx).toBe(2); // 404 + 403
    expect(anomalies.status5xx).toBe(2); // 500 + 502
    expect(anomalies.authGated).toBe(1); // 403

    const html = generateReportHtml(input);
    // Non-zero counts render anchor links to #sitemap
    expect(html).toMatch(/<a href="#sitemap">2<\/a>/);
  });

  it('counts POST API endpoints and forms with password fields', () => {
    const input: ReportInput = {
      ...minimalInput(),
      forms: [
        {
          url: 'https://ex.com/login',
          action: '/login',
          method: 'POST',
          fields: [
            { name: 'user', type: 'text', required: true },
            { name: 'pw', type: 'password', required: true },
          ],
        },
        {
          url: 'https://ex.com/search',
          action: '/search',
          method: 'GET',
          fields: [{ name: 'q', type: 'text', required: false }],
        },
      ],
      apiEndpoints: [
        { pattern: '/api/a', method: 'GET' },
        { pattern: '/api/b', method: 'POST' },
        { pattern: '/api/c', method: 'POST' },
      ],
    };
    const anomalies = computeAnomalyCounts(input);
    expect(anomalies.formsWithPassword).toBe(1);
    expect(anomalies.postEndpoints).toBe(2);
  });

  it('renders zero counts as plain text, not as links', () => {
    const html = generateReportHtml(minimalInput());
    // All five anomaly cards render zero with no anchor, since input has no pages/forms/endpoints
    const anomalySection = html.split('stats-anomalies')[1];
    expect(anomalySection).toBeTruthy();
    // With empty inputs, no anchor links should appear in the anomaly row
    expect(anomalySection!.split('<div class="stat-card">')[1]).not.toContain('href="#');
  });

  it('colors non-zero anomaly counts with stat-nonzero class', () => {
    const input: ReportInput = {
      ...minimalInput(),
      pages: [{ url: 'https://ex.com/x', title: 'X', status: 500 }],
    };
    const html = generateReportHtml(input);
    expect(html).toContain('stat-value stat-nonzero');
  });
});

// ---------------------------------------------------------------------------
// Sitemap tree — children INSIDE li (Fix B)
// ---------------------------------------------------------------------------

describe('sitemap tree a11y structure', () => {
  it('declares role=tree on the outer ul', () => {
    const html = generateReportHtml(fullInput());
    expect(html).toMatch(/<ul class="sitemap-tree" role="tree">/);
  });

  it('uses role=treeitem on each li', () => {
    const html = generateReportHtml(fullInput());
    expect(html).toContain('<li role="treeitem"');
  });

  it('places child <ul> INSIDE the parent <li>, not as a sibling', () => {
    const input = minimalInput();
    input.pages = [
      { url: 'https://example.com/a', title: 'A', status: 200 },
      { url: 'https://example.com/a/b', title: 'B', status: 200 },
    ];
    const html = generateReportHtml(input);
    // Between the start of an <li> and the closing </li> there must be a <ul> child
    // and the <ul> must NOT appear as a sibling outside <li>.
    // Look for `<ul role="group">` nested inside a treeitem li.
    const treeSection = html.split('class="sitemap-tree"')[1] ?? '';
    expect(treeSection).toContain('<ul role="group">');
    // Make sure no `</li>\s*<ul>` sibling pattern exists inside the tree
    expect(treeSection).not.toMatch(/<\/li>\s*<ul/);
  });

  it('adds aria-expanded=true when a node has children', () => {
    const input = minimalInput();
    input.pages = [
      { url: 'https://example.com/parent', title: 'Parent', status: 200 },
      { url: 'https://example.com/parent/child', title: 'Child', status: 200 },
    ];
    const html = generateReportHtml(input);
    expect(html).toContain('aria-expanded="true"');
  });

  it('renders a tree-toggle button on nodes with children', () => {
    const input = minimalInput();
    input.pages = [
      { url: 'https://example.com/p', title: 'P', status: 200 },
      { url: 'https://example.com/p/c', title: 'C', status: 200 },
    ];
    const html = generateReportHtml(input);
    expect(html).toContain('class="tree-toggle"');
  });
});

// ---------------------------------------------------------------------------
// Semantic HTML landmarks (Fix C)
// ---------------------------------------------------------------------------

describe('semantic landmarks', () => {
  it('wraps content in <main>', () => {
    const html = generateReportHtml(minimalInput());
    expect(html).toContain('<main class="container">');
  });

  it('uses <header> for title and stats', () => {
    const html = generateReportHtml(minimalInput());
    expect(html).toContain('<header class="report-header">');
  });

  it('uses <footer> with generator text', () => {
    const html = generateReportHtml(minimalInput());
    expect(html).toContain('<footer class="report-footer">');
    expect(html).toContain('Generated by playwright-archaeologist');
  });

  it('uses <section> with aria-labelledby for each section', () => {
    const html = generateReportHtml(fullInput());
    expect(html).toContain('aria-labelledby="section-title-sitemap"');
    expect(html).toContain('aria-labelledby="section-title-forms"');
    expect(html).toContain('aria-labelledby="section-title-api"');
    expect(html).toContain('aria-labelledby="section-title-screenshots"');
    expect(html).toContain('aria-labelledby="section-title-flow"');
  });

  it('nav uses aria-label "Report sections"', () => {
    const html = generateReportHtml(minimalInput());
    expect(html).toContain('aria-label="Report sections"');
  });
});

// ---------------------------------------------------------------------------
// Sticky th offset (Fix D)
// ---------------------------------------------------------------------------

describe('sticky header offset', () => {
  it('defines --nav-h CSS variable on :root', () => {
    const html = generateReportHtml(minimalInput());
    expect(html).toContain('--nav-h:');
  });

  it('uses var(--nav-h) in the th sticky top rule', () => {
    const html = generateReportHtml(minimalInput());
    expect(html).toContain('top: var(--nav-h)');
  });

  it('includes a ResizeObserver to track nav height', () => {
    const html = generateReportHtml(minimalInput());
    expect(html).toContain('ResizeObserver');
    expect(html).toContain("--nav-h");
  });
});

// ---------------------------------------------------------------------------
// Theme toggle (Fix E)
// ---------------------------------------------------------------------------

describe('theme toggle', () => {
  it('renders a theme-toggle button in the nav', () => {
    const html = generateReportHtml(minimalInput());
    expect(html).toContain('id="theme-toggle"');
    expect(html).toContain('aria-label="Toggle theme"');
  });

  it('includes explicit data-theme overrides in CSS', () => {
    const html = generateReportHtml(minimalInput());
    expect(html).toContain(':root[data-theme="dark"]');
    expect(html).toContain(':root[data-theme="light"]');
  });

  it('persists theme choice via localStorage', () => {
    const html = generateReportHtml(minimalInput());
    expect(html).toContain('localStorage');
    expect(html).toContain('pa-theme');
  });
});

// ---------------------------------------------------------------------------
// Search improvements (Fix F)
// ---------------------------------------------------------------------------

describe('search improvements', () => {
  it('renders a live-region search count', () => {
    const html = generateReportHtml(minimalInput());
    expect(html).toContain('id="search-count"');
    expect(html).toContain('aria-live="polite"');
    expect(html).toContain('role="status"');
  });

  it('adds a visually-hidden label for the search input', () => {
    const html = generateReportHtml(minimalInput());
    expect(html).toMatch(/<label[^>]*for="report-search"[^>]*class="visually-hidden"/);
  });

  it('emits a no-results row in each filterable section', () => {
    const html = generateReportHtml(fullInput());
    // Forms and API sections should each have a no-results row
    const count = (html.match(/class="no-results"/g) || []).length;
    expect(count).toBeGreaterThanOrEqual(2);
  });

  it('pre-computes data-search attribute on rows', () => {
    const html = generateReportHtml(fullInput());
    expect(html).toMatch(/data-search="[^"]*"/);
  });

  it('debounces search input with setTimeout', () => {
    const html = generateReportHtml(minimalInput());
    expect(html).toContain('setTimeout');
  });
});

// ---------------------------------------------------------------------------
// Structured filters (Fix G)
// ---------------------------------------------------------------------------

describe('structured filters', () => {
  it('renders a method filter in the API section', () => {
    const html = generateReportHtml(fullInput());
    expect(html).toContain('id="api-method-filter"');
    expect(html).toContain('data-filter-attr="api-method"');
    expect(html).toContain('<option value="GET">GET</option>');
    expect(html).toContain('<option value="POST">POST</option>');
  });

  it('renders a form type filter in the Forms section', () => {
    const html = generateReportHtml(fullInput());
    expect(html).toContain('id="form-type-filter"');
    expect(html).toContain('data-filter-attr="form-type"');
    expect(html).toContain('<option value="password">Has password</option>');
  });

  it('sets data-form-type=password on forms with password fields', () => {
    const html = generateReportHtml(fullInput());
    // The login form in fullInput() has a password field
    expect(html).toMatch(/data-form-type="password"/);
  });

  it('sets data-api-method on each API row', () => {
    const html = generateReportHtml(fullInput());
    expect(html).toMatch(/data-api-method="GET"/);
    expect(html).toMatch(/data-api-method="POST"/);
  });
});

// ---------------------------------------------------------------------------
// Deep-linkable row IDs (Fix H)
// ---------------------------------------------------------------------------

describe('deep-linkable row IDs', () => {
  it('adds form-N id to each form row', () => {
    const html = generateReportHtml(fullInput());
    expect(html).toContain('id="form-0"');
    expect(html).toContain('id="form-1"');
  });

  it('adds api-<method>-<slug> id to each API row', () => {
    const html = generateReportHtml(fullInput());
    expect(html).toMatch(/id="api-get-[a-z0-9-]+"/);
    expect(html).toMatch(/id="api-post-[a-z0-9-]+"/);
  });

  it('adds a permalink anchor on each row', () => {
    const html = generateReportHtml(fullInput());
    expect(html).toContain('class="row-permalink"');
    expect(html).toContain('aria-label="Permalink to this form"');
  });
});

// ---------------------------------------------------------------------------
// Lightbox keyboard nav (Fix I)
// ---------------------------------------------------------------------------

describe('lightbox keyboard navigation', () => {
  it('handles ArrowLeft and ArrowRight keys on the dialog', () => {
    const html = generateReportHtml(fullInput());
    expect(html).toContain('ArrowRight');
    expect(html).toContain('ArrowLeft');
  });

  it('falls back to the search input when the originating card is filtered', () => {
    const html = generateReportHtml(fullInput());
    // Verify the close logic contains the fallback path
    expect(html).toMatch(/searchInput\.focus\(\)/);
  });
});

// ---------------------------------------------------------------------------
// Favicon + meta (Fix K)
// ---------------------------------------------------------------------------

describe('favicon and meta', () => {
  it('includes a meta description with the target URL', () => {
    const html = generateReportHtml(minimalInput());
    expect(html).toMatch(/<meta name="description" content="Behavioral crawl report for/);
  });

  it('includes meta generator', () => {
    const html = generateReportHtml(minimalInput());
    expect(html).toContain('<meta name="generator" content="playwright-archaeologist">');
  });

  it('includes an inline SVG favicon data URI', () => {
    const html = generateReportHtml(minimalInput());
    expect(html).toMatch(/<link rel="icon" type="image\/svg\+xml" href="data:image\/svg\+xml/);
  });
});

// ---------------------------------------------------------------------------
// Container width (Fix O)
// ---------------------------------------------------------------------------

describe('container width scaling', () => {
  it('uses min(1600px, 95vw) for the container max-width', () => {
    const html = generateReportHtml(minimalInput());
    expect(html).toContain('max-width: min(1600px, 95vw)');
  });
});

// ---------------------------------------------------------------------------
// Absolute-path leak-proofing (Fix P)
// ---------------------------------------------------------------------------

describe('absolute path redaction in screenshots', () => {
  it('redacts absolute paths outside outputDir to <file>', () => {
    const input: ReportInput = {
      ...minimalInput(),
      outputDir: '/tmp/report-out',
      screenshots: [
        {
          url: 'https://ex.com/',
          thumbnailBase64: 'QUJD',
          fullPath: 'C:\\Users\\someone\\somewhere\\img.png',
        },
      ],
    };
    const html = generateReportHtml(input);
    // Should NOT contain the raw absolute path
    expect(html).not.toContain('C:\\Users\\someone');
    // Should redact to <file>
    expect(html).toContain('&lt;file&gt;');
  });

  it('keeps paths that are already relative', () => {
    const input: ReportInput = {
      ...minimalInput(),
      screenshots: [
        {
          url: 'https://ex.com/',
          thumbnailBase64: 'QUJD',
          fullPath: 'screenshots/home.png',
        },
      ],
    };
    const html = generateReportHtml(input);
    expect(html).toContain('screenshots&#x2F;home.png');
  });
});
