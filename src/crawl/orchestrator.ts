/**
 * Crawl orchestrator — the heart of M1.
 *
 * Coordinates browser launch, secure context creation, BFS frontier loop,
 * per-page navigation and scanning, SSRF protection, graceful shutdown,
 * and output generation.
 *
 * Error strategy:
 *   - Per-page errors are logged and the page is skipped (crawl continues).
 *   - SIGINT triggers graceful shutdown: stop loop, write partial results, close browser.
 *   - Fatal errors (browser crash, output dir unwritable) abort the crawl.
 */

import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { chromium } from 'playwright';
import type { Browser, BrowserContext, Page, Response } from 'playwright';

import type { ResolvedConfig } from '../types/config.js';
import type {
  CrawlResult,
  DigResult,
  PageVisitResult,
  PageScanResult,
  PageVisitStatus,
  AssembledArtifacts,
  RouteNode,
  RouteInfo,
  ApiEndpointGroup,
  ScreenshotManifestEntry,
} from '../types/artifacts.js';
import type { CrawlErrorEntry } from '../types/errors.js';
import type { FrontierEntry } from './frontier.js';

import { Frontier } from './frontier.js';
import { shouldCrawl } from './url-utils.js';
import { isBlockedUrl } from '../security/network-guard.js';
import {
  getSecureContextOptions,
  getSecureLaunchOptions,
  TOOL_VERSION,
} from '../security/browser-hardening.js';
import { logger } from '../utils/logger.js';

// Collectors
import { captureScreenshots } from '../collectors/screenshot-capturer.js';
import { probeForms } from '../collectors/form-prober.js';
import { createNetworkLogger } from '../collectors/network-logger.js';

// Assemblers & report generators
import { buildFlowGraph, generateMermaidDefinition } from '../assembler/flow-graph.js';
import { parameterizePath } from '../assembler/api-grouper.js';
import { generateOpenApiSpec, writeOpenApiSpec } from '../report/openapi-output.js';
import { generateReportHtml } from '../report/html/template.js';


// ---------------------------------------------------------------------------
// Init script injected into every page context.
// Provides DOM stability detection via MutationObserver.
// ---------------------------------------------------------------------------

const INIT_SCRIPT = `
(() => {
  // DOM stability detection — sets window.__pa_isDomStable when no mutations
  // have occurred for 500ms.
  let _paStableTimer = null;
  let _paIsStable = false;

  window.__pa_isDomStable = () => _paIsStable;

  const observer = new MutationObserver(() => {
    _paIsStable = false;
    if (_paStableTimer) clearTimeout(_paStableTimer);
    _paStableTimer = setTimeout(() => { _paIsStable = true; }, 500);
  });

  // Start observing once the DOM is ready.
  if (document.documentElement) {
    observer.observe(document.documentElement, {
      childList: true,
      subtree: true,
      attributes: true,
    });
  } else {
    document.addEventListener('DOMContentLoaded', () => {
      observer.observe(document.documentElement, {
        childList: true,
        subtree: true,
        attributes: true,
      });
    });
  }

  // Mark stable initially after a short delay (for static pages).
  _paStableTimer = setTimeout(() => { _paIsStable = true; }, 500);
})();
`;

// ---------------------------------------------------------------------------
// Types internal to the orchestrator
// ---------------------------------------------------------------------------

interface VisitResult {
  status: PageVisitStatus;
  url: string;
  finalUrl: string;
  httpStatus?: number;
  response?: Response;
  error?: string;
}

// ---------------------------------------------------------------------------
// Sleep utility
// ---------------------------------------------------------------------------

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ---------------------------------------------------------------------------
// Per-page navigation
// ---------------------------------------------------------------------------

async function visitPage(
  page: Page,
  entry: FrontierEntry,
  config: ResolvedConfig,
): Promise<VisitResult> {
  try {
    // Use 'load' NOT 'networkidle' (per blocker #7).
    const response = await page.goto(entry.url, {
      waitUntil: 'load',
      timeout: config.timeout,
    });

    if (!response) {
      return { status: 'no_response', url: entry.url, finalUrl: entry.url };
    }

    const finalUrl = response.url();
    const httpStatus = response.status();

    if (httpStatus >= 400) {
      return {
        status: 'http_error',
        url: entry.url,
        finalUrl,
        httpStatus,
        response,
      };
    }

    // Wait for DOM stability (500ms quiet period from MutationObserver).
    // Non-fatal if this times out — we proceed with what we have.
    await page
      .waitForFunction('window.__pa_isDomStable && window.__pa_isDomStable()', {
        timeout: 5000,
      })
      .catch(() => {
        logger.debug(`DOM stability timeout on ${entry.url} — proceeding anyway`);
      });

    return {
      status: 'ok',
      url: entry.url,
      finalUrl,
      httpStatus,
      response,
    };
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);

    if (message.includes('net::ERR_')) {
      return {
        status: 'network_error',
        url: entry.url,
        finalUrl: entry.url,
        error: message,
      };
    }
    if (message.includes('Timeout') || message.includes('timeout')) {
      return {
        status: 'timeout',
        url: entry.url,
        finalUrl: entry.url,
        error: message,
      };
    }

    return {
      status: 'network_error',
      url: entry.url,
      finalUrl: entry.url,
      error: message,
    };
  }
}

