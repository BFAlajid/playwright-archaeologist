/**
 * Per-page visit pipeline.
 *
 * Given a ready-to-use BrowserContext and a frontier entry, this module
 * owns the full per-page flow:
 *   1. Create a new page in the context
 *   2. Register JS error / dialog / popup handlers
 *   3. Start a fresh network logger
 *   4. Navigate (goto) with timeout + wait-for-DOM-stable
 *   5. Scan DOM on success (collect links, forms, screenshots)
 *   6. Stop the network logger
 *   7. Close the page
 *
 * Returns both the PageVisitResult (destined for the pages[] array) and
 * a list of URLs the page wants to enqueue — the caller decides whether
 * to push them into the shared frontier. Returning them instead of
 * enqueueing inline keeps this module side-effect-free with respect to
 * the frontier and makes the crawl loop trivially switchable between
 * serial and concurrent execution.
 */

import type { BrowserContext, Page, Response } from 'playwright';

import type { ResolvedConfig } from '../types/config.js';
import type {
  NavigationEdge,
  PageVisitResult,
  PageVisitStatus,
} from '../types/artifacts.js';
import type { CrawlErrorEntry } from '../types/errors.js';
import type { FrontierEntry } from './frontier.js';

import { shouldCrawl } from './url-utils.js';
import { scanPage } from '../collectors/page-scanner.js';
import { captureScreenshots } from '../collectors/screenshot-capturer.js';
import { probeForms } from '../collectors/form-prober.js';
import { createNetworkLogger } from '../collectors/network-logger.js';
import { CollectorRegistry } from '../plugins/registry.js';
import { logger } from '../utils/logger.js';
import * as path from 'node:path';

// ---------------------------------------------------------------------------
// Internal navigation outcome
// ---------------------------------------------------------------------------

interface VisitOutcome {
  status: PageVisitStatus;
  url: string;
  finalUrl: string;
  httpStatus?: number;
  response?: Response;
  error?: string;
}

async function navigate(
  page: Page,
  entry: FrontierEntry,
  config: ResolvedConfig,
): Promise<VisitOutcome> {
  try {
    // Use 'load' NOT 'networkidle' — SPAs often never reach idle and we
    // wait on our own DOM-stability hook afterwards.
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
      return { status: 'http_error', url: entry.url, finalUrl, httpStatus, response };
    }

    // Wait for DOM stability (MutationObserver-based quiet period, set up
    // by the init script). Non-fatal if this times out.
    await page
      .waitForFunction('window.__pa_isDomStable && window.__pa_isDomStable()', {
        timeout: 5000,
      })
      .catch(() => {
        logger.debug(`DOM stability timeout on ${entry.url} — proceeding anyway`);
      });

    return { status: 'ok', url: entry.url, finalUrl, httpStatus, response };
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    if (message.includes('net::ERR_')) {
      return { status: 'network_error', url: entry.url, finalUrl: entry.url, error: message };
    }
    if (message.includes('Timeout') || message.includes('timeout')) {
      return { status: 'timeout', url: entry.url, finalUrl: entry.url, error: message };
    }
    return { status: 'network_error', url: entry.url, finalUrl: entry.url, error: message };
  }
}

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface VisitPageInput {
  context: BrowserContext;
  entry: FrontierEntry;
  config: ResolvedConfig;
  /**
   * Optional collector plugin registry. When provided, each registered
   * collector runs after the built-in scan/screenshots/forms/network
   * collectors, and its result is attached to `PageVisitResult.pluginData`
   * under the collector's name. A missing registry is equivalent to an
   * empty one — callers get identical behaviour and the legacy
   * `pluginData` field stays `undefined`.
   */
  collectors?: CollectorRegistry;
}

export interface VisitPageOutput {
  pageVisit: PageVisitResult;
  /** URLs the page discovered that are in-scope for the crawl. Caller enqueues. */
  discoveredUrls: Array<{ url: string; referrer: string; depth: number; triggerText?: string }>;
  /** Navigation-level errors (not collector errors, which go on the result). */
  navigationError?: CrawlErrorEntry;
}

// ---------------------------------------------------------------------------
// visitAndCollectPage — the public entry point
// ---------------------------------------------------------------------------

/**
 * Visit a single URL and run all per-page collectors against it.
 *
 * Does not touch the Frontier directly. Returns the PageVisitResult and
 * a list of discovered in-scope URLs for the caller to enqueue. This
 * keeps the function callable from either a serial or concurrent loop.
 */
