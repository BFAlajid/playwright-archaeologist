/**
 * Unit tests for src/assembler/artifacts.ts
 *
 * Verifies the integration of route-tree, routes, api-endpoints, flow-graph,
 * and the screenshot manifest into a single AssembledArtifacts object.
 */

import { describe, it, expect } from 'vitest';
import type { CrawlResult, PageVisitResult } from '../../src/types/artifacts.js';
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
      depth: 2,
      maxPages: 10,
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

describe('buildAssembledArtifacts', () => {
  it('handles empty pages list', () => {
    const result = buildAssembledArtifacts(mkCrawlResult([]), []);
    expect(result.routes).toEqual([]);
    expect(result.forms).toEqual([]);
    expect(result.apiEndpoints).toEqual([]);
    expect(result.screenshots).toEqual([]);
    expect(result.flowGraph.entryPoint).toBe('https://example.com/');
    expect(result.flowGraph.edges).toEqual([]);
    expect(result.flowDiagrams.overview.definition).toBe('');
  });

  it('populates meta with crawl stats', () => {
    const pages = [
      pv({ url: 'https://example.com/a' }),
      pv({ url: 'https://example.com/b' }),
    ];
    const result = buildAssembledArtifacts(mkCrawlResult(pages), pages);
    expect(result.meta.pagesVisited).toBe(2);
    expect(result.meta.targetUrl).toBe('https://example.com/');
    expect(result.meta.completionStatus).toBe('complete');
    expect(result.meta.viewport).toEqual({ width: 1280, height: 720 });
  });

  it('aggregates forms across pages', () => {
    const pages = [
      pv({
        url: 'https://example.com/a',
        formProbe: {
          pageUrl: 'https://example.com/a',
          forms: [
            {
              action: '/submit',
              method: 'POST',
              isImplicit: false,
              fields: [],
              validationMessages: [],
              wasHidden: false,
            },
          ],
        },
      }),
      pv({
        url: 'https://example.com/b',
        formProbe: {
          pageUrl: 'https://example.com/b',
          forms: [
            {
              action: '/x',
              method: 'GET',
              isImplicit: false,
              fields: [],
              validationMessages: [],
              wasHidden: false,
            },
          ],
        },
      }),
    ];
    const result = buildAssembledArtifacts(mkCrawlResult(pages), pages);
    expect(result.forms).toHaveLength(2);
    expect(result.meta.formsFound).toBe(2);
  });

  it('enriches route node counts from form probe and network log', () => {
    const pages = [
      pv({
        url: 'https://example.com/api-page',
        formProbe: {
          pageUrl: 'https://example.com/api-page',
          forms: [
            {
              action: '/x',
              method: 'POST',
              isImplicit: false,
              fields: [],
              validationMessages: [],
              wasHidden: false,
            },
          ],
        },
        networkLog: {
          pageUrl: 'https://example.com/api-page',
          requests: [
            {
              requestId: 'r1',
              url: 'https://example.com/api/x',
              method: 'GET',
              headers: {},
              resourceType: 'xhr',
              classification: 'api',
              initiator: 'fetch',
            },
          ],
          responses: [],
          failedRequests: [],
          graphqlOperations: [],
          webSocketConnections: [],
          cookieMutations: [],
        },
      }),
    ];
    const result = buildAssembledArtifacts(mkCrawlResult(pages), pages);
    expect(result.routes[0].formCount).toBe(1);
    expect(result.routes[0].apiCallCount).toBe(1);
  });

  it('builds flow graph from navigation edges', () => {
    const pages = [
      pv({
        url: 'https://example.com/a',
        navigationEdges: [
          { from: 'https://example.com/a', to: 'https://example.com/b', trigger: 'link' },
        ],
      }),
      pv({ url: 'https://example.com/b' }),
    ];
    const result = buildAssembledArtifacts(mkCrawlResult(pages), pages);
    expect(result.flowGraph.edges).toHaveLength(1);
    expect(result.flowDiagrams.overview.definition).toContain('flowchart LR');
  });

  it('falls back to page-only flow graph when no edges exist', () => {
    const pages = [pv({ url: 'https://example.com/x' })];
    const result = buildAssembledArtifacts(mkCrawlResult(pages), pages);
    expect(result.flowGraph.edges).toEqual([]);
    expect(result.flowGraph.nodes).toHaveLength(1);
    expect(result.flowGraph.nodes[0].url).toBe('https://example.com/x');
  });
});
