/**
 * Performance benchmarks for crawl orchestration simulation.
 *
 * Tests the non-browser overhead of the crawl pipeline:
 * - Orchestrator processing loop with mock pages
 * - URL dedup with realistic collision patterns
 * - Concurrent worker simulation
 * - Memory growth during simulated crawls
 * - Context pool acquire/release patterns
 * - API grouper throughput
 * - Route tree builder throughput
 *
 * Run: npx vitest bench test/performance/crawl-simulation.bench.ts
 *
 * TODO: this bench measures an inlined fake (MockContextPool, simulatePageProcessing,
 * a local parameterizePath copy) rather than the real modules from src/.
 * Replace the inlined copies with real imports from src/crawl/context-pool.ts
 * and src/assembler/api-grouper.ts before relying on budget enforcement.
 * Frontier and normalizeUrl are already imported from src.
 */

import { bench, describe } from 'vitest';
import { Frontier } from '../../src/crawl/frontier.js';
import { normalizeUrl } from '../../src/crawl/url-utils.js';
import { createHash } from 'node:crypto';

// ---------------------------------------------------------------------------
// Realistic URL generators
// ---------------------------------------------------------------------------

/**
 * Generate URLs that mimic a real web application's structure.
 * Includes product pages, user profiles, settings, docs, etc.
 */
function generateRealisticUrls(count: number, baseUrl = 'https://app.example.com'): string[] {
  const urls: string[] = [];
  const sections = [
    'dashboard', 'settings', 'users', 'products', 'orders',
    'reports', 'analytics', 'billing', 'help', 'docs',
    'admin', 'api', 'webhooks', 'integrations', 'notifications',
  ];
  const actions = ['list', 'view', 'edit', 'create', 'export', 'import', 'archive'];

  for (let i = 0; i < count; i++) {
    const section = sections[i % sections.length];
    const action = actions[i % actions.length];
    const id = Math.floor(i / sections.length);

    switch (i % 8) {
      case 0: urls.push(`${baseUrl}/${section}`); break;
      case 1: urls.push(`${baseUrl}/${section}/${id}`); break;
      case 2: urls.push(`${baseUrl}/${section}/${id}/${action}`); break;
      case 3: urls.push(`${baseUrl}/${section}?page=${id}&per_page=25&sort=created_at&order=desc`); break;
      case 4: urls.push(`${baseUrl}/${section}/${id}/sub-${action}?tab=details&view=grid`); break;
      case 5: urls.push(`${baseUrl}/api/v2/${section}/${id}`); break;
      case 6: urls.push(`${baseUrl}/${section}/category-${id % 10}/item-${id}`); break;
      case 7: urls.push(`${baseUrl}/${section}/${id}#section-${i % 5}`); break;
    }
  }
  return urls;
}

/**
 * Generate URLs with high collision rate (e.g., query param reordering,
 * trailing slashes, fragment differences).
 */
function generateCollisionUrls(count: number): string[] {
  const urls: string[] = [];
  const baseUrl = 'https://app.example.com';

  for (let i = 0; i < count; i++) {
    const page = i % 100; // Only 100 unique pages
    const variant = i % 6;

    switch (variant) {
      case 0: urls.push(`${baseUrl}/page/${page}?a=1&b=2`); break;
      case 1: urls.push(`${baseUrl}/page/${page}?b=2&a=1`); break; // Same after normalization
      case 2: urls.push(`${baseUrl}/page/${page}/`); break; // Trailing slash
      case 3: urls.push(`${baseUrl}/page/${page}#top`); break; // Fragment
      case 4: urls.push(`${baseUrl}/page/${page}?a=1&b=2#footer`); break; // Fragment + params
      case 5: urls.push(`${baseUrl}/Page/${page}`); break; // Case variation
    }
  }
  return urls;
}

// ---------------------------------------------------------------------------
// Mock page processing (simulates collector work without browser)
// ---------------------------------------------------------------------------

