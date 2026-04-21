/**
 * Performance benchmarks for HTML report generation.
 *
 * Measures:
 * - HTML template string assembly for various dataset sizes
 * - Base64 encoding of thumbnail images
 * - JSON serialization of report data
 * - Memory footprint during report generation
 * - Estimated output file size
 *
 * Run: npx vitest bench test/performance/report-generation.bench.ts
 *
 * TODO: this bench measures an inlined fake (manual template-string
 * assembly and mock data generators) rather than the real report
 * template. Replace with real imports from src/report/html/template.ts
 * (generateReportHtml) before relying on budget enforcement.
 */

import { bench, describe } from 'vitest';
import { createHash } from 'node:crypto';

// ---------------------------------------------------------------------------
// Mock data generators
// ---------------------------------------------------------------------------

interface MockPageData {
  url: string;
  title: string;
  statusCode: number;
  contentHash: string;
  headings: Array<{ level: number; text: string }>;
  landmarks: string[];
  links: string[];
  meta: Record<string, string>;
}

interface MockFormData {
  pageUrl: string;
  action: string;
  method: string;
  fields: Array<{
    name: string;
    type: string;
    required: boolean;
    placeholder: string;
    pattern?: string;
    options?: string[];
  }>;
}

interface MockApiEndpoint {
  method: string;
  url: string;
  pattern: string;
  statusCode: number;
  requestHeaders: Record<string, string>;
  responseHeaders: Record<string, string>;
  requestBody?: string;
  responseBody?: string;
}

interface MockScreenshot {
  url: string;
  filename: string;
  width: number;
  height: number;
  thumbnailBase64: string;
  fullPath: string;
}

interface MockReportData {
  meta: {
    targetUrl: string;
    crawlDate: string;
    duration: number;
    pagesVisited: number;
    errors: number;
    version: string;
  };
  sitemap: MockPageData[];
  forms: MockFormData[];
  apiMap: MockApiEndpoint[];
  screenshots: MockScreenshot[];
  flowGraph: string;
}

function generateMockPages(count: number): MockPageData[] {
  const pages: MockPageData[] = [];
  for (let i = 0; i < count; i++) {
    pages.push({
      url: `https://example.com/section-${i % 10}/page-${i}`,
      title: `Page ${i} - Section ${i % 10} | Example Web App`,
      statusCode: 200,
      contentHash: createHash('sha256').update(`content-${i}`).digest('hex').slice(0, 16),
      headings: [
        { level: 1, text: `Main Heading for Page ${i}` },
        { level: 2, text: `Subheading A on Page ${i}` },
        { level: 2, text: `Subheading B on Page ${i}` },
        { level: 3, text: `Detail section ${i}` },
      ],
      landmarks: ['banner', 'navigation', 'main', 'contentinfo'],
      links: Array.from({ length: 20 }, (_, j) => `https://example.com/section-${j % 10}/page-${j}`),
      meta: {
        description: `Description for page ${i} with some longer text that describes the page content in detail`,
        keywords: `keyword-${i}, section-${i % 10}, example, web app`,
        'og:title': `Page ${i} - Example Web App`,
        'og:image': `https://example.com/images/page-${i}.png`,
      },
    });
  }
  return pages;
}

function generateMockForms(count: number): MockFormData[] {
  const forms: MockFormData[] = [];
  const fieldTypes = ['text', 'email', 'password', 'number', 'tel', 'url', 'date', 'select', 'checkbox', 'radio'];
  for (let i = 0; i < count; i++) {
    forms.push({
      pageUrl: `https://example.com/section-${i % 10}/page-${i}`,
      action: `/api/form-${i}`,
      method: i % 3 === 0 ? 'GET' : 'POST',
      fields: Array.from({ length: 5 + (i % 5) }, (_, j) => ({
        name: `field_${j}_form_${i}`,
        type: fieldTypes[j % fieldTypes.length],
        required: j < 3,
        placeholder: `Enter ${fieldTypes[j % fieldTypes.length]} value`,
        ...(fieldTypes[j % fieldTypes.length] === 'select' && {
          options: ['option-a', 'option-b', 'option-c', 'option-d'],
        }),
      })),
    });
  }
  return forms;
}

