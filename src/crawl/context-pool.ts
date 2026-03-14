/**
 * Browser context pool for concurrent crawling.
 *
 * Manages a pool of Playwright BrowserContexts with:
 * - Concurrency limiting via async semaphore
 * - Automatic context recycling after N page visits
 * - Shared context options and storage state
 *
 * Callers acquire a context before visiting a page and release it
 * when done. If the pool is at capacity, acquire() blocks until a
 * context is released.
 */

import type { Browser, BrowserContext } from 'playwright';

export interface ContextPoolOptions {
  /** Max concurrent contexts (default 3) */
  concurrency: number;
  /** Pages per context before recycling (default 50) */
  recycleAfter: number;
  /** Context options to apply to all contexts */
  contextOptions: Record<string, unknown>;
  /** Storage state to share across contexts */
  storageState?: string;
}

interface PoolEntry {
  context: BrowserContext;
  pageCount: number;
}

export class ContextPool {
  private readonly browser: Browser;
  private readonly concurrency: number;
  private readonly recycleAfter: number;
  private readonly contextOptions: Record<string, unknown>;
  private readonly storageState?: string;

  /** Contexts currently in use by callers */
  private acquired: Map<BrowserContext, PoolEntry> = new Map();

  /** Contexts sitting idle, ready to be acquired */
  private idle: PoolEntry[] = [];

  /** Waiters blocked on acquire() when pool is full */
  private waiters: Array<() => void> = [];

  /** Whether closeAll() has been called */
  private closed = false;

  constructor(browser: Browser, options: ContextPoolOptions) {
    if (!browser) {
      throw new Error('Browser instance is required');
    }
    if (options.concurrency < 1) {
      throw new Error('Concurrency must be >= 1');
    }
    if (options.recycleAfter < 1) {
      throw new Error('recycleAfter must be >= 1');
    }

    this.browser = browser;
    this.concurrency = options.concurrency;
    this.recycleAfter = options.recycleAfter;
    this.contextOptions = options.contextOptions;
    this.storageState = options.storageState;
  }

  /**
   * Acquire a browser context from the pool.
   * Blocks if the pool is at full capacity until a context is released.
   */
  async acquire(): Promise<BrowserContext> {
    if (this.closed) {
      throw new Error('ContextPool is closed');
    }

    // Wait if we are at capacity (all slots occupied by acquired + idle)
    while (this.acquired.size + this.idle.length >= this.concurrency && this.idle.length === 0) {
      await new Promise<void>((resolve) => {
        this.waiters.push(resolve);
      });
      if (this.closed) {
        throw new Error('ContextPool is closed');
      }
    }

    // Prefer reusing an idle context
    if (this.idle.length > 0) {
      const entry = this.idle.pop()!;
      this.acquired.set(entry.context, entry);
      return entry.context;
    }

    // Create a new context
    const entry = await this.createEntry();
    this.acquired.set(entry.context, entry);
    return entry.context;
  }

  /**
   * Release a context back to the pool. Increments the page count
   * and recycles the context if it has exceeded recycleAfter.
   */
  async release(context: BrowserContext): Promise<void> {
    const entry = this.acquired.get(context);
    if (!entry) {
      throw new Error('Context is not owned by this pool or was already released');
    }

    this.acquired.delete(context);
    entry.pageCount += 1;

    if (this.closed) {
      // Pool is shutting down; close the context
      await context.close();
      return;
    }

    if (entry.pageCount >= this.recycleAfter) {
      // Context is worn out -- close it. A fresh one will be created on next acquire.
      await context.close();
    } else {
      // Return to idle pool
      this.idle.push(entry);
    }

    // Wake the next waiter, if any
    this.drainWaiters();
  }

  /**
   * Close all contexts (both idle and acquired) and reject future operations.
   */
  async closeAll(): Promise<void> {
    this.closed = true;

    // Wake all waiters so they get the "closed" error
    for (const resolve of this.waiters) {
      resolve();
    }
    this.waiters.length = 0;

    // Close idle contexts
    const closeOps: Promise<void>[] = [];
    for (const entry of this.idle) {
      closeOps.push(entry.context.close());
    }
    this.idle.length = 0;

    // Close acquired contexts
    for (const [, entry] of this.acquired) {
      closeOps.push(entry.context.close());
    }
    this.acquired.clear();

    await Promise.all(closeOps);
  }

  /** Current number of active (acquired) contexts */
  get activeCount(): number {
    return this.acquired.size;
  }

  /** Current number of available (idle) contexts */
  get availableCount(): number {
    return this.idle.length;
  }

  // ---------------------------------------------------------------------------
  // Private
  // ---------------------------------------------------------------------------

  private async createEntry(): Promise<PoolEntry> {
    const opts: Record<string, unknown> = { ...this.contextOptions };
    if (this.storageState !== undefined) {
      opts.storageState = this.storageState;
    }
    const context = await this.browser.newContext(opts);
    return { context, pageCount: 0 };
  }

  private drainWaiters(): void {
    if (this.waiters.length > 0) {
      const next = this.waiters.shift()!;
      next();
    }
  }
}
