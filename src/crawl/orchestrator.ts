/**
 * Crawl orchestrator — the heart of M1.
 *
 * Coordinates the high-level flow of a crawl:
 *   1. Pre-flight (output dir, browser install check)
 *   2. Launch browser + build ContextPool with secure defaults + SSRF-safe
 *      route handler + DOM-stability init script
 *   3. Delegate the BFS loop to src/crawl/crawl-loop.ts (N concurrent workers)
 *   4. Drain the pool so every HAR file is flushed
 *   5. Merge per-context HAR files into one `crawl.har`
 *   6. Scrub the HAR for credentials
 *   7. Assemble artifacts + write output files
 *
 * Concurrency lives in the crawl loop, artifact assembly lives in the
 * assembler, file I/O lives in output-writer. This module is the glue.
 *
 * Error strategy:
 *   - Per-page errors are logged and the page is skipped (crawl continues).
 *   - SIGINT triggers graceful shutdown: abort the loop, write partial
 *     results, close browser.
 *   - Fatal errors (browser crash, output dir unwritable) are handled by
 *     src/crawl/fatal-handler.ts so both paths produce the same shape.
 */

import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { chromium } from 'playwright';
import type { Browser, BrowserContext } from 'playwright';

import type { ResolvedConfig } from '../types/config.js';
import type { CrawlResult, DigResult, PageVisitResult } from '../types/artifacts.js';
import type { CrawlErrorEntry } from '../types/errors.js';

import { Frontier } from './frontier.js';
import { ContextPool } from './context-pool.js';
import { runCrawlLoop } from './crawl-loop.js';
import { mergeHarFiles } from './har-merger.js';
import { buildCrawlResult, handleFatalCrawlFailure } from './fatal-handler.js';
import { writeCrawlOutputs } from './output-writer.js';

import { getSecureContextOptions, getSecureLaunchOptions } from '../security/browser-hardening.js';
import { scrubHarFile } from '../security/har-scrubber.js';
import { createNetworkGuard } from '../security/network-guard.js';
import { InstallationError } from '../types/errors.js';
import { logger } from '../utils/logger.js';
import { CollectorRegistry } from '../plugins/registry.js';

// Assemblers
import { buildAssembledArtifacts } from '../assembler/artifacts.js';
import { buildRouteTree } from '../assembler/route-tree.js';

// Re-export buildRouteTree for tests that imported it from the old location.
export { buildRouteTree };

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
// Pre-flight checks
// ---------------------------------------------------------------------------

async function ensureOutputDir(outputDir: string): Promise<void> {
  await fs.mkdir(outputDir, { recursive: true });
}

/**
 * Patterns Playwright uses when the Chromium binary is missing. We match
 * these to distinguish "browser not installed" from all other launch
 * failures (crashes, OOM, etc.), because the former has a friendly fix.
 */
const INSTALLATION_ERROR_PATTERNS = [
  /ENOENT/i,
  /Executable doesn't exist/i,
  /Failed to launch/i,
  /browserType\.launch/i,
];

/**
 * Launch Chromium with the project's secure defaults. If the binary is
 * missing, throw a friendly InstallationError directing the user to
 * `pa install`. Any other launch failure is rethrown unchanged.
 *
 * Replaces the previous `checkBrowserInstallation()` probe which launched
 * and closed a throwaway browser just to verify the install — that cost
 * 600-1500ms on every CLI invocation, on top of the real launch that
 * immediately followed. Now the real launch itself is the check.
 */
async function launchBrowserOrThrowFriendly(): Promise<Browser> {
  try {
    return await chromium.launch(getSecureLaunchOptions());
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    if (INSTALLATION_ERROR_PATTERNS.some((p) => p.test(message))) {
      throw new InstallationError(
        `Chromium browser not found. Run \`pa install\` to install it.\n\nDetails: ${message}`,
        { cause: err instanceof Error ? err : undefined },
      );
    }
    throw err;
  }
}

// ---------------------------------------------------------------------------
// HAR helpers
// ---------------------------------------------------------------------------

/**
 * Produce a stable per-context HAR path inside the output dir. With N
 * contexts in the pool we'd otherwise clobber a single crawl.har.
 */