interface MockCollectedData {
  url: string;
  title: string;
  links: string[];
  forms: number;
  apiRequests: number;
  screenshotHash: string;
  processingTime: number;
}

function simulatePageProcessing(url: string, pageIndex: number): MockCollectedData {
  const startTime = performance.now();

  // Simulate link extraction (50 links per page)
  const links: string[] = [];
  for (let i = 0; i < 50; i++) {
    links.push(`https://app.example.com/section-${pageIndex % 10}/page-${i}`);
  }

  // Simulate content hashing
  const screenshotHash = createHash('sha256')
    .update(`screenshot-content-${url}-${pageIndex}`)
    .digest('hex')
    .slice(0, 16);

  return {
    url,
    title: `Page ${pageIndex} | Example App`,
    links,
    forms: pageIndex % 5 === 0 ? 1 : 0,
    apiRequests: 3 + (pageIndex % 5),
    screenshotHash,
    processingTime: performance.now() - startTime,
  };
}

// ---------------------------------------------------------------------------
// API Grouper Simulation
// ---------------------------------------------------------------------------

interface CapturedRequest {
  method: string;
  url: string;
  statusCode: number;
}

function generateCapturedRequests(count: number): CapturedRequest[] {
  const requests: CapturedRequest[] = [];
  const methods = ['GET', 'POST', 'PUT', 'DELETE'];
  const resources = [
    'users', 'products', 'orders', 'invoices', 'payments',
    'categories', 'tags', 'comments', 'reviews', 'notifications',
  ];

  for (let i = 0; i < count; i++) {
    const resource = resources[i % resources.length];
    const method = methods[i % methods.length];
    const id = Math.floor(i / resources.length);

    switch (i % 4) {
      case 0:
        requests.push({ method, url: `https://api.example.com/v2/${resource}`, statusCode: 200 });
        break;
      case 1:
        requests.push({ method, url: `https://api.example.com/v2/${resource}/${id}`, statusCode: 200 });
        break;
      case 2:
        requests.push({
          method,
          url: `https://api.example.com/v2/${resource}/${id}/sub-resource`,
          statusCode: method === 'DELETE' ? 204 : 200,
        });
        break;
      case 3:
        // UUID-based ID
        const uuid = `${id.toString(16).padStart(8, '0')}-1234-5678-9abc-def012345678`;
        requests.push({ method, url: `https://api.example.com/v2/${resource}/${uuid}`, statusCode: 200 });
        break;
    }
  }
  return requests;
}

/**
 * Simple parameterization simulation (mirrors api-grouper.ts logic).
 */
function parameterizePath(urlPath: string): string {
  return urlPath
    .split('/')
    .map(segment => {
      if (/^\d+$/.test(segment)) return ':id';
      if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(segment)) return ':id';
      if (/^[a-z0-9]+(?:-[a-z0-9]+){2,}$/i.test(segment) && segment.length > 10) return ':slug';
      return segment;
    })
    .join('/');
}

function groupRequests(requests: CapturedRequest[]): Map<string, CapturedRequest[]> {
  const groups = new Map<string, CapturedRequest[]>();
  for (const req of requests) {
    const url = new URL(req.url);
    const pattern = `${req.method} ${parameterizePath(url.pathname)}`;
    const group = groups.get(pattern) ?? [];
    group.push(req);
    groups.set(pattern, group);
  }
  return groups;
}

// ---------------------------------------------------------------------------
// Route Tree Simulation
// ---------------------------------------------------------------------------

interface RouteNode {
  segment: string;
  fullPath: string;
  children: RouteNode[];
  pageCount: number;
}

function buildRouteTree(urls: string[]): RouteNode {
  const root: RouteNode = { segment: '/', fullPath: '/', children: [], pageCount: 0 };

  for (const url of urls) {
    const parsed = new URL(url);
    const segments = parsed.pathname.split('/').filter(Boolean);
    let current = root;
    let path = '';

    for (const segment of segments) {
      path += `/${segment}`;
      let child = current.children.find(c => c.segment === segment);
      if (!child) {
        child = { segment, fullPath: path, children: [], pageCount: 0 };
        current.children.push(child);
      }
      current = child;
    }
    current.pageCount++;
  }

  return root;
}

