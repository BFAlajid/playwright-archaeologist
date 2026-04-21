/**
 * Unit tests for src/crawl/fatal-handler.ts
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';

import type { ResolvedConfig } from '../../src/types/config.js';
import {
  handleFatalCrawlFailure,
  buildCrawlResult,
} from '../../src/crawl/fatal-handler.js';

function mkConfig(overrides: Partial<ResolvedConfig> = {}): ResolvedConfig {
  return {
    targetUrl: 'https://example.com',
    depth: 0,
    maxPages: 1,
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

describe('fatal-handler', () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'pa-fatal-'));
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
  });

  describe('buildCrawlResult', () => {
    it('returns a CrawlResult with duration derived from timestamps', () => {
      const start = new Date('2026-04-20T00:00:00Z');
      const end = new Date('2026-04-20T00:00:30Z');
      const result = buildCrawlResult(
        mkConfig(),
        start,
        end,
        [],
        ['https://example.com/unvisited'],
        [],
        'complete',
      );
      expect(result.durationMs).toBe(30000);
      expect(result.startedAt).toBe(start.toISOString());
      expect(result.finishedAt).toBe(end.toISOString());
      expect(result.unvisitedUrls).toEqual(['https://example.com/unvisited']);
    });

    it('carries through config fields', () => {
      const result = buildCrawlResult(
        mkConfig({ concurrency: 4, depth: 7 }),
        new Date(),
        new Date(),
        [],
        [],
        [],
        'complete',
      );
      expect(result.config.concurrency).toBe(4);
      expect(result.config.depth).toBe(7);
    });
  });

  describe('handleFatalCrawlFailure', () => {
    it('returns a DigResult with completionStatus=error', async () => {
      const config = mkConfig({ outputDir: tmpDir });
      const result = await handleFatalCrawlFailure({
        error: new Error('boom'),
        config,
        startedAt: new Date(),
        pages: [],
        errors: [],
      });
      expect(result.completionStatus).toBe('error');
      expect(result.artifacts).toBeDefined();
      expect(result.outputPaths.outputDir).toBe(tmpDir);
    });

    it('appends an ERR_FATAL entry to the errors array', async () => {
      const config = mkConfig({ outputDir: tmpDir });
      const errors: never[] | Array<{ code: string; message: string }> = [];
      const result = await handleFatalCrawlFailure({
        error: new Error('kaboom'),
        config,
        startedAt: new Date(),
        pages: [],
        errors: errors as never,
      });
      expect(result.errors.some((e) => e.code === 'ERR_FATAL')).toBe(true);
    });

    it('writes partial output files when output dir is writable', async () => {
      const config = mkConfig({ outputDir: tmpDir });
      await handleFatalCrawlFailure({
        error: new Error('crash'),
        config,
        startedAt: new Date(),
        pages: [],
        errors: [],
      });
      const summaryStat = await fs.stat(path.join(tmpDir, 'crawl-summary.json')).catch(() => null);
      expect(summaryStat?.isFile()).toBe(true);
    });

    it('does not throw even when output dir cannot be created', async () => {
      // Point at a path that cannot be created (on Windows a drive letter
      // that doesn't exist causes mkdir to fail).
      const badPath = process.platform === 'win32'
        ? 'Z:\\definitely-not-a-real-path-123'
        : '/proc/1/fake-nope';
      const config = mkConfig({ outputDir: badPath });
      const result = await handleFatalCrawlFailure({
        error: new Error('crash'),
        config,
        startedAt: new Date(),
        pages: [],
        errors: [],
      });
      expect(result.completionStatus).toBe('error');
    });

    it('handles non-Error thrown values', async () => {
      const config = mkConfig({ outputDir: tmpDir });
      const result = await handleFatalCrawlFailure({
        error: 'string error',
        config,
        startedAt: new Date(),
        pages: [],
        errors: [],
      });
      expect(result.errors[0].message).toBe('string error');
    });
  });
});
