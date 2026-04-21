/**
 * Assembled artifact builder.
 *
 * Takes the raw CrawlResult + PageVisitResult[] produced by the orchestrator
 * and assembles the structured output consumed by the report generator:
 *   - route tree (hierarchical)
 *   - flat route list with per-page counts
 *   - deduplicated forms
 *   - grouped API endpoints
 *   - GraphQL operations / WebSocket connections
 *   - flow graph + Mermaid definition
 *   - screenshot manifest
 *
 * No orchestration, no I/O. Pure data transformation so this layer is
 * trivially testable.
 */

import * as path from 'node:path';

import type {
  AssembledArtifacts,
  CrawlResult,
  PageVisitResult,
  RouteNode,
  ScreenshotManifestEntry,
} from '../types/artifacts.js';

import { TOOL_VERSION } from '../security/browser-hardening.js';
import { buildFlowGraph, generateMermaidDefinition } from './flow-graph.js';
import { buildRouteTree } from './route-tree.js';
import { pagesToRouteInfos } from './routes.js';
import { buildApiEndpointGroupsFromPages } from './api-endpoints.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Build a screenshot manifest with paths made relative to `outputDir` so
 * they can be safely embedded in reports and bundles.
 */
export function buildScreenshotManifest(
  pages: PageVisitResult[],
  outputDir: string,
): ScreenshotManifestEntry[] {
  return pages
    .filter(p => p.screenshot && p.screenshot.fullPagePath)
    .map(p => {
      const ss = p.screenshot!;
      const fullPageRel = path.relative(outputDir, ss.fullPagePath);
      const viewportRel = path.relative(outputDir, ss.viewportPath);

      return {
        url: ss.pageUrl,
        title: p.pageScan?.title || '',
        fullPagePath: fullPageRel,
        viewportPath: viewportRel,
        viewport: ss.viewport,
        dimensions: ss.dimensions,
        fullPageHash: ss.fullPageHash,
        thumbnailBase64: '', // Thumbnail generation is a separate step (not in M1).
      };
    });
}

// ---------------------------------------------------------------------------
// Main entry point
// ---------------------------------------------------------------------------

/**
 * Build the complete AssembledArtifacts from a CrawlResult.
 *
 * This is the pure data-transformation layer. Given the raw per-page
 * results from the crawl, it produces the structured, deduplicated
 * artifacts that feed the report generators and the diff engine.
 */
export function buildAssembledArtifacts(
  crawlResult: CrawlResult,
  pages: PageVisitResult[],
): AssembledArtifacts {
  // O(1) page lookup by URL — avoids O(n²) when enriching routes and tree nodes.
  const pageByUrl = new Map<string, PageVisitResult>();
  for (const p of pages) {
    pageByUrl.set(p.url, p);
  }

  const routeTree = buildRouteTree(pages, crawlResult.config.targetUrl);
  const routes = pagesToRouteInfos(pages);

  // Collect forms from all pages.
  const allForms = pages
    .filter(p => p.formProbe)
    .flatMap(p => p.formProbe!.forms);

  // Build API endpoint groups from network logs.
  const apiEndpoints = buildApiEndpointGroupsFromPages(pages);

  // Collect GraphQL operations from all pages.
  const allGraphqlOps = pages
    .filter(p => p.networkLog)
    .flatMap(p => p.networkLog!.graphqlOperations);

  // Collect WebSocket connections from all pages.
  const allWebSockets = pages
    .filter(p => p.networkLog)
    .flatMap(p => p.networkLog!.webSocketConnections);

  // Build flow graph from navigation edges.
  const allEdges = pages.flatMap(p => p.navigationEdges);
  const flowGraph = allEdges.length > 0
    ? buildFlowGraph(allEdges, crawlResult.config.targetUrl)
    : undefined;

  // Generate Mermaid definition.
  const mermaidDef = flowGraph ? generateMermaidDefinition(flowGraph) : '';

  // Build screenshot manifest.
  const screenshots = buildScreenshotManifest(pages, crawlResult.config.targetUrl);

  // Recursively enrich route tree node counts using the pageByUrl index.
  const enrichRouteNode = (node: RouteNode): void => {
    const pageForNode = node.url ? pageByUrl.get(node.url) : undefined;
    if (pageForNode) {
      node.formCount = pageForNode.formProbe?.forms.length ?? 0;
      node.apiCallCount = pageForNode.networkLog?.requests.filter(r => r.classification === 'api').length ?? 0;
      node.hasScreenshot = !!pageForNode.screenshot;
    }
    for (const child of node.children) {
      enrichRouteNode(child);
    }
  };
  enrichRouteNode(routeTree);

  // Update route info counts.
  const enrichedRoutes = routes.map(r => {
    const pageForRoute = pageByUrl.get(r.url);
    return {
      ...r,
      formCount: pageForRoute?.formProbe?.forms.length ?? 0,
      apiCallCount: pageForRoute?.networkLog?.requests.filter(req => req.classification === 'api').length ?? 0,
      hasScreenshot: !!pageForRoute?.screenshot,
    };
  });

  return {
    meta: {
      toolVersion: TOOL_VERSION,
      targetUrl: crawlResult.config.targetUrl,
      crawlDate: crawlResult.startedAt,
      duration: crawlResult.durationMs,
      pagesVisited: pages.length,
      pagesDiscovered: crawlResult.pages.length + crawlResult.unvisitedUrls.length,
      formsFound: allForms.length,
      apiEndpointsFound: apiEndpoints.length,
      screenshotsTaken: screenshots.length,
      errorCount: crawlResult.errors.length,
      completionStatus: crawlResult.completionStatus,
      viewport: crawlResult.config.viewport,
    },
    routeTree,
    routes: enrichedRoutes,
    forms: allForms,
    apiEndpoints,
    graphqlOperations: allGraphqlOps,
    webSocketConnections: allWebSockets,
    flowGraph: flowGraph
      ? {
          nodes: flowGraph.nodes.map(n => ({
            url: n.url,
            title: pageByUrl.get(n.url)?.pageScan?.title || '',
            cluster: n.cluster ?? '/',
          })),
          edges: flowGraph.edges,
          entryPoint: flowGraph.entryUrl,
          deadEnds: flowGraph.nodes.filter(n => n.isExit).map(n => n.url),
          cycles: flowGraph.cycleNodes.length > 0 ? [flowGraph.cycleNodes] : [],
        }
      : {
          nodes: pages
            .filter(p => p.status === 'ok')
            .map(p => ({
              url: p.url,
              title: p.pageScan?.title || '',
              cluster: '/',
            })),
          edges: [],
          entryPoint: crawlResult.config.targetUrl,
          deadEnds: [],
          cycles: [],
        },
    flowDiagrams: {
      overview: { definition: mermaidDef },
      sections: [],
    },
    screenshots,
    errors: crawlResult.errors,
  };
}