function generateMockApiEndpoints(count: number): MockApiEndpoint[] {
  const endpoints: MockApiEndpoint[] = [];
  const methods = ['GET', 'POST', 'PUT', 'DELETE', 'PATCH'];
  for (let i = 0; i < count; i++) {
    const method = methods[i % methods.length];
    endpoints.push({
      method,
      url: `https://example.com/api/v2/resource-${i % 20}/${i}`,
      pattern: `/api/v2/resource-${i % 20}/:id`,
      statusCode: method === 'DELETE' ? 204 : 200,
      requestHeaders: {
        'Content-Type': 'application/json',
        'Accept': 'application/json',
        'X-Request-Id': `req-${i}`,
      },
      responseHeaders: {
        'Content-Type': 'application/json',
        'X-Response-Time': `${10 + i}ms`,
        'Cache-Control': 'no-cache',
      },
      ...(method !== 'GET' && method !== 'DELETE' && {
        requestBody: JSON.stringify({
          name: `Resource ${i}`,
          description: `Description for resource ${i} with additional metadata`,
          tags: [`tag-${i % 5}`, `tag-${i % 3}`],
          metadata: { created: new Date().toISOString(), version: i },
        }),
      }),
      responseBody: JSON.stringify({
        id: i,
        name: `Resource ${i}`,
        status: 'active',
        data: { count: i * 10, items: Array.from({ length: 3 }, (_, j) => ({ id: j, value: `v${j}` })) },
      }),
    });
  }
  return endpoints;
}

/**
 * Generate a fake base64 thumbnail string of approximately the target size.
 * Real thumbnails are ~8KB JPEG encoded as base64 (~11KB string).
 */
function generateFakeThumbnailBase64(sizeBytes = 8192): string {
  // Generate random bytes to simulate JPEG data, then base64 encode
  const buffer = Buffer.alloc(sizeBytes);
  for (let i = 0; i < sizeBytes; i++) {
    buffer[i] = Math.floor(Math.random() * 256);
  }
  return buffer.toString('base64');
}

function generateMockScreenshots(count: number): MockScreenshot[] {
  const screenshots: MockScreenshot[] = [];
  // Pre-generate one thumbnail to reuse (simulates similar-sized thumbnails)
  const baseThumbnail = generateFakeThumbnailBase64(8192);

  for (let i = 0; i < count; i++) {
    screenshots.push({
      url: `https://example.com/section-${i % 10}/page-${i}`,
      filename: `section-${i % 10}_page-${i}.png`,
      width: 1280,
      height: 720 + (i % 500), // Varying heights
      thumbnailBase64: baseThumbnail, // In real code each would be unique
      fullPath: `./screenshots/section-${i % 10}_page-${i}.png`,
    });
  }
  return screenshots;
}

function generateMermaidDefinition(nodeCount: number): string {
  let def = 'graph TD\n';
  for (let i = 0; i < nodeCount; i++) {
    const next = (i + 1) % nodeCount;
    def += `  N${i}[Page ${i}] --> N${next}[Page ${next}]\n`;
    // Add some cross-links for realism
    if (i % 5 === 0 && i + 3 < nodeCount) {
      def += `  N${i} --> N${i + 3}\n`;
    }
  }
  return def;
}

function generateReportData(pageCount: number): MockReportData {
  return {
    meta: {
      targetUrl: 'https://example.com',
      crawlDate: new Date().toISOString(),
      duration: pageCount * 300, // ~300ms per page
      pagesVisited: pageCount,
      errors: Math.floor(pageCount * 0.02),
      version: '0.1.0',
    },
    sitemap: generateMockPages(pageCount),
    forms: generateMockForms(Math.floor(pageCount * 0.3)),
    apiMap: generateMockApiEndpoints(Math.floor(pageCount * 3)),
    screenshots: generateMockScreenshots(pageCount),
    flowGraph: generateMermaidDefinition(Math.min(pageCount, 50)),
  };
}

