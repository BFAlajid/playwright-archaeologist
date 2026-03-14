/**
 * Unit tests for src/utils/progress.ts
 *
 * Progress tracking: page visits, errors, ETA estimation,
 * rolling window rate calculation, and output formatting.
 */

import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { ProgressTracker, type ProgressState } from '../../src/utils/progress.js';

describe('ProgressTracker', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2025-01-01T00:00:00.000Z'));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  // -----------------------------------------------------------------------
  // Page visits
  // -----------------------------------------------------------------------

  describe('page visits', () => {
    it('tracks page visit count', () => {
      const tracker = new ProgressTracker(100);

      tracker.recordVisit('https://example.com/a');
      tracker.recordVisit('https://example.com/b');

      const state = tracker.getState();
      expect(state.pagesVisited).toBe(2);
    });

    it('starts with zero visits', () => {
      const tracker = new ProgressTracker(50);
      const state = tracker.getState();

      expect(state.pagesVisited).toBe(0);
    });

    it('includes estimated total from constructor', () => {
      const tracker = new ProgressTracker(200);
      const state = tracker.getState();

      expect(state.pagesTotal).toBe(200);
    });

    it('defaults estimated total to 0 when not provided', () => {
      const tracker = new ProgressTracker();
      const state = tracker.getState();

      expect(state.pagesTotal).toBe(0);
    });
  });

  // -----------------------------------------------------------------------
  // Errors
  // -----------------------------------------------------------------------

  describe('errors', () => {
    it('tracks error count', () => {
      const tracker = new ProgressTracker();

      tracker.recordError();
      tracker.recordError();
      tracker.recordError();

      expect(tracker.getState().errorsCount).toBe(3);
    });

    it('starts with zero errors', () => {
      const tracker = new ProgressTracker();
      expect(tracker.getState().errorsCount).toBe(0);
    });
  });

  // -----------------------------------------------------------------------
  // Pages per second (rolling window)
  // -----------------------------------------------------------------------

  describe('pages per second', () => {
    it('returns 0 when no pages visited', () => {
      const tracker = new ProgressTracker(100);

      expect(tracker.getState().pagesPerSecond).toBe(0);
    });

    it('returns 0 with only one visit (no interval to measure)', () => {
      const tracker = new ProgressTracker(100);

      tracker.recordVisit('https://example.com/a');

      expect(tracker.getState().pagesPerSecond).toBe(0);
    });

    it('calculates rate from rolling window', () => {
      const tracker = new ProgressTracker(100);

      // Visit 5 pages, 1 second apart
      for (let i = 0; i < 5; i++) {
        tracker.recordVisit(`https://example.com/${i}`);
        vi.advanceTimersByTime(1000);
      }

      const pps = tracker.getState().pagesPerSecond;
      // 4 intervals over 4 seconds = 1.0 p/s
      expect(pps).toBeCloseTo(1.0, 1);
    });

    it('uses only the last 10 timestamps for the rolling window', () => {
      const tracker = new ProgressTracker(100);

      // Visit 15 pages, alternating between fast and slow
      // First 5 at 100ms apart (fast)
      for (let i = 0; i < 5; i++) {
        tracker.recordVisit(`https://example.com/fast-${i}`);
        vi.advanceTimersByTime(100);
      }
      // Next 10 at 500ms apart (slow) -- these fill the rolling window
      for (let i = 0; i < 10; i++) {
        tracker.recordVisit(`https://example.com/slow-${i}`);
        vi.advanceTimersByTime(500);
      }

      const pps = tracker.getState().pagesPerSecond;
      // Rolling window: 10 entries, 9 intervals over 4500ms = 2.0 p/s
      expect(pps).toBeCloseTo(2.0, 1);
    });
  });

  // -----------------------------------------------------------------------
  // ETA estimation
  // -----------------------------------------------------------------------

  describe('estimated remaining time', () => {
    it('returns 0 when pagesPerSecond is 0', () => {
      const tracker = new ProgressTracker(100);
      expect(tracker.getState().estimatedRemainingMs).toBe(0);
    });

    it('returns 0 when total is 0', () => {
      const tracker = new ProgressTracker(0);

      tracker.recordVisit('https://example.com/a');
      vi.advanceTimersByTime(1000);
      tracker.recordVisit('https://example.com/b');

      expect(tracker.getState().estimatedRemainingMs).toBe(0);
    });

    it('returns 0 when all pages are visited', () => {
      const tracker = new ProgressTracker(2);

      tracker.recordVisit('https://example.com/a');
      vi.advanceTimersByTime(1000);
      tracker.recordVisit('https://example.com/b');

      expect(tracker.getState().estimatedRemainingMs).toBe(0);
    });

    it('calculates remaining time based on rate and remaining pages', () => {
      const tracker = new ProgressTracker(10);

      // Visit 2 pages, 1 second apart -> 1 p/s, 8 remaining -> 8000ms
      tracker.recordVisit('https://example.com/a');
      vi.advanceTimersByTime(1000);
      tracker.recordVisit('https://example.com/b');

      const remaining = tracker.getState().estimatedRemainingMs;
      // 8 pages remaining / 1 p/s * 1000 = 8000ms
      expect(remaining).toBeCloseTo(8000, -1);
    });
  });

  // -----------------------------------------------------------------------
  // Currently crawling URLs
  // -----------------------------------------------------------------------

  describe('current URLs', () => {
    it('tracks started pages', () => {
      const tracker = new ProgressTracker();

      tracker.startPage('/about');
      tracker.startPage('/api/users');

      const state = tracker.getState();
      expect(state.currentUrls).toContain('/about');
      expect(state.currentUrls).toContain('/api/users');
    });

    it('removes pages when ended', () => {
      const tracker = new ProgressTracker();

      tracker.startPage('/about');
      tracker.startPage('/api/users');
      tracker.endPage('/about');

      const state = tracker.getState();
      expect(state.currentUrls).not.toContain('/about');
      expect(state.currentUrls).toContain('/api/users');
    });

    it('handles ending a page that was never started', () => {
      const tracker = new ProgressTracker();

      // Should not throw
      tracker.endPage('/nonexistent');

      expect(tracker.getState().currentUrls).toEqual([]);
    });
  });

  // -----------------------------------------------------------------------
  // Update total
  // -----------------------------------------------------------------------

  describe('updateTotal', () => {
    it('updates the estimated total', () => {
      const tracker = new ProgressTracker(50);

      tracker.updateTotal(200);

      expect(tracker.getState().pagesTotal).toBe(200);
    });

    it('throws on negative total', () => {
      const tracker = new ProgressTracker();

      expect(() => tracker.updateTotal(-1)).toThrow('Estimated total must be >= 0');
    });

    it('allows setting total to 0', () => {
      const tracker = new ProgressTracker(50);

      tracker.updateTotal(0);

      expect(tracker.getState().pagesTotal).toBe(0);
    });
  });

  // -----------------------------------------------------------------------
  // Elapsed time
  // -----------------------------------------------------------------------

  describe('elapsed time', () => {
    it('tracks elapsed time from construction', () => {
      const tracker = new ProgressTracker();

      vi.advanceTimersByTime(5000);

      expect(tracker.getState().elapsedMs).toBe(5000);
    });

    it('records startTime at construction', () => {
      const now = Date.now();
      const tracker = new ProgressTracker();

      expect(tracker.getState().startTime).toBe(now);
    });
  });

  // -----------------------------------------------------------------------
  // Format
  // -----------------------------------------------------------------------

  describe('format', () => {
    it('produces a formatted progress string', () => {
      const tracker = new ProgressTracker(50);

      tracker.recordVisit('https://example.com/a');
      vi.advanceTimersByTime(1000);
      tracker.recordVisit('https://example.com/b');

      tracker.startPage('/about');
      tracker.startPage('/api/users');

      const output = tracker.format();

      expect(output).toContain('[2/50]');
      expect(output).toContain('p/s');
      expect(output).toContain('ETA:');
      expect(output).toContain('Errors: 0');
      expect(output).toContain('/about');
      expect(output).toContain('/api/users');
    });

    it('shows idle when no pages are currently crawling', () => {
      const tracker = new ProgressTracker(10);

      const output = tracker.format();

      expect(output).toContain('Crawling: idle');
    });

    it('shows -- for ETA when no rate data', () => {
      const tracker = new ProgressTracker(10);

      const output = tracker.format();

      expect(output).toContain('ETA: --');
    });

    it('handles zero visits without division by zero', () => {
      const tracker = new ProgressTracker();

      // This should not throw
      const output = tracker.format();

      expect(output).toContain('[0/0]');
      expect(output).toContain('0.0 p/s');
    });
  });
});
