/**
 * Performance benchmarks for non-browser crawl pipeline components.
 *
 * Exercises the real shipped modules:
 *   - Frontier (enqueue/dequeue with dedup + normalization)
 *   - normalizeUrl (memoized URL canonicalization)
 *   - buildRouteTree (hierarchical route tree from page visits)
 *   - buildAssembledArtifacts (the full assembler pipeline: route tree +
 *     routes + API endpoints + flow graph + screenshot manifest)
 *
 * Run: npx vitest bench test/performance/crawl-simulation.bench.ts
 */

import { bench, describe } from 'vitest';
import { Frontier } from '../../src/crawl/frontier.js';
import {
  normalizeUrl,
  __clearNormalizeUrlCacheForTesting,
} from '../../src/crawl/url-utils.js';
import { buildRouteTree } from '../../src/assembler/route-tree.js';
import { buildAssembledArtifacts } from '../../src/assembler/artifacts.js';
import type {
  CrawlResult,
  PageVisitResult,
} from '../../src/types/artifacts.js';

// ---------------------------------------------------------------------------
// URL shape generators
// ---------------------------------------------------------------------------

/**
 * Generate URLs of varied shape: section/id paths, query strings, fragments.
 * Deterministic — each index produces the same URL across runs.
 */
function generateRealisticUrls(count: number, baseUrl = 'https://app.example.com'): string[] {
  const urls: string[] = [];
  const sections = [
    'dashboard', 'settings', 'users', 'products', 'orders',
    'reports', 'analytics', 'billing', 'help', 'docs',
    'admin', 'api', 'webhooks', 'integrations', 'notifications',
  ];
  const actions = ['list', 'view', 'edit', 'create', 'export', 'import', 'archive'];

  for (let i = 0; i < count; i++) {
    const section = sections[i % sections.length];
    const action = actions[i % actions.length];
    const id = Math.floor(i / sections.length);

    switch (i % 8) {
      case 0: urls.push(`${baseUrl}/${section}`); break;
      case 1: urls.push(`${baseUrl}/${section}/${id}`); break;
      case 2: urls.push(`${baseUrl}/${section}/${id}/${action}`); break;
      case 3: urls.push(`${baseUrl}/${section}?page=${id}&per_page=25&sort=created_at&order=desc`); break;
      case 4: urls.push(`${baseUrl}/${section}/${id}/sub-${action}?tab=details&view=grid`); break;
      case 5: urls.push(`${baseUrl}/api/v2/${section}/${id}`); break;
      case 6: urls.push(`${baseUrl}/${section}/category-${id % 10}/item-${id}`); break;
      case 7: urls.push(`${baseUrl}/${section}/${id}#section-${i % 5}`); break;
    }
  }
  return urls;
}

/**
 * Generate URLs of varying path depth (2 to 7 segments).
 * Used to stress the route-tree builder with deep nesting.
 */
function generateDeepUrls(count: number): string[] {
  const urls: string[] = [];
  for (let i = 0; i < count; i++) {
    const depth = 2 + (i % 6);
    const segments = Array.from({ length: depth }, (_, j) => `level-${j}-${i % 20}`);
    urls.push(`https://app.example.com/${segments.join('/')}`);
  }
  return urls;
}

// ---------------------------------------------------------------------------
// Synthetic PageVisitResult + CrawlResult builders
// ---------------------------------------------------------------------------

function makePageVisit(url: string, depth: number, pageIndex: number): PageVisitResult {
  const parsedUrl = (() => {
    try { return new URL(url); } catch { return null; }
  })();
  const hostname = parsedUrl?.hostname ?? 'app.example.com';

  return {
    url,
    finalUrl: url,
    status: 'ok',
    httpStatus: 200,
    depth,
    discoveryMethod: depth === 0 ? 'entry' : 'link',
    visitedAt: '2026-04-20T00:00:00Z',
    durationMs: 250,
    pageScan: {
      url,
      statusCode: 200,
      title: `Page ${pageIndex}`,
      metaTags: [],
      headings: [{ level: 1, text: `Heading ${pageIndex}` }],
      landmarks: [{ role: 'main', tagName: 'main' }],
      links: [],
      interactiveElements: [],
      timing: { loadTime: 100, domContentLoaded: 80 },
      contentHash: `hash-${pageIndex}`,
      hashRoutingDetected: false,
    },
    networkLog: pageIndex % 3 === 0
      ? {
          pageUrl: url,
          requests: [
            {
              requestId: `r-${pageIndex}-1`,
              url: `https://${hostname}/api/v2/resource/${pageIndex}`,
              method: 'GET',
              headers: {},
              resourceType: 'xhr',
              classification: 'api',
              initiator: 'fetch',
            },
            {
              requestId: `r-${pageIndex}-2`,
              url: `https://${hostname}/api/v2/users/${pageIndex % 50}`,
              method: 'POST',
              headers: {},
              resourceType: 'xhr',
              classification: 'api',
              initiator: 'fetch',
            },
          ],
          responses: [
            {
              requestId: `r-${pageIndex}-1`,
              statusCode: 200,
              headers: { 'content-type': 'application/json' },
              contentType: 'application/json',
              bodySize: 500,
              timing: 42,
            },
          ],
          failedRequests: [],
          graphqlOperations: [],
          webSocketConnections: [],
          cookieMutations: [],
        }
      : undefined,
    formProbe: pageIndex % 7 === 0
      ? {
          pageUrl: url,
          forms: [
            {
              action: `/submit/${pageIndex}`,
              method: 'POST',
              isImplicit: false,
              fields: [
                { name: 'email', type: 'email', required: true },
                { name: 'password', type: 'password', required: true },
              ],
              validationMessages: [],
              wasHidden: false,
            },
          ],
        }
      : undefined,
    collectorErrors: [],
    navigationEdges: depth < 3 && pageIndex + 1 < 500
      ? [
          {
            from: url,
            to: `https://${hostname}/page-${pageIndex + 1}`,
            trigger: 'link' as const,
          },
        ]
      : [],
  };
}

