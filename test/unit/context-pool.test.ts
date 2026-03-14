/**
 * Unit tests for src/crawl/context-pool.ts
 *
 * Browser context pool: concurrency limiting, context recycling,
 * option forwarding, and cleanup.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { ContextPool, type ContextPoolOptions } from '../../src/crawl/context-pool.js';
import type { Browser, BrowserContext } from 'playwright';

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

function createMockContext(id = 'ctx'): BrowserContext {
  return {
    _id: id,
    close: vi.fn().mockResolvedValue(undefined),
  } as unknown as BrowserContext;
}

function createMockBrowser(contexts?: BrowserContext[]): Browser {
  let callCount = 0;
  return {
    newContext: vi.fn().mockImplementation(async () => {
      if (contexts && callCount < contexts.length) {
        return contexts[callCount++];
      }
      return createMockContext(`auto-${callCount++}`);
    }),
  } as unknown as Browser;
}

function defaultOptions(overrides: Partial<ContextPoolOptions> = {}): ContextPoolOptions {
  return {
    concurrency: 3,
    recycleAfter: 50,
    contextOptions: { bypassCSP: true, acceptDownloads: false },
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('ContextPool', () => {
  let browser: Browser;

  beforeEach(() => {
    browser = createMockBrowser();
  });

  // -----------------------------------------------------------------------
  // Acquire
  // -----------------------------------------------------------------------

  describe('acquire', () => {
    it('returns a browser context', async () => {
      const pool = new ContextPool(browser, defaultOptions());
      const ctx = await pool.acquire();

      expect(ctx).toBeDefined();
      expect(browser.newContext).toHaveBeenCalledTimes(1);
    });

    it('creates separate contexts for each acquire call', async () => {
      const pool = new ContextPool(browser, defaultOptions({ concurrency: 3 }));

      const ctx1 = await pool.acquire();
      const ctx2 = await pool.acquire();

      expect(ctx1).not.toBe(ctx2);
      expect(browser.newContext).toHaveBeenCalledTimes(2);
    });

    it('reuses idle contexts instead of creating new ones', async () => {
      const pool = new ContextPool(browser, defaultOptions({ concurrency: 2 }));

      const ctx1 = await pool.acquire();
      await pool.release(ctx1);

      const ctx2 = await pool.acquire();
      expect(ctx2).toBe(ctx1);
      // Only one context was ever created
      expect(browser.newContext).toHaveBeenCalledTimes(1);
    });
  });

  // -----------------------------------------------------------------------
  // Blocking when pool is full
  // -----------------------------------------------------------------------

  describe('blocking', () => {
    it('blocks when pool is at capacity and unblocks on release', async () => {
      const pool = new ContextPool(browser, defaultOptions({ concurrency: 1 }));

      const ctx1 = await pool.acquire();
      let resolved = false;

      const acquirePromise = pool.acquire().then((ctx) => {
        resolved = true;
        return ctx;
      });

      // Give a microtask tick -- should still be blocked
      await Promise.resolve();
      expect(resolved).toBe(false);

      // Release ctx1 should unblock the waiter
      await pool.release(ctx1);

      const ctx2 = await acquirePromise;
      expect(resolved).toBe(true);
      expect(ctx2).toBeDefined();
    });

    it('handles multiple waiters in FIFO order', async () => {
      const pool = new ContextPool(browser, defaultOptions({ concurrency: 1 }));

      const ctx1 = await pool.acquire();
      const order: number[] = [];

      const p1 = pool.acquire().then((ctx) => { order.push(1); return ctx; });
      const p2 = pool.acquire().then((ctx) => { order.push(2); return ctx; });

      // Release once: first waiter gets the context
      await pool.release(ctx1);
      const c1 = await p1;

      // Release again: second waiter gets a context
      await pool.release(c1);
      await p2;

      expect(order).toEqual([1, 2]);
    });
  });

  // -----------------------------------------------------------------------
  // Recycling
  // -----------------------------------------------------------------------

  describe('recycling', () => {
    it('recycles context after N pages', async () => {
      const recycleAfter = 2;
      const pool = new ContextPool(browser, defaultOptions({ concurrency: 1, recycleAfter }));

      const ctx1 = await pool.acquire();
      await pool.release(ctx1); // pageCount = 1
      expect(ctx1.close).not.toHaveBeenCalled();

      const ctx1Again = await pool.acquire();
      expect(ctx1Again).toBe(ctx1); // reused
      await pool.release(ctx1Again); // pageCount = 2 -> recycle

      expect(ctx1.close).toHaveBeenCalledTimes(1);

      // Next acquire should create a brand new context
      const ctx2 = await pool.acquire();
      expect(ctx2).not.toBe(ctx1);
      expect(browser.newContext).toHaveBeenCalledTimes(2);
    });

    it('does not recycle context before limit is reached', async () => {
      const pool = new ContextPool(browser, defaultOptions({ concurrency: 1, recycleAfter: 5 }));

      const ctx = await pool.acquire();
      await pool.release(ctx); // pageCount = 1
      expect(ctx.close).not.toHaveBeenCalled();
    });
  });

  // -----------------------------------------------------------------------
  // Context options
  // -----------------------------------------------------------------------

  describe('context options', () => {
    it('passes contextOptions to newContext', async () => {
      const opts = { bypassCSP: true, acceptDownloads: false, locale: 'en-US' };
      const pool = new ContextPool(browser, defaultOptions({ contextOptions: opts }));

      await pool.acquire();

      expect(browser.newContext).toHaveBeenCalledWith(
        expect.objectContaining(opts)
      );
    });

    it('passes storageState when provided', async () => {
      const pool = new ContextPool(
        browser,
        defaultOptions({ storageState: '/path/to/state.json' })
      );

      await pool.acquire();

      expect(browser.newContext).toHaveBeenCalledWith(
        expect.objectContaining({ storageState: '/path/to/state.json' })
      );
    });

    it('does not include storageState when not provided', async () => {
      const pool = new ContextPool(browser, defaultOptions());

      await pool.acquire();

      const callArgs = (browser.newContext as ReturnType<typeof vi.fn>).mock.calls[0][0];
      expect(callArgs).not.toHaveProperty('storageState');
    });
  });

  // -----------------------------------------------------------------------
  // closeAll
  // -----------------------------------------------------------------------

  describe('closeAll', () => {
    it('closes all idle contexts', async () => {
      const pool = new ContextPool(browser, defaultOptions({ concurrency: 2 }));

      const ctx1 = await pool.acquire();
      const ctx2 = await pool.acquire();
      await pool.release(ctx1);
      await pool.release(ctx2);

      await pool.closeAll();

      expect(ctx1.close).toHaveBeenCalled();
      expect(ctx2.close).toHaveBeenCalled();
    });

    it('closes all acquired contexts', async () => {
      const pool = new ContextPool(browser, defaultOptions({ concurrency: 2 }));

      const ctx1 = await pool.acquire();
      const ctx2 = await pool.acquire();

      await pool.closeAll();

      expect(ctx1.close).toHaveBeenCalled();
      expect(ctx2.close).toHaveBeenCalled();
    });

    it('closes both idle and acquired contexts', async () => {
      const pool = new ContextPool(browser, defaultOptions({ concurrency: 3 }));

      const ctx1 = await pool.acquire();
      const ctx2 = await pool.acquire();
      await pool.release(ctx1); // now idle

      await pool.closeAll();

      expect(ctx1.close).toHaveBeenCalled();
      expect(ctx2.close).toHaveBeenCalled();
    });

    it('rejects acquire after closeAll', async () => {
      const pool = new ContextPool(browser, defaultOptions());

      await pool.closeAll();

      await expect(pool.acquire()).rejects.toThrow('ContextPool is closed');
    });

    it('unblocks waiters on closeAll', async () => {
      const pool = new ContextPool(browser, defaultOptions({ concurrency: 1 }));

      const ctx = await pool.acquire();

      const acquirePromise = pool.acquire();
      await pool.closeAll();

      await expect(acquirePromise).rejects.toThrow('ContextPool is closed');
    });
  });

  // -----------------------------------------------------------------------
  // activeCount and availableCount
  // -----------------------------------------------------------------------

  describe('counts', () => {
    it('reports 0/0 initially', () => {
      const pool = new ContextPool(browser, defaultOptions());

      expect(pool.activeCount).toBe(0);
      expect(pool.availableCount).toBe(0);
    });

    it('increments activeCount on acquire', async () => {
      const pool = new ContextPool(browser, defaultOptions());

      await pool.acquire();

      expect(pool.activeCount).toBe(1);
      expect(pool.availableCount).toBe(0);
    });

    it('moves context from active to available on release', async () => {
      const pool = new ContextPool(browser, defaultOptions());

      const ctx = await pool.acquire();
      expect(pool.activeCount).toBe(1);
      expect(pool.availableCount).toBe(0);

      await pool.release(ctx);
      expect(pool.activeCount).toBe(0);
      expect(pool.availableCount).toBe(1);
    });

    it('tracks multiple contexts correctly', async () => {
      const pool = new ContextPool(browser, defaultOptions({ concurrency: 3 }));

      const ctx1 = await pool.acquire();
      const ctx2 = await pool.acquire();
      const ctx3 = await pool.acquire();

      expect(pool.activeCount).toBe(3);
      expect(pool.availableCount).toBe(0);

      await pool.release(ctx2);

      expect(pool.activeCount).toBe(2);
      expect(pool.availableCount).toBe(1);
    });

    it('counts go to 0 after closeAll', async () => {
      const pool = new ContextPool(browser, defaultOptions({ concurrency: 2 }));

      await pool.acquire();
      const ctx2 = await pool.acquire();
      await pool.release(ctx2);

      await pool.closeAll();

      expect(pool.activeCount).toBe(0);
      expect(pool.availableCount).toBe(0);
    });
  });

  // -----------------------------------------------------------------------
  // Concurrent acquire/release
  // -----------------------------------------------------------------------

  describe('concurrent acquire/release', () => {
    it('handles concurrent acquire and release without corruption', async () => {
      const pool = new ContextPool(browser, defaultOptions({ concurrency: 3 }));

      // Acquire 3 contexts concurrently
      const [c1, c2, c3] = await Promise.all([
        pool.acquire(),
        pool.acquire(),
        pool.acquire(),
      ]);

      expect(pool.activeCount).toBe(3);

      // Release all concurrently
      await Promise.all([
        pool.release(c1),
        pool.release(c2),
        pool.release(c3),
      ]);

      expect(pool.activeCount).toBe(0);
      expect(pool.availableCount).toBe(3);
    });

    it('handles interleaved acquire/release cycles', async () => {
      const pool = new ContextPool(browser, defaultOptions({ concurrency: 2 }));

      // Cycle 1
      const c1 = await pool.acquire();
      const c2 = await pool.acquire();

      // Start a 3rd acquire (will block)
      let thirdResolved = false;
      const thirdPromise = pool.acquire().then((ctx) => {
        thirdResolved = true;
        return ctx;
      });

      await Promise.resolve();
      expect(thirdResolved).toBe(false);

      // Release one
      await pool.release(c1);
      const c3 = await thirdPromise;
      expect(thirdResolved).toBe(true);

      // Clean up
      await pool.release(c2);
      await pool.release(c3);

      expect(pool.activeCount).toBe(0);
    });
  });

  // -----------------------------------------------------------------------
  // Input validation
  // -----------------------------------------------------------------------

  describe('input validation', () => {
    it('throws on release of unknown context', async () => {
      const pool = new ContextPool(browser, defaultOptions());
      const unknownCtx = createMockContext('unknown');

      await expect(pool.release(unknownCtx)).rejects.toThrow(
        'Context is not owned by this pool'
      );
    });

    it('throws on invalid concurrency', () => {
      expect(() => new ContextPool(browser, defaultOptions({ concurrency: 0 }))).toThrow(
        'Concurrency must be >= 1'
      );
    });

    it('throws on invalid recycleAfter', () => {
      expect(() => new ContextPool(browser, defaultOptions({ recycleAfter: 0 }))).toThrow(
        'recycleAfter must be >= 1'
      );
    });
  });
});
