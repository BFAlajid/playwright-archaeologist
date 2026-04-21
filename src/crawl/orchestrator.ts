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
import {
  createCheckpointState,
  deleteCheckpoint,
  readCheckpoint,
  setupAutoCheckpoint,
  writeCheckpoint,
} from './checkpoint.js';
import { hashConfig } from './config-hash.js';

import { getSecureContextOptions, getSecureLaunchOptions } from '../security/browser-hardening.js';
import { scrubHarFile } from '../security/har-scrubber.js';
import { createNetworkGuard } from '../security/network-guard.js';
import { CheckpointMismatchError, InstallationError } from '../types/errors.js';
import type { CheckpointState } from '../types/artifacts.js';
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

  // Checkpoint state — populated if --resume hydrates from disk, otherwise
  // starts empty. Referenced by the auto-checkpoint getState() closure.
  // Kept at function scope so the finally block can tear down the timer.
  let autoCheckpoint: { stop: () => void } | undefined;
  // Visited URLs carried over from a prior run (checkpoint resume).
  // Passed to the crawl loop to skip re-visiting.
  let priorVisited: Set<string> | undefined;
  // Progress counter the loop mutates each time a page finishes — the
  // auto-checkpoint closure reads it to produce a live snapshot.
  const progressSink = { pagesVisited: 0 };

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
    //
    // Per-context HAR paths are supplied via `contextOptionsFactory`:
    // each newly-created context gets a unique `crawl.har.N.partial`,
    // and we track the paths in `harPaths` so the finally block can
    // merge + scrub them into a single `crawl.har`. `recordHar` is only
    // settable through newContext options, which is why the factory
    // signature lives on the pool.
    // ----------------------------------------------------------------
    const dnsCache = new Map<string, string>();

    // Derive the entry hostname once for the same-site pinning heuristic.
    // A malformed targetUrl would already have been rejected by
    // normalizeEntryUrl() during config resolution.
    let entryHostname: string | undefined;
    try {
      entryHostname = new URL(config.targetUrl).hostname.replace(/^\[|\]$/g, '');
    } catch {
      entryHostname = undefined;
    }

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
        //
        // When `config.socketPinning` is true (default), first-party
        // GET/HEAD requests are fulfilled via a Node HTTPS agent that
        // connects directly to the pinned IP — closing the TOCTOU window
        // between our resolver and Playwright's own TCP connect.
        await ctx.route('**', createNetworkGuard({
          allowPrivate: config.allowPrivate,
          dnsCache,
          pinned: config.socketPinning && !config.allowPrivate,
          entryHostname,
        }));
        await ctx.addInitScript(INIT_SCRIPT);
      },
      contextOptionsFactory: config.noHar
        ? undefined
        : (index) => {
            const harPath = perContextHarPath(config.outputDir, index);
            harPaths.push(harPath);
            return {
              recordHar: {
                path: harPath,
                content: config.harIncludeBodies ? 'embed' : 'omit',
                mode: 'minimal',
              },
            };
          },
    });

    // ----------------------------------------------------------------
    // 4. Checkpoint resume (optional) + frontier initialization
    //
    // If --resume is set AND a checkpoint file exists in outputDir:
    //   - Verify configHash matches the current config. If not, throw
    //     CheckpointMismatchError (fatal — the user must choose to delete
    //     the checkpoint or rerun without --resume).
    //   - Hydrate the frontier with the prior run's pending URLs.
    //   - Seed `priorVisited` so the crawl loop skips already-done URLs.
    //   - Pre-populate `errors` with the prior run's errors.
    //   - Pre-populate `progressSink.pagesVisited` with the prior count
    //     so the live checkpoint snapshot stays monotonic.
    //
    // If a checkpoint file exists but --resume was NOT set, log a warning
    // and start fresh. Do NOT delete the checkpoint — the user may have
    // forgotten the flag and can rerun with it.
    // ----------------------------------------------------------------
    const configHash = hashConfig(config);
    const existingCheckpoint = await readCheckpoint(config.outputDir).catch((err: unknown) => {
      // readCheckpoint throws on malformed JSON or schema violations. A
      // corrupt checkpoint should not block a fresh crawl — warn and
      // proceed as if it was absent.
      const message = err instanceof Error ? err.message : String(err);
      logger.warn(`Failed to read checkpoint (ignoring): ${message}`);
      return null;
    });

    const frontier = new Frontier({ maxDepth: config.depth });

    if (config.resume && existingCheckpoint) {
      if (existingCheckpoint.configHash !== configHash) {
        throw new CheckpointMismatchError(
          configHash,
          existingCheckpoint.configHash,
          path.join(config.outputDir, '.checkpoint.json'),
        );
      }

      // Hydrate pending URLs from the checkpoint frontier. Order matters:
      // we enqueue in the original BFS order.
      for (const entry of existingCheckpoint.frontier) {
        frontier.enqueue({ url: entry.url, depth: entry.depth, referrer: entry.referrer });
      }

      priorVisited = new Set(existingCheckpoint.visited);
      errors.push(...existingCheckpoint.errors);
      progressSink.pagesVisited = existingCheckpoint.pagesVisited;

      logger.info(
        `Resuming from checkpoint: ${existingCheckpoint.frontier.length} URLs remaining, ` +
          `${existingCheckpoint.visited.length} already visited`,
      );

      // If the entry URL is neither in-frontier nor already-visited (e.g.,
      // the checkpoint was written before the entry URL was enqueued),
      // enqueue it so the resumed crawl has something to do.
      if (
        !priorVisited.has(config.targetUrl) &&
        !existingCheckpoint.frontier.some((e) => e.url === config.targetUrl)
      ) {
        frontier.enqueue({ url: config.targetUrl, depth: 0 });
      }
    } else {
      if (existingCheckpoint && !config.resume) {
        logger.warn(
          'Existing checkpoint found at .checkpoint.json but --resume was not set. ' +
            'Starting a fresh crawl. The checkpoint will be preserved.',
        );
      }
      frontier.enqueue({ url: config.targetUrl, depth: 0 });
    }
    logger.debug(`Frontier initialized with entry URL: ${config.targetUrl}`);

    // ----------------------------------------------------------------
    // 4b. Start auto-checkpoint timer
    //
    // Writes a snapshot of { frontier, visited, errors, pagesVisited }
    // to disk every 30s. The write itself is non-fatal; failures are
    // swallowed by setupAutoCheckpoint's internal error handler.
    //
    // The getState() closure reads live data from the orchestrator's
    // mutable state (pages[], errors[], progressSink). Since JS is
    // single-threaded and the write is serialized through an awaited
    // JSON.stringify, there is no partial-read race.
    // ----------------------------------------------------------------
    const startedAtIso = startedAt.toISOString();
    const visitedSet: Set<string> = new Set(priorVisited ?? []);
    const getCheckpointState = (): CheckpointState => {
      // Rebuild the visited list from priorVisited + freshly visited URLs
      // in this run. Deduped via a Set so a resumed URL that somehow got
      // re-enqueued doesn't appear twice.
      for (const p of pages) visitedSet.add(p.url);

      return {
        version: 1,
        startedAt: startedAtIso,
        checkpointedAt: new Date().toISOString(),
        frontier: frontier.snapshot(),
        visited: [...visitedSet],
        skipped: [],
        artifactsDir: config.outputDir,
        pagesVisited: progressSink.pagesVisited,
        errors,
        configHash,
      };
    };

    // Seed an initial checkpoint immediately so that a crash before the
    // first 30s tick still leaves a resumable state. Non-fatal on failure.
    try {
      const initialState =
        config.resume && existingCheckpoint
          ? getCheckpointState()
          : {
              ...createCheckpointState({ configHash, artifactsDir: config.outputDir }),
              frontier: frontier.snapshot(),
              startedAt: startedAtIso,
            };
      await writeCheckpoint(initialState, config.outputDir);
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      logger.debug(`Initial checkpoint write failed (non-fatal): ${message}`);
    }

    autoCheckpoint = setupAutoCheckpoint(getCheckpointState, config.outputDir);

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
      skipVisitedUrls: priorVisited,
      progressSink,
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

    // Stop the auto-checkpoint timer as soon as the crawl loop has
    // returned. Subsequent work (assemble, write artifacts) is not
    // resumable, so there is nothing to snapshot. If the crawl
    // completed cleanly, also delete the checkpoint file so future
    // runs start fresh; for partial/interrupted/error runs we leave
    // it for a future --resume.
    if (autoCheckpoint) {
      autoCheckpoint.stop();
      autoCheckpoint = undefined;
    }
    if (completionStatus === 'complete') {
      await deleteCheckpoint(config.outputDir).catch((err: unknown) => {
        const message = err instanceof Error ? err.message : String(err);
        logger.debug(`Checkpoint cleanup failed (non-fatal): ${message}`);
      });
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

    // Stop the auto-checkpoint timer if the happy path did not already
    // clean it up (e.g., fatal error threw before completion status was
    // evaluated). The checkpoint file itself is intentionally preserved
    // on error/interrupt — a future --resume can pick it up.
    if (autoCheckpoint) {
      autoCheckpoint.stop();
      autoCheckpoint = undefined;
    }

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
