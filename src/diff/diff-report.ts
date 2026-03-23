/**
 * Diff Report Generator
 *
 * Generates a self-contained HTML report showing all changes between
 * two crawl bundles. Color-coded: green for added, red for removed,
 * yellow for modified.
 *
 * Uses the same CSP and escaping as the main report.
 */

import { escapeHtml, escapeAttribute } from '../report/html/escape.js';
import type {
  DiffResult,
  DiffSummary,
  SitemapRouteChange,
  FormChange,
  ApiEndpointChange,
  ScreenshotChange,
  RouteInfo,
  FormInfo,
  ApiEndpointGroup,
} from '../types/artifacts.js';

// ---------------------------------------------------------------------------
// CSP header (matches main report)
// ---------------------------------------------------------------------------

const CSP_META = `<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; img-src data: blob:;">`;

// ---------------------------------------------------------------------------
// CSS styles
// ---------------------------------------------------------------------------

const STYLES = `
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; line-height: 1.6; color: #1a1a2e; background: #f8f9fa; padding: 2rem; max-width: 1200px; margin: 0 auto; }
  h1 { font-size: 1.8rem; margin-bottom: 0.5rem; }
  h2 { font-size: 1.4rem; margin: 2rem 0 1rem; border-bottom: 2px solid #e0e0e0; padding-bottom: 0.5rem; }
  h3 { font-size: 1.1rem; margin: 1rem 0 0.5rem; }
  .meta { color: #666; font-size: 0.9rem; margin-bottom: 2rem; }
  .summary { display: grid; grid-template-columns: repeat(auto-fit, minmax(200px, 1fr)); gap: 1rem; margin-bottom: 2rem; }
  .summary-card { background: #fff; border-radius: 8px; padding: 1rem; box-shadow: 0 1px 3px rgba(0,0,0,0.1); }
  .summary-card h3 { margin: 0 0 0.5rem; font-size: 1rem; }
  .summary-card .count { font-size: 2rem; font-weight: bold; }
  .no-changes { background: #d4edda; color: #155724; padding: 1rem; border-radius: 8px; text-align: center; font-size: 1.2rem; }
  .badge { display: inline-block; padding: 2px 8px; border-radius: 4px; font-size: 0.75rem; font-weight: 600; text-transform: uppercase; }
  .badge-added { background: #d4edda; color: #155724; }
  .badge-removed { background: #f8d7da; color: #721c24; }
  .badge-changed { background: #fff3cd; color: #856404; }
  .badge-unchanged { background: #e2e3e5; color: #383d41; }
  table { width: 100%; border-collapse: collapse; margin: 1rem 0; background: #fff; border-radius: 8px; overflow: hidden; box-shadow: 0 1px 3px rgba(0,0,0,0.1); }
  th, td { padding: 0.75rem 1rem; text-align: left; border-bottom: 1px solid #e0e0e0; }
  th { background: #f1f3f5; font-weight: 600; font-size: 0.85rem; text-transform: uppercase; color: #495057; }
  tr:last-child td { border-bottom: none; }
  .change-detail { font-size: 0.85rem; color: #495057; }
  .old-value { color: #721c24; text-decoration: line-through; }
  .new-value { color: #155724; font-weight: 500; }
  .section { margin-bottom: 2rem; }
  .empty-section { color: #6c757d; font-style: italic; padding: 1rem; }
  ul.change-list { list-style: none; padding: 0; }
  ul.change-list li { padding: 0.5rem 0; border-bottom: 1px solid #f0f0f0; }
  ul.change-list li:last-child { border-bottom: none; }

  @media (prefers-color-scheme: dark) {
    body { color: #c9d1d9; background: #0d1117; }
    h2 { border-bottom-color: #30363d; }
    .meta { color: #8b949e; }
    .summary-card { background: #161b22; box-shadow: 0 1px 3px rgba(0,0,0,0.3); }
    .no-changes { background: #1b3a2d; color: #7ee787; }
    .badge-added { background: #1b3a2d; color: #7ee787; }
    .badge-removed { background: #3d1f28; color: #f85149; }
    .badge-changed { background: #3d2e00; color: #d29922; }
    .badge-unchanged { background: #21262d; color: #8b949e; }
    table { background: #161b22; box-shadow: 0 1px 3px rgba(0,0,0,0.3); }
    th, td { border-bottom-color: #30363d; }
    th { background: #21262d; color: #8b949e; }
    .change-detail { color: #8b949e; }
    .old-value { color: #f85149; }
    .new-value { color: #7ee787; }
    .empty-section { color: #8b949e; }
    ul.change-list li { border-bottom-color: #21262d; }
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
    </div>`;
}