// ---------------------------------------------------------------------------
// Lightweight page scanner (inline for M1 — scanPage collector built in
// parallel will replace this once available).
//
// We attempt to dynamically import the real scanner. If not available,
// fall back to the built-in minimal implementation.
// ---------------------------------------------------------------------------

async function scanPage(page: Page, targetUrl: string): Promise<PageScanResult> {
  // Try the real collector first.
  try {
    const mod = await import('../collectors/page-scanner.js');
    if (typeof mod.scanPage === 'function') {
      return await mod.scanPage(page, targetUrl);
    }
  } catch {
    // Collector not yet available — use inline fallback.
  }

  return inlineScanPage(page);
}

/**
 * Minimal inline page scanner used when the full collector module
 * is not yet built. Extracts links, title, and basic metadata.
 */
async function inlineScanPage(page: Page): Promise<PageScanResult> {
  const url = page.url();

  const data = await page.evaluate(() => {
    const title = document.title || '';

    // Collect links
    const anchors = Array.from(document.querySelectorAll('a[href]'));
    const links = anchors
      .map((a) => {
        const el = a as HTMLAnchorElement;
        const href = el.href; // already resolved to absolute by the browser
        if (!href || href.startsWith('javascript:') || href.startsWith('mailto:')) {
          return null;
        }
        return {
          href,
          text: (el.textContent || '').trim().slice(0, 200),
          isExternal: el.origin !== window.location.origin,
          rel: el.rel || undefined,
        };
      })
      .filter(Boolean) as Array<{
        href: string;
        text: string;
        isExternal: boolean;
        rel?: string;
      }>;

    // Collect headings
    const headings = Array.from(document.querySelectorAll('h1, h2, h3, h4, h5, h6')).map((h) => ({
      level: parseInt(h.tagName[1], 10) as 1 | 2 | 3 | 4 | 5 | 6,
      text: (h.textContent || '').trim().slice(0, 500),
    }));

    // Collect meta tags
    const metaTags = Array.from(document.querySelectorAll('meta[name], meta[property]')).map((m) => {
      const el = m as HTMLMetaElement;
      return {
        name: el.name || undefined,
        property: el.getAttribute('property') || undefined,
        content: el.content || '',
      };
    });

    // Collect landmarks
    const landmarkRoles = ['banner', 'navigation', 'main', 'complementary', 'contentinfo', 'search', 'form', 'region'];
    const landmarks = Array.from(document.querySelectorAll('[role]'))
      .filter((el) => landmarkRoles.includes((el.getAttribute('role') || '').toLowerCase()))
      .map((el) => ({
        role: el.getAttribute('role')!,
        tagName: el.tagName.toLowerCase(),
        label: el.getAttribute('aria-label') || undefined,
      }));

    // Simple content hash (hash of innerText length + first 1000 chars)
    const textContent = (document.body?.innerText || '').slice(0, 10000);
    let hash = 0;
    for (let i = 0; i < textContent.length; i++) {
      const char = textContent.charCodeAt(i);
      hash = ((hash << 5) - hash + char) | 0;
    }
    const contentHash = Math.abs(hash).toString(16).padStart(8, '0');

    // Timing
    const perfEntry = performance.getEntriesByType('navigation')[0] as PerformanceNavigationTiming | undefined;
    const timing = {
      loadTime: perfEntry ? Math.round(perfEntry.loadEventEnd - perfEntry.startTime) : 0,
      domContentLoaded: perfEntry ? Math.round(perfEntry.domContentLoadedEventEnd - perfEntry.startTime) : 0,
      firstContentfulPaint: undefined as number | undefined,
    };
    const fcp = performance.getEntriesByName('first-contentful-paint')[0];
    if (fcp) {
      timing.firstContentfulPaint = Math.round(fcp.startTime);
    }

    // Hash routing detection
    const hashRoutingDetected = window.location.hash.startsWith('#/') || window.location.hash.startsWith('#!/');

    return {
      title,
      links,
      headings,
      metaTags,
      landmarks,
      contentHash,
      timing,
      hashRoutingDetected,
    };
  });

  return {
    url,
    statusCode: 200,
    title: data.title,
    metaTags: data.metaTags,
    headings: data.headings,
    landmarks: data.landmarks,
    links: data.links,
    interactiveElements: [],
    timing: data.timing,
    contentHash: data.contentHash,
    hashRoutingDetected: data.hashRoutingDetected,
  };
}

