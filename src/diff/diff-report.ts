/**
 * Diff Report Generator
 *
 * Generates a self-contained HTML report showing all changes between
 * two crawl bundles. Color-coded: green for added, red for removed,
 * yellow for modified.
 *
 * Uses the same CSP and escaping as the main report.
 */

import {
  escapeHtml,
  escapeAttribute,
  redactAbsolutePath,
  sanitizeUrl,
} from '../report/html/escape.js';
import { CSS_TOKENS, FAVICON_DATA_URI, hashSlug, patternSlug } from '../report/html/tokens.js';
import type {
  DiffResult,
  SitemapRouteChange,
} from '../types/artifacts.js';

// ---------------------------------------------------------------------------
// CSP header (matches main report)
// ---------------------------------------------------------------------------

// `script-src 'unsafe-inline'` is kept for now because the diff report is a
// single self-contained HTML file with no external scripts. Tightening this
// further (external JS with SRI) is Wave 2 hardening. Every other XSS
// primitive is closed: all user data is HTML-entity-encoded via escape.ts
// and this report emits no hrefs with attacker-controlled protocols.
//
// `img-src 'self'` permits loading pixel-diff heatmap PNGs that sit in the
// same directory as the diff report. The diff engine writes these files to
// the user-provided `heatmapDir`; only bundle-local filenames are rendered
// in `<img src>` attributes.
const CSP_META = `<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; img-src 'self' data: blob:;">`;

// ---------------------------------------------------------------------------
// CSS styles
// ---------------------------------------------------------------------------

