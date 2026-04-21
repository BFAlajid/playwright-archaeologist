/**
 * Route tree builder.
 *
 * Takes per-page visit results and produces a hierarchical tree keyed by
 * URL path segments. Routes that share a prefix nest under the same parent
 * rather than being flat siblings (e.g. `/a` and `/a/b` produce
 * root -> a -> b).
 *
 * Extracted from the orchestrator in Wave 2 so the orchestrator only
 * coordinates; actual artifact assembly lives here.
 */

import type { PageVisitResult, RouteNode } from '../types/artifacts.js';

/**
 * Build a hierarchical route tree from page visit results.
 *
 * Each page's pathname is split into segments; nodes are created/walked from
 * the single shared root so routes that share a prefix nest under the same
 * parent (e.g. `/a` and `/a/b` produce root -> a -> b, not two root siblings).
 */
export function buildRouteTree(pages: PageVisitResult[], targetUrl: string): RouteNode {
  const root: RouteNode = {
    segment: '/',
    url: targetUrl,
    title: '',
    statusCode: 0,
    contentHash: '',
    headings: [],
    landmarks: [],
    depth: 0,
    children: [],
    formCount: 0,
    apiCallCount: 0,
    hasScreenshot: false,
  };

  /**
   * Populate a RouteNode's metadata from a PageVisitResult. Only applied when
   * the node directly corresponds to a visited page (leaf of its URL path).
   */
  function fillNodeFromPage(node: RouteNode, page: PageVisitResult): void {
    node.url = page.url;
    node.title = page.pageScan?.title ?? '';
    node.statusCode = page.pageScan?.statusCode ?? page.httpStatus ?? 0;
    node.contentHash = page.pageScan?.contentHash ?? '';
    node.headings = page.pageScan?.headings ?? [];
    node.landmarks = page.pageScan?.landmarks ?? [];
    node.depth = page.depth;
    node.hasScreenshot = !!page.screenshot;
  }

  // Index children by segment for O(1) lookup during tree walk.
  const childIndex = new WeakMap<RouteNode, Map<string, RouteNode>>();
  childIndex.set(root, new Map());

  function ensureChild(parent: RouteNode, segment: string, depthFromRoot: number): RouteNode {
    let index = childIndex.get(parent);
    if (!index) {
      index = new Map();
      childIndex.set(parent, index);
    }
    const existing = index.get(segment);
    if (existing) return existing;

    const child: RouteNode = {
      segment,
      url: '',
      title: '',
      statusCode: 0,
      contentHash: '',
      headings: [],
      landmarks: [],
      depth: depthFromRoot,
      children: [],
      formCount: 0,
      apiCallCount: 0,
      hasScreenshot: false,
    };
    parent.children.push(child);
    index.set(segment, child);
    childIndex.set(child, new Map());
    return child;
  }

  for (const page of pages) {
    let pathname: string;
    try {
      pathname = new URL(page.url).pathname;
    } catch {
      // If the URL can't be parsed, hang the page off the root under its raw URL.
      const child = ensureChild(root, page.url, 1);
      fillNodeFromPage(child, page);
      continue;
    }

    const segments = pathname.split('/').filter(Boolean);

    if (segments.length === 0) {
      // Root page — fill root directly.
      if (page.url === targetUrl || page.pageScan) {
        fillNodeFromPage(root, page);
      }
      continue;
    }

    let current = root;
    for (let i = 0; i < segments.length; i++) {
      current = ensureChild(current, segments[i], i + 1);
    }
    fillNodeFromPage(current, page);
  }

  return root;
}