// ---------------------------------------------------------------------------
// Build a minimal route tree from page visit results
// ---------------------------------------------------------------------------

function buildRouteTree(pages: PageVisitResult[], targetUrl: string): RouteNode {
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

  // Simple flat tree: each page becomes a child of root.
  // The full Assembler will build a proper hierarchical tree.
  for (const page of pages) {
    if (page.url === targetUrl && page.pageScan) {
      // Fill root node from entry page.
      root.title = page.pageScan.title;
      root.statusCode = page.pageScan.statusCode;
      root.contentHash = page.pageScan.contentHash;
      root.headings = page.pageScan.headings;
      root.landmarks = page.pageScan.landmarks;
      root.hasScreenshot = !!page.screenshot;
      continue;
    }

    let segment: string;
    try {
      const parsed = new URL(page.url);
      segment = parsed.pathname.split('/').filter(Boolean).pop() || parsed.pathname;
    } catch {
      segment = page.url;
    }

    const node: RouteNode = {
      segment,
      url: page.url,
      title: page.pageScan?.title || '',
      statusCode: page.pageScan?.statusCode || page.httpStatus || 0,
      contentHash: page.pageScan?.contentHash || '',
      headings: page.pageScan?.headings || [],
      landmarks: page.pageScan?.landmarks || [],
      depth: page.depth,
      children: [],
      formCount: 0,
      apiCallCount: 0,
      hasScreenshot: !!page.screenshot,
    };
    root.children.push(node);
  }

  return root;
}

