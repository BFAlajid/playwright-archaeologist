/**
 * Performance benchmarks for the URL Frontier.
 *
 * Measures:
 * - enqueue throughput with URL normalization + dedup
 * - dequeue throughput (FIFO)
 * - has() lookup latency with large seen-sets
 * - URL normalization cost per URL
 * - Memory footprint at scale (10K, 50K URLs)
 *
 * Run: npx vitest bench test/performance/frontier.bench.ts
 */

import { bench, describe, beforeEach } from 'vitest';
import { Frontier, type FrontierEntry } from '../../src/crawl/frontier.js';
import { normalizeUrl } from '../../src/crawl/url-utils.js';

// ---------------------------------------------------------------------------
// Test data generators
// ---------------------------------------------------------------------------

function generateUrls(count: number, domain = 'https://example.com'): string[] {
  const urls: string[] = [];
  const sections = ['products', 'users', 'settings', 'dashboard', 'api', 'docs', 'blog', 'help', 'admin', 'account'];
  const subpaths = ['edit', 'view', 'delete', 'create', 'list', 'search', 'export', 'import'];

  for (let i = 0; i < count; i++) {
    const section = sections[i % sections.length];
    const sub = subpaths[i % subpaths.length];
    const id = Math.floor(i / sections.length);

    // Mix of URL patterns to exercise different normalization paths
    switch (i % 5) {
      case 0:
        urls.push(`${domain}/${section}/${id}`);
        break;
      case 1:
        urls.push(`${domain}/${section}/${id}/${sub}?page=${id}&sort=asc`);
        break;
      case 2:
        urls.push(`${domain}/${section}/${id}/${sub}?sort=asc&page=${id}`); // query param reorder
        break;
      case 3:
        urls.push(`${domain}/${section}/${id}/`); // trailing slash
        break;
      case 4:
        urls.push(`${domain}/${section}/${id}#section-${i}`); // hash fragment
        break;
    }
  }
  return urls;
}

function generateHighCollisionUrls(count: number): string[] {
  // URLs that normalize to similar values, stressing the dedup Set
  const urls: string[] = [];
  for (let i = 0; i < count; i++) {
    // All normalize to the same base but with different query param orders
    const params = [`a=${i % 10}`, `b=${i % 5}`, `c=${i % 3}`];
    // Shuffle params to create normalization work
    const shuffled = [...params].sort(() => Math.random() - 0.5);
    urls.push(`https://example.com/page?${shuffled.join('&')}`);
  }
  return urls;
}

function generateLongUrls(count: number): string[] {
  const urls: string[] = [];
  for (let i = 0; i < count; i++) {
    const pathSegments = Array.from({ length: 10 }, (_, j) => `segment-${j}-${i}`);
    const queryParams = Array.from({ length: 8 }, (_, j) => `param${j}=value-${j}-${i}`);
    urls.push(`https://example.com/${pathSegments.join('/')}?${queryParams.join('&')}`);
  }
  return urls;
}

// ---------------------------------------------------------------------------
// URL Normalization Benchmarks
// ---------------------------------------------------------------------------

describe('URL Normalization', () => {
  const simpleUrl = 'https://example.com/products/123';
  const urlWithQuery = 'https://example.com/search?sort=price&category=electronics&page=2';
  const urlWithTrailingSlash = 'https://example.com/products/123/';
  const urlWithHash = 'https://example.com/page#section-1';
  const urlWithMixedCase = 'HTTPS://EXAMPLE.COM/Products/ABC';
  const longUrl = `https://example.com/${'a/'.repeat(20)}?${'p=v&'.repeat(10)}`;

  bench('simple URL (no normalization needed)', () => {
    normalizeUrl(simpleUrl);
  });

  bench('URL with query params (needs sorting)', () => {
    normalizeUrl(urlWithQuery);
  });

  bench('URL with trailing slash (needs stripping)', () => {
    normalizeUrl(urlWithTrailingSlash);
  });

  bench('URL with hash fragment (needs stripping)', () => {
    normalizeUrl(urlWithHash);
  });

  bench('URL with mixed case (needs lowercasing)', () => {
    normalizeUrl(urlWithMixedCase);
  });

  bench('long URL with many segments and params', () => {
    normalizeUrl(longUrl);
  });

  bench('URL with hash preservation enabled', () => {
    normalizeUrl('https://example.com/app#/dashboard/settings', { preserveHash: true });
  });

  bench('batch normalize 1000 URLs', () => {
    const urls = generateUrls(1000);
    for (const url of urls) {
      normalizeUrl(url);
    }
  });
});

