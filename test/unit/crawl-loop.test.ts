/**
 * Unit tests for src/crawl/crawl-loop.ts
 *
 * The loop drives N concurrent workers against a shared Frontier + ContextPool.
 * These tests mock Playwright at the Browser/BrowserContext boundary so we
 * can verify scheduling, abort, concurrency, and error propagation without
 * a real browser.
 *
 * The crawl loop calls visitAndCollectPage, which opens pages against a
 * Playwright BrowserContext. For unit tests, we vi.mock that module out so
 * the loop itself is the only thing under test.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Frontier } from '../../src/crawl/frontier.js';
import { ContextPool } from '../../src/crawl/context-pool.js';
import { runCrawlLoop } from '../../src/crawl/crawl-loop.js';
import type { ResolvedConfig } from '../../src/types/config.js';
import type { Browser, BrowserContext } from 'playwright';

// ---------------------------------------------------------------------------
// Mock visitAndCollectPage so the loop drives a fake per-page pipeline.
// The test can push desired behaviour via the module-level state.
// ---------------------------------------------------------------------------

const visitBehavior: {
  delayMs: number;
  discoveries: Map<string, Array<{ url: string; depth: number; referrer: string }>>;
  throwOn: Set<string>;
  inFlight: { count: number; peak: number };
} = {
  delayMs: 30,
  discoveries: new Map(),
  throwOn: new Set(),
  inFlight: { count: 0, peak: 0 },
};

vi.mock('../../src/crawl/visit-page.js', () => ({
  visitAndCollectPage: vi.fn(async (input: { entry: { url: string; depth: number } }) => {
    const url = input.entry.url;
    visitBehavior.inFlight.count++;
    visitBehavior.inFlight.peak = Math.max(
      visitBehavior.inFlight.peak,
      visitBehavior.inFlight.count,
    );
    try {
      await new Promise((r) => setTimeout(r, visitBehavior.delayMs));
      if (visitBehavior.throwOn.has(url)) {
        throw new Error(`simulated failure on ${url}`);
      }
      const discoveredUrls = visitBehavior.discoveries.get(url) ?? [];
      return {
        pageVisit: {
          url,
          finalUrl: url,
          status: 'ok',
          httpStatus: 200,
          depth: input.entry.depth,
          discoveryMethod: 'entry',
          visitedAt: new Date().toISOString(),
          durationMs: visitBehavior.delayMs,
          collectorErrors: [],
          navigationEdges: [],
        },
        discoveredUrls,
        navigationError: undefined,
      };
    } finally {
      visitBehavior.inFlight.count--;
    }
  }),
}));

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

function mkConfig(overrides: Partial<ResolvedConfig> = {}): ResolvedConfig {
  return {
    targetUrl: 'https://example.com/',
    depth: 5,
    maxPages: 100,
    include: [],
    exclude: [],
    followExternal: false,
    deepClick: false,
    includeIframes: false,
    concurrency: 1,
    delay: 0,
    timeout: 30000,
    maxTime: 3600,
    outputDir: '',
    format: 'both',
    noScreenshots: true,
    screenshotFormat: 'jpeg',
    noHar: true,
    viewport: { width: 1280, height: 720 },
    additionalViewports: [],
    resume: false,
    yes: false,
    allowPrivate: true,
    allowAuthScript: false,
    captureJsBodies: false,
    harIncludeBodies: false,
    prettyJson: false,
    includeCookies: false,
    warnings: [],
    ...overrides,
  };
}

function mkMockContext(): BrowserContext {
  return { close: vi.fn().mockResolvedValue(undefined) } as unknown as BrowserContext;
}

function mkMockBrowser(): Browser {
  return {
    newContext: vi.fn().mockImplementation(async () => mkMockContext()),
  } as unknown as Browser;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('runCrawlLoop', () => {
  beforeEach(() => {
    visitBehavior.delayMs = 30;
    visitBehavior.discoveries.clear();
    visitBehavior.throwOn.clear();
    visitBehavior.inFlight = { count: 0, peak: 0 };
  });

  it('visits a single seed URL and exits', async () => {
    const frontier = new Frontier();
    frontier.enqueue({ url: 'https://a.com/', depth: 0 });
    const pool = new ContextPool(mkMockBrowser(), {
      concurrency: 1,
      recycleAfter: 50,
      contextOptions: {},
    });
    const result = await runCrawlLoop({ frontier, pool, config: mkConfig() });

    expect(result.pages).toHaveLength(1);
    expect(result.pages[0].url).toBe('https://a.com/');
    expect(result.completionStatus).toBe('complete');
    expect(result.errors).toEqual([]);
  });

  it('visits discovered URLs transitively', async () => {
    visitBehavior.discoveries.set('https://a.com/', [
      { url: 'https://a.com/x', depth: 1, referrer: 'https://a.com/' },
      { url: 'https://a.com/y', depth: 1, referrer: 'https://a.com/' },
    ]);
    visitBehavior.discoveries.set('https://a.com/x', [
      { url: 'https://a.com/x/1', depth: 2, referrer: 'https://a.com/x' },
    ]);

    const frontier = new Frontier({ maxDepth: 5 });
    frontier.enqueue({ url: 'https://a.com/', depth: 0 });
    const pool = new ContextPool(mkMockBrowser(), {
      concurrency: 1,
      recycleAfter: 50,
      contextOptions: {},
    });
    const result = await runCrawlLoop({ frontier, pool, config: mkConfig() });

    const urls = result.pages.map((p) => p.url).sort();
    expect(urls).toEqual([
      'https://a.com/',
      'https://a.com/x',
      'https://a.com/x/1',
      'https://a.com/y',
    ]);
  });

  it('runs 4 concurrent workers in parallel (peak in-flight ~ concurrency)', async () => {
    visitBehavior.delayMs = 60;
    const frontier = new Frontier();
    for (let i = 0; i < 8; i++) {
      frontier.enqueue({ url: `https://a.com/p${i}`, depth: 0 });
    }
    const pool = new ContextPool(mkMockBrowser(), {
      concurrency: 4,
      recycleAfter: 50,
      contextOptions: {},
    });

    const start = Date.now();
    const result = await runCrawlLoop({
      frontier,
      pool,
      config: mkConfig({ concurrency: 4 }),
    });
    const elapsed = Date.now() - start;

    expect(result.pages).toHaveLength(8);
    // Serial would take ~8 * 60 = 480ms. With 4 workers it should be
    // roughly 2 batches = 120ms. Give plenty of slack for CI: 350ms.
    expect(elapsed).toBeLessThan(350);
    // Peak observed in-flight should be >=2 to prove concurrency.
    expect(visitBehavior.inFlight.peak).toBeGreaterThanOrEqual(2);
  });

  it('respects maxPages limit', async () => {
    const frontier = new Frontier();
    for (let i = 0; i < 10; i++) {
      frontier.enqueue({ url: `https://a.com/p${i}`, depth: 0 });
    }
    const pool = new ContextPool(mkMockBrowser(), {
      concurrency: 1,
      recycleAfter: 50,
      contextOptions: {},
    });
    const result = await runCrawlLoop({
      frontier,
      pool,
      config: mkConfig({ maxPages: 3 }),
    });
    expect(result.pages.length).toBeLessThanOrEqual(3);
    expect(result.completionStatus).toBe('max_pages_reached');
  });

  it('aborts in-flight work when abort signal fires', async () => {
    visitBehavior.delayMs = 100;
    const frontier = new Frontier();
    for (let i = 0; i < 10; i++) {
      frontier.enqueue({ url: `https://a.com/p${i}`, depth: 0 });
    }
    const pool = new ContextPool(mkMockBrowser(), {
      concurrency: 2,
      recycleAfter: 50,
      contextOptions: {},
    });
    const controller = new AbortController();
    // Abort after ~80ms: enough for one batch but not all 10.
    setTimeout(() => controller.abort(), 80);

    const result = await runCrawlLoop({
      frontier,
      pool,
      config: mkConfig({ concurrency: 2 }),
      abortSignal: controller.signal,
    });

    expect(result.interrupted).toBe(true);
    expect(result.completionStatus).toBe('interrupted');
    expect(result.pages.length).toBeLessThan(10);
  });

  it('captures per-page worker errors and keeps going', async () => {
    visitBehavior.throwOn.add('https://a.com/bad');
    const frontier = new Frontier();
    frontier.enqueue({ url: 'https://a.com/good', depth: 0 });
    frontier.enqueue({ url: 'https://a.com/bad', depth: 0 });
    const pool = new ContextPool(mkMockBrowser(), {
      concurrency: 1,
      recycleAfter: 50,
      contextOptions: {},
    });
    const result = await runCrawlLoop({ frontier, pool, config: mkConfig() });
    expect(result.pages.map((p) => p.url).sort()).toEqual(['https://a.com/good']);
    expect(result.errors.length).toBeGreaterThan(0);
    expect(result.errors[0].url).toBe('https://a.com/bad');
  });

  it('calls onPageComplete for every visited page', async () => {
    const frontier = new Frontier();
    frontier.enqueue({ url: 'https://a.com/', depth: 0 });
    frontier.enqueue({ url: 'https://a.com/x', depth: 0 });
    const pool = new ContextPool(mkMockBrowser(), {
      concurrency: 1,
      recycleAfter: 50,
      contextOptions: {},
    });
    const hook = vi.fn();
    await runCrawlLoop({ frontier, pool, config: mkConfig(), onPageComplete: hook });
    expect(hook).toHaveBeenCalledTimes(2);
  });

  it('handles concurrent BFS — one worker discovers a URL, another picks it up', async () => {
    // Worker A picks up /entry, discovers /found. Worker B should pick up /found.
    visitBehavior.delayMs = 50;
    visitBehavior.discoveries.set('https://a.com/entry', [
      { url: 'https://a.com/found', depth: 1, referrer: 'https://a.com/entry' },
    ]);
    const frontier = new Frontier();
    frontier.enqueue({ url: 'https://a.com/entry', depth: 0 });
    const pool = new ContextPool(mkMockBrowser(), {
      concurrency: 2,
      recycleAfter: 50,
      contextOptions: {},
    });
    const result = await runCrawlLoop({
      frontier,
      pool,
      config: mkConfig({ concurrency: 2 }),
    });
    expect(result.pages.map((p) => p.url).sort()).toEqual([
      'https://a.com/entry',
      'https://a.com/found',
    ]);
  });
});
