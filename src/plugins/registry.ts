/**
 * CollectorRegistry
 *
 * Holds an ordered list of Collector plugins and runs them against a single
 * CollectorContext with per-collector timeout and error isolation.
 *
 *   - Default per-collector timeout: 30 000 ms.
 *   - A collector that throws is recorded with `error` (string message) and
 *     the remaining collectors still run.
 *   - A collector that exceeds the timeout is aborted cooperatively (the
 *     pending promise is detached) and reported with an `error` message.
 *     Plugins that ignore cancellation may continue running in the
 *     background; callers should size their plugins to respect the limit.
 */

import type { Collector, CollectorContext, CollectorResult } from './types.js';

/** Default per-collector run time before timeout in milliseconds. */
export const DEFAULT_COLLECTOR_TIMEOUT_MS = 30_000;

export interface RunAllOptions {
  /** Per-collector timeout in ms. Defaults to 30 000. */
  timeoutMs?: number;
}

export class CollectorRegistry {
  private readonly collectors: Collector[] = [];

  /** Register a collector. Later registrations run after earlier ones. */
  register(collector: Collector): void {
    if (!collector || typeof collector.collect !== 'function') {
      throw new TypeError('CollectorRegistry.register: collector must have a collect() method');
    }
    if (typeof collector.name !== 'string' || collector.name.length === 0) {
      throw new TypeError('CollectorRegistry.register: collector.name must be a non-empty string');
    }
    this.collectors.push(collector);
  }

  /** Read-only view of the registered collectors. */
  list(): readonly Collector[] {
    return this.collectors;
  }

  /** Whether any collectors are registered. */
  get size(): number {
    return this.collectors.length;
  }

  /**
   * Run all registered collectors sequentially against `ctx`.
   *
   * Errors and timeouts are captured per collector — this method never
   * throws. Returned array order matches registration order.
   */
  async runAll(ctx: CollectorContext, options: RunAllOptions = {}): Promise<CollectorResult[]> {
    const timeoutMs = options.timeoutMs ?? DEFAULT_COLLECTOR_TIMEOUT_MS;
    const results: CollectorResult[] = [];

    for (const collector of this.collectors) {
      const start = Date.now();
      try {
        const data = await runWithTimeout(collector, ctx, timeoutMs);
        results.push({
          name: collector.name,
          durationMs: Date.now() - start,
          data,
        });
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        results.push({
          name: collector.name,
          durationMs: Date.now() - start,
          error: message,
        });
      }
    }

    return results;
  }
}

function runWithTimeout(
  collector: Collector,
  ctx: CollectorContext,
  timeoutMs: number,
): Promise<unknown> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      reject(new Error(`Collector "${collector.name}" timed out after ${timeoutMs}ms`));
    }, timeoutMs);

    // Keep the timer from holding the event loop if the process is
    // otherwise idle (e.g. during shutdown).
    if (typeof timer.unref === 'function') timer.unref();

    Promise.resolve()
      .then(() => collector.collect(ctx))
      .then(
        (value) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          resolve(value);
        },
        (err: unknown) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          reject(err instanceof Error ? err : new Error(String(err)));
        },
      );
  });
}