// ---------------------------------------------------------------------------
// Frontier Enqueue Benchmarks
// ---------------------------------------------------------------------------

describe('Frontier Enqueue', () => {
  bench('enqueue 1,000 unique URLs', () => {
    const frontier = new Frontier({ maxDepth: 10 });
    const urls = generateUrls(1000);
    for (const url of urls) {
      frontier.enqueue({ url, depth: 0 });
    }
  });

  bench('enqueue 10,000 unique URLs', () => {
    const frontier = new Frontier({ maxDepth: 10 });
    const urls = generateUrls(10_000);
    for (const url of urls) {
      frontier.enqueue({ url, depth: 0 });
    }
  });

  bench('enqueue with 50% duplicates (dedup stress)', () => {
    const frontier = new Frontier({ maxDepth: 10 });
    const baseUrls = generateUrls(5000);
    // Enqueue all, then enqueue again (all duplicates)
    const allUrls = [...baseUrls, ...baseUrls];
    for (const url of allUrls) {
      frontier.enqueue({ url, depth: 0 });
    }
  });

  bench('enqueue high-collision URLs (normalization dedup)', () => {
    const frontier = new Frontier({ maxDepth: 10 });
    const urls = generateHighCollisionUrls(10_000);
    for (const url of urls) {
      frontier.enqueue({ url, depth: 0 });
    }
  });

  bench('enqueue with depth filtering', () => {
    const frontier = new Frontier({ maxDepth: 5 });
    const urls = generateUrls(5000);
    for (let i = 0; i < urls.length; i++) {
      frontier.enqueue({ url: urls[i], depth: i % 8 }); // Some will exceed maxDepth
    }
  });
});

// ---------------------------------------------------------------------------
// Frontier Dequeue Benchmarks
// ---------------------------------------------------------------------------

describe('Frontier Dequeue', () => {
  bench('dequeue 1,000 URLs', () => {
    const frontier = new Frontier({ maxDepth: 10 });
    const urls = generateUrls(1000);
    for (const url of urls) {
      frontier.enqueue({ url, depth: 0 });
    }
    while (!frontier.isEmpty) {
      frontier.dequeue();
    }
  });

  bench('dequeue 10,000 URLs', () => {
    const frontier = new Frontier({ maxDepth: 10 });
    const urls = generateUrls(10_000);
    for (const url of urls) {
      frontier.enqueue({ url, depth: 0 });
    }
    while (!frontier.isEmpty) {
      frontier.dequeue();
    }
  });

  bench('interleaved enqueue/dequeue (realistic crawl pattern)', () => {
    const frontier = new Frontier({ maxDepth: 10 });
    const urls = generateUrls(5000);
    let urlIdx = 0;

    // Seed with 10 URLs
    for (let i = 0; i < 10 && urlIdx < urls.length; i++, urlIdx++) {
      frontier.enqueue({ url: urls[urlIdx], depth: 0 });
    }

    // Process: dequeue 1, enqueue 3 (simulating link discovery)
    while (!frontier.isEmpty && urlIdx < urls.length) {
      frontier.dequeue();
      for (let i = 0; i < 3 && urlIdx < urls.length; i++, urlIdx++) {
        frontier.enqueue({ url: urls[urlIdx], depth: 1 });
      }
    }
    // Drain remaining
    while (!frontier.isEmpty) {
      frontier.dequeue();
    }
  });
});

// ---------------------------------------------------------------------------
// Frontier has() Lookup Benchmarks
// ---------------------------------------------------------------------------

