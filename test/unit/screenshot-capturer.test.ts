/**
 * Unit tests for src/collectors/screenshot-capturer.ts
 *
 * Tests the captureScreenshots function with mocked Playwright Page objects.
 * Verifies screenshot capture, scrolling, hashing, modal detection,
 * PNG dimension extraction, directory creation, and graceful failure.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { captureScreenshots } from '../../src/collectors/screenshot-capturer.js';
import type { Page, Locator } from 'playwright';
import { createHash } from 'node:crypto';
import { join, sep } from 'node:path';

// ---------------------------------------------------------------------------
// Mock fs/promises — intercept mkdir and stat calls
// ---------------------------------------------------------------------------

vi.mock('node:fs/promises', () => ({
  mkdir: vi.fn(async () => undefined),
  readFile: vi.fn(async () => Buffer.alloc(0)),
  stat: vi.fn(async () => ({ size: 1024 })),
}));

import { mkdir, stat } from 'node:fs/promises';

// ---------------------------------------------------------------------------
// Helpers: create a valid PNG buffer with specified dimensions
// ---------------------------------------------------------------------------

/**
 * Build a minimal PNG-like buffer with the given dimensions encoded
 * at the correct byte offsets (16-19 for width, 20-23 for height).
 * This is not a valid PNG file, but has the correct IHDR offsets for parsing.
 */
function makePngBuffer(width: number, height: number): Buffer {
  // 8-byte PNG signature + 4-byte IHDR length + 4-byte IHDR type + 4-byte width + 4-byte height + padding
  const buf = Buffer.alloc(32);
  // PNG signature (first 8 bytes)
  buf.writeUInt32BE(0x89504E47, 0);
  buf.writeUInt32BE(0x0D0A1A0A, 4);
  // IHDR chunk length (13 bytes of IHDR data)
  buf.writeUInt32BE(13, 8);
  // IHDR chunk type
  buf.write('IHDR', 12);
  // Width at offset 16, height at offset 20
  buf.writeUInt32BE(width, 16);
  buf.writeUInt32BE(height, 20);
  return buf;
}

// ---------------------------------------------------------------------------
// Helpers: mock Page factory
// ---------------------------------------------------------------------------

interface MockLocator {
  count: ReturnType<typeof vi.fn>;
  nth: ReturnType<typeof vi.fn>;
  isVisible: ReturnType<typeof vi.fn>;
}

function createMockLocator(visibleElements: boolean[]): MockLocator {
  const locator: MockLocator = {
    count: vi.fn(async () => visibleElements.length),
    nth: vi.fn(),
    isVisible: vi.fn(),
  };

  locator.nth.mockImplementation((index: number) => ({
    isVisible: vi.fn(async () => visibleElements[index] ?? false),
  }));

  return locator;
}