// ---------------------------------------------------------------------------
// HTML escaping (minimal implementation for benchmarking)
// ---------------------------------------------------------------------------

function escapeHtml(str: string): string {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

// ---------------------------------------------------------------------------
// Report HTML generation (simplified for benchmarking)
// ---------------------------------------------------------------------------

function generateSitemapHtml(pages: MockPageData[]): string {
  let html = '<section id="sitemap"><h2>Sitemap</h2><ul role="tree" aria-label="Sitemap">';
  for (const page of pages) {
    html += `<li role="treeitem" aria-level="1">`;
    html += `<span class="tree-label">${escapeHtml(page.url)}</span>`;
    html += `<span class="tree-title">${escapeHtml(page.title)}</span>`;
    html += `<span class="tree-status">${page.statusCode}</span>`;
    if (page.headings.length > 0) {
      html += '<ul role="group">';
      for (const heading of page.headings) {
        html += `<li role="treeitem" aria-level="2">H${heading.level}: ${escapeHtml(heading.text)}</li>`;
      }
      html += '</ul>';
    }
    html += '</li>';
  }
  html += '</ul></section>';
  return html;
}

function generateFormsHtml(forms: MockFormData[]): string {
  let html = '<section id="forms"><h2>Forms</h2><table role="grid">';
  html += '<thead><tr><th>Page</th><th>Action</th><th>Method</th><th>Fields</th></tr></thead><tbody>';
  for (const form of forms) {
    html += `<tr>`;
    html += `<td>${escapeHtml(form.pageUrl)}</td>`;
    html += `<td>${escapeHtml(form.action)}</td>`;
    html += `<td>${form.method}</td>`;
    html += '<td><ul>';
    for (const field of form.fields) {
      html += `<li>${escapeHtml(field.name)} (${field.type}${field.required ? ', required' : ''})</li>`;
    }
    html += '</ul></td></tr>';
  }
  html += '</tbody></table></section>';
  return html;
}

function generateApiMapHtml(endpoints: MockApiEndpoint[]): string {
  let html = '<section id="api-map"><h2>API Map</h2><table role="grid">';
  html += '<thead><tr><th>Method</th><th>Pattern</th><th>Status</th><th>Example URL</th></tr></thead><tbody>';
  for (const ep of endpoints) {
    html += `<tr>`;
    html += `<td class="method-${ep.method.toLowerCase()}">${ep.method}</td>`;
    html += `<td>${escapeHtml(ep.pattern)}</td>`;
    html += `<td>${ep.statusCode}</td>`;
    html += `<td>${escapeHtml(ep.url)}</td>`;
    html += '</tr>';
  }
  html += '</tbody></table></section>';
  return html;
}

function generateScreenshotsHtml(screenshots: MockScreenshot[]): string {
  let html = '<section id="screenshots"><h2>Screenshots</h2><div class="screenshot-gallery">';
  for (const ss of screenshots) {
    html += `<div class="screenshot-card">`;
    html += `<img class="screenshot-thumb" src="data:image/jpeg;base64,${ss.thumbnailBase64}" `;
    html += `alt="Screenshot of ${escapeHtml(ss.url)}" width="320" loading="lazy" />`;
    html += `<a href="${escapeHtml(ss.fullPath)}">${escapeHtml(ss.url)}</a>`;
    html += `<span>${ss.width}x${ss.height}</span>`;
    html += '</div>';
  }
  html += '</div></section>';
  return html;
}

function generateFullReportHtml(data: MockReportData): string {
  const css = `
    :root { --bg: #fff; --text: #1a1a1a; --accent: #2563eb; }
    body { font-family: system-ui, sans-serif; margin: 0; padding: 20px; color: var(--text); }
    table { width: 100%; border-collapse: collapse; }
    th, td { padding: 8px 12px; border: 1px solid #e2e8f0; text-align: left; }
    .screenshot-gallery { display: grid; grid-template-columns: repeat(auto-fill, minmax(320px, 1fr)); gap: 16px; }
    .screenshot-thumb { max-width: 320px; height: auto; }
  `.repeat(3); // Simulate realistic CSS size

  const js = `
    document.addEventListener('DOMContentLoaded', function() {
      var data = JSON.parse(document.getElementById('report-data').textContent);
      console.log('Report loaded:', data.meta.pagesVisited, 'pages');
    });
  `.repeat(10); // Simulate realistic JS size

  const sitemapHtml = generateSitemapHtml(data.sitemap);
  const formsHtml = generateFormsHtml(data.forms);
  const apiMapHtml = generateApiMapHtml(data.apiMap);
  const screenshotsHtml = generateScreenshotsHtml(data.screenshots);

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; img-src data: blob:;">
  <title>Archaeologist Report - ${escapeHtml(data.meta.targetUrl)}</title>
  <style>${css}</style>
</head>
<body>
  <header>
    <h1>Behavioral Specification Report</h1>
    <dl class="report-meta">
      <dt>Target</dt><dd>${escapeHtml(data.meta.targetUrl)}</dd>
      <dt>Crawled</dt><dd>${data.meta.crawlDate}</dd>
      <dt>Pages</dt><dd>${data.meta.pagesVisited}</dd>
      <dt>Duration</dt><dd>${data.meta.duration}ms</dd>
      <dt>Errors</dt><dd>${data.meta.errors}</dd>
    </dl>
  </header>
  <main>
    ${sitemapHtml}
    ${formsHtml}
    ${apiMapHtml}
    ${screenshotsHtml}
    <section id="flow-graph">
      <h2>Navigation Flow</h2>
      <div class="flow-graph-container">
        <pre>${escapeHtml(data.flowGraph)}</pre>
      </div>
    </section>
  </main>
  <script type="application/json" id="report-data">
    ${JSON.stringify(data)}
  </script>
  <script>${js}</script>
</body>
</html>`;
}

// ---------------------------------------------------------------------------
// Pre-generated datasets (created once, reused across benchmarks)
// ---------------------------------------------------------------------------

const data20 = generateReportData(20);
const data100 = generateReportData(100);
const data500 = generateReportData(500);

// ---------------------------------------------------------------------------
// HTML Report Generation Benchmarks
// ---------------------------------------------------------------------------

describe('HTML Report Generation', () => {
  bench('generate HTML for 20-page dataset', () => {
    generateFullReportHtml(data20);
  });

  bench('generate HTML for 100-page dataset', () => {
    generateFullReportHtml(data100);
  });

  bench('generate HTML for 500-page dataset', () => {
    generateFullReportHtml(data500);
  });
});

// ---------------------------------------------------------------------------
// Individual Section Benchmarks
// ---------------------------------------------------------------------------

describe('Report Section Generation', () => {
  bench('sitemap section: 100 pages', () => {
    generateSitemapHtml(data100.sitemap);
  });

  bench('sitemap section: 500 pages', () => {
    generateSitemapHtml(data500.sitemap);
  });

  bench('forms section: 30 forms (100-page crawl)', () => {
    generateFormsHtml(data100.forms);
  });

  bench('forms section: 150 forms (500-page crawl)', () => {
    generateFormsHtml(data500.forms);
  });

  bench('API map section: 300 endpoints (100-page crawl)', () => {
    generateApiMapHtml(data100.apiMap);
  });

  bench('API map section: 1500 endpoints (500-page crawl)', () => {
    generateApiMapHtml(data500.apiMap);
  });

  bench('screenshots section: 100 thumbnails', () => {
    generateScreenshotsHtml(data100.screenshots);
  });

  bench('screenshots section: 500 thumbnails', () => {
    generateScreenshotsHtml(data500.screenshots);
  });
});

// ---------------------------------------------------------------------------
// Base64 Encoding Benchmarks
// ---------------------------------------------------------------------------

describe('Base64 Thumbnail Encoding', () => {
  // Simulate raw JPEG buffer encoding
  const smallJpeg = Buffer.alloc(5 * 1024); // 5KB JPEG
  const mediumJpeg = Buffer.alloc(8 * 1024); // 8KB JPEG
  const largeJpeg = Buffer.alloc(15 * 1024); // 15KB JPEG

  // Fill with pseudo-random data
  for (let i = 0; i < smallJpeg.length; i++) smallJpeg[i] = i % 256;
  for (let i = 0; i < mediumJpeg.length; i++) mediumJpeg[i] = i % 256;
  for (let i = 0; i < largeJpeg.length; i++) largeJpeg[i] = i % 256;

  bench('encode 1 thumbnail (8KB)', () => {
    `data:image/jpeg;base64,${mediumJpeg.toString('base64')}`;
  });

  bench('encode 100 thumbnails (8KB each)', () => {
    for (let i = 0; i < 100; i++) {
      `data:image/jpeg;base64,${mediumJpeg.toString('base64')}`;
    }
  });

  bench('encode 500 thumbnails (8KB each)', () => {
    for (let i = 0; i < 500; i++) {
      `data:image/jpeg;base64,${mediumJpeg.toString('base64')}`;
    }
  });

  bench('encode 100 large thumbnails (15KB each)', () => {
    for (let i = 0; i < 100; i++) {
      `data:image/jpeg;base64,${largeJpeg.toString('base64')}`;
    }
  });
});

// ---------------------------------------------------------------------------
// JSON Serialization Benchmarks
// ---------------------------------------------------------------------------

describe('JSON Serialization', () => {
  bench('JSON.stringify 20-page report data', () => {
    JSON.stringify(data20);
  });

  bench('JSON.stringify 100-page report data', () => {
    JSON.stringify(data100);
  });

  bench('JSON.stringify 500-page report data', () => {
    JSON.stringify(data500);
  });

  bench('JSON.stringify + escapeHtml 100-page (XSS prevention overhead)', () => {
    const json = JSON.stringify(data100);
    // In real report generation, the JSON is embedded in a script tag
    // and must be safe for HTML context
    escapeHtml(json);
  });
});

// ---------------------------------------------------------------------------
// HTML Escaping Benchmarks (XSS Prevention Cost)
// ---------------------------------------------------------------------------

describe('HTML Escaping Throughput', () => {
  const shortString = 'Hello <world> & "friends"';
  const mediumString = 'A longer string with <html> entities & "quotes" that needs escaping in the report output for safety reasons, repeated multiple times.'.repeat(5);
  const longString = mediumString.repeat(20);
  const safeString = 'This string has no special characters and does not need escaping at all.';

  bench('escape short string (25 chars)', () => {
    escapeHtml(shortString);
  });

  bench('escape medium string (~750 chars)', () => {
    escapeHtml(mediumString);
  });

  bench('escape long string (~15K chars)', () => {
    escapeHtml(longString);
  });

  bench('escape safe string (no replacements needed)', () => {
    escapeHtml(safeString);
  });

  bench('escape 1000 URL strings', () => {
    for (let i = 0; i < 1000; i++) {
      escapeHtml(`https://example.com/page/${i}?q=search&lang=en`);
    }
  });
});

// ---------------------------------------------------------------------------
// Output Size Estimation
// ---------------------------------------------------------------------------

describe('Output Size Estimation', () => {
  bench('measure 20-page report HTML size', () => {
    const html = generateFullReportHtml(data20);
    const size = Buffer.byteLength(html, 'utf-8');
    // Size is measured but not asserted in bench mode; use budget.json thresholds in tests
    void size;
  });

  bench('measure 100-page report HTML size', () => {
    const html = generateFullReportHtml(data100);
    const size = Buffer.byteLength(html, 'utf-8');
    void size;
  });

  bench('measure 500-page report HTML size', () => {
    const html = generateFullReportHtml(data500);
    const size = Buffer.byteLength(html, 'utf-8');
    void size;
  });
});
