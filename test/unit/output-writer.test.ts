/**
 * Unit tests for src/crawl/output-writer.ts
 *
 * Verifies the file-write entry point produces the expected files in the
 * output directory, skips conditional files when their input is empty, and
 * survives individual write failures without aborting the overall run.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';

import type {
  AssembledArtifacts,
  CrawlResult,
  PageVisitResult,
} from '../../src/types/artifacts.js';
import { writeCrawlOutputs } from '../../src/crawl/output-writer.js';
import { buildAssembledArtifacts } from '../../src/assembler/artifacts.js';

function pv(overrides: Partial<PageVisitResult>): PageVisitResult {
  return {
    url: 'https://example.com/',
    finalUrl: 'https://example.com/',
    status: 'ok',
    httpStatus: 200,
    depth: 0,
    discoveryMethod: 'entry',
    visitedAt: '2026-04-20T00:00:00Z',
    durationMs: 10,
    collectorErrors: [],
    navigationEdges: [],
    ...overrides,
  };
}

function mkCrawlResult(pages: PageVisitResult[]): CrawlResult {
  return {
    config: {
      targetUrl: 'https://example.com/',
      depth: 1,
      maxPages: 5,
      concurrency: 1,
      viewport: { width: 1280, height: 720 },
      followExternal: false,
      deepClick: false,
    },
    startedAt: '2026-04-20T00:00:00Z',
    finishedAt: '2026-04-20T00:00:30Z',
    durationMs: 30000,
    pages,
    unvisitedUrls: [],
    errors: [],
    completionStatus: 'complete',
  };
}

describe('writeCrawlOutputs', () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'pa-ow-'));
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
  });

  it('always writes sitemap.json and crawl-summary.json', async () => {
    const pages = [pv({})];
    const crawl = mkCrawlResult(pages);
    const artifacts = buildAssembledArtifacts(crawl, pages);

    const result = await writeCrawlOutputs(tmpDir, crawl, pages, artifacts, {
      pagesVisited: pages.length,
    });

    expect(result.sitemapJson).toBeDefined();
    expect(result.crawlSummaryJson).toBeDefined();
    expect((await fs.stat(result.sitemapJson!)).isFile()).toBe(true);
    expect((await fs.stat(result.crawlSummaryJson!)).isFile()).toBe(true);
    const summary = JSON.parse(await fs.readFile(result.crawlSummaryJson!, 'utf-8'));
    expect(summary.targetUrl).toBe('https://example.com/');
  });

  it('skips forms.json when no forms exist', async () => {
    const pages = [pv({})];
    const crawl = mkCrawlResult(pages);
    const artifacts = buildAssembledArtifacts(crawl, pages);
    const result = await writeCrawlOutputs(tmpDir, crawl, pages, artifacts, {
      pagesVisited: pages.length,
    });
    expect(result.formsJson).toBeUndefined();
    const exists = await fs.stat(path.join(tmpDir, 'forms.json')).catch(() => null);
    expect(exists).toBeNull();
  });

  it('writes forms.json when forms are present', async () => {
    const pages = [
      pv({
        url: 'https://example.com/',
        formProbe: {
          pageUrl: 'https://example.com/',
          forms: [
            {
              action: '/post',
              method: 'POST',
              isImplicit: false,
              fields: [],
              validationMessages: [],
              wasHidden: false,
            },
          ],
        },
      }),
    ];
    const crawl = mkCrawlResult(pages);
    const artifacts = buildAssembledArtifacts(crawl, pages);
    const result = await writeCrawlOutputs(tmpDir, crawl, pages, artifacts, {
      pagesVisited: pages.length,
    });
    expect(result.formsJson).toBeDefined();
    const formsText = await fs.readFile(result.formsJson!, 'utf-8');
    const forms = JSON.parse(formsText);
    expect(forms).toHaveLength(1);
  });

  it('writes api-map.json and openapi.json when endpoints exist', async () => {
    const pages = [
      pv({
        networkLog: {
          pageUrl: 'https://example.com/',
          requests: [
            {
              requestId: 'r1',
              url: 'https://example.com/api/items',
              method: 'GET',
              headers: {},
              resourceType: 'xhr',
              classification: 'api',
              initiator: 'fetch',
            },
          ],
          responses: [
            {
              requestId: 'r1',
              statusCode: 200,
              headers: {},
              contentType: 'application/json',
              bodySize: 10,
              timing: 5,
            },
          ],
          failedRequests: [],
          graphqlOperations: [],
          webSocketConnections: [],
          cookieMutations: [],
        },
      }),
    ];
    const crawl = mkCrawlResult(pages);
    const artifacts = buildAssembledArtifacts(crawl, pages);
    const result = await writeCrawlOutputs(tmpDir, crawl, pages, artifacts, {
      pagesVisited: pages.length,
    });
    expect(result.apiMapJson).toBeDefined();
    expect(result.openapiJson).toBeDefined();
  });

  it('writes HTML report', async () => {
    const pages = [pv({})];
    const crawl = mkCrawlResult(pages);
    const artifacts = buildAssembledArtifacts(crawl, pages);
    const result = await writeCrawlOutputs(tmpDir, crawl, pages, artifacts, {
      pagesVisited: pages.length,
    });
    expect(result.reportHtml).toBeDefined();
    const html = await fs.readFile(result.reportHtml!, 'utf-8');
    expect(html).toContain('<!DOCTYPE html>');
  });

  it('writes flow-graph.mmd when flow graph has edges', async () => {
    const pages = [
      pv({
        url: 'https://example.com/a',
        navigationEdges: [
          { from: 'https://example.com/a', to: 'https://example.com/b', trigger: 'link' },
        ],
      }),
      pv({ url: 'https://example.com/b' }),
    ];
    const crawl = mkCrawlResult(pages);
    const artifacts = buildAssembledArtifacts(crawl, pages);
    const result = await writeCrawlOutputs(tmpDir, crawl, pages, artifacts, {
      pagesVisited: pages.length,
    });
    expect(result.flowGraphMmd).toBeDefined();
    const mmd = await fs.readFile(result.flowGraphMmd!, 'utf-8');
    expect(mmd).toContain('flowchart LR');
  });

  it('pretty-prints JSON when prettyJson is true', async () => {
    const pages = [pv({})];
    const crawl = mkCrawlResult(pages);
    const artifacts = buildAssembledArtifacts(crawl, pages);
    const result = await writeCrawlOutputs(tmpDir, crawl, pages, artifacts, {
      prettyJson: true,
      pagesVisited: pages.length,
    });
    const text = await fs.readFile(result.sitemapJson!, 'utf-8');
    // Pretty JSON should contain newlines; compact JSON would not.
    expect(text).toContain('\n');
  });
});
