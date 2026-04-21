/**
 * Performance benchmarks for HTML report generation.
 *
 * Exercises the real shipped modules:
 *   - generateReportHtml (src/report/html/template.ts): the main self-
 *     contained HTML report produced at the end of a crawl.
 *   - generateDiffReportHtml (src/diff/diff-report.ts): the diff report
 *     produced by `pa diff`.
 *
 * Inputs are synthetic ReportInput and DiffResult objects scaled to the
 * page counts the production reports are sized for.
 *
 * Run: npx vitest bench test/performance/report-generation.bench.ts
 */

import { bench, describe } from 'vitest';
import { createHash } from 'node:crypto';
import {
  generateReportHtml,
  type ReportInput,
  type ReportPage,
  type ReportForm,
  type ReportApiEndpoint,
  type ReportScreenshot,
} from '../../src/report/html/template.js';
import { generateDiffReportHtml } from '../../src/diff/diff-report.js';
import type {
  DiffResult,
  DiffSummary,
  RouteInfo,
  FormInfo,
  ApiEndpointGroup,
} from '../../src/types/artifacts.js';

// ---------------------------------------------------------------------------
// Synthetic report-input generators
// ---------------------------------------------------------------------------

function generatePages(count: number): ReportPage[] {
  const pages: ReportPage[] = [];
  for (let i = 0; i < count; i++) {
    pages.push({
      url: `https://example.com/section-${i % 10}/page-${i}`,
      title: `Page ${i} - Section ${i % 10}`,
      status: 200,
      depth: 1 + (i % 4),
      contentHash: createHash('sha256').update(`content-${i}`).digest('hex').slice(0, 16),
    });
  }
  return pages;
}

function generateForms(count: number): ReportForm[] {
  const forms: ReportForm[] = [];
  const fieldTypes = ['text', 'email', 'password', 'number', 'tel', 'url', 'date'];
  for (let i = 0; i < count; i++) {
    forms.push({
      url: `https://example.com/section-${i % 10}/page-${i}`,
      action: `/api/form-${i}`,
      method: i % 3 === 0 ? 'GET' : 'POST',
      fields: Array.from({ length: 5 + (i % 5) }, (_, j) => ({
        name: `field_${j}_form_${i}`,
        type: fieldTypes[j % fieldTypes.length],
        required: j < 3,
      })),
    });
  }
  return forms;
}

function generateApiEndpoints(count: number): ReportApiEndpoint[] {
  const endpoints: ReportApiEndpoint[] = [];
  const methods = ['GET', 'POST', 'PUT', 'DELETE', 'PATCH'];
  for (let i = 0; i < count; i++) {
    const method = methods[i % methods.length];
    endpoints.push({
      method,
      url: `https://example.com/api/v2/resource-${i % 20}/${i}`,
      pattern: `/api/v2/resource-${i % 20}/:id`,
      status: method === 'DELETE' ? 204 : 200,
      methods: [method],
      examples: [
        { url: `https://example.com/api/v2/resource-${i % 20}/${i}`, status: 200 },
      ],
    });
  }
  return endpoints;
}

/**
 * Generate a short synthetic base64 thumbnail string. The template does
 * not itself encode — it only embeds the provided string in a data URL —
 * so for bench realism we include a ~11KB base64 payload per screenshot
 * to match production JPEG thumbnail sizes.
 */
const SHARED_THUMB_B64 = (() => {
  const raw = Buffer.alloc(8192);
  for (let i = 0; i < raw.length; i++) raw[i] = (i * 7 + 13) % 256;
  return raw.toString('base64');
})();

function generateScreenshots(count: number): ReportScreenshot[] {
  const screenshots: ReportScreenshot[] = [];
  for (let i = 0; i < count; i++) {
    screenshots.push({
      url: `https://example.com/section-${i % 10}/page-${i}`,
      thumbnailBase64: SHARED_THUMB_B64,
      fullPath: `./screenshots/section-${i % 10}_page-${i}.png`,
    });
  }
  return screenshots;
}

function generateReportInput(pageCount: number): ReportInput {
  return {
    targetUrl: 'https://example.com',
    crawlDate: '2026-04-20T12:00:00.000Z',
    duration: pageCount * 300,
    pagesVisited: pageCount,
    errors: Math.floor(pageCount * 0.02),
    pages: generatePages(pageCount),
    forms: generateForms(Math.floor(pageCount * 0.3)),
    apiEndpoints: generateApiEndpoints(Math.floor(pageCount * 3)),
    screenshots: generateScreenshots(pageCount),
    toolVersion: '0.2.0',
  };
}

// ---------------------------------------------------------------------------
// Synthetic DiffResult generator
// ---------------------------------------------------------------------------

function makeRouteInfo(url: string): RouteInfo {
  return {
    url,
    title: url,
    statusCode: 200,
    contentHash: createHash('sha256').update(url).digest('hex').slice(0, 16),
    depth: 1,
    formCount: 0,
    apiCallCount: 0,
    hasScreenshot: false,
    discoveryMethod: 'link',
  };
}

function makeFormInfo(idx: number): FormInfo {
  return {
    action: `/submit-${idx}`,
    method: 'POST',
    isImplicit: false,
    fields: [
      { name: 'email', type: 'email', required: true },
      { name: 'password', type: 'password', required: true },
    ],
    validationMessages: [],
    wasHidden: false,
  };
}

