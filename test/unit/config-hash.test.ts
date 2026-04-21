/**
 * Tests for src/crawl/config-hash.ts
 *
 * hashConfig must:
 *   - Be deterministic for the same config (stable across calls, stable
 *     across key insertion order).
 *   - Ignore volatile fields (outputDir, authScript, cookiesFile, warnings,
 *     collectors, resume).
 *   - Produce different hashes for configs that differ in crawl-shaping
 *     fields (depth, maxPages, targetUrl, include, exclude, etc.).
 */

import { describe, it, expect } from 'vitest';
import { hashConfig } from '../../src/crawl/config-hash.js';
import type { ResolvedConfig } from '../../src/types/config.js';

function baseConfig(): ResolvedConfig {
  return {
    targetUrl: 'https://example.com',
    depth: 5,
    maxPages: 1000,
    include: [],
    exclude: [],
    followExternal: false,
    deepClick: false,
    includeIframes: false,
    concurrency: 3,
    delay: 0,
    timeout: 30_000,
    maxTime: 3600,
    includeCookies: false,
    outputDir: '/tmp/a',
    format: 'both',
    noScreenshots: false,
    screenshotFormat: 'jpeg',
    noHar: false,
    prettyJson: false,
    harIncludeBodies: false,
    viewport: { width: 1280, height: 720 },
    additionalViewports: [],
    resume: false,
    yes: false,
    allowPrivate: false,
    allowAuthScript: false,
    captureJsBodies: false,
    warnings: [],
  } as unknown as ResolvedConfig;
}

describe('hashConfig', () => {
  it('is deterministic for the same config', () => {
    const cfg = baseConfig();
    const a = hashConfig(cfg);
    const b = hashConfig(cfg);
    expect(a).toBe(b);
    expect(a).toMatch(/^[0-9a-f]{64}$/);
  });

  it('is stable regardless of key insertion order', () => {
    const cfg1 = baseConfig();
    const cfg2 = { ...cfg1 };
    // Re-insert keys in a different order by reading/deleting/writing.
    const reordered: Record<string, unknown> = {};
    for (const k of Object.keys(cfg2).reverse()) {
      reordered[k] = (cfg2 as unknown as Record<string, unknown>)[k];
    }
    expect(hashConfig(reordered as unknown as ResolvedConfig)).toBe(hashConfig(cfg1));
  });

  it('ignores outputDir', () => {
    const a = baseConfig();
    const b = { ...a, outputDir: '/tmp/completely/different/path' };
    expect(hashConfig(a)).toBe(hashConfig(b));
  });

  it('ignores authScript and cookiesFile', () => {
    const a = baseConfig();
    const b = { ...a, authScript: '/path/to/auth.js', cookiesFile: '/path/to/cookies.json' };
    expect(hashConfig(a)).toBe(hashConfig(b));
  });

  it('ignores warnings', () => {
    const a = baseConfig();
    const b = { ...a, warnings: ['some warning'] };
    expect(hashConfig(a)).toBe(hashConfig(b));
  });

  it('ignores the resume flag itself', () => {
    // The original crawl runs with resume=false; the resuming run sets
    // resume=true. These must produce the SAME hash for resume to work.
    const a = baseConfig();
    const b = { ...a, resume: true };
    expect(hashConfig(a)).toBe(hashConfig(b));
  });

  it('ignores collectors (function refs are not serializable)', () => {
    const a = baseConfig();
    const b = {
      ...a,
      collectors: [{ name: 'x', collect: async () => ({}) }],
    };
    expect(hashConfig(a as ResolvedConfig)).toBe(hashConfig(b as unknown as ResolvedConfig));
  });

  it('changes when targetUrl differs', () => {
    const a = baseConfig();
    const b = { ...a, targetUrl: 'https://other.example.com' };
    expect(hashConfig(a)).not.toBe(hashConfig(b));
  });

  it('changes when depth differs', () => {
    const a = baseConfig();
    const b = { ...a, depth: 2 };
    expect(hashConfig(a)).not.toBe(hashConfig(b));
  });

  it('changes when maxPages differs', () => {
    const a = baseConfig();
    const b = { ...a, maxPages: 50 };
    expect(hashConfig(a)).not.toBe(hashConfig(b));
  });

  it('changes when include patterns differ', () => {
    const a = baseConfig();
    const b = { ...a, include: ['**/users/**'] };
    expect(hashConfig(a)).not.toBe(hashConfig(b));
  });

  it('changes when viewport differs', () => {
    const a = baseConfig();
    const b = { ...a, viewport: { width: 375, height: 667 } };
    expect(hashConfig(a)).not.toBe(hashConfig(b));
  });

  it('is sensitive to include/exclude order (arrays keep declared order)', () => {
    // Rationale: glob matching is order-sensitive when we later implement
    // "first match wins" — treat differently ordered arrays as different
    // configs. Changing this would require sorting in resolveConfig.
    const a = { ...baseConfig(), include: ['**/a/**', '**/b/**'] };
    const b = { ...baseConfig(), include: ['**/b/**', '**/a/**'] };
    expect(hashConfig(a)).not.toBe(hashConfig(b));
  });
});
