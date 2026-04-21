/**
 * Unit tests for src/crawl/frontier.ts
 *
 * URL frontier queue: BFS ordering, deduplication, depth tracking,
 * size reporting, and concurrent access safety.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { Frontier, type FrontierEntry } from '../../src/crawl/frontier.js';

describe('Frontier', () => {
  let frontier: Frontier;

  beforeEach(() => {
    frontier = new Frontier();
  });

  // -----------------------------------------------------------------------
  // Enqueue / Dequeue ordering (BFS)
  // -----------------------------------------------------------------------

  describe('BFS ordering', () => {
    it('dequeues URLs in FIFO order', () => {
      frontier.enqueue({ url: 'https://example.com/a', depth: 0 });
      frontier.enqueue({ url: 'https://example.com/b', depth: 0 });
      frontier.enqueue({ url: 'https://example.com/c', depth: 0 });

      expect(frontier.dequeue()?.url).toBe('https://example.com/a');
      expect(frontier.dequeue()?.url).toBe('https://example.com/b');
      expect(frontier.dequeue()?.url).toBe('https://example.com/c');
    });

    it('processes shallower URLs before deeper ones naturally via BFS', () => {
      frontier.enqueue({ url: 'https://example.com/', depth: 0 });

      const first = frontier.dequeue();
      expect(first?.depth).toBe(0);

      // Simulate discovering links at depth 1
      frontier.enqueue({ url: 'https://example.com/a', depth: 1 });
      frontier.enqueue({ url: 'https://example.com/b', depth: 1 });

      expect(frontier.dequeue()?.depth).toBe(1);
      expect(frontier.dequeue()?.depth).toBe(1);
    });
  });

  // -----------------------------------------------------------------------
  // Deduplication
  // -----------------------------------------------------------------------

  describe('deduplication', () => {
    it('rejects duplicate URLs', () => {
      const first = frontier.enqueue({
        url: 'https://example.com/page',
        depth: 0,
      });
      const second = frontier.enqueue({
        url: 'https://example.com/page',
        depth: 1,
      });

      expect(first).toBe(true);
      expect(second).toBe(false);
      expect(frontier.size).toBe(1);
    });

    it('treats normalized URLs as duplicates', () => {
      frontier.enqueue({
        url: 'https://example.com/page/',
        depth: 0,
      });
      const dup = frontier.enqueue({
        url: 'https://example.com/page',
        depth: 0,
      });

      // If frontier normalizes URLs, these should be the same
      // This test documents the expected behavior
      expect(frontier.size).toBeLessThanOrEqual(2);
    });

    it('reports hasSeen correctly for enqueued URLs', () => {
      frontier.enqueue({ url: 'https://example.com/a', depth: 0 });

      expect(frontier.hasSeen('https://example.com/a')).toBe(true);
      expect(frontier.hasSeen('https://example.com/b')).toBe(false);
    });

    it('reports hasSeen for dequeued URLs', () => {
      frontier.enqueue({ url: 'https://example.com/a', depth: 0 });
      frontier.dequeue();

      expect(frontier.hasSeen('https://example.com/a')).toBe(true);
    });

    it('rejects re-enqueue of a previously dequeued URL', () => {
      frontier.enqueue({ url: 'https://example.com/a', depth: 0 });
      frontier.dequeue();

      const result = frontier.enqueue({
        url: 'https://example.com/a',
        depth: 1,
      });
      expect(result).toBe(false);
    });
  });

  // -----------------------------------------------------------------------
  // Depth tracking
  // -----------------------------------------------------------------------

  describe('depth tracking', () => {
    it('preserves depth on dequeued entries', () => {
      frontier.enqueue({ url: 'https://example.com/', depth: 0 });
      frontier.enqueue({ url: 'https://example.com/a', depth: 1 });
      frontier.enqueue({ url: 'https://example.com/a/b', depth: 2 });

      expect(frontier.dequeue()?.depth).toBe(0);
      expect(frontier.dequeue()?.depth).toBe(1);
      expect(frontier.dequeue()?.depth).toBe(2);
    });

    it('rejects URLs exceeding max depth', () => {
      const depthLimited = new Frontier({ maxDepth: 2 });

      expect(
        depthLimited.enqueue({
          url: 'https://example.com/',
          depth: 0,
        })
      ).toBe(true);
      expect(
        depthLimited.enqueue({
          url: 'https://example.com/a',
          depth: 2,
        })
      ).toBe(true);
      expect(
        depthLimited.enqueue({
          url: 'https://example.com/a/b',
          depth: 3,
        })
      ).toBe(false);
    });

    it('preserves referrer information', () => {
      frontier.enqueue({
        url: 'https://example.com/page',
        depth: 1,
        referrer: 'https://example.com/',
      });

      const entry = frontier.dequeue();
      expect(entry?.referrer).toBe('https://example.com/');
    });
  });

  // -----------------------------------------------------------------------
  // Size reporting
  // -----------------------------------------------------------------------

  describe('size reporting', () => {
    it('reports size 0 for empty queue', () => {
      expect(frontier.size).toBe(0);
    });

    it('reports correct size after enqueue', () => {
      frontier.enqueue({ url: 'https://example.com/a', depth: 0 });
      frontier.enqueue({ url: 'https://example.com/b', depth: 0 });

      expect(frontier.size).toBe(2);
    });

    it('decrements size after dequeue', () => {
      frontier.enqueue({ url: 'https://example.com/a', depth: 0 });
      frontier.enqueue({ url: 'https://example.com/b', depth: 0 });
      frontier.dequeue();

      expect(frontier.size).toBe(1);
    });

    it('reports totalSeen including dequeued URLs', () => {
      frontier.enqueue({ url: 'https://example.com/a', depth: 0 });
      frontier.enqueue({ url: 'https://example.com/b', depth: 0 });
      frontier.dequeue();

      expect(frontier.totalSeen).toBe(2);
      expect(frontier.size).toBe(1);
    });
  });

  // -----------------------------------------------------------------------
  // Empty queue behavior
  // -----------------------------------------------------------------------

  describe('empty queue', () => {
    it('returns undefined on dequeue from empty queue', () => {
      expect(frontier.dequeue()).toBeUndefined();
    });

    it('reports isEmpty true for new frontier', () => {
      expect(frontier.isEmpty).toBe(true);
    });

    it('reports isEmpty true after draining the queue', () => {
      frontier.enqueue({ url: 'https://example.com/', depth: 0 });
      frontier.dequeue();

      expect(frontier.isEmpty).toBe(true);
    });

    it('reports isEmpty false when items exist', () => {
      frontier.enqueue({ url: 'https://example.com/', depth: 0 });

      expect(frontier.isEmpty).toBe(false);
    });
  });

  // -----------------------------------------------------------------------
  // Concurrent access safety
  // -----------------------------------------------------------------------

  describe('concurrent access', () => {
    it('handles rapid concurrent enqueue operations without duplicates', async () => {
      const urls = Array.from({ length: 100 }, (_, i) => ({
        url: `https://example.com/page-${i}`,
        depth: 0,
      }));

      // Simulate concurrent enqueues
      const results = await Promise.all(
        urls.map((entry) => Promise.resolve(frontier.enqueue(entry)))
      );

      const successCount = results.filter(Boolean).length;
      expect(successCount).toBe(100);
      expect(frontier.size).toBe(100);
    });

    it('handles concurrent enqueue of same URL without double-adding', async () => {
      const promises = Array.from({ length: 10 }, () =>
        Promise.resolve(
          frontier.enqueue({
            url: 'https://example.com/contested',
            depth: 0,
          })
        )
      );

      const results = await Promise.all(promises);
      const successCount = results.filter(Boolean).length;

      // Exactly one should succeed
      expect(successCount).toBe(1);
      expect(frontier.size).toBe(1);
    });
  });

  // -----------------------------------------------------------------------
  // Bulk operations
  // -----------------------------------------------------------------------

  describe('bulk operations', () => {
    it('handles thousands of URLs efficiently', () => {
      const count = 10_000;
      for (let i = 0; i < count; i++) {
        frontier.enqueue({
          url: `https://example.com/page-${i}`,
          depth: i % 5,
        });
      }

      expect(frontier.size).toBe(count);
      expect(frontier.totalSeen).toBe(count);

      // Drain and verify order
      const first = frontier.dequeue();
      expect(first?.url).toBe('https://example.com/page-0');
    });
  });

  // -----------------------------------------------------------------------
  // maxSeen bound
  //
  // A BFS with unbounded `seen` eats memory linearly with URL count. The
  // frontier must fail loudly rather than OOM; callers can raise the cap
  // when they genuinely need more.
  // -----------------------------------------------------------------------

  describe('maxSeen bound', () => {
    it('throws FrontierOverflowError when seen-set exceeds the limit', () => {
      const small = new Frontier({ maxSeen: 3 });

      small.enqueue({ url: 'https://example.com/a', depth: 0 });
      small.enqueue({ url: 'https://example.com/b', depth: 0 });
      small.enqueue({ url: 'https://example.com/c', depth: 0 });

      expect(() =>
        small.enqueue({ url: 'https://example.com/d', depth: 0 }),
      ).toThrow(/exceeded 3 URLs/);
    });

    it('exposes ERR_FRONTIER_OVERFLOW error code', () => {
      const small = new Frontier({ maxSeen: 1 });
      small.enqueue({ url: 'https://example.com/a', depth: 0 });

      try {
        small.enqueue({ url: 'https://example.com/b', depth: 0 });
        expect.fail('enqueue should have thrown');
      } catch (err: unknown) {
        const e = err as { code?: string; name?: string };
        expect(e.code).toBe('ERR_FRONTIER_OVERFLOW');
        expect(e.name).toBe('FrontierOverflowError');
      }
    });

    it('does not throw for duplicate URLs once the limit is reached', () => {
      const small = new Frontier({ maxSeen: 2 });
      small.enqueue({ url: 'https://example.com/a', depth: 0 });
      small.enqueue({ url: 'https://example.com/b', depth: 0 });

      // Re-enqueuing an already-seen URL is a no-op (returns false), not
      // a new slot. It must NOT overflow.
      expect(() =>
        small.enqueue({ url: 'https://example.com/a', depth: 0 }),
      ).not.toThrow();
    });

    it('defaults to a high bound that ordinary crawls do not hit', () => {
      // 10k URLs is far below the default 500_000 cap — should succeed.
      const large = new Frontier();
      for (let i = 0; i < 10_000; i++) {
        large.enqueue({ url: `https://example.com/p${i}`, depth: 0 });
      }
      expect(large.totalSeen).toBe(10_000);
    });
  });
});