// ---------------------------------------------------------------------------
// Orchestrator Processing Benchmarks
// ---------------------------------------------------------------------------

describe('Orchestrator Processing Loop', () => {
  bench('process 100 pages (mock browser, single worker)', () => {
    const frontier = new Frontier({ maxDepth: 5 });
    frontier.enqueue({ url: 'https://app.example.com/', depth: 0 });

    const results: MockCollectedData[] = [];
    let pagesProcessed = 0;

    while (!frontier.isEmpty && pagesProcessed < 100) {
      const entry = frontier.dequeue();
      if (!entry) break;

      const data = simulatePageProcessing(entry.url, pagesProcessed);
      results.push(data);
      pagesProcessed++;

      // Enqueue discovered links
      for (const link of data.links) {
        frontier.enqueue({ url: link, depth: entry.depth + 1, referrer: entry.url });
      }
    }
  });

  bench('process 500 pages (mock browser, single worker)', () => {
    const frontier = new Frontier({ maxDepth: 5 });
    frontier.enqueue({ url: 'https://app.example.com/', depth: 0 });

    const results: MockCollectedData[] = [];
    let pagesProcessed = 0;

    while (!frontier.isEmpty && pagesProcessed < 500) {
      const entry = frontier.dequeue();
      if (!entry) break;

      const data = simulatePageProcessing(entry.url, pagesProcessed);
      results.push(data);
      pagesProcessed++;

      for (const link of data.links) {
        frontier.enqueue({ url: link, depth: entry.depth + 1, referrer: entry.url });
      }
    }
  });

  bench('process 100 pages with concurrent frontier access (3 workers)', () => {
    const frontier = new Frontier({ maxDepth: 5 });
    const urls = generateRealisticUrls(300);
    for (const url of urls) {
      frontier.enqueue({ url, depth: 0 });
    }

    // Simulate 3 workers pulling from the same frontier
    const workerResults: MockCollectedData[][] = [[], [], []];
    let totalProcessed = 0;

    while (!frontier.isEmpty && totalProcessed < 100) {
      // Each "worker" processes one page per iteration
      for (let w = 0; w < 3; w++) {
        if (frontier.isEmpty || totalProcessed >= 100) break;
        const entry = frontier.dequeue();
        if (!entry) break;

        const data = simulatePageProcessing(entry.url, totalProcessed);
        workerResults[w].push(data);
        totalProcessed++;

        // Enqueue discovered links
        for (const link of data.links) {
          frontier.enqueue({ url: link, depth: entry.depth + 1 });
        }
      }
    }
  });
});

// ---------------------------------------------------------------------------
// URL Dedup with Realistic Collision Patterns
// ---------------------------------------------------------------------------

describe('URL Dedup with Collisions', () => {
  bench('dedup 5,000 URLs with 60% collision rate', () => {
    const frontier = new Frontier({ maxDepth: 10 });
    const urls = generateCollisionUrls(5000);
    for (const url of urls) {
      frontier.enqueue({ url, depth: 0 });
    }
  });

  bench('dedup 10,000 URLs with 60% collision rate', () => {
    const frontier = new Frontier({ maxDepth: 10 });
    const urls = generateCollisionUrls(10_000);
    for (const url of urls) {
      frontier.enqueue({ url, depth: 0 });
    }
  });

  bench('normalize + dedup 25,000 URLs (500 pages x 50 links)', () => {
    // This is the realistic worst case for a 500-page crawl
    const seen = new Set<string>();
    const urls = generateRealisticUrls(25_000);
    let unique = 0;
    for (const url of urls) {
      const normalized = normalizeUrl(url);
      if (!seen.has(normalized)) {
        seen.add(normalized);
        unique++;
      }
    }
    void unique;
  });
});

