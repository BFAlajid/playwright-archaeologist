/**
 * HTML Report Template
 *
 * Generates the self-contained HTML report from assembled artifacts.
 * All target-site data is HTML-entity-encoded via escape.ts.
 * Includes CSP meta tag for XSS prevention.
 */

import {
  escapeHtml,
  escapeAttribute,
  escapeJsonInHtml,
  sanitizeUrl,
  sanitizeSvg,
  redactAbsolutePath,
} from './escape.js';
import { CSS_TOKENS, FAVICON_DATA_URI, hashSlug, patternSlug } from './tokens.js';

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

export interface ReportFormField {
  name: string;
  type: string;
  required: boolean;
}

export interface ReportForm {
  url: string;
  action: string;
  method: string;
  fields: ReportFormField[];
}

export interface ReportApiEndpoint {
  url?: string;
  pattern?: string;
  method: string;
  status?: number;
  /**
   * All methods observed for this pattern (populated when the report input
   * collapses multiple method rows into a single group). Used for the stat
   * row count of POST endpoints — if absent, `method` alone is consulted.
   */
  methods?: string[];
  examples?: Array<{ url: string; status: number }>;
}

export interface ReportScreenshot {
  url: string;
  thumbnailBase64: string;
  fullPath: string;
}

export interface ReportAccessibility {
  /** Total count of violations across all pages. */
  totalViolations: number;
  /** Counts grouped by impact level (critical/serious/moderate/minor/unknown). */
  byImpact: Record<string, number>;
  /** Per-page violation counts, rendered as a sortable table. */
  perPage: Array<{
    url: string;
    violations: number;
    byImpact: Record<string, number>;
  }>;
}

