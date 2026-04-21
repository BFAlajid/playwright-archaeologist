/**
 * Collector plugin contract.
 *
 * Allows programmatic callers of `dig()` to register additional per-page
 * collectors that run alongside the built-in page-scanner, screenshot
 * capturer, form prober, and network logger. A collector receives the
 * Playwright `Page` (already navigated and DOM-stable) plus the initial
 * response and returns any serializable data it wants surfaced on the
 * `PageVisitResult.pluginData` map.
 *
 * Design notes:
 *   - Plugins are vetted and registered in-process; this is not a
 *     dynamic plugin loader.
 *   - Each collector runs with an individual timeout so one slow plugin
 *     cannot stall the crawl loop.
 *   - Per-collector errors are caught and surfaced as strings on the
 *     result so one failing plugin never kills the page visit.
 */

import type { Page, Response } from 'playwright';

/**
 * Context passed to each collector's `collect` method.
 */
export interface CollectorContext {
  /** The (already navigated, DOM-stable) Playwright page. */
  page: Page;
  /** The URL being visited (before any redirects). */
  url: string;
  /** The initial response returned by page.goto, or null if missing. */
  response: Response | null;
  /** Millisecond timestamp when the page visit started. */
  startTime: number;
}

/**
 * A collector is a named, self-contained per-page data producer.
 *
 * Collectors MUST:
 *   - Return serializable data (JSON-friendly) — it is written to disk.
 *   - Not mutate shared state between calls.
 *   - Tolerate any page state (auth failure, partial load, etc.).
 */
export interface Collector<T = unknown> {
  /** Unique collector name. Used as the `PageVisitResult.pluginData` key. */
  readonly name: string;
  /** Produce data for a single page visit. */
  collect(ctx: CollectorContext): Promise<T>;
}

/**
 * The result of running one collector on one page.
 *
 * Either `data` is set (success) or `error` is set (failure / timeout).
 * Both fields present is not a valid shape.
 */
export interface CollectorResult {
  name: string;
  durationMs: number;
  data?: unknown;
  error?: string;
}