function createMockPage(options: {
  url: string;
  scrollHeight?: number;
  screenshotBuffer?: Buffer;
  screenshotThrows?: boolean;
  modalElements?: boolean[];
}): Page {
  const pngBuffer = options.screenshotBuffer ?? makePngBuffer(1280, 2400);
  const modalElements = options.modalElements ?? [];
  const locator = createMockLocator(modalElements);

  const page = {
    url: () => options.url,
    evaluate: vi.fn(async (fn: Function, ...args: unknown[]) => {
      // Detect which evaluate call this is based on the function source
      const fnStr = fn.toString();

      if (fnStr.includes('scrollHeight')) {
        return options.scrollHeight ?? 3000;
      }
      if (fnStr.includes('scrollTo')) {
        return undefined;
      }
      if (fnStr.includes('setTimeout')) {
        return undefined;
      }
      return undefined;
    }),
    screenshot: vi.fn(async (_opts?: Record<string, unknown>) => {
      if (options.screenshotThrows) {
        throw new Error('Screenshot capture failed');
      }
      return pngBuffer;
    }),
    locator: vi.fn((_selector: string) => locator as unknown as Locator),
  } as unknown as Page;

  return page;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('captureScreenshots', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // -------------------------------------------------------------------------
  // File path generation
  // -------------------------------------------------------------------------

  it('generates correct file paths from the page URL', async () => {
    const page = createMockPage({ url: 'https://example.com/about' });
    const outputDir = '/output/screenshots';

    const result = await captureScreenshots(page, 'https://example.com', outputDir);

    // urlToFilename('https://example.com/about') produces a sanitized name
    // The paths should be in the output directory with _full.png and _viewport.png suffixes
    // Use platform-agnostic assertions (Windows uses backslash, Unix uses forward slash)
    expect(result.fullPagePath).toContain('example.com');
    expect(result.fullPagePath).toMatch(/_full\.png$/);
    expect(result.viewportPath).toContain('example.com');
    expect(result.viewportPath).toMatch(/_viewport\.png$/);
    // Both paths start with the output directory
    expect(result.fullPagePath.startsWith(outputDir.replace(/\//g, sep))).toBe(true);
    expect(result.viewportPath.startsWith(outputDir.replace(/\//g, sep))).toBe(true);
  });

  it('uses the page URL in the result', async () => {
    const page = createMockPage({ url: 'https://example.com/dashboard' });

    const result = await captureScreenshots(page, 'https://example.com', '/out');

    expect(result.pageUrl).toBe('https://example.com/dashboard');
  });

  // -------------------------------------------------------------------------
  // Screenshot capture calls
  // -------------------------------------------------------------------------

  it('calls page.screenshot twice: once for fullPage and once for viewport', async () => {
    const page = createMockPage({ url: 'https://example.com/' });

    await captureScreenshots(page, 'https://example.com', '/out');

    const screenshotMock = page.screenshot as ReturnType<typeof vi.fn>;
    expect(screenshotMock).toHaveBeenCalledTimes(2);

    // First call: full-page screenshot
    const firstCallArgs = screenshotMock.mock.calls[0][0];
    expect(firstCallArgs.fullPage).toBe(true);
    expect(firstCallArgs.path).toMatch(/_full\.png$/);

    // Second call: viewport-only screenshot
    const secondCallArgs = screenshotMock.mock.calls[1][0];
    expect(secondCallArgs.fullPage).toBeUndefined();
    expect(secondCallArgs.path).toMatch(/_viewport\.png$/);
  });

  // -------------------------------------------------------------------------
  // Scrolling behavior
  // -------------------------------------------------------------------------

  it('calls page.evaluate for scrolling to trigger lazy-loaded content', async () => {
    const page = createMockPage({ url: 'https://example.com/', scrollHeight: 3000 });

    await captureScreenshots(page, 'https://example.com', '/out');

    const evaluateMock = page.evaluate as ReturnType<typeof vi.fn>;
    // Should have been called multiple times:
    // 1x for scrollHeight, Nx for scrollTo + settle, 1x for scroll-to-top
    expect(evaluateMock.mock.calls.length).toBeGreaterThanOrEqual(3);

    // Check that scrollTo was called (functions containing 'scrollTo')
    const scrollCalls = evaluateMock.mock.calls.filter((call: unknown[]) =>
      (call[0] as Function).toString().includes('scrollTo'),
    );
    expect(scrollCalls.length).toBeGreaterThanOrEqual(1);
  });

  it('limits scrolling to 3 viewport increments', async () => {
    // Page is very tall but we should only scroll 3 times
    const page = createMockPage({ url: 'https://example.com/', scrollHeight: 100_000 });
    const viewport = { width: 1280, height: 720 };

    await captureScreenshots(page, 'https://example.com', '/out', viewport);

    const evaluateMock = page.evaluate as ReturnType<typeof vi.fn>;
    // Count scrollTo calls (excluding the final scroll-to-top)
    const scrollDownCalls = evaluateMock.mock.calls.filter((call: unknown[]) => {
      const fnStr = (call[0] as Function).toString();
      return fnStr.includes('scrollTo') && call.length > 1 && typeof call[1] === 'number';
    });
    // Should have at most 3 scroll-down calls
    expect(scrollDownCalls.length).toBeLessThanOrEqual(3);
  });

  // -------------------------------------------------------------------------
  // SHA-256 hash computation
  // -------------------------------------------------------------------------

  it('computes correct SHA-256 hashes for both screenshots', async () => {
    const pngBuffer = makePngBuffer(800, 600);
    const expectedHash = createHash('sha256').update(pngBuffer).digest('hex');

    const page = createMockPage({
      url: 'https://example.com/',
      screenshotBuffer: pngBuffer,
    });

    const result = await captureScreenshots(page, 'https://example.com', '/out');

    expect(result.fullPageHash).toBe(expectedHash);
    expect(result.viewportHash).toBe(expectedHash);
    expect(result.fullPageHash).toHaveLength(64);
  });

  // -------------------------------------------------------------------------
  // Modal detection
  // -------------------------------------------------------------------------

  it('detects visible modals on the page', async () => {
    const page = createMockPage({
      url: 'https://example.com/',
      modalElements: [true], // one visible modal
    });

    const result = await captureScreenshots(page, 'https://example.com', '/out');

    expect(result.modalDetected).toBe(true);
    expect(page.locator).toHaveBeenCalledWith(
      'dialog[open], [role="dialog"], .modal.show, .modal.active',
    );
  });

  it('returns modalDetected false when no modals are present', async () => {
    const page = createMockPage({
      url: 'https://example.com/',
      modalElements: [], // no modals
    });

    const result = await captureScreenshots(page, 'https://example.com', '/out');

    expect(result.modalDetected).toBe(false);
  });

  it('returns modalDetected false when modals exist but are not visible', async () => {
    const page = createMockPage({
      url: 'https://example.com/',
      modalElements: [false, false], // modals exist but none visible
    });

    const result = await captureScreenshots(page, 'https://example.com', '/out');

    expect(result.modalDetected).toBe(false);
  });

  // -------------------------------------------------------------------------
  // Graceful failure
  // -------------------------------------------------------------------------

  it('returns empty result when screenshot throws', async () => {
    const page = createMockPage({
      url: 'https://example.com/broken',
      screenshotThrows: true,
    });

    const result = await captureScreenshots(page, 'https://example.com', '/out');

    expect(result.pageUrl).toBe('https://example.com/broken');
    expect(result.fullPagePath).toBe('');
    expect(result.viewportPath).toBe('');
    expect(result.fullPageHash).toBe('0'.repeat(64));
    expect(result.viewportHash).toBe('0'.repeat(64));
    expect(result.dimensions).toEqual({ width: 0, height: 0 });
    expect(result.fileSizeBytes).toBe(0);
    expect(result.modalDetected).toBe(false);
  });

  it('preserves the viewport in the failure result', async () => {
    const page = createMockPage({
      url: 'https://example.com/',
      screenshotThrows: true,
    });
    const viewport = { width: 1920, height: 1080 };

    const result = await captureScreenshots(page, 'https://example.com', '/out', viewport);

    expect(result.viewport).toEqual({ width: 1920, height: 1080 });
  });

  // -------------------------------------------------------------------------
  // Output directory creation
  // -------------------------------------------------------------------------

  it('creates the output directory with recursive flag', async () => {
    const page = createMockPage({ url: 'https://example.com/' });
    const outputDir = '/deep/nested/output/screenshots';

    await captureScreenshots(page, 'https://example.com', outputDir);

    expect(mkdir).toHaveBeenCalledWith(outputDir, { recursive: true });
  });

  // -------------------------------------------------------------------------
  // PNG dimension extraction
  // -------------------------------------------------------------------------

  it('extracts correct dimensions from the PNG buffer', async () => {
    const pngBuffer = makePngBuffer(1920, 3200);
    const page = createMockPage({
      url: 'https://example.com/',
      screenshotBuffer: pngBuffer,
    });

    const result = await captureScreenshots(page, 'https://example.com', '/out');

    expect(result.dimensions).toEqual({ width: 1920, height: 3200 });
  });

  it('returns zero dimensions for a buffer too small to be a valid PNG', async () => {
    // A buffer smaller than 24 bytes cannot contain IHDR width/height
    const tinyBuffer = Buffer.alloc(10);
    const page = createMockPage({
      url: 'https://example.com/',
      screenshotBuffer: tinyBuffer,
    });

    const result = await captureScreenshots(page, 'https://example.com', '/out');

    expect(result.dimensions).toEqual({ width: 0, height: 0 });
  });

  // -------------------------------------------------------------------------
  // Viewport defaults
  // -------------------------------------------------------------------------

  it('uses default viewport 1280x720 when none is provided', async () => {
    const page = createMockPage({ url: 'https://example.com/' });

    const result = await captureScreenshots(page, 'https://example.com', '/out');

    expect(result.viewport).toEqual({ width: 1280, height: 720 });
  });

  it('uses the provided custom viewport', async () => {
    const page = createMockPage({ url: 'https://example.com/' });
    const viewport = { width: 768, height: 1024 };

    const result = await captureScreenshots(page, 'https://example.com', '/out', viewport);

    expect(result.viewport).toEqual({ width: 768, height: 1024 });
  });

  // -------------------------------------------------------------------------
  // File size
  // -------------------------------------------------------------------------

  it('reports the file size from stat', async () => {
    const page = createMockPage({ url: 'https://example.com/' });
    vi.mocked(stat).mockResolvedValueOnce({ size: 54321 } as any);

    const result = await captureScreenshots(page, 'https://example.com', '/out');

    expect(result.fileSizeBytes).toBe(54321);
  });

  // -------------------------------------------------------------------------
  // Result shape
  // -------------------------------------------------------------------------

  it('returns a complete ScreenshotResult with all required fields', async () => {
    const page = createMockPage({ url: 'https://example.com/page' });

    const result = await captureScreenshots(page, 'https://example.com', '/out');

    expect(result).toHaveProperty('pageUrl');
    expect(result).toHaveProperty('fullPagePath');
    expect(result).toHaveProperty('viewportPath');
    expect(result).toHaveProperty('viewport');
    expect(result).toHaveProperty('fullPageHash');
    expect(result).toHaveProperty('viewportHash');
    expect(result).toHaveProperty('dimensions');
    expect(result).toHaveProperty('fileSizeBytes');
    expect(result).toHaveProperty('modalDetected');
    expect(typeof result.fullPageHash).toBe('string');
    expect(typeof result.viewportHash).toBe('string');
    expect(typeof result.fileSizeBytes).toBe('number');
    expect(typeof result.modalDetected).toBe('boolean');
  });
});