const STYLES = `
  ${CSS_TOKENS}

  * { margin: 0; padding: 0; box-sizing: border-box; }

  body {
    font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
    line-height: 1.6;
    color: var(--text);
    background: var(--bg);
    padding: 2rem;
    max-width: min(1600px, 95vw);
    margin: 0 auto;
  }
  h1 { font-size: 1.8rem; margin-bottom: 0.5rem; }
  h2 { font-size: 1.4rem; margin: 2rem 0 1rem; border-bottom: 2px solid var(--border-light); padding-bottom: 0.5rem; }
  h3 { font-size: 1.1rem; margin: 1rem 0 0.5rem; }
  .meta { color: var(--text-muted); font-size: 0.9rem; margin-bottom: 2rem; }

  .summary {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(200px, 1fr));
    gap: 1rem;
    margin-bottom: 2rem;
  }
  .summary-card {
    background: var(--bg-surface);
    border: 1px solid var(--border-light);
    border-radius: var(--radius);
    padding: 1rem;
    box-shadow: var(--shadow);
  }
  .summary-card h3 { margin: 0 0 0.5rem; font-size: 1rem; }
  .summary-card .count { font-size: 2rem; font-weight: bold; }
  .summary-card .net-delta {
    font-size: 0.8rem;
    color: var(--text-muted);
    margin-top: 0.25rem;
    font-family: 'SF Mono', SFMono-Regular, Consolas, 'Liberation Mono', Menlo, monospace;
  }

  .no-changes {
    background: var(--no-changes-bg);
    color: var(--no-changes-fg);
    padding: 1rem;
    border-radius: var(--radius);
    text-align: center;
    font-size: 1.2rem;
  }

  .badge {
    display: inline-block;
    padding: 2px 8px;
    border-radius: 4px;
    font-size: 0.75rem;
    font-weight: 600;
    text-transform: uppercase;
  }
  .badge-added { background: var(--badge-added-bg); color: var(--badge-added-fg); }
  .badge-removed { background: var(--badge-removed-bg); color: var(--badge-removed-fg); }
  .badge-changed { background: var(--badge-changed-bg); color: var(--badge-changed-fg); }
  .badge-unchanged { background: var(--badge-unchanged-bg); color: var(--badge-unchanged-fg); }

  /* Change-type filter chips */
  .chip-bar {
    display: flex;
    flex-wrap: wrap;
    gap: 0.5rem;
    margin-bottom: 1.5rem;
  }
  .chip {
    background: var(--bg-surface);
    border: 1px solid var(--border);
    color: var(--text);
    padding: 0.4rem 0.9rem;
    border-radius: 999px;
    font-size: 0.85rem;
    cursor: pointer;
    font-weight: 500;
    min-height: 36px;
  }
  .chip[aria-pressed="true"] {
    background: var(--accent);
    color: #fff;
    border-color: var(--accent);
  }
  .chip:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }

  table {
    width: 100%;
    border-collapse: collapse;
    margin: 1rem 0;
    background: var(--bg-surface);
    border-radius: var(--radius);
    overflow: hidden;
    box-shadow: var(--shadow);
  }
  th, td {
    padding: 0.75rem 1rem;
    text-align: left;
    border-bottom: 1px solid var(--border-light);
  }
  th {
    background: var(--bg-surface-hover);
    font-weight: 600;
    font-size: 0.85rem;
    text-transform: uppercase;
    color: var(--text-muted);
  }
  tr:last-child td { border-bottom: none; }

  .change-detail { font-size: 0.85rem; color: var(--text-muted); }
  .old-value { color: var(--status-5xx); text-decoration: line-through; }
  .new-value { color: var(--status-2xx); font-weight: 500; }

  .section { margin-bottom: 2rem; }
  .section-block[hidden] { display: none; }
  .empty-section { color: var(--text-muted); font-style: italic; padding: 1rem; }

  ul.change-list { list-style: none; padding: 0; }
  ul.change-list li { padding: 0.5rem 0; border-bottom: 1px solid var(--border-light); }
  ul.change-list li:last-child { border-bottom: none; }

  a.back-link {
    color: var(--accent);
    text-decoration: none;
    font-size: 0.8rem;
    margin-left: 0.5rem;
  }
  a.back-link:hover,
  a.back-link:focus-visible { text-decoration: underline; }

  footer.report-footer {
    margin-top: 3rem;
    padding: 1rem 0;
    border-top: 1px solid var(--border-light);
    color: var(--text-muted);
    font-size: 0.8rem;
    text-align: center;
  }

  .visually-hidden {
    position: absolute !important;
    width: 1px !important;
    height: 1px !important;
    overflow: hidden !important;
    clip: rect(0,0,0,0) !important;
    white-space: nowrap !important;
    border: 0 !important;
  }

  .heatmap-thumb {
    max-width: 120px;
    max-height: 80px;
    border: 1px solid var(--border-light);
    border-radius: 3px;
    background: var(--bg-surface);
    display: block;
  }
`;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function badge(type: 'added' | 'removed' | 'changed' | 'unchanged'): string {
  return `<span class="badge badge-${type}">${type}</span>`;
}

function summaryCard(
  title: string,
  counts: { added: number; removed: number; changed: number; unchanged: number },
): string {
  const total = counts.added + counts.removed + counts.changed;
  const net = counts.added - counts.removed;
  const netSign = net >= 0 ? '+' : '';
  return `
    <div class="summary-card">
      <h3>${escapeHtml(title)}</h3>
      <div class="count">${total}</div>
      <div class="change-detail">
        ${counts.added > 0 ? `${badge('added')} ${counts.added}` : ''}
        ${counts.removed > 0 ? `${badge('removed')} ${counts.removed}` : ''}
        ${counts.changed > 0 ? `${badge('changed')} ${counts.changed}` : ''}
        ${counts.unchanged > 0 ? `${badge('unchanged')} ${counts.unchanged}` : ''}
      </div>
      <div class="net-delta">+${counts.added} / -${counts.removed} / ~${counts.changed} &rarr; net ${netSign}${net}</div>
    </div>`;
}

/**
 * Pick a safe URL to link to, or return `''` to indicate "no link".
 * Falls back to empty string for anything that is not http/https.
 */
function safeReportLink(reportUrl: string | undefined, fragment?: string): string {
  if (!reportUrl) return '';
  const safe = sanitizeUrl(reportUrl);
  if (safe === '#') return '';
  return fragment ? `${safe}${fragment}` : safe;
}

/**
 * Order for rendering route changes: statusCode changes first (most impactful),
 * then contentHash, then title-only. Exported for unit testing.
 */