// ---------------------------------------------------------------------------
// API Grouper Benchmarks
// ---------------------------------------------------------------------------

describe('API Request Grouping', () => {
  bench('group 100 captured requests', () => {
    const requests = generateCapturedRequests(100);
    groupRequests(requests);
  });

  bench('group 1,000 captured requests', () => {
    const requests = generateCapturedRequests(1000);
    groupRequests(requests);
  });

  bench('group 5,000 captured requests', () => {
    const requests = generateCapturedRequests(5000);
    groupRequests(requests);
  });

  bench('parameterize 1,000 URL paths', () => {
    const paths = [
      '/api/v2/users/123',
      '/api/v2/users/456/posts',
      '/api/v2/products/789/reviews/12',
      '/api/v2/orders/abc-def-123-456',
      '/api/v2/categories/electronics/items',
    ];
    for (let i = 0; i < 1000; i++) {
      parameterizePath(paths[i % paths.length]);
    }
  });
});

// ---------------------------------------------------------------------------
// Route Tree Builder Benchmarks
// ---------------------------------------------------------------------------

describe('Route Tree Building', () => {
  bench('build tree from 100 URLs', () => {
    const urls = generateRealisticUrls(100);
    buildRouteTree(urls);
  });

  bench('build tree from 500 URLs', () => {
    const urls = generateRealisticUrls(500);
    buildRouteTree(urls);
  });

  bench('build tree from 1,000 URLs', () => {
    const urls = generateRealisticUrls(1000);
    buildRouteTree(urls);
  });

  bench('build tree from 5,000 URLs (deep nesting)', () => {
    const urls: string[] = [];
    for (let i = 0; i < 5000; i++) {
      const depth = 2 + (i % 6);
      const segments = Array.from({ length: depth }, (_, j) => `level-${j}-${i % 20}`);
      urls.push(`https://app.example.com/${segments.join('/')}`);
    }
    buildRouteTree(urls);
  });
});

// ---------------------------------------------------------------------------
// Context Pool Simulation
// ---------------------------------------------------------------------------

describe('Context Pool Acquire/Release', () => {
  // Simulates the overhead of maintaining a pool of browser contexts

  class MockContextPool {
    private available: number[] = [];
    private inUse = new Set<number>();
    private nextId = 0;
    private readonly maxSize: number;
    private recycleAfter: number;
    private usageCounts = new Map<number, number>();

    constructor(maxSize: number, recycleAfter = 50) {
      this.maxSize = maxSize;
      this.recycleAfter = recycleAfter;
    }

    acquire(): number | null {
      if (this.available.length > 0) {
        const id = this.available.pop()!;
        this.inUse.add(id);
        return id;
      }
      if (this.inUse.size < this.maxSize) {
        const id = this.nextId++;
        this.inUse.add(id);
        this.usageCounts.set(id, 0);
        return id;
      }
      return null; // Pool exhausted
    }

    release(id: number): boolean {
      if (!this.inUse.has(id)) return false;
      this.inUse.delete(id);
      const usage = (this.usageCounts.get(id) ?? 0) + 1;
      this.usageCounts.set(id, usage);

      if (usage >= this.recycleAfter) {
        // Recycle: don't return to pool, will create new on next acquire
        this.usageCounts.delete(id);
        return true; // recycled
      }

      this.available.push(id);
      return false; // reused
    }
  }

  bench('acquire/release 1,000 times (pool size 3)', () => {
    const pool = new MockContextPool(3, 50);
    for (let i = 0; i < 1000; i++) {
      const id = pool.acquire();
      if (id !== null) {
        pool.release(id);
      }
    }
  });

  bench('acquire/release 5,000 times with recycling every 50 (pool size 5)', () => {
    const pool = new MockContextPool(5, 50);
    for (let i = 0; i < 5000; i++) {
      const id = pool.acquire();
      if (id !== null) {
        pool.release(id);
      }
    }
  });

  bench('concurrent acquire pattern (3 workers, 500 pages)', () => {
    const pool = new MockContextPool(3, 50);
    const workers = [0, 0, 0]; // pages processed per worker

    for (let page = 0; page < 500; page++) {
      const workerIdx = page % 3;
      const ctxId = pool.acquire();
      if (ctxId !== null) {
        workers[workerIdx]++;
        // Simulate page processing time
        pool.release(ctxId);
      }
    }
  });
});

