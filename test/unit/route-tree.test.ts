/**
 * Unit tests for src/assembler/route-tree.ts
 *
 * The hierarchical route tree nests pages that share a path prefix under
 * the same parent. Tests cover: empty input, shared-prefix nesting, intermediate
 * node creation when a parent URL was not crawled, and URL parse failures.
 */

import { describe, it, expect } from 'vitest';
import type { PageVisitResult } from '../../src/types/artifacts.js';
import { buildRouteTree } from '../../src/assembler/route-tree.js';

function pv(url: string, depth: number = 0): PageVisitResult {
  return {
    url,
    finalUrl: url,
    status: 'ok',
    httpStatus: 200,
    depth,
    discoveryMethod: 'entry',
    visitedAt: '2026-04-20T00:00:00Z',
    durationMs: 10,
    collectorErrors: [],
    navigationEdges: [],
    pageScan: {
      url,
      statusCode: 200,
      title: `Title for ${url}`,
      metaTags: [],
      headings: [],
      landmarks: [],
      links: [],
      interactiveElements: [],
      timing: { loadTime: 0, domContentLoaded: 0 },
      contentHash: 'hash',
      hashRoutingDetected: false,
    },
  };
}

describe('buildRouteTree (assembler/route-tree)', () => {
  it('returns a root node for an empty page list', () => {
    const tree = buildRouteTree([], 'https://example.com');
    expect(tree.segment).toBe('/');
    expect(tree.children).toEqual([]);
  });

  it('fills root node from the entry page', () => {
    const tree = buildRouteTree([pv('https://example.com/')], 'https://example.com/');
    expect(tree.statusCode).toBe(200);
    expect(tree.title).toBe('Title for https://example.com/');
  });

  it('nests /a/b under /a — shared prefix, no flat siblings', () => {
    const pages = [
      pv('https://example.com/a', 1),
      pv('https://example.com/a/b', 2),
    ];
    const tree = buildRouteTree(pages, 'https://example.com/');
    expect(tree.children).toHaveLength(1);
    const a = tree.children[0];
    expect(a.segment).toBe('a');
    expect(a.children).toHaveLength(1);
    expect(a.children[0].segment).toBe('b');
  });

  it('creates intermediate directory nodes when parent page was not visited', () => {
    const pages = [pv('https://example.com/a/b/c', 3)];
    const tree = buildRouteTree(pages, 'https://example.com/');
    const a = tree.children[0];
    expect(a.segment).toBe('a');
    expect(a.url).toBe(''); // not visited, so URL is empty
    const b = a.children[0];
    expect(b.segment).toBe('b');
    const c = b.children[0];
    expect(c.segment).toBe('c');
    expect(c.title).toBe('Title for https://example.com/a/b/c');
  });

  it('does not duplicate intermediate nodes when children share a prefix', () => {
    const pages = [
      pv('https://example.com/users/1', 2),
      pv('https://example.com/users/2', 2),
    ];
    const tree = buildRouteTree(pages, 'https://example.com/');
    expect(tree.children).toHaveLength(1);
    const users = tree.children[0];
    expect(users.segment).toBe('users');
    expect(users.children).toHaveLength(2);
  });

  it('hangs an unparseable URL off the root under its raw string', () => {
    const page = pv('not-a-url', 1);
    const tree = buildRouteTree([page], 'https://example.com/');
    expect(tree.children).toHaveLength(1);
    expect(tree.children[0].segment).toBe('not-a-url');
  });

  it('marks hasScreenshot on nodes when screenshot is present', () => {
    const page = pv('https://example.com/page', 1);
    page.screenshot = {
      pageUrl: page.url,
      fullPagePath: '/tmp/x.png',
      viewportPath: '/tmp/y.png',
      viewport: { width: 1280, height: 720 },
      fullPageHash: 'h1',
      viewportHash: 'h2',
      dimensions: { width: 1280, height: 2000 },
      fileSizeBytes: 1000,
      modalDetected: false,
    };
    const tree = buildRouteTree([page], 'https://example.com/');
    expect(tree.children[0].hasScreenshot).toBe(true);
  });
});