export function sortRouteChanges(
  changes: SitemapRouteChange[],
): SitemapRouteChange[] {
  const score = (c: SitemapRouteChange): number => {
    if (c.changes.statusCode) return 0;
    if (c.changes.contentHash) return 1;
    if (c.changes.title) return 2;
    return 3;
  };
  return [...changes].sort((a, b) => score(a) - score(b));
}

function routeRowId(url: string): string {
  return `route-${hashSlug(url)}`;
}

function apiRowId(method: string, pattern: string): string {
  const slug = patternSlug(pattern) || hashSlug(pattern);
  return `api-${method.toLowerCase()}-${slug}`;
}

function formRowId(idx: number): string {
  return `form-${idx}`;
}

// ---------------------------------------------------------------------------
// Section renderers
// ---------------------------------------------------------------------------

interface RenderContext {
  oldReport?: string;
  newReport?: string;
}

function renderRoutesSection(diff: DiffResult, ctx: RenderContext): string {
  const { sitemap } = diff;
  const hasContent =
    sitemap.added.length + sitemap.removed.length + sitemap.changed.length > 0;

  if (!hasContent) {
    return `
      <div class="section" id="section-routes">
        <h2>Routes</h2>
        <p class="empty-section">No route changes detected.</p>
      </div>`;
  }

  let html = `<div class="section" id="section-routes"><h2>Routes</h2>`;

  if (sitemap.added.length > 0) {
    html += `<div class="section-block" data-type="added">`;
    html += `<h3>${badge('added')} Added Routes (${sitemap.added.length})</h3>`;
    html += `<table><thead><tr><th>URL</th><th>Title</th><th>Status</th></tr></thead><tbody>`;
    for (const route of sitemap.added) {
      const id = routeRowId(route.url);
      const link = safeReportLink(ctx.newReport, `#${id}`);
      const backLink = link
        ? ` <a class="back-link" href="${escapeAttribute(link)}">View in new bundle &rarr;</a>`
        : '';
      html += `<tr id="${id}"><td>${escapeHtml(route.url)}${backLink}</td><td>${escapeHtml(route.title)}</td><td>${route.statusCode}</td></tr>`;
    }
    html += `</tbody></table></div>`;
  }

  if (sitemap.removed.length > 0) {
    html += `<div class="section-block" data-type="removed">`;
    html += `<h3>${badge('removed')} Removed Routes (${sitemap.removed.length})</h3>`;
    html += `<table><thead><tr><th>URL</th><th>Title</th><th>Status</th></tr></thead><tbody>`;
    for (const route of sitemap.removed) {
      const id = routeRowId(route.url);
      const link = safeReportLink(ctx.oldReport, `#${id}`);
      const backLink = link
        ? ` <a class="back-link" href="${escapeAttribute(link)}">View in old bundle &rarr;</a>`
        : '';
      html += `<tr id="${id}"><td>${escapeHtml(route.url)}${backLink}</td><td>${escapeHtml(route.title)}</td><td>${route.statusCode}</td></tr>`;
    }
    html += `</tbody></table></div>`;
  }

  if (sitemap.changed.length > 0) {
    const sorted = sortRouteChanges(sitemap.changed);
    html += `<div class="section-block" data-type="changed">`;
    html += `<h3>${badge('changed')} Modified Routes (${sorted.length})</h3>`;
    html += `<table><thead><tr><th>URL</th><th>Changes</th></tr></thead><tbody>`;
    for (const change of sorted) {
      const changeDescs: string[] = [];
      if (change.changes.title) {
        changeDescs.push(
          `Title: <span class="old-value">${escapeHtml(change.changes.title.old)}</span> &rarr; <span class="new-value">${escapeHtml(change.changes.title.new)}</span>`,
        );
      }
      if (change.changes.statusCode) {
        changeDescs.push(
          `Status: <span class="old-value">${change.changes.statusCode.old}</span> &rarr; <span class="new-value">${change.changes.statusCode.new}</span>`,
        );
      }
      if (change.changes.contentHash) {
        changeDescs.push(`Content changed (hash differs)`);
      }
      const id = routeRowId(change.url);
      const newLink = safeReportLink(ctx.newReport, `#${id}`);
      const oldLink = safeReportLink(ctx.oldReport, `#${id}`);
      const backLinks =
        (newLink ? ` <a class="back-link" href="${escapeAttribute(newLink)}">new &rarr;</a>` : '') +
        (oldLink ? ` <a class="back-link" href="${escapeAttribute(oldLink)}">old &rarr;</a>` : '');
      html += `<tr id="${id}"><td>${escapeHtml(change.url)}${backLinks}</td><td class="change-detail">${changeDescs.join('<br>')}</td></tr>`;
    }
    html += `</tbody></table></div>`;
  }

  html += `</div>`;
  return html;
}