// ---------------------------------------------------------------------------
// Memory Growth Simulation
// ---------------------------------------------------------------------------

describe('Memory Growth During Crawl', () => {
  bench('simulate 100-page crawl memory pattern', () => {
    const frontier = new Frontier({ maxDepth: 5 });
    const collectedUrls: string[] = [];
    const screenshotHashes: string[] = [];
    const formData: Array<{ url: string; fieldCount: number }> = [];
    const apiRequests: Array<{ method: string; url: string }> = [];

    frontier.enqueue({ url: 'https://app.example.com/', depth: 0 });

    let processed = 0;
    while (!frontier.isEmpty && processed < 100) {
      const entry = frontier.dequeue();
      if (!entry) break;

      collectedUrls.push(entry.url);
      screenshotHashes.push(
        createHash('sha256').update(entry.url).digest('hex').slice(0, 16)
      );

      if (processed % 5 === 0) {
        formData.push({ url: entry.url, fieldCount: 5 + (processed % 8) });
      }

      for (let i = 0; i < 3 + (processed % 5); i++) {
        apiRequests.push({ method: 'GET', url: `${entry.url}/api/resource/${i}` });
      }

      for (let i = 0; i < 50; i++) {
        frontier.enqueue({
          url: `https://app.example.com/page-${processed}-link-${i}`,
          depth: entry.depth + 1,
        });
      }

      processed++;
    }
  });

  bench('simulate 500-page crawl memory pattern', () => {
    const frontier = new Frontier({ maxDepth: 5 });
    const collectedUrls: string[] = [];
    const screenshotHashes: string[] = [];
    const apiRequests: Array<{ method: string; url: string }> = [];

    frontier.enqueue({ url: 'https://app.example.com/', depth: 0 });

    let processed = 0;
    while (!frontier.isEmpty && processed < 500) {
      const entry = frontier.dequeue();
      if (!entry) break;

      collectedUrls.push(entry.url);
      screenshotHashes.push(
        createHash('sha256').update(entry.url).digest('hex').slice(0, 16)
      );

      for (let i = 0; i < 3; i++) {
        apiRequests.push({ method: 'GET', url: `${entry.url}/api/${i}` });
      }

      for (let i = 0; i < 50; i++) {
        frontier.enqueue({
          url: `https://app.example.com/p${processed}/l${i}`,
          depth: entry.depth + 1,
        });
      }

      processed++;
    }
  });
});

// ---------------------------------------------------------------------------
// Content Hash Comparison (Sitemap Diff Fast-Path)
// ---------------------------------------------------------------------------

describe('Content Hash Comparison', () => {
  bench('compute content hashes for 500 pages', () => {
    for (let i = 0; i < 500; i++) {
      createHash('sha256')
        .update(`page-content-${i}-with-some-representative-text-that-simulates-innerText-extraction`)
        .digest('hex')
        .slice(0, 16);
    }
  });

  bench('compare 500 content hash pairs (90% unchanged)', () => {
    const oldHashes: string[] = [];
    const newHashes: string[] = [];
    for (let i = 0; i < 500; i++) {
      const hash = createHash('sha256').update(`content-${i}`).digest('hex').slice(0, 16);
      oldHashes.push(hash);
      newHashes.push(i % 10 === 0
        ? createHash('sha256').update(`modified-content-${i}`).digest('hex').slice(0, 16)
        : hash
      );
    }

    const changed: number[] = [];
    for (let i = 0; i < 500; i++) {
      if (oldHashes[i] !== newHashes[i]) changed.push(i);
    }
    void changed;
  });
});
