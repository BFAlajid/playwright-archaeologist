/**
 * Unit tests for src/types/config.ts
 *
 * Configuration schema validation: valid configs, boundary values,
 * viewport parsing, URL normalization, file path validation,
 * and default application.
 */

import { describe, it, expect } from 'vitest';
import {
  CrawlConfigSchema,
  ViewportSchema,
  parseViewport,
  normalizeEntryUrl,
} from '../../src/types/config.js';

// ---------------------------------------------------------------------------
// CrawlConfigSchema validation
// ---------------------------------------------------------------------------

describe('CrawlConfigSchema', () => {
  /**
   * Helper: parse with only required fields plus overrides.
   */
  function parseConfig(overrides: Record<string, unknown> = {}) {
    return CrawlConfigSchema.safeParse({
      targetUrl: 'https://example.com',
      ...overrides,
    });
  }

  describe('valid configurations', () => {
    it('accepts minimal valid config with only targetUrl', () => {
      const result = parseConfig();
      expect(result.success).toBe(true);
    });

    it('applies all defaults correctly', () => {
      const result = parseConfig();
      expect(result.success).toBe(true);
      if (!result.success) return;

      expect(result.data.depth).toBe(5);
      expect(result.data.maxPages).toBe(1000);
      expect(result.data.concurrency).toBe(3);
      expect(result.data.timeout).toBe(30_000);
      expect(result.data.maxTime).toBe(3600);
      expect(result.data.delay).toBe(0);
      expect(result.data.viewport).toEqual({ width: 1280, height: 720 });
      expect(result.data.outputDir).toBe('.archaeologist');
      expect(result.data.format).toBe('both');
      expect(result.data.followExternal).toBe(false);
      expect(result.data.deepClick).toBe(false);
      expect(result.data.includeIframes).toBe(false);
      expect(result.data.noScreenshots).toBe(false);
      expect(result.data.noHar).toBe(false);
      expect(result.data.resume).toBe(false);
      expect(result.data.yes).toBe(false);
      expect(result.data.allowPrivate).toBe(false);
      expect(result.data.includeCookies).toBe(false);
    });

    it('accepts full valid config', () => {
      const result = parseConfig({
        depth: 10,
        maxPages: 500,
        concurrency: 5,
        timeout: 60000,
        maxTime: 7200,
        delay: 100,
        viewport: { width: 1920, height: 1080 },
        outputDir: './output',
        format: 'html',
        followExternal: true,
        deepClick: true,
        include: ['**/docs/**'],
        exclude: ['**/admin/**'],
        noScreenshots: true,
        allowPrivate: true,
      });
      expect(result.success).toBe(true);
    });
  });

  describe('depth validation', () => {
    it('accepts depth 0 (crawl only entry URL)', () => {
      const result = parseConfig({ depth: 0 });
      expect(result.success).toBe(true);
      if (result.success) expect(result.data.depth).toBe(0);
    });

    it('rejects depth -1', () => {
      const result = parseConfig({ depth: -1 });
      expect(result.success).toBe(false);
    });

    it('accepts depth 100 (max)', () => {
      const result = parseConfig({ depth: 100 });
      expect(result.success).toBe(true);
    });

    it('rejects depth > 100', () => {
      const result = parseConfig({ depth: 101 });
      expect(result.success).toBe(false);
    });

    it('rejects non-integer depth', () => {
      const result = parseConfig({ depth: 2.5 });
      expect(result.success).toBe(false);
    });
  });

  describe('concurrency validation', () => {
    it('rejects concurrency 0', () => {
      const result = parseConfig({ concurrency: 0 });
      expect(result.success).toBe(false);
    });

    it('accepts concurrency 1', () => {
      const result = parseConfig({ concurrency: 1 });
      expect(result.success).toBe(true);
    });

    it('accepts concurrency 20 (max)', () => {
      const result = parseConfig({ concurrency: 20 });
      expect(result.success).toBe(true);
    });

    it('rejects concurrency > 20', () => {
      const result = parseConfig({ concurrency: 21 });
      expect(result.success).toBe(false);
    });

    it('rejects negative concurrency', () => {
      const result = parseConfig({ concurrency: -1 });
      expect(result.success).toBe(false);
    });
  });

  describe('timeout validation', () => {
    it('rejects timeout 0', () => {
      const result = parseConfig({ timeout: 0 });
      expect(result.success).toBe(false);
    });

    it('rejects timeout < 1000', () => {
      const result = parseConfig({ timeout: 999 });
      expect(result.success).toBe(false);
    });

    it('accepts timeout 1000 (minimum)', () => {
      const result = parseConfig({ timeout: 1000 });
      expect(result.success).toBe(true);
    });

    it('accepts timeout 300000 (maximum)', () => {
      const result = parseConfig({ timeout: 300000 });
      expect(result.success).toBe(true);
    });

    it('rejects timeout > 300000', () => {
      const result = parseConfig({ timeout: 300001 });
      expect(result.success).toBe(false);
    });
  });

  describe('maxPages validation', () => {
    it('rejects maxPages 0', () => {
      const result = parseConfig({ maxPages: 0 });
      expect(result.success).toBe(false);
    });

    it('accepts maxPages 1', () => {
      const result = parseConfig({ maxPages: 1 });
      expect(result.success).toBe(true);
    });

    it('accepts maxPages 100000', () => {
      const result = parseConfig({ maxPages: 100000 });
      expect(result.success).toBe(true);
    });
  });

  describe('delay validation', () => {
    it('accepts delay 0', () => {
      const result = parseConfig({ delay: 0 });
      expect(result.success).toBe(true);
    });

    it('rejects delay -1', () => {
      const result = parseConfig({ delay: -1 });
      expect(result.success).toBe(false);
    });

    it('accepts delay 60000 (max)', () => {
      const result = parseConfig({ delay: 60000 });
      expect(result.success).toBe(true);
    });

    it('rejects delay > 60000', () => {
      const result = parseConfig({ delay: 60001 });
      expect(result.success).toBe(false);
    });
  });

  describe('maxTime validation', () => {
    it('accepts maxTime 0 (no limit)', () => {
      const result = parseConfig({ maxTime: 0 });
      expect(result.success).toBe(true);
    });

    it('rejects negative maxTime', () => {
      const result = parseConfig({ maxTime: -1 });
      expect(result.success).toBe(false);
    });
  });

  describe('format validation', () => {
    it('accepts "html"', () => {
      const result = parseConfig({ format: 'html' });
      expect(result.success).toBe(true);
    });

    it('accepts "json"', () => {
      const result = parseConfig({ format: 'json' });
      expect(result.success).toBe(true);
    });

    it('accepts "openapi"', () => {
      const result = parseConfig({ format: 'openapi' });
      expect(result.success).toBe(true);
    });

    it('accepts "both"', () => {
      const result = parseConfig({ format: 'both' });
      expect(result.success).toBe(true);
    });

    it('rejects invalid format', () => {
      const result = parseConfig({ format: 'xml' });
      expect(result.success).toBe(false);
    });
  });

  describe('targetUrl validation', () => {
    it('rejects missing URL', () => {
      const result = CrawlConfigSchema.safeParse({});
      expect(result.success).toBe(false);
    });

    it('rejects empty string URL', () => {
      const result = CrawlConfigSchema.safeParse({ targetUrl: '' });
      expect(result.success).toBe(false);
    });

    it('rejects non-URL string', () => {
      const result = CrawlConfigSchema.safeParse({
        targetUrl: 'not-a-url',
      });
      expect(result.success).toBe(false);
    });

    it('accepts http URL', () => {
      const result = parseConfig({ targetUrl: 'http://localhost:3000' });
      expect(result.success).toBe(true);
    });

    it('accepts https URL', () => {
      const result = parseConfig({ targetUrl: 'https://example.com' });
      expect(result.success).toBe(true);
    });
  });
});

