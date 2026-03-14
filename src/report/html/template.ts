/**
 * HTML Report Template
 *
 * Generates the self-contained HTML report from assembled artifacts.
 * All target-site data is HTML-entity-encoded via escape.ts.
 * Includes CSP meta tag for XSS prevention.
 */

import { escapeHtml, escapeAttribute, escapeJsonInHtml } from './escape.js';

// ---------------------------------------------------------------------------
// Interfaces
// ---------------------------------------------------------------------------

export interface ReportPage {
  url: string;
  title: string;
  status: number;
  depth?: number;
  contentHash?: string;
}

export interface ReportForm {
  url: string;
  action: string;
  method: string;
  fields: Array<{ name: string; type: string; required: boolean }>;
}

export interface ReportApiEndpoint {
  url?: string;
  pattern?: string;
  method: string;
  status?: number;
  examples?: Array<{ url: string; status: number }>;
}

export interface ReportScreenshot {
  url: string;
  thumbnailBase64: string;
  fullPath: string;
}

export interface ReportInput {
  title?: string;
  targetUrl: string;
  crawlDate: string;
  duration: number;
  pagesVisited: number;
  errors: number;
  pages?: ReportPage[];
  sitemap?: ReportPage[];
  forms: ReportForm[];
  apiEndpoints: ReportApiEndpoint[];
  screenshots?: ReportScreenshot[];
  flowDiagramSvg?: string;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const CSP_META = `<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; img-src data: blob:;">`;

// ---------------------------------------------------------------------------
// CSS
// ---------------------------------------------------------------------------

function generateCss(): string {
  return `
    :root {
      --bg: #ffffff;
      --bg-surface: #f8f9fa;
      --bg-surface-hover: #f0f1f3;
      --bg-nav: #1a1a2e;
      --text: #1a1a2e;
      --text-muted: #6c757d;
      --text-nav: #ffffff;
      --border: #dee2e6;
      --border-light: #e9ecef;
      --accent: #4361ee;
      --accent-hover: #3a56d4;
      --status-2xx: #198754;
      --status-3xx: #0d6efd;
      --status-4xx: #e67700;
      --status-5xx: #dc3545;
      --method-get: #198754;
      --method-post: #0d6efd;
      --method-put: #e67700;
      --method-delete: #dc3545;
      --method-patch: #cc8800;
      --badge-bg: #e9ecef;
      --shadow: 0 1px 3px rgba(0,0,0,0.08);
      --radius: 6px;
    }

    @media (prefers-color-scheme: dark) {
      :root {
        --bg: #0d1117;
        --bg-surface: #161b22;
        --bg-surface-hover: #1c2129;
        --bg-nav: #010409;
        --text: #e6edf3;
        --text-muted: #8b949e;
        --text-nav: #e6edf3;
        --border: #30363d;
        --border-light: #21262d;
        --accent: #58a6ff;
        --accent-hover: #79b8ff;
        --status-2xx: #3fb950;
        --status-3xx: #58a6ff;
        --status-4xx: #d29922;
        --status-5xx: #f85149;
        --method-get: #3fb950;
        --method-post: #58a6ff;
        --method-put: #d29922;
        --method-delete: #f85149;
        --method-patch: #e3b341;
        --badge-bg: #21262d;
        --shadow: 0 1px 3px rgba(0,0,0,0.3);
      }
    }

    * { box-sizing: border-box; margin: 0; padding: 0; }

    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Oxygen, Ubuntu, Cantarell, sans-serif;
      line-height: 1.6;
      color: var(--text);
      background: var(--bg);
    }

    /* Navigation */
    .nav {
      position: sticky;
      top: 0;
      z-index: 100;
      background: var(--bg-nav);
      color: var(--text-nav);
      display: flex;
      align-items: center;
      gap: 0.25rem;
      padding: 0 1.5rem;
      box-shadow: var(--shadow);
      flex-wrap: wrap;
    }
    .nav-brand {
      font-weight: 700;
      font-size: 0.95rem;
      padding: 0.75rem 0.5rem 0.75rem 0;
      margin-right: 1rem;
      white-space: nowrap;
    }
    .nav a {
      color: var(--text-nav);
      text-decoration: none;
      padding: 0.75rem 0.75rem;
      font-size: 0.875rem;
      opacity: 0.8;
      transition: opacity 0.15s;
    }
    .nav a:hover, .nav a:focus { opacity: 1; }

    /* Main */
    .container {
      max-width: 1200px;
      margin: 0 auto;
      padding: 1.5rem;
    }

    /* Stats bar */
    .stats {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(160px, 1fr));
      gap: 1rem;
      margin-bottom: 2rem;
    }
    .stat-card {
      background: var(--bg-surface);
      border: 1px solid var(--border-light);
      border-radius: var(--radius);
      padding: 1rem 1.25rem;
    }
    .stat-label {
      font-size: 0.75rem;
      text-transform: uppercase;
      letter-spacing: 0.05em;
      color: var(--text-muted);
      margin-bottom: 0.25rem;
    }
    .stat-value {
      font-size: 1.5rem;
      font-weight: 700;
    }
    .stat-value a {
      color: var(--accent);
      text-decoration: none;
    }

    /* Search */
    .search-bar {
      margin-bottom: 1.5rem;
    }
    .search-bar input {
      width: 100%;
      max-width: 400px;
      padding: 0.5rem 0.75rem;
      border: 1px solid var(--border);
      border-radius: var(--radius);
      font-size: 0.875rem;
      background: var(--bg);
      color: var(--text);
    }
    .search-bar input:focus {
      outline: 2px solid var(--accent);
      outline-offset: -1px;
    }

    /* Sections */
    .section {
      margin-bottom: 2.5rem;
    }
    .section-title {
      font-size: 1.25rem;
      font-weight: 700;
      margin-bottom: 1rem;
      padding-bottom: 0.5rem;
      border-bottom: 2px solid var(--border-light);
    }

    /* Details / Summary */
    details {
      margin: 0.75rem 0;
      border: 1px solid var(--border-light);
      border-radius: var(--radius);
      overflow: hidden;
    }
    summary {
      cursor: pointer;
      font-weight: 600;
      padding: 0.75rem 1rem;
      background: var(--bg-surface);
      user-select: none;
    }
    summary:hover { background: var(--bg-surface-hover); }
    details > :not(summary) { padding: 0 1rem; }
    details[open] > :not(summary) { padding: 0.75rem 1rem; }

    /* Tables */
    table {
      width: 100%;
      border-collapse: collapse;
      font-size: 0.875rem;
    }
    th, td {
      padding: 0.625rem 0.75rem;
      text-align: left;
      border-bottom: 1px solid var(--border-light);
    }
    th {
      background: var(--bg-surface);
      font-weight: 600;
      font-size: 0.8rem;
      text-transform: uppercase;
      letter-spacing: 0.03em;
      color: var(--text-muted);
      position: sticky;
      top: 0;
    }
    tbody tr:hover { background: var(--bg-surface-hover); }
    tr[data-searchable] { transition: none; }

    /* Badges */
    .badge {
      display: inline-block;
      padding: 0.15rem 0.5rem;
      border-radius: 3px;
      font-size: 0.75rem;
      font-weight: 600;
      font-family: 'SF Mono', SFMono-Regular, Consolas, 'Liberation Mono', Menlo, monospace;
    }
    .badge-get { background: var(--method-get); color: #fff; }
    .badge-post { background: var(--method-post); color: #fff; }
    .badge-put { background: var(--method-put); color: #fff; }
    .badge-delete { background: var(--method-delete); color: #fff; }
    .badge-patch { background: var(--method-patch); color: #fff; }
    .badge-default { background: var(--badge-bg); color: var(--text); }
    .badge-field {
      background: var(--badge-bg);
      color: var(--text);
      margin: 0.1rem;
    }
    .badge-required {
      background: var(--status-5xx);
      color: #fff;
    }

    /* Status colors */
    .status-2xx { color: var(--status-2xx); font-weight: 600; }
    .status-3xx { color: var(--status-3xx); font-weight: 600; }
    .status-4xx { color: var(--status-4xx); font-weight: 600; }
    .status-5xx { color: var(--status-5xx); font-weight: 600; }

    /* Sitemap tree */
    .sitemap-tree { list-style: none; padding-left: 0; }
    .sitemap-tree ul { list-style: none; padding-left: 1.25rem; }
    .sitemap-tree li { padding: 0.2rem 0; }
    .sitemap-tree .tree-label {
      font-family: 'SF Mono', SFMono-Regular, Consolas, 'Liberation Mono', Menlo, monospace;
      font-size: 0.85rem;
    }
    .sitemap-tree .tree-title {
      color: var(--text-muted);
      font-size: 0.8rem;
      margin-left: 0.5rem;
    }

    /* Screenshots grid */
    .screenshot-grid {
      display: grid;
      grid-template-columns: repeat(auto-fill, minmax(280px, 1fr));
      gap: 1rem;
    }
    .screenshot-card {
      border: 1px solid var(--border-light);
      border-radius: var(--radius);
      overflow: hidden;
      cursor: pointer;
      transition: box-shadow 0.15s;
    }
    .screenshot-card:hover {
      box-shadow: 0 4px 12px rgba(0,0,0,0.12);
    }
    .screenshot-card img {
      width: 100%;
      height: auto;
      display: block;
      background: var(--bg-surface);
    }
    .screenshot-label {
      padding: 0.5rem 0.75rem;
      font-size: 0.8rem;
      color: var(--text-muted);
      background: var(--bg-surface);
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }

    /* Dialog lightbox */
    dialog {
      border: none;
      border-radius: var(--radius);
      padding: 0;
      max-width: 90vw;
      max-height: 90vh;
      background: var(--bg);
      box-shadow: 0 8px 30px rgba(0,0,0,0.3);
    }
    dialog::backdrop {
      background: rgba(0,0,0,0.6);
    }
    .dialog-content {
      display: flex;
      flex-direction: column;
      align-items: center;
      padding: 1rem;
    }
    .dialog-content img {
      max-width: 100%;
      max-height: 80vh;
    }
    .dialog-actions {
      display: flex;
      gap: 0.75rem;
      margin-top: 0.75rem;
      align-items: center;
    }
    .dialog-actions a, .dialog-actions button {
      font-size: 0.85rem;
      padding: 0.4rem 0.8rem;
      border-radius: var(--radius);
      cursor: pointer;
    }
    .dialog-actions button {
      border: 1px solid var(--border);
      background: var(--bg-surface);
      color: var(--text);
    }
    .dialog-actions a {
      background: var(--accent);
      color: #fff;
      text-decoration: none;
    }

    /* Flow diagram */
    .flow-svg-container { overflow-x: auto; }
    .flow-svg-container svg { max-width: 100%; height: auto; }

    /* Examples sub-rows */
    .examples-list {
      list-style: none;
      padding: 0;
      margin: 0;
    }
    .examples-list li {
      padding: 0.2rem 0;
      font-size: 0.8rem;
      font-family: 'SF Mono', SFMono-Regular, Consolas, 'Liberation Mono', Menlo, monospace;
    }

    /* Responsive */
    @media (max-width: 768px) {
      .nav { padding: 0 0.75rem; }
      .nav a { padding: 0.5rem 0.5rem; font-size: 0.8rem; }
      .container { padding: 1rem; }
      .stats { grid-template-columns: repeat(2, 1fr); }
      .screenshot-grid { grid-template-columns: repeat(auto-fill, minmax(200px, 1fr)); }
      th, td { padding: 0.4rem 0.5rem; font-size: 0.8rem; }
    }

    /* Print */
    @media print {
      .nav { display: none; }
      .search-bar { display: none; }
      body { background: #fff; color: #000; }
      .container { max-width: none; padding: 0; }
      details { border: none; }
      details[open] > summary { background: none; border-bottom: 1px solid #ccc; }
      details { break-inside: avoid; }
      details > * { display: block !important; }
      details:not([open]) > :not(summary) { display: block !important; }
      .screenshot-card { break-inside: avoid; }
      dialog { display: none; }
      table { font-size: 0.75rem; }
      th { background: #f0f0f0 !important; }
    }
  `;
}

// ---------------------------------------------------------------------------
// JS
// ---------------------------------------------------------------------------

function generateJs(hasScreenshots: boolean): string {
  return `
    (function() {
      // Search filter
      var searchInput = document.getElementById('report-search');
      if (searchInput) {
        searchInput.addEventListener('input', function(e) {
          var term = e.target.value.toLowerCase();
          var rows = document.querySelectorAll('tr[data-searchable]');
          for (var i = 0; i < rows.length; i++) {
            var text = rows[i].textContent.toLowerCase();
            rows[i].style.display = term && text.indexOf(term) === -1 ? 'none' : '';
          }
          var items = document.querySelectorAll('li[data-searchable]');
          for (var j = 0; j < items.length; j++) {
            var itemText = items[j].textContent.toLowerCase();
            items[j].style.display = term && itemText.indexOf(term) === -1 ? 'none' : '';
          }
        });
      }
      ${hasScreenshots ? `
      // Screenshot lightbox
      var dialog = document.getElementById('screenshot-dialog');
      var dialogImg = document.getElementById('dialog-img');
      var dialogLink = document.getElementById('dialog-link');
      var cards = document.querySelectorAll('.screenshot-card');
      for (var k = 0; k < cards.length; k++) {
        cards[k].addEventListener('click', function() {
          var src = this.getAttribute('data-full');
          var thumb = this.querySelector('img');
          if (dialogImg && thumb) dialogImg.src = thumb.src;
          if (dialogLink) dialogLink.href = src;
          if (dialog && dialog.showModal) dialog.showModal();
        });
      }
      var closeBtn = document.getElementById('dialog-close');
      if (closeBtn && dialog) {
        closeBtn.addEventListener('click', function() { dialog.close(); });
      }
      if (dialog) {
        dialog.addEventListener('click', function(e) {
          if (e.target === dialog) dialog.close();
        });
      }
      ` : ''}
    })();
  `;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function statusClass(status: number): string {
  if (status >= 200 && status < 300) return 'status-2xx';
  if (status >= 300 && status < 400) return 'status-3xx';
  if (status >= 400 && status < 500) return 'status-4xx';
  if (status >= 500) return 'status-5xx';
  return '';
}

function methodBadgeClass(method: string): string {
  const m = method.toUpperCase();
  switch (m) {
    case 'GET': return 'badge badge-get';
    case 'POST': return 'badge badge-post';
    case 'PUT': return 'badge badge-put';
    case 'DELETE': return 'badge badge-delete';
    case 'PATCH': return 'badge badge-patch';
    default: return 'badge badge-default';
  }
}

function formatDuration(seconds: number): string {
  if (seconds < 60) return `${seconds.toFixed(1)}s`;
  const mins = Math.floor(seconds / 60);
  const secs = seconds % 60;
  return `${mins}m ${secs.toFixed(0)}s`;
}

// ---------------------------------------------------------------------------
// Sitemap tree builder
// ---------------------------------------------------------------------------

interface TreeNode {
  segment: string;
  page?: ReportPage;
  children: Map<string, TreeNode>;
}

function buildTree(pages: ReportPage[]): TreeNode {
  const root: TreeNode = { segment: '', children: new Map() };

  for (const page of pages) {
    let path: string;
    try {
      const u = new URL(page.url);
      path = u.pathname;
    } catch {
      path = page.url;
    }

    const segments = path.split('/').filter(Boolean);
    let current = root;

    for (const seg of segments) {
      if (!current.children.has(seg)) {
        current.children.set(seg, { segment: seg, children: new Map() });
      }
      current = current.children.get(seg)!;
    }
    current.page = page;

    // Also handle root page (path = '/')
    if (segments.length === 0) {
      root.page = page;
    }
  }

  return root;
}

function renderTree(node: TreeNode, depth: number = 0): string {
  const lines: string[] = [];

  // Render current node if it has a page
  if (node.page) {
    const page = node.page;
    const label = node.segment || '/';
    const statusCls = statusClass(page.status);
    const titlePart = page.title ? ` <span class="tree-title">${escapeHtml(page.title)}</span>` : '';
    lines.push(
      `<li data-searchable><span class="tree-label">${escapeHtml(label)}</span>` +
      ` <span class="${statusCls}">${page.status}</span>` +
      `${titlePart}</li>`
    );
  } else if (depth > 0) {
    // Directory node with no page
    lines.push(`<li><span class="tree-label">${escapeHtml(node.segment)}/</span></li>`);
  }

  // Sort children and render
  const sortedChildren = [...node.children.entries()].sort((a, b) => a[0].localeCompare(b[0]));
  if (sortedChildren.length > 0) {
    lines.push('<ul>');
    for (const [, child] of sortedChildren) {
      lines.push(renderTree(child, depth + 1));
    }
    lines.push('</ul>');
  }

  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// Section renderers
// ---------------------------------------------------------------------------

function renderNavigation(input: ReportInput): string {
  const hasScreenshots = input.screenshots && input.screenshots.length > 0;
  const hasFlow = !!input.flowDiagramSvg;
  const pages = input.pages ?? input.sitemap ?? [];

  const links: string[] = [];
  if (pages.length > 0) links.push('<a href="#sitemap">Sitemap</a>');
  if (input.forms.length > 0) links.push('<a href="#forms">Forms</a>');
  if (input.apiEndpoints.length > 0) links.push('<a href="#api">API</a>');
  if (hasScreenshots) links.push('<a href="#screenshots">Screenshots</a>');
  if (hasFlow) links.push('<a href="#flow">Flow</a>');

  return `<nav class="nav" role="navigation" aria-label="Report sections">
    <span class="nav-brand">Archaeologist</span>
    ${links.join('\n    ')}
  </nav>`;
}

function renderStatsBar(input: ReportInput): string {
  return `<div class="stats">
    <div class="stat-card">
      <div class="stat-label">Target</div>
      <div class="stat-value"><a href="${escapeAttribute(input.targetUrl)}">${escapeHtml(truncateUrl(input.targetUrl))}</a></div>
    </div>
    <div class="stat-card">
      <div class="stat-label">Crawl Date</div>
      <div class="stat-value">${escapeHtml(input.crawlDate)}</div>
    </div>
    <div class="stat-card">
      <div class="stat-label">Duration</div>
      <div class="stat-value">${escapeHtml(formatDuration(input.duration))}</div>
    </div>
    <div class="stat-card">
      <div class="stat-label">Pages Visited</div>
      <div class="stat-value">${input.pagesVisited}</div>
    </div>
    <div class="stat-card">
      <div class="stat-label">Errors</div>
      <div class="stat-value">${input.errors}</div>
    </div>
  </div>`;
}

function truncateUrl(url: string): string {
  if (url.length <= 40) return url;
  try {
    const u = new URL(url);
    return u.hostname + (u.pathname.length > 1 ? u.pathname : '');
  } catch {
    return url;
  }
}

function renderSitemapSection(pages: ReportPage[]): string {
  if (pages.length === 0) return '';

  const tree = buildTree(pages);
  const treeHtml = renderTree(tree);

  return `<div class="section" id="sitemap">
    <h2 class="section-title">Sitemap (${pages.length} pages)</h2>
    <details open>
      <summary>Page Tree</summary>
      <ul class="sitemap-tree">
        ${treeHtml}
      </ul>
    </details>
  </div>`;
}

function renderFormsSection(forms: ReportForm[]): string {
  if (forms.length === 0) return '';

  const rows = forms.map((form) => {
    const fieldsHtml = form.fields.map((f) => {
      const reqClass = f.required ? 'badge badge-required' : 'badge badge-field';
      return `<span class="${reqClass}">${escapeHtml(f.name)}: ${escapeHtml(f.type)}</span>`;
    }).join(' ');

    return `<tr data-searchable>
      <td>${escapeHtml(form.url)}</td>
      <td>${escapeHtml(form.action)}</td>
      <td><span class="${methodBadgeClass(form.method)}">${escapeHtml(form.method.toUpperCase())}</span></td>
      <td>${fieldsHtml}</td>
    </tr>`;
  }).join('\n');

  return `<div class="section" id="forms">
    <h2 class="section-title">Forms (${forms.length})</h2>
    <table>
      <thead><tr><th>Page URL</th><th>Action</th><th>Method</th><th>Fields</th></tr></thead>
      <tbody>${rows}</tbody>
    </table>
  </div>`;
}

function renderApiSection(endpoints: ReportApiEndpoint[]): string {
  if (endpoints.length === 0) return '';

  const rows = endpoints.map((ep) => {
    const pattern = ep.pattern ?? ep.url ?? '';
    const examplesHtml = ep.examples && ep.examples.length > 0
      ? `<details><summary>${ep.examples.length} example(s)</summary><ul class="examples-list">${
          ep.examples.map((ex) =>
            `<li>${escapeHtml(ex.url)} <span class="${statusClass(ex.status)}">${ex.status}</span></li>`
          ).join('')
        }</ul></details>`
      : (ep.status != null ? `<span class="${statusClass(ep.status)}">${ep.status}</span>` : '');

    return `<tr data-searchable>
      <td><span class="${methodBadgeClass(ep.method)}">${escapeHtml(ep.method.toUpperCase())}</span></td>
      <td>${escapeHtml(pattern)}</td>
      <td>${examplesHtml}</td>
    </tr>`;
  }).join('\n');

  return `<div class="section" id="api">
    <h2 class="section-title">API Endpoints (${endpoints.length})</h2>
    <table>
      <thead><tr><th>Method</th><th>Pattern</th><th>Details</th></tr></thead>
      <tbody>${rows}</tbody>
    </table>
  </div>`;
}

function renderScreenshotsSection(screenshots: ReportScreenshot[]): string {
  if (screenshots.length === 0) return '';

  const cards = screenshots.map((ss) => {
    let label: string;
    try {
      const u = new URL(ss.url);
      label = u.pathname || '/';
    } catch {
      label = ss.url;
    }

    return `<div class="screenshot-card" data-full="${escapeAttribute(ss.fullPath)}" data-searchable>
      <img src="data:image/jpeg;base64,${escapeAttribute(ss.thumbnailBase64)}" alt="Screenshot of ${escapeAttribute(label)}" loading="lazy">
      <div class="screenshot-label">${escapeHtml(label)}</div>
    </div>`;
  }).join('\n');

  return `<div class="section" id="screenshots">
    <h2 class="section-title">Screenshots (${screenshots.length})</h2>
    <div class="screenshot-grid">
      ${cards}
    </div>
  </div>

  <dialog id="screenshot-dialog">
    <div class="dialog-content">
      <img id="dialog-img" src="" alt="Full screenshot">
      <div class="dialog-actions">
        <a id="dialog-link" href="" target="_blank" rel="noopener">Open Full Image</a>
        <button id="dialog-close" type="button">Close</button>
      </div>
    </div>
  </dialog>`;
}

function renderFlowSection(svgContent: string): string {
  return `<div class="section" id="flow">
    <h2 class="section-title">Flow Diagram</h2>
    <details open>
      <summary>Navigation Flow</summary>
      <div class="flow-svg-container">
        ${svgContent}
      </div>
    </details>
  </div>`;
}

// ---------------------------------------------------------------------------
// Main generator
// ---------------------------------------------------------------------------

/**
 * Generate the complete HTML report string.
 * All user-provided data is escaped to prevent XSS.
 */
export function generateReportHtml(input: ReportInput): string {
  const pages = input.pages ?? input.sitemap ?? [];
  const screenshots = input.screenshots ?? [];
  const hasScreenshots = screenshots.length > 0;
  const hasFlow = !!input.flowDiagramSvg;

  const reportTitle = input.title
    ? escapeHtml(input.title)
    : `Archaeologist Report: ${escapeHtml(input.targetUrl)}`;

  const reportData = {
    targetUrl: input.targetUrl,
    crawlDate: input.crawlDate,
    duration: input.duration,
    pagesVisited: input.pagesVisited,
    errors: input.errors,
    pageCount: pages.length,
    formCount: input.forms.length,
    apiEndpointCount: input.apiEndpoints.length,
    screenshotCount: screenshots.length,
  };

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  ${CSP_META}
  <title>${reportTitle}</title>
  <style>${generateCss()}</style>
</head>
<body>
  ${renderNavigation(input)}

  <div class="container">
    <h1>${reportTitle}</h1>

    ${renderStatsBar(input)}

    <div class="search-bar">
      <input type="text" id="report-search" placeholder="Filter pages, forms, endpoints..." aria-label="Search report">
    </div>

    ${renderSitemapSection(pages)}
    ${renderFormsSection(input.forms)}
    ${renderApiSection(input.apiEndpoints)}
    ${hasScreenshots ? renderScreenshotsSection(screenshots) : ''}
    ${hasFlow ? renderFlowSection(input.flowDiagramSvg!) : ''}
  </div>

  <script type="application/json" id="report-data">${escapeJsonInHtml(JSON.stringify(reportData))}</script>
  <script>${generateJs(hasScreenshots)}</script>
</body>
</html>`;
}