function perContextHarPath(outputDir: string, index: number): string {
  return path.join(outputDir, `crawl.har.${index}.partial`);
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
  const pages: PageVisitResult[] = [];
  const errors: CrawlErrorEntry[] = [];
  let browser: Browser | undefined;
  let pool: ContextPool | undefined;

  // Track which per-context HAR files we have asked Playwright to create,
  // so we know what to merge at teardown.
  const harPaths: string[] = [];

  // SIGINT -> AbortController so the loop stops picking up new work.
  const sigintController = new AbortController();
  const sigintHandler = () => {
    logger.warn('SIGINT received — shutting down gracefully...');
    sigintController.abort();
  };
  process.on('SIGINT', sigintHandler);

  try {
    // ----------------------------------------------------------------
    // 1. Pre-flight
    // ----------------------------------------------------------------
    logger.info(`Crawling ${config.targetUrl}...`);
    logger.info(`  depth=${config.depth}, maxPages=${config.maxPages}, concurrency=${config.concurrency}`);
    logger.info(`  viewport=${config.viewport.width}x${config.viewport.height}`);
    logger.info(`  output=${config.outputDir}, format=${config.format}`);

    await ensureOutputDir(config.outputDir);

    // ----------------------------------------------------------------
    // 2. Launch browser
    //
    // Single launch attempt — if the binary is missing, this is where we
    // find out. No separate probe that doubles startup latency.
    // ----------------------------------------------------------------
    browser = await launchBrowserOrThrowFriendly();
    logger.debug('Browser launched');

    // ----------------------------------------------------------------
    // 3. Build ContextPool
    //
    // Each context gets its own HAR (if enabled) so multiple contexts do
    // not race to write the same file. We merge them at teardown.
    //
    // A single session-wide DNS cache is shared across every context so
    // that rebinding detection is meaningful across the whole crawl, not
    // just within one context.
    // ----------------------------------------------------------------
    let harIndex = 0;
    const dnsCache = new Map<string, string>();

    pool = new ContextPool(browser, {
      concurrency: Math.max(1, config.concurrency),
      recycleAfter: 50,
      // Cast: ContextPool accepts an open bag (Record<string, unknown>) but
      // Playwright's BrowserContextOptions is a struct type. The values are
      // the same at runtime.
      contextOptions: getSecureContextOptions({ viewport: config.viewport }) as unknown as Record<string, unknown>,
      setupContext: async (ctx) => {
        // Route-level SSRF guard: every outbound subresource request (not
        // just top-level navigations) passes through the network guard
        // before the browser issues it. This blocks an attacker page from
        // fetching private-network resources via <img>, fetch(), <iframe>,
        // etc. The pre-dequeue isBlockedUrl() in crawl-loop is the first
        // line of defense; this is the second.
        await ctx.route('**', createNetworkGuard({
          allowPrivate: config.allowPrivate,
          dnsCache,
        }));
        await ctx.addInitScript(INIT_SCRIPT);
      },
    });

    // Because recordHar is only settable via newContext options and our
    // pool reuses the same options for every context, we take a different
    // strategy for multi-context HAR recording: create the first context
    // with the "canonical" recordHar path, and for any additional contexts
    // that will be created later (when worker count > 1), we build a new
    // pool option that points each to a unique file.
    //
    // Simpler approach that keeps the invariant: replace the whole pool's
    // contextOptions.recordHar with a factory-ish thunk. Since Playwright
    // doesn't accept thunks, we instead intercept newContext by wrapping
    // the browser.
    //
    // Wrap the pool's setupContext path so the *first* newContext() call
    // uses recordHar path crawl.har.0.partial, the next crawl.har.1.partial,
    // etc. We accomplish that by constructing a fresh ContextPool per
    // concurrency slot is overkill — instead, monkeypatch browser.newContext
    // via our own wrapper.
    //
    // Bail early: for the single-context case (concurrency === 1) we keep
    // the original path crawl.har. For concurrency > 1, we route each
    // context to a numbered partial.
    const realNewContext = browser.newContext.bind(browser);
    (browser as unknown as { newContext: typeof realNewContext }).newContext = async (opts) => {
      const merged = { ...(opts ?? {}) };
      if (!config.noHar) {
        const harPath = perContextHarPath(config.outputDir, harIndex++);
        harPaths.push(harPath);
        merged.recordHar = {
          path: harPath,
          content: config.harIncludeBodies ? 'embed' : 'omit',
          mode: 'minimal',
        };
      }
      return realNewContext(merged);
    };

    // ----------------------------------------------------------------
    // 4. Initialize frontier
    // ----------------------------------------------------------------
    const frontier = new Frontier({ maxDepth: config.depth });
    frontier.enqueue({ url: config.targetUrl, depth: 0 });
    logger.debug(`Frontier initialized with entry URL: ${config.targetUrl}`);

    // ----------------------------------------------------------------
    // 5. Run the crawl loop
    //
    // Build a collector registry from `config.collectors` (programmatic API
    // only — the CLI wires specific vetted collectors via its own flags).
    // An empty registry is equivalent to not passing one.
    // ----------------------------------------------------------------
    const registry = new CollectorRegistry();
    if (config.collectors) {
      for (const c of config.collectors) {
        registry.register(c);
      }
    }

    const loopResult = await runCrawlLoop({
      frontier,
      pool,
      config,
      abortSignal: sigintController.signal,
      collectors: registry.size > 0 ? registry : undefined,
    });

    pages.push(...loopResult.pages);
    errors.push(...loopResult.errors);

    // ----------------------------------------------------------------
    // 6. Determine completion status.
    //
    // Prefer the more-specific loop-reported status over 'complete' when
    // the loop bailed on a budget.
    // ----------------------------------------------------------------
    let completionStatus: CrawlResult['completionStatus'] = loopResult.completionStatus;
    if (sigintController.signal.aborted) {
      completionStatus = 'interrupted';
    }

    // ----------------------------------------------------------------
    // 7. Drain pool (flushes HAR files to disk)
    // ----------------------------------------------------------------
    logger.debug('Draining context pool...');
    await pool.drain();
    pool = undefined;

    logger.debug('Closing browser...');
    await browser.close().catch((err: unknown) => {
      const message = err instanceof Error ? err.message : String(err);
      logger.warn(`Browser close error: ${message}`);
    });
    browser = undefined;

    // ----------------------------------------------------------------
    // 8. Compose CrawlResult
    // ----------------------------------------------------------------
    const finishedAt = new Date();

    // Collect unvisited URLs for the report (pages that remained in the
    // frontier when the loop exited).
    const unvisitedUrls: string[] = [];
    while (!frontier.isEmpty) {
      const remaining = frontier.dequeue();
      if (remaining) unvisitedUrls.push(remaining.url);
    }

    const crawlResult = buildCrawlResult(
      config,
      startedAt,
      finishedAt,
      pages,
      unvisitedUrls,
      errors,
      completionStatus,
    );

    // ----------------------------------------------------------------
    // 9. Assemble artifacts and write outputs
    // ----------------------------------------------------------------
    const artifacts = buildAssembledArtifacts(crawlResult, pages);

    const writtenFiles = await writeCrawlOutputs(
      config.outputDir,
      crawlResult,
      pages,
      artifacts,
      {
        prettyJson: config.prettyJson,
        pagesVisited: pages.length,
      },
    );

    // ----------------------------------------------------------------
    // 10. Log summary
    // ----------------------------------------------------------------
    logger.success(
      `Crawl complete: ${pages.length} pages visited, ${frontier.totalSeen + pages.length} URLs seen, ${errors.length} errors`,
    );
    logger.info(`  Duration: ${(crawlResult.durationMs / 1000).toFixed(1)}s`);
    logger.info(`  Status: ${completionStatus}`);
    logger.info(`  Output: ${config.outputDir}`);

    return {
      artifacts,
      outputPaths: {
        outputDir: config.outputDir,
        sitemapJson: writtenFiles.sitemapJson,
        formsJson: writtenFiles.formsJson,
        apiMapJson: writtenFiles.apiMapJson,
        openapiJson: writtenFiles.openapiJson,
        flowGraphMmd: writtenFiles.flowGraphMmd,
        reportHtml: writtenFiles.reportHtml,
        harFile: config.noHar ? undefined : path.join(config.outputDir, 'crawl.har'),
      },
      errors,
      completionStatus,
    };
  } catch (err: unknown) {
    return handleFatalCrawlFailure({
      error: err,
      config,
      startedAt,
      pages,
      errors,
    });
  } finally {
    process.removeListener('SIGINT', sigintHandler);

    // Ensure browser resources are freed even on fatal error. We always
    // drain+close so HAR files flush before the merge below.
    if (pool) {
      await pool.drain().catch(() => {});
    }
    if (browser) {
      await browser.close().catch(() => {});
    }

    // Merge per-context HAR files into a single crawl.har, then scrub.
    if (!config.noHar) {
      const targetHar = path.join(config.outputDir, 'crawl.har');
      try {
        if (harPaths.length > 0) {
          await mergeHarFiles(harPaths, targetHar);
        }
      } catch (mergeErr: unknown) {
        const message = mergeErr instanceof Error ? mergeErr.message : String(mergeErr);
        logger.warn(`HAR merge failed: ${message}`);
      }
      try {
        await scrubHarFile(targetHar, { includeCookies: config.includeCookies });
      } catch (scrubErr: unknown) {
        const message = scrubErr instanceof Error ? scrubErr.message : String(scrubErr);
        logger.warn(`HAR scrub failed: ${message}`);
      }
    }
  }
}
