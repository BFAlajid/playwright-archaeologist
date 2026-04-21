/**
 * Route info builder — flat list of visited routes.
 *
 * Converts successful PageVisitResults into RouteInfo entries for the
 * flat route list in AssembledArtifacts. Counts (formCount, apiCallCount,
 * hasScreenshot) are zero-initialised here and enriched downstream.
 */

import type { PageVisitResult, RouteInfo } from '../types/artifacts.js';

/**
 * Produce a flat list of RouteInfo from PageVisitResult[].
 *
 * Only pages with status 'ok' are included. Form/API/screenshot counts
 * start at zero; callers enrich them using the per-page data.
 */
export function pagesToRouteInfos(pages: PageVisitResult[]): RouteInfo[] {
  return pages
    .filter((p) => p.status === 'ok')
    .map((p) => ({
      url: p.url,
      title: p.pageScan?.title || '',
      statusCode: p.pageScan?.statusCode || p.httpStatus || 0,
      contentHash: p.pageScan?.contentHash || '',
      depth: p.depth,
      formCount: 0,
      apiCallCount: 0,
      hasScreenshot: !!p.screenshot,
      discoveryMethod: p.discoveryMethod,
    }));
}
