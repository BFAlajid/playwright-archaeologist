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
  /**
   * Optional per-context setup hook. Called exactly once per newly-created
   * context, immediately after `browser.newContext()` returns and before
   * the context is handed to a caller. Use this to install init scripts,
   * route handlers, cookies, extra headers, etc.
   *
   * Runs sequentially during `acquire()` of a fresh context, so it can
   * safely await async setup.
   */
  setupContext?: (context: BrowserContext) => Promise<void>;
  /**
   * Optional factory producing per-context options. Called once per new
   * context creation with the creation index (0, 1, 2, ...). The returned
   * object is merged on top of the base `contextOptions` (and
   * `storageState` if set). Use to set per-context HAR paths, per-context
   * storage state, etc.
   */
  contextOptionsFactory?: (index: number) => Record<string, unknown>;
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
  private readonly setupContext?: (context: BrowserContext) => Promise<void>;
  private readonly contextOptionsFactory?: (index: number) => Record<string, unknown>;

  /**
   * Monotonic creation counter passed to `contextOptionsFactory`. First
   * context created is index 0, next is 1, etc. Never decremented, even
   * when contexts are recycled.
   */
  private creationIndex = 0;

  /** Contexts currently in use by callers */
  private acquired: Map<BrowserContext, PoolEntry> = new Map();

  /** Contexts sitting idle, ready to be acquired */
  private idle: PoolEntry[] = [];

  /** Waiters blocked on acquire() when pool is full */
  private waiters: Array<() => void> = [];

  /** Whether closeAll() has been called */
  private closed = false;

  /** Every context ever created, in creation order. Used for drain/HAR merge. */
  private allContexts: BrowserContext[] = [];

  /**
   * Number of acquires that have passed the capacity gate and are currently
   * awaiting `browser.newContext()`. Incremented synchronously before the
   * await so that simultaneous acquire() calls in the same microtask cannot
   * all bypass the gate and over-allocate contexts.
   */
  private pendingCreations = 0;

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
    this.setupContext = options.setupContext;
    this.contextOptionsFactory = options.contextOptionsFactory;
  }

  /** All contexts that have ever been created by this pool. */
  get createdContexts(): readonly BrowserContext[] {
    return this.allContexts;
  }

  /**
   * Acquire a browser context from the pool.
   * Blocks if the pool is at full capacity until a context is released.
   */
  async acquire(): Promise<BrowserContext> {
    if (this.closed) {
      throw new Error('ContextPool is closed');
    }

    // Wait while every slot is taken by an acquired context, a pending create,
    // or an idle context that isn't available to reuse. Adding pendingCreations
    // closes the race where many acquire() calls all pass the gate in the same
    // microtask before any has incremented acquired.
    while (
      this.acquired.size + this.pendingCreations + this.idle.length >= this.concurrency &&
      this.idle.length === 0
    ) {
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

    // Reserve the slot SYNCHRONOUSLY before awaiting. If we awaited first, a
    // concurrent acquire() could pass the gate using the same slot.
    this.pendingCreations += 1;
    try {
      const entry = await this.createEntry();
      this.acquired.set(entry.context, entry);
      return entry.context;
    } finally {
      this.pendingCreations -= 1;
    }
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
    // Factory is invoked synchronously BEFORE newContext() so the merged
    // options shape reaches Playwright. The index is monotonic across the
    // pool lifetime — never reused, never decremented on recycle.
    if (this.contextOptionsFactory) {
      const index = this.creationIndex++;
      const extra = this.contextOptionsFactory(index);
      Object.assign(opts, extra);
    }
    const context = await this.browser.newContext(opts);
    this.allContexts.push(context);

    // Apply user-supplied per-context setup before handing off. If this
    // throws, close the context immediately to avoid leaking it.
    if (this.setupContext) {
      try {
        await this.setupContext(context);
      } catch (err) {
        await context.close().catch(() => {});
        throw err;
      }
    }

    return { context, pageCount: 0 };
  }

  /**
   * Close every context the pool has ever created, wait for them to drain
   * (which flushes HAR files to disk), then mark the pool closed.
   *
   * Different from closeAll: drain closes *every* context in creation order,
   * including ones already closed during recycling (idempotent). Use
   * after the crawl loop exits, before HAR merge.
   */
  async drain(): Promise<void> {
    this.closed = true;
    for (const r of this.waiters) r();
    this.waiters.length = 0;

    // Close every context we ever created so HAR files flush.
    const ops: Promise<void>[] = [];
    for (const ctx of this.allContexts) {
      ops.push(ctx.close().catch(() => {}));
    }
    await Promise.all(ops);

    this.idle.length = 0;
    this.acquired.clear();
  }

  private drainWaiters(): void {
    if (this.waiters.length > 0) {
      const next = this.waiters.shift()!;
      next();
    }
  }
}