export async function visitAndCollectPage(
  input: VisitPageInput,
): Promise<VisitPageOutput> {
  const { context, entry, config, collectors } = input;
  const pageStartTime = Date.now();

  const page = await context.newPage();
  const discoveredUrls: VisitPageOutput['discoveredUrls'] = [];

  // Capture popups: crawl their URL if in-scope, then close them so they
  // do not accumulate and eat resources.
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
          discoveredUrls.push({ url: popupUrl, referrer: entry.url, depth: entry.depth + 1 });
        }
      }
      await popup.close();
    } catch {
      // Best-effort — popup may already be closed.
    }
  });

  // Capture JS errors as metadata (not fatal).
  const jsErrors: string[] = [];
  page.on('pageerror', (err) => {
    jsErrors.push(err.message);
    logger.debug(`JS error on ${entry.url}: ${err.message}`);
  });

  // Auto-dismiss dialogs so navigation doesn't hang.
  page.on('dialog', async (dialog) => {
    logger.debug(`Dialog on ${entry.url}: ${dialog.type()} "${dialog.message()}"`);
    await dialog.dismiss();
  });

  // Start network logger before goto so it captures every request.
  const networkLogger = createNetworkLogger(page, entry.url, {
    includeCookies: config.includeCookies,
    captureJsBodies: config.captureJsBodies,
  });
  networkLogger.start();

  const visit = await navigate(page, entry, config);

  const pageVisit: PageVisitResult = {
    url: entry.url,
    finalUrl: visit.finalUrl,
    status: visit.status,
    httpStatus: visit.httpStatus,
    depth: entry.depth,
    referrer: entry.referrer,
    discoveryMethod: entry.referrer ? 'link' : 'entry',
    visitedAt: new Date(pageStartTime).toISOString(),
    durationMs: 0,
    collectorErrors: [],
    navigationEdges: [],
  };

  let navigationError: CrawlErrorEntry | undefined;

  if (visit.status === 'ok') {
    // Page scanner
    try {
      const scan = await scanPage(page, config.targetUrl, visit.response ?? null);
      pageVisit.pageScan = scan;
      pageVisit.httpStatus = scan.statusCode;

      for (const link of scan.links) {
        if (
          shouldCrawl(link.href, config.targetUrl, {
            include: config.include,
            exclude: config.exclude,
            followExternal: config.followExternal,
          })
        ) {
          discoveredUrls.push({
            url: link.href,
            referrer: entry.url,
            depth: entry.depth + 1,
            triggerText: link.text || undefined,
          });
        }
      }
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      logger.warn(`Scanner error on ${entry.url}: ${message}`);
      pageVisit.collectorErrors.push({ collector: 'page-scanner', message });
    }

    // Screenshots
    if (!config.noScreenshots) {
      try {
        const screenshotsDir = path.join(config.outputDir, 'screenshots');
        const ssResult = await captureScreenshots(
          page,
          config.targetUrl,
          screenshotsDir,
          config.viewport,
          { format: config.screenshotFormat },
        );
        pageVisit.screenshot = ssResult;
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        logger.warn(`Screenshot error on ${entry.url}: ${message}`);
        pageVisit.collectorErrors.push({ collector: 'screenshot-capturer', message });
      }
    }

    // Form probing
    try {
      const formResult = await probeForms(page, entry.url);
      pageVisit.formProbe = formResult;
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      logger.warn(`Form probe error on ${entry.url}: ${message}`);
      pageVisit.collectorErrors.push({ collector: 'form-prober', message });
    }

    // Collector plugins (run after built-ins so plugins see a stable page).
    // Missing registry == no plugins, zero behaviour change for legacy callers.
    if (collectors && collectors.size > 0) {
      const pluginResults = await collectors.runAll({
        page,
        url: entry.url,
        response: visit.response ?? null,
        startTime: pageStartTime,
      });
      const pluginData: Record<string, unknown> = {};
      const pluginErrors: Array<{ collector: string; message: string }> = [];
      for (const r of pluginResults) {
        if (r.error) {
          pluginErrors.push({ collector: r.name, message: r.error });
          logger.warn(`Plugin "${r.name}" error on ${entry.url}: ${r.error}`);
        } else {
          pluginData[r.name] = r.data;
        }
      }
      if (Object.keys(pluginData).length > 0) pageVisit.pluginData = pluginData;
      if (pluginErrors.length > 0) pageVisit.pluginErrors = pluginErrors;
    }
  } else {
    // Navigation failed — record an error for the top-level errors[] list.
    navigationError = {
      timestamp: new Date().toISOString(),
      url: entry.url,
      code: 'ERR_NAVIGATION',
      message: visit.error || `Navigation failed: ${visit.status}`,
      status: visit.status === 'timeout' ? 'timeout' : 'network_error',
      httpStatus: visit.httpStatus,
    };
  }

  // Stop network logger regardless of navigation outcome.
  try {
    pageVisit.networkLog = networkLogger.stop();
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    logger.warn(`Network log error on ${entry.url}: ${message}`);
    pageVisit.collectorErrors.push({ collector: 'network-logger', message });
  }

  pageVisit.durationMs = Date.now() - pageStartTime;

  // Close the page.
  try {
    await page.close();
  } catch {
    // Best-effort — page may already be closed.
  }

  // Build navigation edges from the discovered URLs for this page's
  // navigation edge list. The caller filters these against the frontier's
  // dedup before enqueueing.
  const edges: NavigationEdge[] = discoveredUrls
    .filter((d) => d.referrer === entry.url)
    .map((d) => ({
      from: entry.url,
      to: d.url,
      trigger: 'link',
      triggerText: d.triggerText,
    }));
  pageVisit.navigationEdges = edges;

  return { pageVisit, discoveredUrls, navigationError };
}