describe('Frontier has() Lookup', () => {
  bench('has() with 1,000 URLs in seen set', () => {
    const frontier = new Frontier({ maxDepth: 10 });
    const urls = generateUrls(1000);
    for (const url of urls) {
      frontier.enqueue({ url, depth: 0 });
    }
    // Check 1000 lookups (500 hits, 500 misses)
    for (let i = 0; i < 500; i++) {
      frontier.hasSeen(urls[i]); // hit
      frontier.hasSeen(`https://other-domain.com/page/${i}`); // miss
    }
  });

  bench('has() with 10,000 URLs in seen set', () => {
    const frontier = new Frontier({ maxDepth: 10 });
    const urls = generateUrls(10_000);
    for (const url of urls) {
      frontier.enqueue({ url, depth: 0 });
    }
    // Check 2000 lookups
    for (let i = 0; i < 1000; i++) {
      frontier.hasSeen(urls[i]);
      frontier.hasSeen(`https://other-domain.com/page/${i}`);
    }
  });

  bench('has() with long URLs (worst-case hashing)', () => {
    const frontier = new Frontier({ maxDepth: 10 });
    const urls = generateLongUrls(1000);
    for (const url of urls) {
      frontier.enqueue({ url, depth: 0 });
    }
    for (const url of urls) {
      frontier.hasSeen(url);
    }
  });
});

// ---------------------------------------------------------------------------
// Memory Benchmarks
// ---------------------------------------------------------------------------

describe('Frontier Memory Usage', () => {
  bench('memory baseline: empty frontier', () => {
    const _frontier = new Frontier({ maxDepth: 10 });
  });

  bench('memory: load 10,000 URLs', () => {
    const frontier = new Frontier({ maxDepth: 10 });
    const urls = generateUrls(10_000);
    for (const url of urls) {
      frontier.enqueue({ url, depth: 0 });
    }
    // Force GC if available to get accurate measurement
    if (typeof globalThis.gc === 'function') {
      globalThis.gc();
    }
  });

  bench('memory: load 50,000 URLs', () => {
    const frontier = new Frontier({ maxDepth: 10 });
    const urls = generateUrls(50_000);
    for (const url of urls) {
      frontier.enqueue({ url, depth: 0 });
    }
    if (typeof globalThis.gc === 'function') {
      globalThis.gc();
    }
  });
});

// ---------------------------------------------------------------------------
// Realistic Crawl Simulation
// ---------------------------------------------------------------------------

describe('Frontier Crawl Simulation', () => {
  bench('simulate 500-page BFS crawl (50 links per page)', () => {
    const frontier = new Frontier({ maxDepth: 5 });
    const domain = 'https://webapp.example.com';

    // Seed
    frontier.enqueue({ url: `${domain}/`, depth: 0 });

    let pagesVisited = 0;
    const maxPages = 500;

    while (!frontier.isEmpty && pagesVisited < maxPages) {
      const entry = frontier.dequeue();
      if (!entry) break;
      pagesVisited++;

      // Simulate discovering 50 links per page
      for (let i = 0; i < 50; i++) {
        const linkUrl = `${domain}/section-${pagesVisited % 10}/page-${i}?ref=${pagesVisited}`;
        frontier.enqueue({
          url: linkUrl,
          depth: entry.depth + 1,
          referrer: entry.url,
        });
      }
    }
  });

  bench('simulate high-dedup crawl (90% duplicate links)', () => {
    const frontier = new Frontier({ maxDepth: 5 });
    const domain = 'https://webapp.example.com';

    // Pre-generate a pool of 100 URLs that keep reappearing
    const urlPool = Array.from({ length: 100 }, (_, i) => `${domain}/page/${i}`);

    frontier.enqueue({ url: `${domain}/`, depth: 0 });

    let pagesVisited = 0;

    while (!frontier.isEmpty && pagesVisited < 500) {
      const entry = frontier.dequeue();
      if (!entry) break;
      pagesVisited++;

      // Each page links to 50 URLs, 90% from the existing pool
      for (let i = 0; i < 50; i++) {
        const url = i < 45
          ? urlPool[Math.floor(Math.random() * urlPool.length)] // duplicate
          : `${domain}/unique/${pagesVisited}/${i}`; // new
        frontier.enqueue({ url, depth: entry.depth + 1 });
      }
    }
  });
});