function renderFormsSection(diff: DiffResult, ctx: RenderContext): string {
  const { forms } = diff;
  const hasContent =
    forms.added.length + forms.removed.length + forms.changed.length > 0;

  if (!hasContent) {
    return `
      <div class="section" id="section-forms">
        <h2>Forms</h2>
        <p class="empty-section">No form changes detected.</p>
      </div>`;
  }

  let html = `<div class="section" id="section-forms"><h2>Forms</h2>`;

  if (forms.added.length > 0) {
    html += `<div class="section-block" data-type="added">`;
    html += `<h3>${badge('added')} Added Forms (${forms.added.length})</h3>`;
    html += `<table><thead><tr><th>Action</th><th>Method</th><th>Fields</th></tr></thead><tbody>`;
    forms.added.forEach((form, i) => {
      const fieldNames = form.fields.map((f) => escapeHtml(f.name)).join(', ');
      const id = formRowId(i);
      const link = safeReportLink(ctx.newReport, `#${id}`);
      const backLink = link
        ? ` <a class="back-link" href="${escapeAttribute(link)}">View &rarr;</a>`
        : '';
      html += `<tr id="added-${id}"><td>${escapeHtml(form.action)}${backLink}</td><td>${escapeHtml(form.method)}</td><td>${fieldNames}</td></tr>`;
    });
    html += `</tbody></table></div>`;
  }

  if (forms.removed.length > 0) {
    html += `<div class="section-block" data-type="removed">`;
    html += `<h3>${badge('removed')} Removed Forms (${forms.removed.length})</h3>`;
    html += `<table><thead><tr><th>Action</th><th>Method</th><th>Fields</th></tr></thead><tbody>`;
    forms.removed.forEach((form, i) => {
      const fieldNames = form.fields.map((f) => escapeHtml(f.name)).join(', ');
      const id = formRowId(i);
      const link = safeReportLink(ctx.oldReport, `#${id}`);
      const backLink = link
        ? ` <a class="back-link" href="${escapeAttribute(link)}">View &rarr;</a>`
        : '';
      html += `<tr id="removed-${id}"><td>${escapeHtml(form.action)}${backLink}</td><td>${escapeHtml(form.method)}</td><td>${fieldNames}</td></tr>`;
    });
    html += `</tbody></table></div>`;
  }

  if (forms.changed.length > 0) {
    html += `<div class="section-block" data-type="changed">`;
    html += `<h3>${badge('changed')} Modified Forms (${forms.changed.length})</h3>`;
    html += `<ul class="change-list">`;
    for (const change of forms.changed) {
      html += `<li><strong>${escapeHtml(change.formId)}</strong>`;
      const descs: string[] = [];
      if (change.changes.fieldsAdded?.length) {
        descs.push(`Fields added: ${change.changes.fieldsAdded.map((f) => escapeHtml(f.name)).join(', ')}`);
      }
      if (change.changes.fieldsRemoved?.length) {
        descs.push(`Fields removed: ${change.changes.fieldsRemoved.map((f) => escapeHtml(f.name)).join(', ')}`);
      }
      if (change.changes.actionChanged) {
        descs.push(`Action: <span class="old-value">${escapeHtml(change.changes.actionChanged.old)}</span> &rarr; <span class="new-value">${escapeHtml(change.changes.actionChanged.new)}</span>`);
      }
      if (change.changes.methodChanged) {
        descs.push(`Method: <span class="old-value">${escapeHtml(change.changes.methodChanged.old)}</span> &rarr; <span class="new-value">${escapeHtml(change.changes.methodChanged.new)}</span>`);
      }
      html += `<div class="change-detail">${descs.join('<br>')}</div></li>`;
    }
    html += `</ul></div>`;
  }

  html += `</div>`;
  return html;
}

