/**
 * Concurrent BFS crawl loop.
 *
 * Previously the orchestrator drove a fully-serial while-loop. This module
 * replaces that with N concurrent workers sharing:
 *   - a single Frontier (thread-safe for our use: V8 single-threaded)
 *   - a ContextPool sized to `config.concurrency`
 *
 * Each worker: while there is work (or another worker is actively visiting,
 * who might enqueue more), dequeue -> run visitAndCollectPage -> push result.
 *
 * Supports graceful abort via AbortSignal. When the signal fires, workers
 * finish their in-flight page and exit without picking up new work.
 *
 * Time/page budget enforcement stays here, shared across all workers via
 * the in-loop counters — the first worker to trip a limit flips a flag
 * and the others exit cleanly.
 */

import { setTimeout as sleep } from 'node:timers/promises';

import type { ResolvedConfig } from '../types/config.js';
import type {
  CrawlResult,
  PageVisitResult,
} from '../types/artifacts.js';
import type { CrawlErrorEntry } from '../types/errors.js';

import { ContextPool } from './context-pool.js';
import { Frontier } from './frontier.js';
import type { FrontierEntry } from './frontier.js';
import { isBlockedUrl } from '../security/network-guard.js';
import { visitAndCollectPage } from './visit-page.js';
import type { CollectorRegistry } from '../plugins/registry.js';
import { logger } from '../utils/logger.js';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface CrawlLoopInput {
  frontier: Frontier;
  pool: ContextPool;
  config: ResolvedConfig;
  /** Optional abort signal — crawl stops accepting new work when fired. */
  abortSignal?: AbortSignal;
  /** Optional collector plugin registry, threaded into visitAndCollectPage. */
  collectors?: CollectorRegistry;
  /** Called once per completed page (includes errored/blocked pages). */
  onPageComplete?: (result: PageVisitResult) => void;
}

export interface CrawlLoopOutput {
  pages: PageVisitResult[];
  errors: CrawlErrorEntry[];
  interrupted: boolean;
  completionStatus: CrawlResult['completionStatus'];
}

// ---------------------------------------------------------------------------
// runCrawlLoop — public entry point
// ---------------------------------------------------------------------------

/**
 * Run the BFS crawl loop with `config.concurrency` concurrent workers
 * drawing from the shared frontier and context pool.
 */
export async function runCrawlLoop(input: CrawlLoopInput): Promise<CrawlLoopOutput> {
  const { frontier, pool, config, abortSignal, collectors, onPageComplete } = input;

  const pages: PageVisitResult[] = [];
  const errors: CrawlErrorEntry[] = [];
  let visitedCount = 0;
  let interrupted = false;
  let completionStatus: CrawlResult['completionStatus'] = 'complete';
  const crawlStartTime = Date.now();

  // Track how many workers are actively processing an entry. A worker
  // finds the frontier "done" only when it is both empty AND no other
  // worker is mid-flight (mid-flight work may still enqueue new URLs).
  let inFlight = 0;

  // Shared budget-exceeded flag so the first worker to trip it signals
  // the others without a race.
  const budgetFlag: { tripped: boolean } = { tripped: false };

  async function tryClaimEntry(): Promise<FrontierEntry | null> {
    // Serialized by the JS event loop — no lock required.
    while (!frontier.isEmpty) {
      const entry = frontier.dequeue();
      if (!entry) return null;

      if (budgetFlag.tripped || interrupted) {
        return null;
      }

      // Enforce page/time budget on the dequeue side so we don't start
      // work we won't finish. Check happens each claim.
      if (visitedCount >= config.maxPages) {
        completionStatus = 'max_pages_reached';
        budgetFlag.tripped = true;
        return null;
      }

      if (config.maxTime > 0) {
        const elapsed = (Date.now() - crawlStartTime) / 1000;
        if (elapsed >= config.maxTime) {
          completionStatus = 'max_time_reached';
          budgetFlag.tripped = true;
          logger.warn(`Max crawl time reached (${config.maxTime}s) — stopping`);
          return null;
        }
      }

      // SSRF check before we start the visit. Blocked URLs count as
      // errors, not page visits.
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

      // Reserve a slot in the counter *before* returning so other workers
      // don't think the frontier has drained while this one is still busy.
      return entry;
    }
    return null;
  }

  async function worker(workerId: number): Promise<void> {
    while (true) {
      if (abortSignal?.aborted) {
        interrupted = true;
        completionStatus = 'interrupted';
        return;
      }

      const entry = await tryClaimEntry();
      if (!entry) {
        // Nothing to do right now. If other workers are in flight they may
        // enqueue more; poll briefly before exiting. If the frontier is
        // empty AND nobody is in flight, we are done.
        if (inFlight === 0 && frontier.isEmpty) return;
        if (budgetFlag.tripped || interrupted) return;
        await sleep(10);
        continue;
      }

      inFlight++;
      try {
        const context = await pool.acquire();
        try {
          const { pageVisit, discoveredUrls, navigationError } = await visitAndCollectPage({
            context,
            entry,
            config,
            collectors,
          });

          pages.push(pageVisit);
          visitedCount++;
          onPageComplete?.(pageVisit);

          if (navigationError) errors.push(navigationError);

          // Enqueue newly discovered URLs in the shared frontier.
          for (const d of discoveredUrls) {
            frontier.enqueue({
              url: d.url,
              depth: d.depth,
              referrer: d.referrer,
            });
          }

          const statusIcon = pageVisit.status === 'ok' ? 'OK' : pageVisit.status.toUpperCase();
          logger.info(
            `[${visitedCount}/${frontier.totalSeen}] ${statusIcon} ${entry.url}${
              entry.depth > 0 ? ` (depth ${entry.depth})` : ''
            }${config.concurrency > 1 ? ` [w${workerId}]` : ''}`,
          );

          if (config.delay > 0 && !interrupted) {
            await sleep(config.delay);
          }
        } finally {
          await pool.release(context);
        }
      } catch (err: unknown) {
        // Never let a worker throw — log and continue.
        const message = err instanceof Error ? err.message : String(err);
        logger.warn(`Worker ${workerId} error on ${entry.url}: ${message}`);
        errors.push({
          timestamp: new Date().toISOString(),
          url: entry.url,
          code: 'ERR_NAVIGATION',
          message,
        });
      } finally {
        inFlight--;
      }
    }
  }

  const workerCount = Math.max(1, config.concurrency | 0);
  const workers: Promise<void>[] = [];
  for (let i = 0; i < workerCount; i++) {
    workers.push(worker(i + 1));
  }
  await Promise.all(workers);

  if (interrupted) {
    completionStatus = 'interrupted';
  }

  return {
    pages,
    errors,
    interrupted,
    completionStatus,
  };
}