function pagesToRouteInfos(pages: PageVisitResult[]): RouteInfo[] {
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

// ---------------------------------------------------------------------------
// Helper: build ApiEndpointGroup[] from network logs across all pages
// ---------------------------------------------------------------------------

function buildApiEndpointGroupsFromPages(pages: PageVisitResult[]): ApiEndpointGroup[] {
  // Collect all API requests with their responses across all pages.
  const groupMap = new Map<string, {
    pattern: string;
    method: string;
    urls: string[];
    callingPages: Set<string>;
    statusCodes: Set<number>;
    contentTypes: Set<string>;
    isGraphQL: boolean;
    graphqlOps: Set<string>;
    firstRequest?: { url: string; headers: Record<string, string>; body?: string; contentType?: string };
    firstResponse?: { statusCode: number; headers: Record<string, string>; body?: string; contentType?: string; bodySize: number };
  }>();

  for (const page of pages) {
    if (!page.networkLog) continue;
    const log = page.networkLog;

    for (const req of log.requests) {
      if (req.classification !== 'api') continue;

      let urlPath: string;
      try {
        urlPath = new URL(req.url).pathname;
      } catch {
        urlPath = req.url;
      }

      const pattern = parameterizePath(urlPath);
      const key = `${req.method} ${pattern}`;

      let group = groupMap.get(key);
      if (!group) {
        group = {
          pattern,
          method: req.method,
          urls: [],
          callingPages: new Set(),
          statusCodes: new Set(),
          contentTypes: new Set(),
          isGraphQL: req.url.includes('graphql'),
          graphqlOps: new Set(),
        };
        groupMap.set(key, group);
      }

      group.urls.push(req.url);
      group.callingPages.add(page.url);

      const resp = log.responses.find(r => r.requestId === req.requestId);

      if (resp) {
        group.statusCodes.add(resp.statusCode);
        if (resp.contentType) group.contentTypes.add(resp.contentType);
      }

      // Store first request/response as example.
      if (!group.firstRequest) {
        group.firstRequest = {
          url: req.url,
          headers: req.headers,
          body: req.body,
          contentType: req.contentType,
        };
      }
      if (!group.firstResponse && resp) {
        group.firstResponse = {
          statusCode: resp.statusCode,
          headers: resp.headers,
          body: resp.body,
          contentType: resp.contentType,
          bodySize: resp.bodySize,
        };
      }
    }

    // Collect GraphQL operations.
    for (const gqlOp of log.graphqlOperations) {
      const key = `POST ${parameterizePath(new URL(gqlOp.endpointUrl).pathname)}`;
      const group = groupMap.get(key);
      if (group) {
        group.isGraphQL = true;
        group.graphqlOps.add(gqlOp.operationName);
      }
    }
  }

  // Convert to ApiEndpointGroup[].
  const result: ApiEndpointGroup[] = [];
  for (const g of groupMap.values()) {
    result.push({
      pattern: g.pattern,
      method: g.method,
      classification: 'api',
      observedUrls: g.urls,
      callCount: g.urls.length,
      callingPages: Array.from(g.callingPages),
      exampleRequest: g.firstRequest ?? {
        url: g.urls[0] ?? '',
        headers: {},
      },
      exampleResponse: g.firstResponse ?? {
        statusCode: 0,
        headers: {},
        bodySize: 0,
      },
      observedStatusCodes: Array.from(g.statusCodes),
      observedContentTypes: Array.from(g.contentTypes),
      isGraphQL: g.isGraphQL,
      graphqlOperations: g.graphqlOps.size > 0 ? Array.from(g.graphqlOps) : undefined,
    });
  }

  return result;
}

// ---------------------------------------------------------------------------
// Helper: build ScreenshotManifestEntry[] from pages
// ---------------------------------------------------------------------------

function buildScreenshotManifest(pages: PageVisitResult[], outputDir: string): ScreenshotManifestEntry[] {
  return pages
    .filter(p => p.screenshot && p.screenshot.fullPagePath)
    .map(p => {
      const ss = p.screenshot!;
      // Convert absolute paths to relative (from output dir).
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
// Build the assembled artifacts from crawl results
// ---------------------------------------------------------------------------

function buildAssembledArtifacts(
  crawlResult: CrawlResult,
  pages: PageVisitResult[],
): AssembledArtifacts {
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

  // Update route tree node counts.
  for (const node of [routeTree, ...routeTree.children]) {
    const pageForNode = pages.find(p => p.url === node.url);
    if (pageForNode) {
      node.formCount = pageForNode.formProbe?.forms.length ?? 0;
      node.apiCallCount = pageForNode.networkLog?.requests.filter(r => r.classification === 'api').length ?? 0;
      node.hasScreenshot = !!pageForNode.screenshot;
    }
  }

  // Update route info counts.
  const enrichedRoutes = routes.map(r => {
    const pageForRoute = pages.find(p => p.url === r.url);
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
            title: pages.find(p => p.url === n.url)?.pageScan?.title || '',
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

// ---------------------------------------------------------------------------
// Write output files
// ---------------------------------------------------------------------------

async function writeOutputFiles(
  outputDir: string,
  crawlResult: CrawlResult,
  pages: PageVisitResult[],
): Promise<{
  sitemapJson?: string;
}> {
  const paths: { sitemapJson?: string } = {};

  // Write sitemap.json
  const sitemap = pages
    .filter((p) => p.status === 'ok')
    .map((p) => ({
      url: p.url,
      title: p.pageScan?.title || '',
      depth: p.depth,
      statusCode: p.httpStatus,
      links: p.pageScan?.links.length ?? 0,
    }));

  const sitemapPath = path.join(outputDir, 'sitemap.json');
  await fs.writeFile(sitemapPath, JSON.stringify(sitemap, null, 2), 'utf-8');
  paths.sitemapJson = sitemapPath;

  // Write crawl summary
  const summary = {
    targetUrl: crawlResult.config.targetUrl,
    startedAt: crawlResult.startedAt,
    finishedAt: crawlResult.finishedAt,
    durationMs: crawlResult.durationMs,
    pagesVisited: crawlResult.pages.length,
    pagesDiscovered: crawlResult.pages.length + crawlResult.unvisitedUrls.length,
    completionStatus: crawlResult.completionStatus,
    errors: crawlResult.errors.length,
  };

  const summaryPath = path.join(outputDir, 'crawl-summary.json');
  await fs.writeFile(summaryPath, JSON.stringify(summary, null, 2), 'utf-8');

  return paths;
}

// ---------------------------------------------------------------------------
// Pre-flight checks
// ---------------------------------------------------------------------------

async function ensureOutputDir(outputDir: string): Promise<void> {
  await fs.mkdir(outputDir, { recursive: true });
}

async function checkBrowserInstallation(): Promise<void> {
  let browser: Browser | undefined;
  try {
    browser = await chromium.launch({ handleSIGINT: false, handleSIGTERM: false, handleSIGHUP: false });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(
      `Chromium browser not found. Run \`pa install\` to install it.\n\nDetails: ${message}`,
    );
  } finally {
    if (browser) {
      await browser.close();
    }
  }
}

// ---------------------------------------------------------------------------
// Main orchestrator
// ---------------------------------------------------------------------------

/**
 * Run a full crawl of the target URL.
 *
 * @param config - Fully validated and resolved crawl configuration.
 * @returns The assembled artifacts, output paths, and completion status.
 */
export async function dig(config: ResolvedConfig): Promise<DigResult> {
  const startedAt = new Date();
  const errors: CrawlErrorEntry[] = [];
  const pages: PageVisitResult[] = [];
  let completionStatus: CrawlResult['completionStatus'] = 'complete';
  let interrupted = false;
  let browser: Browser | undefined;
  let context: BrowserContext | undefined;

  // ------------------------------------------------------------------
  // SIGINT handler for graceful shutdown
  // ------------------------------------------------------------------
  const sigintHandler = () => {
    logger.warn('SIGINT received — shutting down gracefully...');
    interrupted = true;
    completionStatus = 'interrupted';
  };
  process.on('SIGINT', sigintHandler);

  try {
    // ----------------------------------------------------------------
    // 1. Pre-flight checks
    // ----------------------------------------------------------------
    logger.info(`Crawling ${config.targetUrl}...`);
    logger.info(`  depth=${config.depth}, maxPages=${config.maxPages}, concurrency=${config.concurrency}`);
    logger.info(`  viewport=${config.viewport.width}x${config.viewport.height}`);
    logger.info(`  output=${config.outputDir}, format=${config.format}`);

    await ensureOutputDir(config.outputDir);
    await checkBrowserInstallation();

    // ----------------------------------------------------------------
    // 2. Launch browser
    // ----------------------------------------------------------------
    browser = await chromium.launch(getSecureLaunchOptions());
    logger.debug('Browser launched');

    // ----------------------------------------------------------------
    // 3. Create secure browser context
    // ----------------------------------------------------------------
    const contextOptions = getSecureContextOptions({
      viewport: config.viewport,
      recordHar: config.noHar
        ? undefined
        : {
            path: path.join(config.outputDir, 'crawl.har'),
            content: 'embed',
            mode: 'minimal',
          },
    });

    context = await browser.newContext(contextOptions);

    // Inject init script for DOM stability detection.
    await context.addInitScript(INIT_SCRIPT);

    // Register popup handler on individual pages instead of context.
    // context.on('page') fires for ALL pages including ones we create with
    // context.newPage(), which would close them before we can use them.
    const frontier = new Frontier({ maxDepth: config.depth });

    logger.debug('Browser context created with secure defaults');

    // ----------------------------------------------------------------
    // 4. Initialize frontier
    // ----------------------------------------------------------------
    frontier.enqueue({ url: config.targetUrl, depth: 0 });
    logger.debug(`Frontier initialized with entry URL: ${config.targetUrl}`);

    // ----------------------------------------------------------------
    // 5. BFS Crawl Loop
    // ----------------------------------------------------------------
    let visitedCount = 0;
    const crawlStartTime = Date.now();

    while (!frontier.isEmpty && visitedCount < config.maxPages && !interrupted) {
      // Check global time limit.
      if (config.maxTime > 0) {
        const elapsed = (Date.now() - crawlStartTime) / 1000;
        if (elapsed >= config.maxTime) {
          logger.warn(`Max crawl time reached (${config.maxTime}s) — stopping`);
          completionStatus = 'max_time_reached';
          break;
        }
      }

      const entry = frontier.dequeue();
      if (!entry) break;

      // SSRF check
      if (!config.allowPrivate) {
        const blockResult = await isBlockedUrl(entry.url);
        if (blockResult.blocked) {
          logger.warn(`SSRF blocked: ${entry.url} — ${blockResult.reason}`);
          errors.push({
            timestamp: new Date().toISOString(),
            url: entry.url,
            code: 'ERR_SECURITY_BLOCK',
            message: blockResult.reason || 'Blocked by SSRF protection',
            securityReason: 'private_ip',
          });
          continue;
        }
      }

      // Create new page in context.
      const page = await context.newPage();
      const pageStartTime = Date.now();

      // Handle popups opened from this page (window.open, target="_blank").
      page.on('popup', async (popup) => {
        try {
          const popupUrl = popup.url();
          if (popupUrl && popupUrl !== 'about:blank') {
            logger.debug(`Popup detected: ${popupUrl}`);
            if (
              shouldCrawl(popupUrl, config.targetUrl, {
                include: config.include,
                exclude: config.exclude,
                followExternal: config.followExternal,
              })
            ) {
              frontier.enqueue({ url: popupUrl, depth: entry.depth + 1 });
            }
          }
          await popup.close();
        } catch {
          // Best-effort — popup may already be closed.
        }
      });
      const jsErrors: string[] = [];

      // Capture JS errors on the page (blocker #14).
      page.on('pageerror', (err) => {
        jsErrors.push(err.message);
        logger.debug(`JS error on ${entry.url}: ${err.message}`);
      });

      // Auto-dismiss dialogs.
      page.on('dialog', async (dialog) => {
        logger.debug(`Dialog on ${entry.url}: ${dialog.type()} "${dialog.message()}"`);
        await dialog.dismiss();
      });

      // Start network logger BEFORE navigation so it captures all requests.
      const networkLogger = createNetworkLogger(page, entry.url, {
        includeCookies: config.includeCookies,
      });
      networkLogger.start();

      // Visit the page.
      const visitResult = await visitPage(page, entry, config);
      visitedCount++;

      // Build the PageVisitResult.
      const pageVisitResult: PageVisitResult = {
        url: entry.url,
        finalUrl: visitResult.finalUrl,
        status: visitResult.status,
        httpStatus: visitResult.httpStatus,
        depth: entry.depth,
        referrer: entry.referrer,
        discoveryMethod: entry.referrer ? 'link' : 'entry',
        visitedAt: new Date(pageStartTime).toISOString(),
        durationMs: 0,
        collectorErrors: [],
        navigationEdges: [],
      };

      // If navigation succeeded, scan the page.
      if (visitResult.status === 'ok') {
        try {
          const scanResult = await scanPage(page, config.targetUrl);
          pageVisitResult.pageScan = scanResult;
          pageVisitResult.httpStatus = scanResult.statusCode;

          // Enqueue discovered links.
          for (const link of scanResult.links) {
            if (
              shouldCrawl(link.href, config.targetUrl, {
                include: config.include,
                exclude: config.exclude,
                followExternal: config.followExternal,
              })
            ) {
              const enqueued = frontier.enqueue({
                url: link.href,
                depth: entry.depth + 1,
                referrer: entry.url,
              });
              if (enqueued) {
                pageVisitResult.navigationEdges.push({
                  from: entry.url,
                  to: link.href,
                  trigger: 'link',
                  triggerText: link.text || undefined,
                });
              }
            }
          }
        } catch (err: unknown) {
          const message = err instanceof Error ? err.message : String(err);
          logger.warn(`Scanner error on ${entry.url}: ${message}`);
          pageVisitResult.collectorErrors.push({
            collector: 'page-scanner',
            message,
          });
        }

        // Screenshot capture (if enabled).
        if (!config.noScreenshots) {
          try {
            const screenshotsDir = path.join(config.outputDir, 'screenshots');
            const ssResult = await captureScreenshots(page, config.targetUrl, screenshotsDir, config.viewport);
            pageVisitResult.screenshot = ssResult;
          } catch (err: unknown) {
            const message = err instanceof Error ? err.message : String(err);
            logger.warn(`Screenshot error on ${entry.url}: ${message}`);
            pageVisitResult.collectorErrors.push({ collector: 'screenshot-capturer', message });
          }
        }

        // Form probing.
        try {
          const formResult = await probeForms(page, entry.url);
          pageVisitResult.formProbe = formResult;
        } catch (err: unknown) {
          const message = err instanceof Error ? err.message : String(err);
          logger.warn(`Form probe error on ${entry.url}: ${message}`);
          pageVisitResult.collectorErrors.push({ collector: 'form-prober', message });
        }
      } else {
        // Log navigation failures.
        const errorMessage = visitResult.error || `Navigation failed: ${visitResult.status}`;
        errors.push({
          timestamp: new Date().toISOString(),
          url: entry.url,
          code: 'ERR_NAVIGATION',
          message: errorMessage,
          status: visitResult.status === 'timeout' ? 'timeout' : 'network_error',
          httpStatus: visitResult.httpStatus,
        });
      }

      // Stop network logging (always, regardless of navigation outcome).
      try {
        const networkResult = networkLogger.stop();
        pageVisitResult.networkLog = networkResult;
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        logger.warn(`Network log error on ${entry.url}: ${message}`);
        pageVisitResult.collectorErrors.push({ collector: 'network-logger', message });
      }

      pageVisitResult.durationMs = Date.now() - pageStartTime;
      pages.push(pageVisitResult);

      // Close the page.
      try {
        await page.close();
      } catch {
        // Best-effort — page may already be closed.
      }

      // Delay between pages.
      if (config.delay > 0 && !interrupted) {
        await sleep(config.delay);
      }

      // Log progress.
      const statusIcon = visitResult.status === 'ok' ? 'OK' : visitResult.status.toUpperCase();
      logger.info(
        `[${visitedCount}/${frontier.totalSeen}] ${statusIcon} ${entry.url}${
          entry.depth > 0 ? ` (depth ${entry.depth})` : ''
        }`,
      );
      if (visitResult.status !== 'ok' && visitResult.error) {
        logger.warn(`  Error: ${visitResult.error}`);
      }
    }

    // Determine completion status if not already set.
    if (!interrupted && completionStatus === 'complete') {
      if (visitedCount >= config.maxPages && !frontier.isEmpty) {
        completionStatus = 'max_pages_reached';
      }
    }

    // ----------------------------------------------------------------
    // 6. Teardown
    // ----------------------------------------------------------------
    logger.debug('Closing browser context...');
    if (context) {
      await context.close().catch((err: unknown) => {
        const message = err instanceof Error ? err.message : String(err);
        logger.warn(`Context close error (HAR may not be written): ${message}`);
      });
    }

    logger.debug('Closing browser...');
    if (browser) {
      await browser.close().catch((err: unknown) => {
        const message = err instanceof Error ? err.message : String(err);
        logger.warn(`Browser close error: ${message}`);
      });
    }

    // Nullify references so finally-block doesn't double-close.
    context = undefined;
    browser = undefined;

    // ----------------------------------------------------------------
    // 7. Generate output
    // ----------------------------------------------------------------
    const finishedAt = new Date();
    const durationMs = finishedAt.getTime() - startedAt.getTime();

    // Collect unvisited URLs from the frontier.
    const unvisitedUrls: string[] = [];
    while (!frontier.isEmpty) {
      const remaining = frontier.dequeue();
      if (remaining) unvisitedUrls.push(remaining.url);
    }

    const crawlResult: CrawlResult = {
      config: {
        targetUrl: config.targetUrl,
        depth: config.depth,
        maxPages: config.maxPages,
        concurrency: config.concurrency,
        viewport: config.viewport,
        followExternal: config.followExternal,
        deepClick: config.deepClick,
      },
      startedAt: startedAt.toISOString(),
      finishedAt: finishedAt.toISOString(),
      durationMs,
      pages,
      unvisitedUrls,
      errors,
      completionStatus,
    };

    // Write output files.
    let outputPaths: { sitemapJson?: string } = {};
    try {
      outputPaths = await writeOutputFiles(config.outputDir, crawlResult, pages);
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      logger.error(`Failed to write output files: ${message}`);
    }

    // Build assembled artifacts.
    const artifacts = buildAssembledArtifacts(crawlResult, pages);

    // Write additional output files (forms, api-map, flow graph, OpenAPI, report).
    try {
      // Forms JSON
      if (artifacts.forms.length > 0) {
        await fs.writeFile(
          path.join(config.outputDir, 'forms.json'),
          JSON.stringify(artifacts.forms, null, 2),
          'utf-8',
        );
        logger.info(`  Forms: ${artifacts.forms.length} found`);
      }

      // API endpoint map
      if (artifacts.apiEndpoints.length > 0) {
        await fs.writeFile(
          path.join(config.outputDir, 'api-map.json'),
          JSON.stringify(artifacts.apiEndpoints, null, 2),
          'utf-8',
        );
        logger.info(`  API endpoints: ${artifacts.apiEndpoints.length} groups`);
      }

      // Flow graph (Mermaid definition)
      const allEdges = pages.flatMap(p => p.navigationEdges);
      if (allEdges.length > 0) {
        const flowGraph = buildFlowGraph(allEdges, config.targetUrl);
        const mermaidDef = generateMermaidDefinition(flowGraph);
        await fs.writeFile(
          path.join(config.outputDir, 'flow-graph.mmd'),
          mermaidDef,
          'utf-8',
        );
        logger.info(`  Flow graph: ${flowGraph.nodes.length} nodes, ${flowGraph.edges.length} edges`);
      }

      // OpenAPI spec
      if (artifacts.apiEndpoints.length > 0) {
        try {
          const spec = generateOpenApiSpec(artifacts.apiEndpoints, {
            title: `API - ${config.targetUrl}`,
            targetUrl: config.targetUrl,
          });
          await writeOpenApiSpec(spec, path.join(config.outputDir, 'openapi.json'));
          logger.info('  OpenAPI spec written');
        } catch (err: unknown) {
          logger.warn(`OpenAPI generation failed: ${err instanceof Error ? err.message : String(err)}`);
        }
      }

      // HTML report
      try {
        const reportInput = {
          targetUrl: config.targetUrl,
          crawlDate: new Date(crawlStartTime).toISOString(),
          duration: (Date.now() - crawlStartTime) / 1000,
          pagesVisited: visitedCount,
          errors: errors.length,
          pages: pages
            .filter(p => p.status === 'ok')
            .map(p => ({
              url: p.url,
              title: p.pageScan?.title || '',
              status: p.httpStatus || 0,
              depth: p.depth,
              contentHash: p.pageScan?.contentHash,
            })),
          forms: artifacts.forms.map(f => ({
            url: f.action || '',
            action: f.action,
            method: f.method,
            fields: f.fields.map(field => ({
              name: field.name,
              type: field.type,
              required: field.required,
            })),
          })),
          apiEndpoints: artifacts.apiEndpoints.map(g => ({
            pattern: g.pattern,
            method: g.method,
            examples: g.observedUrls.slice(0, 5).map(url => ({
              url,
              status: g.exampleResponse.statusCode,
            })),
          })),
          // Mermaid-to-SVG rendering is a later feature; omit flow diagram from HTML for now.
          flowDiagramSvg: undefined,
        };
        const html = generateReportHtml(reportInput);
        await fs.writeFile(path.join(config.outputDir, 'report.html'), html, 'utf-8');
        logger.success(`HTML report: ${path.join(config.outputDir, 'report.html')}`);
      } catch (err: unknown) {
        logger.warn(`Report generation failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      logger.warn(`Additional output generation error: ${message}`);
    }

    // Log summary.
    logger.success(
      `Crawl complete: ${pages.length} pages visited, ${frontier.totalSeen} URLs discovered, ${errors.length} errors`,
    );
    logger.info(`  Duration: ${(durationMs / 1000).toFixed(1)}s`);
    logger.info(`  Status: ${completionStatus}`);
    logger.info(`  Output: ${config.outputDir}`);

    // ----------------------------------------------------------------
    // 8. Return DigResult
    // ----------------------------------------------------------------
    return {
      artifacts,
      outputPaths: {
        outputDir: config.outputDir,
        sitemapJson: outputPaths.sitemapJson,
        harFile: config.noHar ? undefined : path.join(config.outputDir, 'crawl.har'),
      },
      errors,
      completionStatus,
    };
  } catch (err: unknown) {
    // Fatal error — still try to write partial results.
    const message = err instanceof Error ? err.message : String(err);
    logger.error(`Fatal crawl error: ${message}`);

    errors.push({
      timestamp: new Date().toISOString(),
      url: config.targetUrl,
      code: 'ERR_FATAL',
      message,
    });

    const finishedAt = new Date();
    const durationMs = finishedAt.getTime() - startedAt.getTime();

    // Attempt to write partial output.
    try {
      await ensureOutputDir(config.outputDir);
      await writeOutputFiles(
        config.outputDir,
        {
          config: {
            targetUrl: config.targetUrl,
            depth: config.depth,
            maxPages: config.maxPages,
            concurrency: config.concurrency,
            viewport: config.viewport,
            followExternal: config.followExternal,
            deepClick: config.deepClick,
          },
          startedAt: startedAt.toISOString(),
          finishedAt: finishedAt.toISOString(),
          durationMs,
          pages,
          unvisitedUrls: [],
          errors,
          completionStatus: 'error',
        },
        pages,
      );
    } catch {
      // Best-effort — output may not be writable.
    }

    const artifacts = buildAssembledArtifacts(
      {
        config: {
          targetUrl: config.targetUrl,
          depth: config.depth,
          maxPages: config.maxPages,
          concurrency: config.concurrency,
          viewport: config.viewport,
          followExternal: config.followExternal,
          deepClick: config.deepClick,
        },
        startedAt: startedAt.toISOString(),
        finishedAt: finishedAt.toISOString(),
        durationMs,
        pages,
        unvisitedUrls: [],
        errors,
        completionStatus: 'error',
      },
      pages,
    );

    return {
      artifacts,
      outputPaths: { outputDir: config.outputDir },
      errors,
      completionStatus: 'error',
    };
  } finally {
    // Remove SIGINT handler.
    process.removeListener('SIGINT', sigintHandler);

    // Ensure browser resources are freed.
    if (context) {
      await context.close().catch(() => {});
    }
    if (browser) {
      await browser.close().catch(() => {});
    }
  }
}