// ---------------------------------------------------------------------------
// parseViewport
// ---------------------------------------------------------------------------

describe('parseViewport', () => {
  it('parses "1280x720"', () => {
    const result = parseViewport('1280x720');
    expect(result).toEqual({ width: 1280, height: 720 });
  });

  it('parses "1920x1080"', () => {
    const result = parseViewport('1920x1080');
    expect(result).toEqual({ width: 1920, height: 1080 });
  });

  it('parses "375x812" (mobile)', () => {
    const result = parseViewport('375x812');
    expect(result).toEqual({ width: 375, height: 812 });
  });

  it('rejects "invalid" string', () => {
    expect(parseViewport('invalid')).toBeNull();
  });

  it('rejects "1280" (missing height)', () => {
    expect(parseViewport('1280')).toBeNull();
  });

  it('rejects "x720" (missing width)', () => {
    expect(parseViewport('x720')).toBeNull();
  });

  it('rejects "1280X720" (uppercase X)', () => {
    expect(parseViewport('1280X720')).toBeNull();
  });

  it('rejects "1280 x 720" (spaces)', () => {
    expect(parseViewport('1280 x 720')).toBeNull();
  });

  it('rejects "0x0"', () => {
    // 0x0 should fail ViewportSchema min constraints
    expect(parseViewport('0x0')).toBeNull();
  });

  it('rejects viewport with width below 320', () => {
    expect(parseViewport('100x720')).toBeNull();
  });

  it('rejects viewport with height below 240', () => {
    expect(parseViewport('1280x100')).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// normalizeEntryUrl
// ---------------------------------------------------------------------------

describe('normalizeEntryUrl', () => {
  it('prepends https:// when no protocol is specified', () => {
    const result = normalizeEntryUrl('example.com');
    expect(result.url).toBe('https://example.com');
    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0]).toContain('https://');
  });

  it('preserves http:// protocol', () => {
    const result = normalizeEntryUrl('http://localhost:3000');
    expect(result.url).toBe('http://localhost:3000');
    expect(result.warnings).toHaveLength(0);
  });

  it('preserves https:// protocol', () => {
    const result = normalizeEntryUrl('https://example.com');
    expect(result.url).toBe('https://example.com');
    expect(result.warnings).toHaveLength(0);
  });

  it('rejects ftp:// protocol', () => {
    expect(() => normalizeEntryUrl('ftp://files.example.com')).toThrow();
  });

  it('rejects file:// protocol', () => {
    expect(() => normalizeEntryUrl('file:///etc/passwd')).toThrow();
  });

  it('trims whitespace', () => {
    const result = normalizeEntryUrl('  https://example.com  ');
    expect(result.url).toBe('https://example.com');
  });

  it('handles URL with path', () => {
    const result = normalizeEntryUrl('example.com/path');
    expect(result.url).toBe('https://example.com/path');
  });

  it('rejects empty string', () => {
    expect(() => normalizeEntryUrl('')).toThrow();
  });

  it('rejects URL with no hostname', () => {
    expect(() => normalizeEntryUrl('https://')).toThrow();
  });
});
