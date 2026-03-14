/**
 * Progress tracker for crawl operations.
 *
 * Tracks page visits, errors, currently-active URLs, and provides
 * ETA estimates using a rolling window of recent visit timestamps.
 */

const ROLLING_WINDOW_SIZE = 10;

export interface ProgressState {
  pagesVisited: number;
  pagesTotal: number;
  currentUrls: string[];
  errorsCount: number;
  startTime: number;
  elapsedMs: number;
  estimatedRemainingMs: number;
  pagesPerSecond: number;
}

export class ProgressTracker {
  private pagesVisited = 0;
  private pagesTotal: number;
  private errorsCount = 0;
  private readonly startTime: number;
  private readonly currentUrls: Set<string> = new Set();

  /** Rolling window of timestamps (ms) when pages were recorded as visited */
  private readonly visitTimestamps: number[] = [];

  constructor(estimatedTotal?: number) {
    this.pagesTotal = estimatedTotal ?? 0;
    this.startTime = Date.now();
  }

  /** Record a page visit. */
  recordVisit(url: string): void {
    this.pagesVisited += 1;
    this.visitTimestamps.push(Date.now());

    // Keep only the most recent entries in the rolling window
    if (this.visitTimestamps.length > ROLLING_WINDOW_SIZE) {
      this.visitTimestamps.shift();
    }
  }

  /** Record an error. */
  recordError(): void {
    this.errorsCount += 1;
  }

  /** Mark a URL as currently being crawled. */
  startPage(url: string): void {
    this.currentUrls.add(url);
  }

  /** Mark a URL as done crawling. */
  endPage(url: string): void {
    this.currentUrls.delete(url);
  }

  /** Update the estimated total page count. */
  updateTotal(total: number): void {
    if (total < 0) {
      throw new Error('Estimated total must be >= 0');
    }
    this.pagesTotal = total;
  }

  /** Get the current progress state snapshot. */
  getState(): ProgressState {
    const now = Date.now();
    const elapsedMs = now - this.startTime;
    const pps = this.calculatePagesPerSecond();
    const remaining = this.calculateRemainingMs(pps);

    return {
      pagesVisited: this.pagesVisited,
      pagesTotal: this.pagesTotal,
      currentUrls: Array.from(this.currentUrls),
      errorsCount: this.errorsCount,
      startTime: this.startTime,
      elapsedMs,
      estimatedRemainingMs: remaining,
      pagesPerSecond: pps,
    };
  }

  /**
   * Format the current progress as a terminal-friendly string.
   *
   * Example: `[12/50] 2.3 p/s | ETA: 16s | Errors: 0 | Crawling: /about, /api/users`
   */
  format(): string {
    const state = this.getState();
    const pps = state.pagesPerSecond.toFixed(1);
    const eta = state.estimatedRemainingMs > 0
      ? `${Math.ceil(state.estimatedRemainingMs / 1000)}s`
      : '--';

    const crawling = state.currentUrls.length > 0
      ? state.currentUrls.join(', ')
      : 'idle';

    return `[${state.pagesVisited}/${state.pagesTotal}] ${pps} p/s | ETA: ${eta} | Errors: ${state.errorsCount} | Crawling: ${crawling}`;
  }

  // ---------------------------------------------------------------------------
  // Private
  // ---------------------------------------------------------------------------

  /**
   * Calculate pages per second from the rolling window of visit timestamps.
   * Uses the time span between the oldest and newest entry in the window.
   */
  private calculatePagesPerSecond(): number {
    const timestamps = this.visitTimestamps;
    if (timestamps.length < 2) {
      return 0;
    }

    const oldest = timestamps[0];
    const newest = timestamps[timestamps.length - 1];
    const spanMs = newest - oldest;

    if (spanMs <= 0) {
      return 0;
    }

    // Number of intervals is (count - 1) over the time span
    return ((timestamps.length - 1) / spanMs) * 1000;
  }

  /**
   * Estimate remaining milliseconds: (remaining pages) / pagesPerSecond * 1000
   */
  private calculateRemainingMs(pps: number): number {
    if (pps <= 0 || this.pagesTotal <= 0) {
      return 0;
    }

    const remaining = this.pagesTotal - this.pagesVisited;
    if (remaining <= 0) {
      return 0;
    }

    return (remaining / pps) * 1000;
  }
}