// ---------------------------------------------------------------------------
// Section renderers
// ---------------------------------------------------------------------------

function renderRoutesSection(diff: DiffResult): string {
  const { sitemap } = diff;
  const hasContent =
    sitemap.added.length + sitemap.removed.length + sitemap.changed.length > 0;

  if (!hasContent) {
    return `
      <div class="section">
        <h2>Routes</h2>
        <p class="empty-section">No route changes detected.</p>
      </div>`;
  }

  let html = `<div class="section"><h2>Routes</h2>`;

  if (sitemap.added.length > 0) {
    html += `<h3>${badge('added')} Added Routes (${sitemap.added.length})</h3>`;
    html += `<table><thead><tr><th>URL</th><th>Title</th><th>Status</th></tr></thead><tbody>`;
    for (const route of sitemap.added) {
      html += `<tr><td>${escapeHtml(route.url)}</td><td>${escapeHtml(route.title)}</td><td>${route.statusCode}</td></tr>`;
    }
    html += `</tbody></table>`;
  }

  if (sitemap.removed.length > 0) {
    html += `<h3>${badge('removed')} Removed Routes (${sitemap.removed.length})</h3>`;
    html += `<table><thead><tr><th>URL</th><th>Title</th><th>Status</th></tr></thead><tbody>`;
    for (const route of sitemap.removed) {
      html += `<tr><td>${escapeHtml(route.url)}</td><td>${escapeHtml(route.title)}</td><td>${route.statusCode}</td></tr>`;
    }
    html += `</tbody></table>`;
  }

  if (sitemap.changed.length > 0) {
    html += `<h3>${badge('changed')} Modified Routes (${sitemap.changed.length})</h3>`;
    html += `<table><thead><tr><th>URL</th><th>Changes</th></tr></thead><tbody>`;
    for (const change of sitemap.changed) {
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
      html += `<tr><td>${escapeHtml(change.url)}</td><td class="change-detail">${changeDescs.join('<br>')}</td></tr>`;
    }
    html += `</tbody></table>`;
  }

  html += `</div>`;
  return html;
}

function renderFormsSection(diff: DiffResult): string {
  const { forms } = diff;
  const hasContent =
    forms.added.length + forms.removed.length + forms.changed.length > 0;

  if (!hasContent) {
    return `
      <div class="section">
        <h2>Forms</h2>
        <p class="empty-section">No form changes detected.</p>
      </div>`;
  }

  let html = `<div class="section"><h2>Forms</h2>`;

  if (forms.added.length > 0) {
    html += `<h3>${badge('added')} Added Forms (${forms.added.length})</h3>`;
    html += `<table><thead><tr><th>Action</th><th>Method</th><th>Fields</th></tr></thead><tbody>`;
    for (const form of forms.added) {
      const fieldNames = form.fields.map((f) => escapeHtml(f.name)).join(', ');
      html += `<tr><td>${escapeHtml(form.action)}</td><td>${escapeHtml(form.method)}</td><td>${fieldNames}</td></tr>`;
    }
    html += `</tbody></table>`;
  }

  if (forms.removed.length > 0) {
    html += `<h3>${badge('removed')} Removed Forms (${forms.removed.length})</h3>`;
    html += `<table><thead><tr><th>Action</th><th>Method</th><th>Fields</th></tr></thead><tbody>`;
    for (const form of forms.removed) {
      const fieldNames = form.fields.map((f) => escapeHtml(f.name)).join(', ');
      html += `<tr><td>${escapeHtml(form.action)}</td><td>${escapeHtml(form.method)}</td><td>${fieldNames}</td></tr>`;
    }
    html += `</tbody></table>`;
  }

  if (forms.changed.length > 0) {
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
    html += `</ul>`;
  }

  html += `</div>`;
  return html;
}