function makeApiEndpoint(method: string, pattern: string): ApiEndpointGroup {
  return {
    method,
    pattern,
    classification: 'api',
    observedUrls: [],
    callCount: 1,
    callingPages: [],
    exampleRequest: { url: pattern, headers: {} },
    exampleResponse: { statusCode: 200, headers: {}, bodySize: 500 },
    observedStatusCodes: [200],
    observedContentTypes: ['application/json'],
    isGraphQL: false,
  };
}

function generateDiffResult(
  addedCount: number,
  removedCount: number,
  changedCount: number,
): DiffResult {
  const summary: DiffSummary = {
    routes: { added: addedCount, removed: removedCount, changed: changedCount, unchanged: 100 },
    forms: { added: Math.floor(addedCount / 4), removed: 0, changed: Math.floor(changedCount / 4), unchanged: 20 },
    api: { added: Math.floor(addedCount / 2), removed: Math.floor(removedCount / 2), changed: Math.floor(changedCount / 2), unchanged: 60 },
    screenshots: { added: 0, removed: 0, changed: Math.floor(changedCount / 3), unchanged: 80 },
  };

  return {
    meta: {
      oldBundle: {
        path: '/tmp/old-bundle',
        createdAt: '2026-04-19T00:00:00.000Z',
        targetUrl: 'https://example.com',
        toolVersion: '0.2.0',
      },
      newBundle: {
        path: '/tmp/new-bundle',
        createdAt: '2026-04-20T00:00:00.000Z',
        targetUrl: 'https://example.com',
        toolVersion: '0.2.0',
      },
      comparedAt: '2026-04-20T12:00:00.000Z',
    },
    hasChanges: addedCount + removedCount + changedCount > 0,
    sitemap: {
      added: Array.from({ length: addedCount }, (_, i) =>
        makeRouteInfo(`https://example.com/new-page-${i}`),
      ),
      removed: Array.from({ length: removedCount }, (_, i) =>
        makeRouteInfo(`https://example.com/old-page-${i}`),
      ),
      changed: Array.from({ length: changedCount }, (_, i) => ({
        url: `https://example.com/section-${i % 10}/page-${i}`,
        changes: {
          contentHash: { old: `old-hash-${i}`, new: `new-hash-${i}` },
          title: i % 3 === 0
            ? { old: `Page ${i}`, new: `Page ${i} (updated)` }
            : undefined,
        },
      })),
      unchangedCount: 100,
    },
    forms: {
      added: Array.from({ length: Math.floor(addedCount / 4) }, (_, i) => makeFormInfo(i)),
      removed: [],
      changed: Array.from({ length: Math.floor(changedCount / 4) }, (_, i) => ({
        formId: `form-${i}`,
        pageUrl: `https://example.com/section-${i % 10}/form-${i}`,
        changes: {
          fieldsAdded: [{ name: 'new_field', type: 'text', required: false }],
        },
      })),
      unchangedCount: 20,
    },
    api: {
      added: Array.from({ length: Math.floor(addedCount / 2) }, (_, i) =>
        makeApiEndpoint('GET', `/api/new/:id${i}`),
      ),
      removed: Array.from({ length: Math.floor(removedCount / 2) }, (_, i) =>
        makeApiEndpoint('DELETE', `/api/old/:id${i}`),
      ),
      changed: Array.from({ length: Math.floor(changedCount / 2) }, (_, i) => ({
        endpointId: `GET /api/v2/resource/:id${i}`,
        changes: {
          bodySizeChange: { old: 500, new: 750, percentChange: 50 },
          statusCodesAdded: [201],
        },
      })),
      unchangedCount: 60,
    },
    screenshots: {
      added: [],
      removed: [],
      changed: Array.from({ length: Math.floor(changedCount / 3) }, (_, i) => ({
        url: `https://example.com/section-${i % 10}/page-${i}`,
        diffPercentage: 5.2 + (i % 10),
        diffPixelCount: 50_000 + i * 100,
        totalPixels: 921_600, // 1280*720
        diffImagePath: '',
        oldScreenshotPath: `/tmp/old/page-${i}.png`,
        newScreenshotPath: `/tmp/new/page-${i}.png`,
      })),
      unchangedCount: 80,
    },
    summary,
  };
}

// ---------------------------------------------------------------------------
// Pre-generated inputs (one-time cost, reused per bench iteration)
// ---------------------------------------------------------------------------

const report100 = generateReportInput(100);
const report1k = generateReportInput(1000);
const report10k = generateReportInput(10_000);
const diffResult = generateDiffResult(30, 10, 50);

// ---------------------------------------------------------------------------
// generateReportHtml (real template)
// ---------------------------------------------------------------------------

describe('generateReportHtml', () => {
  bench('htmlGeneration100Pages: generateReportHtml for 100-page ReportInput', () => {
    generateReportHtml(report100);
  });

  bench('htmlGeneration1000Pages: generateReportHtml for 1000-page ReportInput', () => {
    generateReportHtml(report1k);
  });

  bench('htmlGeneration10000Pages: generateReportHtml for 10000-page ReportInput', () => {
    generateReportHtml(report10k);
  });
});

// ---------------------------------------------------------------------------
// generateDiffReportHtml (real diff template)
// ---------------------------------------------------------------------------

describe('generateDiffReportHtml', () => {
  bench('diffReportGeneration: generateDiffReportHtml for a synthetic DiffResult', () => {
    generateDiffReportHtml(diffResult);
  });
});
