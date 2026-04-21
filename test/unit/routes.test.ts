/**
 * Unit tests for src/assembler/routes.ts
 */

import { describe, it, expect } from 'vitest';
import type { PageVisitResult } from '../../src/types/artifacts.js';
import { pagesToRouteInfos } from '../../src/assembler/routes.js';

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

describe('pagesToRouteInfos', () => {
  it('returns empty array for empty input', () => {
    expect(pagesToRouteInfos([])).toEqual([]);
  });

  it('filters out non-ok pages', () => {
    const pages = [
      pv({ url: 'https://a.com/', status: 'ok' }),
      pv({ url: 'https://a.com/x', status: 'http_error' }),
      pv({ url: 'https://a.com/y', status: 'timeout' }),
    ];
    const result = pagesToRouteInfos(pages);
    expect(result).toHaveLength(1);
    expect(result[0].url).toBe('https://a.com/');
  });

  it('uses pageScan.title when available, empty string otherwise', () => {
    const withScan = pv({
      url: 'https://a.com/1',
      pageScan: {
        url: 'https://a.com/1',
        statusCode: 200,
        title: 'Hello',
        metaTags: [],
        headings: [],
        landmarks: [],
        links: [],
        interactiveElements: [],
        timing: { loadTime: 0, domContentLoaded: 0 },
        contentHash: 'abc',
        hashRoutingDetected: false,
      },
    });
    const without = pv({ url: 'https://a.com/2' });
    const result = pagesToRouteInfos([withScan, without]);
    expect(result[0].title).toBe('Hello');
    expect(result[0].contentHash).toBe('abc');
    expect(result[1].title).toBe('');
    expect(result[1].contentHash).toBe('');
  });

  it('falls back to httpStatus when pageScan missing', () => {
    const p = pv({ url: 'https://a.com/', httpStatus: 201 });
    const [info] = pagesToRouteInfos([p]);
    expect(info.statusCode).toBe(201);
  });

  it('sets hasScreenshot when screenshot present', () => {
    const p = pv({
      url: 'https://a.com/',
      screenshot: {
        pageUrl: 'https://a.com/',
        fullPagePath: '/tmp/a.png',
        viewportPath: '/tmp/b.png',
        viewport: { width: 1280, height: 720 },
        fullPageHash: '',
        viewportHash: '',
        dimensions: { width: 1280, height: 2000 },
        fileSizeBytes: 100,
        modalDetected: false,
      },
    });
    const [info] = pagesToRouteInfos([p]);
    expect(info.hasScreenshot).toBe(true);
  });

  it('initializes formCount and apiCallCount to zero', () => {
    const [info] = pagesToRouteInfos([pv({})]);
    expect(info.formCount).toBe(0);
    expect(info.apiCallCount).toBe(0);
  });
});