function renderApiSection(diff: DiffResult): string {
  const { api } = diff;
  const hasContent =
    api.added.length + api.removed.length + api.changed.length > 0;

  if (!hasContent) {
    return `
      <div class="section">
        <h2>API Endpoints</h2>
        <p class="empty-section">No API endpoint changes detected.</p>
      </div>`;
  }

  let html = `<div class="section"><h2>API Endpoints</h2>`;

  if (api.added.length > 0) {
    html += `<h3>${badge('added')} Added Endpoints (${api.added.length})</h3>`;
    html += `<table><thead><tr><th>Method</th><th>Pattern</th><th>Status Codes</th></tr></thead><tbody>`;
    for (const ep of api.added) {
      html += `<tr><td>${escapeHtml(ep.method)}</td><td>${escapeHtml(ep.pattern)}</td><td>${ep.observedStatusCodes.join(', ')}</td></tr>`;
    }
    html += `</tbody></table>`;
  }

  if (api.removed.length > 0) {
    html += `<h3>${badge('removed')} Removed Endpoints (${api.removed.length})</h3>`;
    html += `<table><thead><tr><th>Method</th><th>Pattern</th><th>Status Codes</th></tr></thead><tbody>`;
    for (const ep of api.removed) {
      html += `<tr><td>${escapeHtml(ep.method)}</td><td>${escapeHtml(ep.pattern)}</td><td>${ep.observedStatusCodes.join(', ')}</td></tr>`;
    }
    html += `</tbody></table>`;
  }

  if (api.changed.length > 0) {
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
    html += `</ul>`;
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
      <div class="section">
        <h2>Screenshots</h2>
        <p class="empty-section">No screenshot changes detected.</p>
      </div>`;
  }

  let html = `<div class="section"><h2>Screenshots</h2>`;

  if (screenshots.added.length > 0) {
    html += `<h3>${badge('added')} New Screenshots (${screenshots.added.length})</h3>`;
    html += `<table><thead><tr><th>URL</th></tr></thead><tbody>`;
    for (const ss of screenshots.added) {
      html += `<tr><td>${escapeHtml(ss.url)}</td></tr>`;
    }
    html += `</tbody></table>`;
  }

  if (screenshots.removed.length > 0) {
    html += `<h3>${badge('removed')} Removed Screenshots (${screenshots.removed.length})</h3>`;
    html += `<table><thead><tr><th>URL</th></tr></thead><tbody>`;
    for (const ss of screenshots.removed) {
      html += `<tr><td>${escapeHtml(ss.url)}</td></tr>`;
    }
    html += `</tbody></table>`;
  }

  if (screenshots.changed.length > 0) {
    html += `<h3>${badge('changed')} Changed Screenshots (${screenshots.changed.length})</h3>`;
    html += `<table><thead><tr><th>URL</th><th>Diff</th></tr></thead><tbody>`;
    for (const ss of screenshots.changed) {
      html += `<tr><td>${escapeHtml(ss.url)}</td><td>${ss.diffPercentage}% changed</td></tr>`;
    }
    html += `</tbody></table>`;
  }

  html += `</div>`;
  return html;
}

// ---------------------------------------------------------------------------
// Main export
// ---------------------------------------------------------------------------

/**
 * Generate a self-contained HTML diff report.
 *
 * @param diff - The DiffResult to render
 * @returns Complete HTML document as a string
 */
export function generateDiffReportHtml(diff: DiffResult): string {
  const { meta, summary, hasChanges } = diff;

  const summarySection = `
    <div class="summary">
      ${summaryCard('Routes', summary.routes)}
      ${summaryCard('Forms', summary.forms)}
      ${summaryCard('API Endpoints', summary.api)}
      ${summaryCard('Screenshots', summary.screenshots)}
    </div>`;

  const noChangesNotice = !hasChanges
    ? `<div class="no-changes">No changes detected between bundles.</div>`
    : '';

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  ${CSP_META}
  <title>Diff Report — playwright-archaeologist</title>
  <style>${STYLES}</style>
</head>
<body>
  <h1>Regression Diff Report</h1>
  <div class="meta">
    <p>Old bundle: ${escapeHtml(meta.oldBundle.targetUrl || meta.oldBundle.path)} (${escapeHtml(meta.oldBundle.createdAt)})</p>
    <p>New bundle: ${escapeHtml(meta.newBundle.targetUrl || meta.newBundle.path)} (${escapeHtml(meta.newBundle.createdAt)})</p>
    <p>Compared at: ${escapeHtml(meta.comparedAt)}</p>
  </div>

  ${summarySection}
  ${noChangesNotice}

  ${renderRoutesSection(diff)}
  ${renderFormsSection(diff)}
  ${renderApiSection(diff)}
  ${renderScreenshotsSection(diff)}
</body>
</html>`;
}