function renderApiSection(diff: DiffResult, ctx: RenderContext): string {
  const { api } = diff;
  const hasContent =
    api.added.length + api.removed.length + api.changed.length > 0;

  if (!hasContent) {
    return `
      <div class="section" id="section-api">
        <h2>API Endpoints</h2>
        <p class="empty-section">No API endpoint changes detected.</p>
      </div>`;
  }

  let html = `<div class="section" id="section-api"><h2>API Endpoints</h2>`;

  if (api.added.length > 0) {
    html += `<div class="section-block" data-type="added">`;
    html += `<h3>${badge('added')} Added Endpoints (${api.added.length})</h3>`;
    html += `<table><thead><tr><th>Method</th><th>Pattern</th><th>Status Codes</th></tr></thead><tbody>`;
    for (const ep of api.added) {
      const id = apiRowId(ep.method, ep.pattern);
      const link = safeReportLink(ctx.newReport, `#${id}`);
      const backLink = link
        ? ` <a class="back-link" href="${escapeAttribute(link)}">View &rarr;</a>`
        : '';
      html += `<tr id="added-${id}"><td>${escapeHtml(ep.method)}</td><td>${escapeHtml(ep.pattern)}${backLink}</td><td>${ep.observedStatusCodes.join(', ')}</td></tr>`;
    }
    html += `</tbody></table></div>`;
  }

  if (api.removed.length > 0) {
    html += `<div class="section-block" data-type="removed">`;
    html += `<h3>${badge('removed')} Removed Endpoints (${api.removed.length})</h3>`;
    html += `<table><thead><tr><th>Method</th><th>Pattern</th><th>Status Codes</th></tr></thead><tbody>`;
    for (const ep of api.removed) {
      const id = apiRowId(ep.method, ep.pattern);
      const link = safeReportLink(ctx.oldReport, `#${id}`);
      const backLink = link
        ? ` <a class="back-link" href="${escapeAttribute(link)}">View &rarr;</a>`
        : '';
      html += `<tr id="removed-${id}"><td>${escapeHtml(ep.method)}</td><td>${escapeHtml(ep.pattern)}${backLink}</td><td>${ep.observedStatusCodes.join(', ')}</td></tr>`;
    }
    html += `</tbody></table></div>`;
  }

  if (api.changed.length > 0) {
    html += `<div class="section-block" data-type="changed">`;
    html += `<h3>${badge('changed')} Modified Endpoints (${api.changed.length})</h3>`;
    html += `<ul class="change-list">`;
    for (const change of api.changed) {
      html += `<li><strong>${escapeHtml(change.endpointId)}</strong>`;
      const descs: string[] = [];
      if (change.changes.statusCodesAdded?.length) {
        descs.push(`New status codes: ${change.changes.statusCodesAdded.join(', ')}`);
      }
      if (change.changes.statusCodesRemoved?.length) {
        descs.push(`Removed status codes: ${change.changes.statusCodesRemoved.join(', ')}`);
      }
      if (change.changes.contentTypeChanged) {
        descs.push(`Content-Type: <span class="old-value">${escapeHtml(change.changes.contentTypeChanged.old)}</span> &rarr; <span class="new-value">${escapeHtml(change.changes.contentTypeChanged.new)}</span>`);
      }
      if (change.changes.bodySizeChange) {
        descs.push(`Body size: ${change.changes.bodySizeChange.old}B &rarr; ${change.changes.bodySizeChange.new}B (${change.changes.bodySizeChange.percentChange}%)`);
      }
      html += `<div class="change-detail">${descs.join('<br>')}</div></li>`;
    }
    html += `</ul></div>`;
  }

  html += `</div>`;
  return html;
}

