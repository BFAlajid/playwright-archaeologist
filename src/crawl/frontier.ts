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

export interface FrontierEntry {
  url: string;
  depth: number;
  referrer?: string;
}

export class Frontier {
  private queue: FrontierEntry[] = [];
  private head: number = 0;
  private seen: Set<string> = new Set();
  private maxDepth: number;

  constructor(options: { maxDepth?: number } = {}) {
    this.maxDepth = options.maxDepth ?? Infinity;
  }

  /**
   * Add a URL to the queue. Returns false if already seen or exceeds max depth.
   */
  enqueue(entry: FrontierEntry): boolean {
    if (entry.depth > this.maxDepth) {
      return false;
    }

    const normalized = normalizeUrl(entry.url);

    if (this.seen.has(normalized)) {
      return false;
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