function makeCrawlResult(pages: PageVisitResult[], targetUrl: string): CrawlResult {
  return {
    config: {
      targetUrl,
      depth: 5,
      maxPages: 1000,
      concurrency: 3,
      viewport: { width: 1280, height: 720 },
      followExternal: false,
      deepClick: false,
    },
    startedAt: '2026-04-20T00:00:00Z',
    finishedAt: '2026-04-20T00:05:00Z',
    durationMs: 300_000,
    pages,
    unvisitedUrls: [],
    errors: [],
    completionStatus: 'complete',
  };
}

// ---------------------------------------------------------------------------
// Pre-generated inputs (created once; bench loops reuse them)
// ---------------------------------------------------------------------------

const realistic10kUrls = generateRealisticUrls(10_000);
const deep1kUrls = generateDeepUrls(1000);
const realistic500Urls = generateRealisticUrls(500);

const pages500: PageVisitResult[] = realistic500Urls.map((u, i) =>
  makePageVisit(u, Math.min(5, Math.floor(i / 100)), i),
);
const crawlResult500 = makeCrawlResult(pages500, 'https://app.example.com/');

const pages1000Deep: PageVisitResult[] = deep1kUrls.map((u, i) =>
  makePageVisit(u, Math.min(6, i % 7), i),
);

// ---------------------------------------------------------------------------
// Frontier enqueue/dequeue (drives Frontier.enqueue → normalizeUrl → Set)
// ---------------------------------------------------------------------------

describe('Frontier enqueue/dequeue', () => {
  bench('enqueue 10000 URLs through Frontier (real normalizeUrl + dedup)', () => {
    const frontier = new Frontier({ maxDepth: 10, maxSeen: 200_000 });
    for (let i = 0; i < realistic10kUrls.length; i++) {
      frontier.enqueue({ url: realistic10kUrls[i], depth: 0 });
    }
  });

  bench('dequeue 10000 URLs from a pre-filled Frontier', () => {
    const frontier = new Frontier({ maxDepth: 10, maxSeen: 200_000 });
    for (let i = 0; i < realistic10kUrls.length; i++) {
      frontier.enqueue({ url: realistic10kUrls[i], depth: 0 });
    }
    while (!frontier.isEmpty) {
      frontier.dequeue();
    }
  });
});

// ---------------------------------------------------------------------------
// normalizeUrl (real implementation with its memoization cache)
// ---------------------------------------------------------------------------

describe('normalizeUrl', () => {
  bench('urlNormalization: 10000 calls with varied shapes (cache cold per iter)', () => {
    // Clear the cache each iteration so we measure steady-state work,
    // not just the cached-hit fast path.
    __clearNormalizeUrlCacheForTesting();
    for (let i = 0; i < realistic10kUrls.length; i++) {
      normalizeUrl(realistic10kUrls[i]);
    }
  });
});

// ---------------------------------------------------------------------------
// buildRouteTree (real assembler module)
// ---------------------------------------------------------------------------

describe('routeTree construction', () => {
  bench('routeTreeWith1000Urls: buildRouteTree over 1000 varying-depth URLs', () => {
    buildRouteTree(pages1000Deep, 'https://app.example.com/');
  });
});

// ---------------------------------------------------------------------------
// buildAssembledArtifacts (full assembler pipeline, 500 pages)
// ---------------------------------------------------------------------------

describe('AssembledArtifacts (500-page synthetic)', () => {
  bench('buildAssembledArtifacts over 500 synthetic PageVisitResults', () => {
    buildAssembledArtifacts(crawlResult500, pages500);
  });
});