export interface ReportInput {
  title?: string;
  targetUrl: string;
  crawlDate: string;
  /** Crawl duration in milliseconds. */
  duration: number;
  pagesVisited: number;
  errors: number;
  pages?: ReportPage[];
  sitemap?: ReportPage[];
  forms: ReportForm[];
  apiEndpoints: ReportApiEndpoint[];
  screenshots?: ReportScreenshot[];
  /**
   * Flow diagram content. Either an inline SVG (pre-rendered) or a fallback
   * block containing the Mermaid source as <pre> text. Rendered as-is inside
   * the flow section container.
   */
  flowDiagramSvg?: string;
  /**
   * Directory the report will be written to. Used to rewrite any leaked
   * absolute paths in data attributes to relative form before rendering.
   */
  outputDir?: string;
  /** Tool version — shown in the footer. */
  toolVersion?: string;
  /**
   * Accessibility audit summary produced by the axe collector. Omitted
   * when the collector was not registered or produced no data.
   */
  accessibility?: ReportAccessibility;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

// `script-src 'unsafe-inline'` is a known gap: the report ships as a single
// self-contained HTML file, so the search/lightbox JS lives inline. Moving
// to an external script file (and dropping 'unsafe-inline') is Wave 2
// hardening — every other XSS primitive the attacker might reach is closed
// by escape.ts / sanitizeUrl / sanitizeSvg: href schemes are http/https-only,
// SVG event handlers and <script> blocks are stripped, and the lightbox
// target URL is validated before being assigned to dialogLink.href.
const CSP_META = `<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; img-src data: blob:;">`;

// ---------------------------------------------------------------------------
// CSS
// ---------------------------------------------------------------------------

function generateCss(): string {
  return `
    ${CSS_TOKENS}

    * { box-sizing: border-box; margin: 0; padding: 0; }

    /*
     * Screen-reader-only utility. Visible to AT, hidden visually.
     */
    .visually-hidden {
      position: absolute !important;
      width: 1px !important;
      height: 1px !important;
      padding: 0 !important;
      margin: -1px !important;
      overflow: hidden !important;
      clip: rect(0,0,0,0) !important;
      white-space: nowrap !important;
      border: 0 !important;
    }

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
    .nav a:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
    .nav-spacer { flex: 1; }
    .nav-theme-toggle {
      background: transparent;
      color: var(--text-nav);
      border: 1px solid rgba(255,255,255,0.2);
      border-radius: var(--radius);
      padding: 0.35rem 0.65rem;
      font-size: 0.8rem;
      cursor: pointer;
      min-width: 44px;
      min-height: 32px;
    }
    .nav-theme-toggle:hover { background: rgba(255,255,255,0.1); }
    .nav-theme-toggle:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }

    /* Main */
    .container {
      max-width: min(1600px, 95vw);
      margin: 0 auto;
      padding: 1.5rem;
    }

    /* Header / footer landmarks */
    header.report-header { margin-bottom: 1rem; }
    footer.report-footer {
      margin-top: 3rem;
      padding: 1rem 0;
      border-top: 1px solid var(--border-light);
      color: var(--text-muted);
      font-size: 0.8rem;
      text-align: center;
    }

    /* Stats bar */
    .stats {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(160px, 1fr));
      gap: 1rem;
      margin-bottom: 1rem;
    }
    .stats-anomalies { margin-bottom: 2rem; }
    .stat-card {
      background: var(--bg-surface);
      border: 1px solid var(--border-light);
      border-radius: var(--radius);
      padding: 1rem 1.25rem;
    }
    .stat-card.has-errors { border-color: #e74c3c; }
    .stat-card.has-errors .stat-value { color: #e74c3c; }
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
    .stat-value a:focus-visible {
      outline: 2px solid var(--accent);
      outline-offset: 2px;
    }
    .stat-value.stat-nonzero { color: var(--status-5xx); }

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
    #search-count {
      font-size: 0.8rem;
      color: var(--text-muted);
      margin-top: 0.25rem;
      min-height: 1.2rem;
    }

    /* Filter bar per-section */
    .filter-bar {
      display: flex;
      flex-wrap: wrap;
      gap: 0.5rem;
      margin-bottom: 0.75rem;
      align-items: center;
      font-size: 0.85rem;
    }
    .filter-bar label {
      color: var(--text-muted);
      margin-right: 0.25rem;
    }
    .filter-bar select {
      padding: 0.3rem 0.5rem;
      border: 1px solid var(--border);
      border-radius: var(--radius);
      background: var(--bg);
      color: var(--text);
      font-size: 0.85rem;
      min-height: 32px;
    }
    .filter-bar select:focus-visible {
      outline: 2px solid var(--accent);
      outline-offset: -1px;
    }

    /* Sections */
    section.section, .section {
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
      top: var(--nav-h);
      z-index: 10;
    }
    tbody tr:hover { background: var(--bg-surface-hover); }
    tr[data-searchable] { transition: none; }
    tr.no-results td {
      text-align: center;
      color: var(--text-muted);
      font-style: italic;
    }

    /* Deep-link permalinks */
    .row-permalink {
      text-decoration: none;
      color: var(--text-muted);
      opacity: 0;
      transition: opacity 0.1s;
      margin-left: 0.25rem;
      font-size: 0.8rem;
    }
    tbody tr:hover .row-permalink,
    tbody tr:focus-within .row-permalink,
    .row-permalink:focus-visible { opacity: 1; }
    .row-permalink:focus-visible {
      outline: 2px solid var(--accent);
      outline-offset: 2px;
    }

    /* Badges */
    .badge {
      display: inline-block;
      padding: 0.15rem 0.5rem;
      border-radius: 3px;
      font-size: 0.75rem;
      font-weight: 600;
      font-family: 'SF Mono', SFMono-Regular, Consolas, 'Liberation Mono', Menlo, monospace;
      margin: 0.1rem;
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
    }
    .badge-required {
      background: var(--status-5xx);
      color: #fff;
    }
    .badge-sensitive {
      background: var(--status-4xx);
      color: #fff;
    }
    .form-legend {
      font-size: 0.8rem;
      color: var(--text-muted);
      margin-bottom: 0.5rem;
    }
    .form-legend .legend-swatch {
      display: inline-block;
      width: 0.75rem;
      height: 0.75rem;
      border-radius: 2px;
      vertical-align: middle;
      margin-right: 0.25rem;
    }
    .form-legend .swatch-required { background: var(--status-5xx); }
    .form-legend .swatch-sensitive { background: var(--status-4xx); }

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
    .tree-toggle {
      display: inline-block;
      width: 1rem;
      height: 1rem;
      line-height: 1rem;
      text-align: center;
      background: transparent;
      border: 0;
      color: var(--text-muted);
      cursor: pointer;
      padding: 0;
      margin-right: 0.2rem;
      font-size: 0.75rem;
    }
    .tree-toggle:focus-visible {
      outline: 2px solid var(--accent);
      outline-offset: 2px;
    }
    .sitemap-tree li[aria-expanded="false"] > ul { display: none; }
    .sitemap-tree li[aria-expanded="false"] > .tree-toggle::before { content: "\u25B8"; }
    .sitemap-tree li[aria-expanded="true"] > .tree-toggle::before { content: "\u25BE"; }

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
    .screenshot-card:focus-visible {
      outline: 2px solid var(--accent);
      outline-offset: 2px;
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
    .mermaid-source {
      background: var(--bg-surface);
      border: 1px solid var(--border-light);
      border-radius: var(--radius);
      padding: 0.75rem 1rem;
      font-family: 'SF Mono', SFMono-Regular, Consolas, 'Liberation Mono', Menlo, monospace;
      font-size: 0.8rem;
      overflow-x: auto;
      white-space: pre;
      margin: 0;
    }

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

    /* Accessibility (axe) section */
    .a11y-impact-grid {
      display: grid;
      gap: 0.4rem;
      max-width: 620px;
      margin-bottom: 1rem;
    }
    .a11y-bar-row {
      display: grid;
      grid-template-columns: 80px 1fr 3rem;
      align-items: center;
      gap: 0.5rem;
      font-size: 0.85rem;
    }
    .a11y-bar-label { text-transform: capitalize; color: var(--text-muted); }
    .a11y-bar-track {
      display: block;
      height: 10px;
      background: var(--bg-surface);
      border: 1px solid var(--border-light);
      border-radius: 5px;
      overflow: hidden;
    }
    .a11y-bar-fill {
      display: block;
      height: 100%;
      background: var(--accent);
      transition: width 0.2s ease;
    }
    .a11y-bar-fill.a11y-impact-critical { background: var(--status-5xx); }
    .a11y-bar-fill.a11y-impact-serious { background: #e67e22; }
    .a11y-bar-fill.a11y-impact-moderate { background: var(--status-4xx); }
    .a11y-bar-fill.a11y-impact-minor { background: var(--accent); }
    .a11y-bar-fill.a11y-impact-unknown { background: var(--text-muted); }
    .a11y-bar-count { font-variant-numeric: tabular-nums; font-weight: 600; }
    .badge.badge-impact-critical { background: var(--status-5xx); color: #fff; }
    .badge.badge-impact-serious { background: #e67e22; color: #fff; }
    .badge.badge-impact-moderate { background: var(--status-4xx); color: #fff; }
    .badge.badge-impact-minor { background: var(--accent); color: #fff; }
    .badge.badge-impact-unknown { background: var(--badge-bg); color: var(--text); }

    /* Responsive */
    @media (max-width: 768px) {
      .nav { padding: 0 0.75rem; }
      .nav a { padding: 0.5rem 0.5rem; font-size: 0.8rem; }
      .container { padding: 1rem; }
      .stats { grid-template-columns: repeat(2, 1fr); }
      .screenshot-grid { grid-template-columns: repeat(auto-fill, minmax(200px, 1fr)); }
      th, td { padding: 0.4rem 0.5rem; font-size: 0.8rem; }
      .row-permalink { opacity: 1; } /* touch devices: no hover */
      .nav-theme-toggle { min-width: 44px; min-height: 44px; }
    }

    /* Print */
    @media print {
      .nav { display: none; }
      .search-bar { display: none; }
      .filter-bar { display: none; }
      body { background: #fff; color: #000; }
      .container { max-width: none; padding: 0; }
      details { border: none; }
      details[open] > summary { background: none; border-bottom: 1px solid #ccc; }
      details { break-inside: avoid; }
      details > * { display: block !important; }
      details:not([open]) > :not(summary) { display: block !important; }
      .sitemap-tree li[aria-expanded="false"] > ul { display: block !important; }
      .screenshot-card { break-inside: avoid; }
      dialog { display: none; }
      table { font-size: 0.75rem; }
      th { background: #f0f0f0 !important; }
      .row-permalink { display: none; }
      footer.report-footer { display: none; }
    }
  `;
}

// ---------------------------------------------------------------------------
// JS
// ---------------------------------------------------------------------------

function generateJs(hasScreenshots: boolean): string {
  return `
    (function() {
      // ---------------------------------------------------------------
      // Theme toggle — cycles auto/light/dark, persisted in localStorage
      // ---------------------------------------------------------------
      var THEME_KEY = 'pa-theme';
      function applyTheme(t) {
        if (t === 'light' || t === 'dark') {
          document.documentElement.setAttribute('data-theme', t);
        } else {
          document.documentElement.removeAttribute('data-theme');
        }
      }
      function readTheme() {
        try { return localStorage.getItem(THEME_KEY) || 'auto'; }
        catch (e) { return 'auto'; }
      }
      function writeTheme(t) {
        try { localStorage.setItem(THEME_KEY, t); } catch (e) { /* noop */ }
      }
      function themeLabel(t) {
        if (t === 'light') return 'Theme: Light';
        if (t === 'dark') return 'Theme: Dark';
        return 'Theme: Auto';
      }
      var toggle = document.getElementById('theme-toggle');
      var current = readTheme();
      applyTheme(current);
      if (toggle) {
        toggle.textContent = themeLabel(current);
        toggle.addEventListener('click', function() {
          current = current === 'auto' ? 'light' : current === 'light' ? 'dark' : 'auto';
          writeTheme(current);
          applyTheme(current);
          toggle.textContent = themeLabel(current);
        });
      }

      // ---------------------------------------------------------------
      // Nav height tracker — updates --nav-h when the nav wraps so that
      // sticky table headers never overlap the nav on mobile.
      // ---------------------------------------------------------------
      var navEl = document.querySelector('.nav');
      function updateNavHeight() {
        if (!navEl) return;
        var h = navEl.offsetHeight || 48;
        document.documentElement.style.setProperty('--nav-h', h + 'px');
      }
      updateNavHeight();
      if (typeof ResizeObserver !== 'undefined' && navEl) {
        try {
          var ro = new ResizeObserver(updateNavHeight);
          ro.observe(navEl);
        } catch (e) { /* noop */ }
      }
      window.addEventListener('resize', updateNavHeight);

      // ---------------------------------------------------------------
      // Search + per-section structured filters
      // ---------------------------------------------------------------
      var searchInput = document.getElementById('report-search');
      var searchCount = document.getElementById('search-count');

      // Map section id -> { selects: [{select, attr}], rows: NodeList, empty: HTMLElement }
      var sectionFilters = [];
      var sections = document.querySelectorAll('section.section, div.section');
      for (var s = 0; s < sections.length; s++) {
        var sec = sections[s];
        var selects = sec.querySelectorAll('select[data-filter-attr]');
        var rows = sec.querySelectorAll('tr[data-searchable]');
        var empty = sec.querySelector('tr.no-results');
        if (selects.length > 0 || rows.length > 0) {
          var fData = { selects: [], rows: rows, empty: empty, section: sec };
          for (var si = 0; si < selects.length; si++) {
            fData.selects.push({ select: selects[si], attr: selects[si].getAttribute('data-filter-attr') });
          }
          sectionFilters.push(fData);
        }
      }

      function rowMatches(row, term, filters) {
        // Structured filter match (AND across all selects).
        for (var fi = 0; fi < filters.length; fi++) {
          var val = filters[fi].select.value;
          if (val === '' || val === '*') continue;
          var attr = filters[fi].attr;
          var rowVal = row.getAttribute('data-' + attr) || '';
          if (rowVal !== val) return false;
        }
        if (!term) return true;
        var text = row.dataset.search || row.textContent.toLowerCase();
        return text.indexOf(term) !== -1;
      }

      function applyFilters() {
        var term = searchInput ? searchInput.value.toLowerCase() : '';
        var totalVisible = 0;
        var totalRows = 0;
        for (var i = 0; i < sectionFilters.length; i++) {
          var sf = sectionFilters[i];
          var secVisible = 0;
          for (var r = 0; r < sf.rows.length; r++) {
            var row = sf.rows[r];
            if (row.classList.contains('no-results')) continue;
            totalRows++;
            var ok = rowMatches(row, term, sf.selects);
            row.style.display = ok ? '' : 'none';
            if (ok) { secVisible++; totalVisible++; }
          }
          if (sf.empty) sf.empty.style.display = (sf.rows.length > 1 && secVisible === 0) ? '' : 'none';
        }
        // Also filter sitemap <li> items by free text.
        var items = document.querySelectorAll('li[data-searchable]');
        for (var j = 0; j < items.length; j++) {
          var itemText = items[j].dataset.search || items[j].textContent.toLowerCase();
          items[j].style.display = term && itemText.indexOf(term) === -1 ? 'none' : '';
        }
        if (searchCount) {
          if (term) {
            searchCount.textContent = totalVisible + ' of ' + totalRows + ' matching "' + term + '"';
          } else {
            searchCount.textContent = '';
          }
        }
      }

      var debounceTimer = null;
      if (searchInput) {
        searchInput.addEventListener('input', function() {
          if (debounceTimer) clearTimeout(debounceTimer);
          debounceTimer = setTimeout(applyFilters, 100);
        });
      }
      for (var k = 0; k < sectionFilters.length; k++) {
        for (var ki = 0; ki < sectionFilters[k].selects.length; ki++) {
          sectionFilters[k].selects[ki].select.addEventListener('change', applyFilters);
        }
      }

      // ---------------------------------------------------------------
      // Sitemap tree toggle (caret buttons)
      // ---------------------------------------------------------------
      var treeToggles = document.querySelectorAll('.tree-toggle');
      for (var tt = 0; tt < treeToggles.length; tt++) {
        treeToggles[tt].addEventListener('click', function(e) {
          e.preventDefault();
          e.stopPropagation();
          var li = this.closest('li[role="treeitem"]');
          if (!li) return;
          var expanded = li.getAttribute('aria-expanded') === 'true';
          li.setAttribute('aria-expanded', expanded ? 'false' : 'true');
        });
      }

      ${hasScreenshots ? `
      // ---------------------------------------------------------------
      // Screenshot lightbox
      // ---------------------------------------------------------------
      var dialog = document.getElementById('screenshot-dialog');
      var dialogImg = document.getElementById('dialog-img');
      var dialogLink = document.getElementById('dialog-link');
      var closeBtn = document.getElementById('dialog-close');
      var cards = document.querySelectorAll('.screenshot-card');
      var lastFocusedCard = null;

      // Only allow relative / absolute-local paths for the lightbox link.
      // This blocks a tampered bundle from slipping data:/javascript:
      // URLs into dialogLink.href, which would otherwise execute when the
      // user clicks "Open Full Image".
      function isSafeFullPath(p) {
        if (typeof p !== 'string' || p.length === 0) return false;
        if (p.charAt(0) === '.' && p.charAt(1) === '/') return true;
        if (p.charAt(0) === '/') return true;
        // Windows absolute path: C:\\ or C:/
        if (/^[A-Za-z]:[\\\\\\/]/.test(p)) return true;
        return false;
      }

      function currentVisibleCards() {
        var out = [];
        for (var i = 0; i < cards.length; i++) {
          if (cards[i].style.display !== 'none') out.push(cards[i]);
        }
        return out;
      }

      function openLightbox(card) {
        var src = card.getAttribute('data-full');
        if (dialogImg) dialogImg.src = src;
        if (dialogLink) dialogLink.href = isSafeFullPath(src) ? src : '#';
        lastFocusedCard = card;
        if (dialog && dialog.showModal) {
          dialog.showModal();
          if (closeBtn) closeBtn.focus();
        }
      }

      function closeLightbox() {
        if (dialog) dialog.close();
        // If the originally-focused card is filtered out of view, fall back
        // to the search input so focus doesn't land in nowhere.
        if (lastFocusedCard && lastFocusedCard.style.display === 'none') {
          if (searchInput) searchInput.focus();
        } else if (lastFocusedCard) {
          lastFocusedCard.focus();
        }
        lastFocusedCard = null;
      }

      function navigateLightbox(direction) {
        if (!lastFocusedCard) return;
        var visible = currentVisibleCards();
        if (visible.length === 0) return;
        var idx = visible.indexOf(lastFocusedCard);
        if (idx === -1) idx = 0;
        var next = (idx + direction + visible.length) % visible.length;
        openLightbox(visible[next]);
      }

      for (var cc = 0; cc < cards.length; cc++) {
        (function(card) {
          card.addEventListener('click', function() { openLightbox(card); });
          card.addEventListener('keydown', function(e) {
            if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); openLightbox(card); }
          });
        })(cards[cc]);
      }
      if (closeBtn) {
        closeBtn.addEventListener('click', function() { closeLightbox(); });
      }
      if (dialog) {
        dialog.addEventListener('click', function(e) {
          if (e.target === dialog) closeLightbox();
        });
        dialog.addEventListener('keydown', function(e) {
          if (e.key === 'ArrowRight') { e.preventDefault(); navigateLightbox(1); }
          else if (e.key === 'ArrowLeft') { e.preventDefault(); navigateLightbox(-1); }
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

/**
 * Format a duration given in milliseconds as "Xs" or "Xm Ys".
 */
function formatDuration(ms: number): string {
  const seconds = ms / 1000;
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

/**
 * Render a single tree node as a `<li>` element.
 *
 * Children, when present, are emitted INSIDE the parent `<li>` (not as a
 * sibling). This produces a valid ARIA tree that screen readers can
 * traverse — the previous sibling-layout was unreadable.
 */
function renderTreeNode(node: TreeNode, depth: number = 0): string {
  const sortedChildren = [...node.children.entries()].sort((a, b) =>
    a[0].localeCompare(b[0]),
  );
  const hasChildren = sortedChildren.length > 0;

  // Render current node label.
  let labelHtml = '';
  if (node.page) {
    const page = node.page;
    const label = node.segment || '/';
    const statusCls = statusClass(page.status);
    const titlePart = page.title
      ? ` <span class="tree-title">${escapeHtml(page.title)}</span>`
      : '';
    labelHtml =
      `<span class="tree-label">${escapeHtml(label)}</span>` +
      ` <span class="${statusCls}">${page.status}</span>${titlePart}`;
  } else if (depth > 0) {
    labelHtml = `<span class="tree-label">${escapeHtml(node.segment)}/</span>`;
  }

  const childrenHtml = hasChildren
    ? `<ul role="group">${sortedChildren
        .map(([, child]) => renderTreeNode(child, depth + 1))
        .join('\n')}</ul>`
    : '';

  const searchTerm = escapeAttribute(
    ((node.page?.title || '') + ' ' + (node.page?.url || '') + ' ' + node.segment)
      .toLowerCase(),
  );

  const ariaExpanded = hasChildren ? ' aria-expanded="true"' : '';
  const toggleBtn = hasChildren
    ? `<button class="tree-toggle" type="button" aria-label="Toggle children" tabindex="-1"></button>`
    : '';

  // Children go INSIDE the <li>, not beside it — fixes the broken sibling
  // layout that previously produced invalid tree markup.
  return (
    `<li role="treeitem"${ariaExpanded} data-searchable data-search="${searchTerm}">` +
    toggleBtn +
    labelHtml +
    childrenHtml +
    `</li>`
  );
}

// ---------------------------------------------------------------------------
// Section renderers
// ---------------------------------------------------------------------------

function renderNavigation(input: ReportInput): string {
  const hasScreenshots = input.screenshots && input.screenshots.length > 0;
  const hasFlow = !!input.flowDiagramSvg;
  const hasA11y = !!input.accessibility;
  const pages = input.pages ?? input.sitemap ?? [];

  const links: string[] = [];
  if (pages.length > 0) links.push('<a href="#sitemap">Sitemap</a>');
  if (input.forms.length > 0) links.push('<a href="#forms">Forms</a>');
  if (input.apiEndpoints.length > 0) links.push('<a href="#api">API</a>');
  if (hasScreenshots) links.push('<a href="#screenshots">Screenshots</a>');
  if (hasFlow) links.push('<a href="#flow">Flow</a>');
  if (hasA11y) links.push('<a href="#accessibility">Accessibility</a>');

  return `<nav class="nav" aria-label="Report sections">
    <span class="nav-brand">Archaeologist</span>
    ${links.join('\n    ')}
    <span class="nav-spacer"></span>
    <button id="theme-toggle" type="button" class="nav-theme-toggle" aria-label="Toggle theme">Theme: Auto</button>
  </nav>`;
}

/**
 * Compute anomaly counts used in the executive summary row.
 * Exported for unit testing.
 */
export function computeAnomalyCounts(input: ReportInput): {
  status4xx: number;
  status5xx: number;
  postEndpoints: number;
  formsWithPassword: number;
  authGated: number;
} {
  const pages = input.pages ?? input.sitemap ?? [];
  let status4xx = 0;
  let status5xx = 0;
  let authGated = 0;
  for (const p of pages) {
    if (p.status >= 400 && p.status < 500) status4xx++;
    if (p.status >= 500 && p.status < 600) status5xx++;
    if (p.status === 401 || p.status === 403) authGated++;
  }

  let postEndpoints = 0;
  for (const ep of input.apiEndpoints) {
    const methods = ep.methods && ep.methods.length > 0 ? ep.methods : [ep.method];
    if (methods.some((m) => m.toUpperCase() === 'POST')) postEndpoints++;
  }

  let formsWithPassword = 0;
  for (const form of input.forms) {
    if (form.fields.some((f) => f.type.toLowerCase() === 'password')) {
      formsWithPassword++;
    }
  }

  return { status4xx, status5xx, postEndpoints, formsWithPassword, authGated };
}

function renderStatsBar(input: ReportInput): string {
  const anomalies = computeAnomalyCounts(input);

  // Anchor helper — link to section only if the section is populated.
  const anchorOrPlain = (count: number, href: string): string => {
    const cls = count > 0 ? 'stat-value stat-nonzero' : 'stat-value';
    if (count === 0) return `<div class="${cls}">0</div>`;
    return `<div class="${cls}"><a href="${href}">${count}</a></div>`;
  };

  return `<div class="stats">
    <div class="stat-card">
      <div class="stat-label">Target</div>
      <div class="stat-value"><a href="${escapeAttribute(sanitizeUrl(input.targetUrl))}">${escapeHtml(truncateUrl(input.targetUrl))}</a></div>
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
    <div class="stat-card${input.errors > 0 ? ' has-errors' : ''}">
      <div class="stat-label">Errors</div>
      <div class="stat-value">${input.errors}</div>
    </div>
  </div>
  <div class="stats stats-anomalies" aria-label="Anomaly summary">
    <div class="stat-card">
      <div class="stat-label">4xx Routes</div>
      ${anchorOrPlain(anomalies.status4xx, '#sitemap')}
    </div>
    <div class="stat-card">
      <div class="stat-label">5xx Routes</div>
      ${anchorOrPlain(anomalies.status5xx, '#sitemap')}
    </div>
    <div class="stat-card">
      <div class="stat-label">POST Endpoints</div>
      ${anchorOrPlain(anomalies.postEndpoints, '#api')}
    </div>
    <div class="stat-card">
      <div class="stat-label">Forms With Password</div>
      ${anchorOrPlain(anomalies.formsWithPassword, '#forms')}
    </div>
    <div class="stat-card">
      <div class="stat-label">Auth-Gated Pages</div>
      ${anchorOrPlain(anomalies.authGated, '#sitemap')}
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
  // Render the root's children plus, if present, the root's own page entry.
  // The root itself is a virtual container, not a tree item.
  const sortedChildren = [...tree.children.entries()].sort((a, b) =>
    a[0].localeCompare(b[0]),
  );
  const rootItems: string[] = [];
  if (tree.page) {
    const rootNode: TreeNode = { segment: '/', page: tree.page, children: new Map() };
    rootItems.push(renderTreeNode(rootNode, 0));
  }
  for (const [, child] of sortedChildren) {
    rootItems.push(renderTreeNode(child, 1));
  }

  return `<section class="section" id="sitemap" aria-labelledby="section-title-sitemap">
    <h2 class="section-title" id="section-title-sitemap">Sitemap (${pages.length} pages)</h2>
    <details open>
      <summary>Page Tree</summary>
      <ul class="sitemap-tree" role="tree">
        ${rootItems.join('\n        ')}
      </ul>
    </details>
  </section>`;
}

const SENSITIVE_FIELD_TYPES = new Set(['password', 'email', 'tel']);

function fieldBadgeClass(field: { type: string; required: boolean }): string {
  if (field.required) return 'badge badge-required';
  if (SENSITIVE_FIELD_TYPES.has(field.type.toLowerCase())) return 'badge badge-sensitive';
  return 'badge badge-field';
}

function hasPassword(form: ReportForm): boolean {
  return form.fields.some((f) => f.type.toLowerCase() === 'password');
}

function hasFileUpload(form: ReportForm): boolean {
  return form.fields.some((f) => f.type.toLowerCase() === 'file');
}

function formFilterCategory(form: ReportForm): string {
  if (hasPassword(form)) return 'password';
  if (hasFileUpload(form)) return 'file';
  return 'other';
}

function renderFormsSection(forms: ReportForm[]): string {
  if (forms.length === 0) return '';

  const rows = forms.map((form, idx) => {
    const fieldsHtml = form.fields.map((f) => {
      const cls = fieldBadgeClass(f);
      const displayName = f.name && f.name.length > 0 ? f.name : '(unnamed)';
      return `<span class="${cls}">${escapeHtml(displayName)}: ${escapeHtml(f.type)}</span>`;
    }).join(' ');

    const rowId = `form-${idx}`;
    const category = formFilterCategory(form);
    const searchText = escapeAttribute(
      `${form.url} ${form.action} ${form.method} ${form.fields.map(f => f.name + ' ' + f.type).join(' ')}`.toLowerCase(),
    );

    return `<tr data-searchable id="${rowId}" data-search="${searchText}" data-form-type="${category}">
      <td>${escapeHtml(form.url)} <a href="#${rowId}" class="row-permalink" aria-label="Permalink to this form">#</a></td>
      <td>${escapeHtml(form.action)}</td>
      <td><span class="${methodBadgeClass(form.method)}">${escapeHtml(form.method.toUpperCase())}</span></td>
      <td>${fieldsHtml}</td>
    </tr>`;
  }).join('\n');

  return `<section class="section" id="forms" aria-labelledby="section-title-forms">
    <h2 class="section-title" id="section-title-forms">Forms (${forms.length})</h2>
    <p class="form-legend">
      <span class="legend-swatch swatch-required"></span>Red = required
      &nbsp;&middot;&nbsp;
      <span class="legend-swatch swatch-sensitive"></span>Yellow = sensitive type (password, email, tel)
    </p>
    <div class="filter-bar">
      <label for="form-type-filter">Filter:</label>
      <select id="form-type-filter" name="type-filter" data-filter-attr="form-type">
        <option value="*">All</option>
        <option value="password">Has password</option>
        <option value="file">Has file upload</option>
        <option value="other">Other</option>
      </select>
    </div>
    <table>
      <thead><tr><th>Page URL</th><th>Action</th><th>Method</th><th>Fields</th></tr></thead>
      <tbody>${rows}
      <tr class="no-results" style="display:none"><td colspan="4">No matching rows</td></tr>
      </tbody>
    </table>
  </section>`;
}

function renderApiSection(endpoints: ReportApiEndpoint[]): string {
  if (endpoints.length === 0) return '';

  const rows = endpoints.map((ep) => {
    const pattern = ep.pattern ?? ep.url ?? '';
    const method = ep.method.toUpperCase();
    const examplesHtml = ep.examples && ep.examples.length > 0
      ? `<details><summary>${ep.examples.length} example(s)</summary><ul class="examples-list">${
          ep.examples.map((ex) =>
            `<li>${escapeHtml(ex.url)} <span class="${statusClass(ex.status)}">${ex.status}</span></li>`
          ).join('')
        }</ul></details>`
      : (ep.status != null ? `<span class="${statusClass(ep.status)}">${ep.status}</span>` : '');

    const slug = patternSlug(pattern) || hashSlug(pattern);
    const rowId = `api-${method.toLowerCase()}-${slug}`;
    const searchText = escapeAttribute(`${method} ${pattern}`.toLowerCase());

    return `<tr data-searchable id="${rowId}" data-search="${searchText}" data-api-method="${method}">
      <td><span class="${methodBadgeClass(ep.method)}">${escapeHtml(method)}</span></td>
      <td>${escapeHtml(pattern)} <a href="#${rowId}" class="row-permalink" aria-label="Permalink to this endpoint">#</a></td>
      <td>${examplesHtml}</td>
    </tr>`;
  }).join('\n');

  return `<section class="section" id="api" aria-labelledby="section-title-api">
    <h2 class="section-title" id="section-title-api">API Endpoints (${endpoints.length})</h2>
    <div class="filter-bar">
      <label for="api-method-filter">Filter:</label>
      <select id="api-method-filter" name="method-filter" data-filter-attr="api-method">
        <option value="*">All methods</option>
        <option value="GET">GET</option>
        <option value="POST">POST</option>
        <option value="PUT">PUT</option>
        <option value="DELETE">DELETE</option>
        <option value="PATCH">PATCH</option>
      </select>
    </div>
    <table>
      <thead><tr><th>Method</th><th>Pattern</th><th>Details</th></tr></thead>
      <tbody>${rows}
      <tr class="no-results" style="display:none"><td colspan="3">No matching rows</td></tr>
      </tbody>
    </table>
  </section>`;
}

function renderScreenshotsSection(
  screenshots: ReportScreenshot[],
  outputDir?: string,
): string {
  if (screenshots.length === 0) return '';

  const cards = screenshots.map((ss) => {
    let label: string;
    try {
      const u = new URL(ss.url);
      label = u.pathname || '/';
    } catch {
      label = ss.url;
    }

    // Redact any absolute path leaked into the manifest; prefer a relative
    // path anchored to the report's output directory.
    const safePath = redactAbsolutePath(ss.fullPath, outputDir);

    return `<div class="screenshot-card" data-full="${escapeAttribute(safePath)}" data-searchable tabindex="0" role="button" aria-label="View screenshot of ${escapeAttribute(label)}">
      <img src="data:image/jpeg;base64,${escapeAttribute(ss.thumbnailBase64)}" alt="Screenshot of ${escapeAttribute(label)}" loading="lazy">
      <div class="screenshot-label">${escapeHtml(label)}</div>
    </div>`;
  }).join('\n');

  return `<section class="section" id="screenshots" aria-labelledby="section-title-screenshots">
    <h2 class="section-title" id="section-title-screenshots">Screenshots (${screenshots.length})</h2>
    <div class="screenshot-grid">
      ${cards}
    </div>
  </section>

  <dialog id="screenshot-dialog" aria-label="Screenshot preview">
    <div class="dialog-content">
      <img id="dialog-img" src="" alt="Full screenshot">
      <div class="dialog-actions">
        <a id="dialog-link" href="" target="_blank" rel="noopener">Open Full Image</a>
        <button id="dialog-close" type="button" aria-label="Close">Close</button>
      </div>
    </div>
  </dialog>`;
}

function renderAccessibilitySection(a11y: ReportAccessibility): string {
  const impactOrder = ['critical', 'serious', 'moderate', 'minor', 'unknown'];
  const knownImpacts = Object.keys(a11y.byImpact).filter((k) => !impactOrder.includes(k));
  const impacts = [...impactOrder, ...knownImpacts].filter((k) => (a11y.byImpact[k] ?? 0) > 0);
  const maxCount = impacts.reduce(
    (m, k) => Math.max(m, a11y.byImpact[k] ?? 0),
    0,
  );

  // Aggregate by-impact bars: purely CSS-based (width percentage).
  const bars = impacts.map((impact) => {
    const count = a11y.byImpact[impact] ?? 0;
    const pct = maxCount > 0 ? Math.round((count / maxCount) * 100) : 0;
    return `<div class="a11y-bar-row">
      <span class="a11y-bar-label">${escapeHtml(impact)}</span>
      <span class="a11y-bar-track" aria-hidden="true"><span class="a11y-bar-fill a11y-impact-${escapeAttribute(impact)}" style="width:${pct}%"></span></span>
      <span class="a11y-bar-count">${count}</span>
    </div>`;
  }).join('');

  // Per-page rows — sorted by violation count descending.
  const rows = [...a11y.perPage]
    .sort((a, b) => b.violations - a.violations)
    .map((p) => {
      const breakdown = impactOrder
        .filter((imp) => (p.byImpact[imp] ?? 0) > 0)
        .map((imp) => `<span class="badge badge-impact-${escapeAttribute(imp)}">${escapeHtml(imp)}: ${p.byImpact[imp]}</span>`)
        .join(' ');
      return `<tr><td>${escapeHtml(p.url)}</td><td>${p.violations}</td><td>${breakdown}</td></tr>`;
    }).join('\n');

  return `<section class="section" id="accessibility" aria-labelledby="section-title-accessibility">
    <h2 class="section-title" id="section-title-accessibility">Accessibility (${a11y.totalViolations} violation${a11y.totalViolations === 1 ? '' : 's'})</h2>
    ${a11y.totalViolations === 0
      ? `<p class="form-legend">No accessibility violations detected.</p>`
      : `<div class="a11y-impact-grid" role="list" aria-label="Violations by impact level">
          ${bars}
        </div>
        <details ${a11y.perPage.length <= 20 ? 'open' : ''}>
          <summary>Per-page breakdown (${a11y.perPage.length} page${a11y.perPage.length === 1 ? '' : 's'})</summary>
          <table>
            <thead><tr><th>Page URL</th><th>Violations</th><th>By impact</th></tr></thead>
            <tbody>${rows}</tbody>
          </table>
        </details>`}
  </section>`;
}

function renderFlowSection(svgContent: string): string {
  // sanitizeSvg strips <script> blocks, on* event handlers, and non-http(s)
  // hrefs. svgContent is currently always undefined (see orchestrator.ts),
  // but we close the gap now so a future Mermaid-to-SVG pre-rendering path
  // cannot inject anything executable.
  const safeSvg = sanitizeSvg(svgContent);
  return `<section class="section" id="flow" aria-labelledby="section-title-flow">
    <h2 class="section-title" id="section-title-flow">Flow Diagram</h2>
    <details open>
      <summary>Navigation Flow</summary>
      <div class="flow-svg-container">
        ${safeSvg}
      </div>
    </details>
  </section>`;
}

/**
 * Return a visible fallback block for a Mermaid definition.
 * The raw definition text is HTML-entity-encoded and wrapped in a <pre>
 * element so the report always shows the flow content even when no
 * client-side Mermaid renderer is available.
 */
export function generateMermaidSvgString(definition: string): string {
  const body = definition?.trim() ?? '';
  if (!body) return '';
  return `<pre class="mermaid-source">${escapeHtml(body)}</pre>`;
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

  const description = `Behavioral crawl report for ${escapeAttribute(input.targetUrl)}`;
  const toolVersion = input.toolVersion
    ? escapeHtml(input.toolVersion)
    : '';

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  ${CSP_META}
  <meta name="description" content="${description}">
  <meta name="generator" content="playwright-archaeologist">
  <link rel="icon" type="image/svg+xml" href="${FAVICON_DATA_URI}">
  <title>${reportTitle}</title>
  <style>${generateCss()}</style>
</head>
<body>
  ${renderNavigation(input)}

  <main class="container">
    <header class="report-header">
      <h1>${reportTitle}</h1>
      ${renderStatsBar(input)}
    </header>

    <div class="search-bar">
      <label for="report-search" class="visually-hidden">Search</label>
      <input type="text" id="report-search" placeholder="Filter pages, forms, endpoints..." aria-label="Search report">
      <div role="status" aria-live="polite" id="search-count"></div>
    </div>

    ${renderSitemapSection(pages)}
    ${renderFormsSection(input.forms)}
    ${renderApiSection(input.apiEndpoints)}
    ${hasScreenshots ? renderScreenshotsSection(screenshots, input.outputDir) : ''}
    ${hasFlow ? renderFlowSection(input.flowDiagramSvg!) : ''}
    ${input.accessibility ? renderAccessibilitySection(input.accessibility) : ''}

    <footer class="report-footer">
      Generated by playwright-archaeologist${toolVersion ? ` v${toolVersion}` : ''}
    </footer>
  </main>

  <script>${generateJs(hasScreenshots)}</script>
</body>
</html>`;
}

// Silence unused-import warning when the helper is only used indirectly.
void escapeJsonInHtml;
