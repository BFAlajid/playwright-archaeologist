/**
 * Coverage report renderers — HTML, JSON, Markdown, and JUnit.
 *
 * All four formats consume the same `CoverageReport` produced by
 * `computeCoverage`. They exist here side-by-side so the CLI can pick
 * an output format at runtime without pulling in extra dependencies.
 *
 * The HTML report reuses the tokens + escape helpers from the main crawl
 * report so light/dark theming and CSP behavior stay consistent.
 */

import { escapeHtml, escapeAttribute, sanitizeUrl } from '../report/html/escape.js';
import { CSS_TOKENS, FAVICON_DATA_URI, hashSlug } from '../report/html/tokens.js';
import type {
  CoverageReport,
  CoverageRouteEntry,
  CoverageApiEntry,
} from './coverage-engine.js';

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

function routeId(url: string): string {
  return `cov-route-${hashSlug(url)}`;
}

function apiId(method: string, pattern: string): string {
  return `cov-api-${method.toLowerCase()}-${hashSlug(pattern)}`;
}

function pctBucket(pct: number): 'high' | 'mid' | 'low' {
  if (pct >= 80) return 'high';
  if (pct >= 50) return 'mid';
  return 'low';
}

// ---------------------------------------------------------------------------
// HTML renderer
// ---------------------------------------------------------------------------

