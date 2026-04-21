/**
 * URL Frontier -- BFS queue with deduplication.
 *
 * Maintains a queue of URLs to visit with:
 * - BFS ordering (FIFO)
 * - Deduplication using normalized URLs
 * - Depth tracking per URL
 *
 * Uses a dequeue pointer instead of Array.shift() to avoid O(n)
 * cost on large queues. Compacts the internal array when more than
 * half of its entries have been consumed.
 */

import { normalizeUrl } from './url-utils';
import { FrontierOverflowError } from '../types/errors';

export interface FrontierEntry {
  url: string;
  depth: number;
  referrer?: string;
}

/**
 * Default upper bound on the seen-set size. 500k URLs × ~100 bytes each
 * keeps the frontier under ~50 MB of resident memory. Crawls that legitimately
 * need more can raise `maxSeen`; the alternative is a Bloom filter (future
 * work).
 */
const DEFAULT_MAX_SEEN = 500_000;

export interface FrontierOptions {
  maxDepth?: number;
  /**
   * Upper bound on the seen-set. When the count exceeds this limit,
   * `enqueue` throws `FrontierOverflowError` so the crawl fails loudly
   * rather than silently eating memory.
   */
  maxSeen?: number;
}

export class Frontier {
  private queue: FrontierEntry[] = [];
  private head: number = 0;
  private seen: Set<string> = new Set();
  private maxDepth: number;
  private maxSeen: number;

  constructor(options: FrontierOptions = {}) {
    this.maxDepth = options.maxDepth ?? Infinity;
    this.maxSeen = options.maxSeen ?? DEFAULT_MAX_SEEN;
  }

  /**
   * Add a URL to the queue. Returns false if already seen or exceeds max depth.
   * Throws `FrontierOverflowError` when adding this URL would push the seen-set
   * past `maxSeen`.
   */
  enqueue(entry: FrontierEntry): boolean {
    if (entry.depth > this.maxDepth) {
      return false;
    }

    const normalized = normalizeUrl(entry.url);

    if (this.seen.has(normalized)) {
      return false;
    }

    // Check before insertion so the error reflects the limit, not an
    // off-by-one overshoot.
    if (this.seen.size >= this.maxSeen) {
      throw new FrontierOverflowError(this.seen.size, this.maxSeen);
    }

    this.seen.add(normalized);
    this.queue.push(entry);
    return true;
  }

  /**
   * Remove and return the next URL from the queue (FIFO).
   * Returns undefined if queue is empty.
   */
  dequeue(): FrontierEntry | undefined {
    if (this.head >= this.queue.length) {
      return undefined;
    }

    const entry = this.queue[this.head++];

    // Compact when more than half the array is consumed
    if (this.head > this.queue.length / 2) {
      this.queue = this.queue.slice(this.head);
      this.head = 0;
    }

    return entry;
  }

  /**
   * Check if a URL has been seen (ever enqueued, whether still queued or already dequeued).
   */
  hasSeen(url: string): boolean {
    const normalized = normalizeUrl(url);
    return this.seen.has(normalized);
  }

  /**
   * Get the number of URLs remaining in the queue.
   */
  get size(): number {
    return this.queue.length - this.head;
  }

  /**
   * Get the total number of URLs seen (visited + queued).
   */
  get totalSeen(): number {
    return this.seen.size;
  }

  /**
   * Check if the queue is empty.
   */
  get isEmpty(): boolean {
    return this.head >= this.queue.length;
  }
}