function renderScreenshotsSection(diff: DiffResult): string {
  const { screenshots } = diff;
  const hasContent =
    screenshots.added.length + screenshots.removed.length + screenshots.changed.length > 0;

  if (!hasContent) {
    return `
      <div class="section" id="section-screenshots">
        <h2>Screenshots</h2>
        <p class="empty-section">No screenshot changes detected.</p>
      </div>`;
  }

  let html = `<div class="section" id="section-screenshots"><h2>Screenshots</h2>`;

  if (screenshots.added.length > 0) {
    html += `<div class="section-block" data-type="added">`;
    html += `<h3>${badge('added')} New Screenshots (${screenshots.added.length})</h3>`;
    html += `<table><thead><tr><th>URL</th></tr></thead><tbody>`;
    for (const ss of screenshots.added) {
      html += `<tr><td>${escapeHtml(ss.url)}</td></tr>`;
    }
    html += `</tbody></table></div>`;
  }

  if (screenshots.removed.length > 0) {
    html += `<div class="section-block" data-type="removed">`;
    html += `<h3>${badge('removed')} Removed Screenshots (${screenshots.removed.length})</h3>`;
    html += `<table><thead><tr><th>URL</th></tr></thead><tbody>`;
    for (const ss of screenshots.removed) {
      html += `<tr><td>${escapeHtml(ss.url)}</td></tr>`;
    }
    html += `</tbody></table></div>`;
  }

  if (screenshots.changed.length > 0) {
    html += `<div class="section-block" data-type="changed">`;
    html += `<h3>${badge('changed')} Changed Screenshots (${screenshots.changed.length})</h3>`;
    html += `<table><thead><tr><th>URL</th><th>Diff</th><th>Heatmap</th></tr></thead><tbody>`;
    for (const ss of screenshots.changed) {
      // Pixel-diff path exposes a numeric percentage; hash-only fallback
      // uses the legacy "100% changed" label. If the diff engine could
      // not run (dimension mismatch etc.), diffUnavailableReason is set.
      const pctCell = ss.diffUnavailableReason
        ? `<span class="change-detail">${escapeHtml(ss.diffUnavailableReason)}</span>`
        : `${ss.diffPercentage}% changed`;
      const heatmapCell = ss.heatmapPath
        ? `<a href="${escapeAttribute(sanitizeUrl(ss.heatmapPath) === '#'
            ? ss.heatmapPath
            : ss.heatmapPath)}"><img class="heatmap-thumb" src="${escapeAttribute(ss.heatmapPath)}" alt="Pixel diff heatmap for ${escapeAttribute(ss.url)}" loading="lazy"></a>`
        : `<span class="change-detail">(no heatmap)</span>`;
      html += `<tr><td>${escapeHtml(ss.url)}</td><td>${pctCell}</td><td>${heatmapCell}</td></tr>`;
    }
    html += `</tbody></table></div>`;
  }

  html += `</div>`;
  return html;
}

// ---------------------------------------------------------------------------
// Inline JS: chip-bar filter + theme toggle
// ---------------------------------------------------------------------------

const DIFF_JS = `
  (function() {
    // Theme toggle (same contract as main report).
    var THEME_KEY = 'pa-theme';
    var toggle = document.getElementById('theme-toggle');
    function applyTheme(t) {
      if (t === 'light' || t === 'dark') document.documentElement.setAttribute('data-theme', t);
      else document.documentElement.removeAttribute('data-theme');
    }
    var saved = 'auto';
    try { saved = localStorage.getItem(THEME_KEY) || 'auto'; } catch (e) {}
    applyTheme(saved);
    if (toggle) {
      function label(t) { return t === 'light' ? 'Theme: Light' : t === 'dark' ? 'Theme: Dark' : 'Theme: Auto'; }
      toggle.textContent = label(saved);
      toggle.addEventListener('click', function() {
        saved = saved === 'auto' ? 'light' : saved === 'light' ? 'dark' : 'auto';
        try { localStorage.setItem(THEME_KEY, saved); } catch (e) {}
        applyTheme(saved);
        toggle.textContent = label(saved);
      });
    }

    // Chip filter — toggles visibility of .section-block[data-type=...]
    var chips = document.querySelectorAll('.chip[data-filter]');
    var active = 'all';
    function apply() {
      var blocks = document.querySelectorAll('.section-block[data-type]');
      for (var i = 0; i < blocks.length; i++) {
        var t = blocks[i].getAttribute('data-type');
        if (active === 'all' || active === t) {
          blocks[i].removeAttribute('hidden');
        } else {
          blocks[i].setAttribute('hidden', '');
        }
      }
    }
    for (var c = 0; c < chips.length; c++) {
      (function(chip) {
        chip.addEventListener('click', function() {
          active = chip.getAttribute('data-filter') || 'all';
          for (var j = 0; j < chips.length; j++) {
            chips[j].setAttribute('aria-pressed', chips[j] === chip ? 'true' : 'false');
          }
          apply();
        });
      })(chips[c]);
    }
  })();
`;