const CSP_META = `<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; img-src 'self' data:;">`;

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
  .meta { color: var(--text-muted); font-size: 0.9rem; margin-bottom: 2rem; }
  .summary {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(220px, 1fr));
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
  .summary-card .pct { font-size: 2rem; font-weight: bold; }
  .summary-card.high .pct { color: var(--status-2xx); }
  .summary-card.mid .pct { color: var(--status-4xx); }
  .summary-card.low .pct { color: var(--status-5xx); }
  .summary-card .detail { font-size: 0.8rem; color: var(--text-muted); margin-top: 0.25rem; }
  .badge { display: inline-block; padding: 2px 8px; border-radius: 4px; font-size: 0.75rem; font-weight: 600; text-transform: uppercase; }
  .badge-covered { background: var(--badge-added-bg); color: var(--badge-added-fg); }
  .badge-uncovered { background: var(--badge-removed-bg); color: var(--badge-removed-fg); }
  .chip-bar { display: flex; flex-wrap: wrap; gap: 0.5rem; margin-bottom: 1rem; }
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
  .chip[aria-pressed="true"] { background: var(--accent); color: #fff; border-color: var(--accent); }
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
  th, td { padding: 0.75rem 1rem; text-align: left; border-bottom: 1px solid var(--border-light); font-size: 0.9rem; }
  th { background: var(--bg-surface-hover); font-weight: 600; font-size: 0.85rem; text-transform: uppercase; color: var(--text-muted); }
  tr:last-child td { border-bottom: none; }
  tr[data-covered="false"] td.status { color: var(--status-5xx); }
  tr[data-covered="true"] td.status { color: var(--status-2xx); }
  .covering-list { font-size: 0.8rem; color: var(--text-muted); }
  .covering-list li { list-style: none; }
  .mono { font-family: 'SF Mono', SFMono-Regular, Consolas, Menlo, monospace; font-size: 0.85rem; }
  .section-note { color: var(--text-muted); font-style: italic; }
  footer.report-footer { margin-top: 3rem; padding: 1rem 0; border-top: 1px solid var(--border-light); color: var(--text-muted); font-size: 0.8rem; text-align: center; }
  .visually-hidden {
    position: absolute !important;
    width: 1px !important;
    height: 1px !important;
    overflow: hidden !important;
    clip: rect(0,0,0,0) !important;
    white-space: nowrap !important;
    border: 0 !important;
  }
`;

const REPORT_JS = `
  (function() {
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

    var chips = document.querySelectorAll('.chip[data-filter]');
    var active = 'all';
    function apply() {
      var rows = document.querySelectorAll('tr[data-covered]');
      for (var i = 0; i < rows.length; i++) {
        var c = rows[i].getAttribute('data-covered');
        var show = active === 'all' || (active === 'uncovered' && c === 'false') || (active === 'covered' && c === 'true');
        rows[i].style.display = show ? '' : 'none';
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

function renderRouteRow(entry: CoverageRouteEntry): string {
  const id = routeId(entry.url);
  const status = entry.covered
    ? `<span class="badge badge-covered">covered</span>`
    : `<span class="badge badge-uncovered">uncovered</span>`;
  const tests = entry.coveringTests.length > 0
    ? `<ul class="covering-list">${entry.coveringTests
        .map((t) => `<li>${escapeHtml(t.filePath)}:${t.lineNumber} <span class="mono">${escapeHtml(t.method)}</span></li>`)
        .join('')}</ul>`
    : `<span class="section-note">&mdash;</span>`;
  const urlCell = `<span class="mono">${escapeHtml(entry.url)}</span>`;
  return `<tr id="${id}" data-covered="${entry.covered}"><td class="status">${status}</td><td>${urlCell}</td><td>${tests}</td></tr>`;
}

function renderApiRow(entry: CoverageApiEntry): string {
  const id = apiId(entry.method, entry.pattern);
  const status = entry.covered
    ? `<span class="badge badge-covered">covered</span>`
    : `<span class="badge badge-uncovered">uncovered</span>`;
  const tests = entry.coveringTests.length > 0
    ? `<ul class="covering-list">${entry.coveringTests
        .map((t) => `<li>${escapeHtml(t.filePath)}:${t.lineNumber} <span class="mono">${escapeHtml(t.method)}</span></li>`)
        .join('')}</ul>`
    : `<span class="section-note">&mdash;</span>`;
  return `<tr id="${id}" data-covered="${entry.covered}"><td class="status">${status}</td><td><span class="mono">${escapeHtml(entry.method)}</span></td><td><span class="mono">${escapeHtml(entry.pattern)}</span></td><td>${tests}</td></tr>`;
}

/**
 * Render a full HTML coverage report.
 */
export function generateCoverageReportHtml(report: CoverageReport): string {
  const { summary } = report;

  const routesBucket = pctBucket(summary.routesPercentage);
  const apisBucket = pctBucket(summary.apisPercentage);
  const overallBucket = pctBucket(summary.overallPercentage);

  const targetDisplay = report.bundleTarget || '(unknown target)';
  const targetHref = sanitizeUrl(report.bundleTarget);

  const ignoredSection = report.ignoredPatterns.length > 0
    ? `<p class="meta">Ignored patterns: ${report.ignoredPatterns
        .map((p) => `<span class="mono">${escapeHtml(p)}</span>`)
        .join(', ')}</p>`
    : '';

  const routeRows = report.routes.length > 0
    ? report.routes.map(renderRouteRow).join('')
    : `<tr><td colspan="3" class="section-note">No routes in bundle.</td></tr>`;

  const apiRows = report.apis.length > 0
    ? report.apis.map(renderApiRow).join('')
    : `<tr><td colspan="4" class="section-note">No API endpoints in bundle.</td></tr>`;

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  ${CSP_META}
  <meta name="description" content="Playwright test coverage report against a crawl bundle">
  <meta name="generator" content="playwright-archaeologist">
  <link rel="icon" type="image/svg+xml" href="${FAVICON_DATA_URI}">
  <title>Coverage Report &mdash; playwright-archaeologist</title>
  <style>${STYLES}</style>
</head>
<body>
  <header>
    <div style="display:flex;align-items:center;gap:1rem;justify-content:space-between;flex-wrap:wrap;">
      <h1>Test Coverage Report</h1>
      <button id="theme-toggle" type="button" class="chip" aria-label="Toggle theme">Theme: Auto</button>
    </div>
    <div class="meta">
      <p>Bundle target: ${targetHref === '#' ? escapeHtml(targetDisplay) : `<a href="${escapeAttribute(targetHref)}">${escapeHtml(targetDisplay)}</a>`}</p>
      <p>Test directory: <span class="mono">${escapeHtml(report.testDir)}</span></p>
      <p>Scanned at: ${escapeHtml(report.scannedAt)}</p>
    </div>
    ${ignoredSection}
  </header>

  <main>
    <div class="summary">
      <div class="summary-card ${overallBucket}">
        <h3>Overall</h3>
        <div class="pct">${summary.overallPercentage}%</div>
        <div class="detail">${summary.routesCovered + summary.apisCovered} / ${summary.routesTotal + summary.apisTotal} covered</div>
      </div>
      <div class="summary-card ${routesBucket}">
        <h3>Routes</h3>
        <div class="pct">${summary.routesPercentage}%</div>
        <div class="detail">${summary.routesCovered} / ${summary.routesTotal} covered</div>
      </div>
      <div class="summary-card ${apisBucket}">
        <h3>API Endpoints</h3>
        <div class="pct">${summary.apisPercentage}%</div>
        <div class="detail">${summary.apisCovered} / ${summary.apisTotal} covered</div>
      </div>
    </div>

    <div class="chip-bar" role="group" aria-label="Filter by coverage">
      <button class="chip" type="button" data-filter="all" aria-pressed="true">All</button>
      <button class="chip" type="button" data-filter="uncovered" aria-pressed="false">Uncovered</button>
      <button class="chip" type="button" data-filter="covered" aria-pressed="false">Covered</button>
    </div>

    <section>
      <h2>Routes</h2>
      <table>
        <thead><tr><th>Status</th><th>URL</th><th>Covering tests</th></tr></thead>
        <tbody>${routeRows}</tbody>
      </table>
    </section>

    <section>
      <h2>API Endpoints</h2>
      <table>
        <thead><tr><th>Status</th><th>Method</th><th>Pattern</th><th>Covering tests</th></tr></thead>
        <tbody>${apiRows}</tbody>
      </table>
    </section>
  </main>

  <footer class="report-footer">
    Generated by playwright-archaeologist
  </footer>

  <script>${REPORT_JS}</script>
</body>
</html>`;
}

// ---------------------------------------------------------------------------
// JSON renderer
// ---------------------------------------------------------------------------

/**
 * Serialize the full coverage report as JSON. Pretty-printed by default so
 * the output is useful for CI log inspection.
 */
export function generateCoverageReportJson(report: CoverageReport, pretty = true): string {
  return JSON.stringify(report, null, pretty ? 2 : 0);
}

// ---------------------------------------------------------------------------
// Markdown renderer
// ---------------------------------------------------------------------------

/**
 * Minimal Markdown coverage report — summary + a list of uncovered routes
 * and endpoints. Designed to render cleanly in a GitHub PR comment.
 */
export function generateCoverageReportMarkdown(report: CoverageReport): string {
  const { summary } = report;
  const uncoveredRoutes = report.routes.filter((r) => !r.covered);
  const uncoveredApis = report.apis.filter((a) => !a.covered);

  const lines: string[] = [];
  lines.push('# Playwright Coverage Report');
  lines.push('');
  lines.push(`- Bundle target: \`${report.bundleTarget || '(unknown)'}\``);
  lines.push(`- Test directory: \`${report.testDir}\``);
  lines.push(`- Scanned at: ${report.scannedAt}`);
  if (report.ignoredPatterns.length > 0) {
    lines.push(`- Ignored patterns: ${report.ignoredPatterns.map((p) => `\`${p}\``).join(', ')}`);
  }
  lines.push('');
  lines.push('## Summary');
  lines.push('');
  lines.push('| Category | Covered | Total | Percentage |');
  lines.push('| --- | --- | --- | --- |');
  lines.push(`| Routes | ${summary.routesCovered} | ${summary.routesTotal} | ${summary.routesPercentage}% |`);
  lines.push(`| APIs | ${summary.apisCovered} | ${summary.apisTotal} | ${summary.apisPercentage}% |`);
  lines.push(`| **Overall** | **${summary.routesCovered + summary.apisCovered}** | **${summary.routesTotal + summary.apisTotal}** | **${summary.overallPercentage}%** |`);
  lines.push('');

  lines.push(`## Uncovered routes (${uncoveredRoutes.length})`);
  lines.push('');
  if (uncoveredRoutes.length === 0) {
    lines.push('_None._');
  } else {
    for (const r of uncoveredRoutes) {
      lines.push(`- \`${r.url}\``);
    }
  }
  lines.push('');

  lines.push(`## Uncovered API endpoints (${uncoveredApis.length})`);
  lines.push('');
  if (uncoveredApis.length === 0) {
    lines.push('_None._');
  } else {
    for (const a of uncoveredApis) {
      lines.push(`- \`${a.method} ${a.pattern}\``);
    }
  }
  lines.push('');

  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// JUnit renderer
// ---------------------------------------------------------------------------

/**
 * XML-escape a value for inclusion inside an attribute or element.
 * We duplicate this (rather than reuse diff-report helpers) because the
 * JUnit schema has different escaping requirements than HTML — XML rejects
 * `&` even when it's already part of an entity, so we have to be strict.
 */
function xmlEscape(input: string): string {
  return input
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;')
    .replace(/[\x00-\x1f]/g, '');
}

/**
 * Render the coverage report as JUnit XML where each uncovered route /
 * endpoint is a failing `<testcase>`. Useful as a CI gate — Jenkins /
 * CircleCI / GitLab JUnit importers understand this shape.
 */
export function generateCoverageReportJUnit(report: CoverageReport): string {
  const { summary, routes, apis } = report;
  const totalTests = summary.routesTotal + summary.apisTotal;
  const failures = (summary.routesTotal - summary.routesCovered) + (summary.apisTotal - summary.apisCovered);

  const lines: string[] = [];
  lines.push('<?xml version="1.0" encoding="UTF-8"?>');
  lines.push(
    `<testsuite name="playwright-archaeologist coverage" tests="${totalTests}" failures="${failures}" errors="0" skipped="0" timestamp="${xmlEscape(report.scannedAt)}">`,
  );

  for (const r of routes) {
    const name = xmlEscape(`route ${r.url}`);
    const classname = 'coverage.routes';
    if (r.covered) {
      lines.push(`  <testcase classname="${classname}" name="${name}"/>`);
    } else {
      lines.push(`  <testcase classname="${classname}" name="${name}">`);
      lines.push(`    <failure message="No Playwright test targets this route" type="UncoveredRoute"/>`);
      lines.push(`  </testcase>`);
    }
  }

  for (const a of apis) {
    const name = xmlEscape(`api ${a.method} ${a.pattern}`);
    const classname = 'coverage.apis';
    if (a.covered) {
      lines.push(`  <testcase classname="${classname}" name="${name}"/>`);
    } else {
      lines.push(`  <testcase classname="${classname}" name="${name}">`);
      lines.push(`    <failure message="No Playwright test targets this API endpoint" type="UncoveredApi"/>`);
      lines.push(`  </testcase>`);
    }
  }

  lines.push('</testsuite>');
  return lines.join('\n');
}