// ---------------------------------------------------------------------------
// Main export
// ---------------------------------------------------------------------------

/**
 * Generate a self-contained HTML diff report.
 */
export function generateDiffReportHtml(diff: DiffResult): string {
  const { meta, summary, hasChanges } = diff;

  const ctx: RenderContext = {
    oldReport: meta.oldBundle.reportUrl,
    newReport: meta.newBundle.reportUrl,
  };

  const summarySection = `
    <div class="summary">
      ${summaryCard('Routes', summary.routes)}
      ${summaryCard('Forms', summary.forms)}
      ${summaryCard('API Endpoints', summary.api)}
      ${summaryCard('Screenshots', summary.screenshots)}
    </div>`;

  const chipBar = `
    <div class="chip-bar" role="group" aria-label="Filter by change type">
      <button class="chip" type="button" data-filter="all" aria-pressed="true">All</button>
      <button class="chip" type="button" data-filter="added" aria-pressed="false">Added</button>
      <button class="chip" type="button" data-filter="removed" aria-pressed="false">Removed</button>
      <button class="chip" type="button" data-filter="changed" aria-pressed="false">Changed</button>
    </div>`;

  const noChangesNotice = !hasChanges
    ? `<div class="no-changes">No changes detected between bundles.</div>`
    : '';

  // Redact any absolute filesystem path before rendering. The bundle `path`
  // field may contain `/home/runner/...` or `C:\Users\...` which we don't
  // want to leak when the report is shared.
  const oldLabel = meta.oldBundle.targetUrl || redactAbsolutePath(meta.oldBundle.path);
  const newLabel = meta.newBundle.targetUrl || redactAbsolutePath(meta.newBundle.path);

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  ${CSP_META}
  <meta name="description" content="Regression diff report between two crawl bundles">
  <meta name="generator" content="playwright-archaeologist">
  <link rel="icon" type="image/svg+xml" href="${FAVICON_DATA_URI}">
  <title>Diff Report &mdash; playwright-archaeologist</title>
  <style>${STYLES}</style>
</head>
<body>
  <header>
    <div style="display:flex;align-items:center;gap:1rem;justify-content:space-between;flex-wrap:wrap;">
      <h1>Regression Diff Report</h1>
      <button id="theme-toggle" type="button" class="chip" aria-label="Toggle theme">Theme: Auto</button>
    </div>
    <div class="meta">
      <p>Old bundle: ${escapeHtml(oldLabel)} (${escapeHtml(meta.oldBundle.createdAt)})</p>
      <p>New bundle: ${escapeHtml(newLabel)} (${escapeHtml(meta.newBundle.createdAt)})</p>
      <p>Compared at: ${escapeHtml(meta.comparedAt)}</p>
    </div>
  </header>

  <main>
    ${summarySection}
    ${chipBar}
    ${noChangesNotice}

    ${renderRoutesSection(diff, ctx)}
    ${renderFormsSection(diff, ctx)}
    ${renderApiSection(diff, ctx)}
    ${renderScreenshotsSection(diff)}
  </main>

  <footer class="report-footer">
    Generated by playwright-archaeologist
  </footer>

  <script>${DIFF_JS}</script>
</body>
</html>`;
}
