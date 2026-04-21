/**
 * Unit tests for src/collectors/screenshot-capturer.ts
 *
 * Tests the captureScreenshots function with mocked Playwright Page objects.
 * Verifies screenshot capture, scrolling, hashing, modal detection,
 * PNG dimension extraction, directory creation, and graceful failure.
 *
 * The implementation streams screenshot bytes directly to disk via
 * Playwright's `path` option and then streams the file back through
 * createHash — it does NOT hold the screenshot in a Node Buffer. The tests
 * mock `node:fs` streams accordingly.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { captureScreenshots, parseJpegDimensions } from '../../src/collectors/screenshot-capturer.js';
import type { Page, Locator } from 'playwright';
import { createHash } from 'node:crypto';
import { sep } from 'node:path';

// ---------------------------------------------------------------------------
// Mock fs/promises — intercept mkdir/stat calls
// ---------------------------------------------------------------------------

vi.mock('node:fs/promises', () => ({
  mkdir: vi.fn(async () => undefined),
  stat: vi.fn(async () => ({ size: 1024 })),
}));

import { mkdir, stat } from 'node:fs/promises';

// ---------------------------------------------------------------------------
// Mock node:fs createReadStream — return a readable stream of the buffer
// the test wants to pretend the screenshot wrote. Controlled per-test via
// setMockFileBuffer().
// ---------------------------------------------------------------------------

let mockFileBuffer: Buffer = Buffer.alloc(0);
function setMockFileBuffer(buf: Buffer) {
  mockFileBuffer = buf;
}

vi.mock('node:fs', () => ({
  createReadStream: vi.fn((_filePath: string, opts?: { start?: number; end?: number }) => {
    // Slice the mock buffer to match the requested byte range if any.
    const start = opts?.start ?? 0;
    const endInclusive = opts?.end ?? mockFileBuffer.length - 1;
    const sliced = mockFileBuffer.slice(start, endInclusive + 1);

    const handlers = new Map<string, Array<(...args: unknown[]) => void>>();
    const stream = {
      on(event: string, handler: (...args: unknown[]) => void) {
        if (!handlers.has(event)) handlers.set(event, []);
        handlers.get(event)!.push(handler);
        // Fire asynchronously like a real stream.
        if (event === 'end') {
          setTimeout(() => {
            const dataHandlers = handlers.get('data') ?? [];
            for (const h of dataHandlers) h(sliced);
            const endHandlers = handlers.get('end') ?? [];
            for (const h of endHandlers) h();
          }, 0);
        }
        return stream;
      },
    };
    return stream;
  }),
}));

// ---------------------------------------------------------------------------
// Helpers: create a valid PNG buffer with specified dimensions
// ---------------------------------------------------------------------------

/**
 * Build a minimal PNG-like buffer with the given dimensions encoded
 * at the correct byte offsets (16-19 for width, 20-23 for height).
 */
function makePngBuffer(width: number, height: number): Buffer {
  const buf = Buffer.alloc(32);
  buf.writeUInt32BE(0x89504e47, 0);
  buf.writeUInt32BE(0x0d0a1a0a, 4);
  buf.writeUInt32BE(13, 8);
  buf.write('IHDR', 12);
  buf.writeUInt32BE(width, 16);
  buf.writeUInt32BE(height, 20);
  return buf;
}

/**
 * Build a minimal JPEG-like buffer with dimensions encoded in an SOF0 marker.
 */
function makeJpegBuffer(width: number, height: number): Buffer {
  // SOI (0xFFD8) + SOF0 (0xFFC0) + len(2) + precision(1) + height(2) + width(2) + ...
  const buf = Buffer.alloc(32);
  buf[0] = 0xff; buf[1] = 0xd8;           // SOI
  buf[2] = 0xff; buf[3] = 0xc0;           // SOF0
  buf.writeUInt16BE(11, 4);               // segment length (not validated here)
  buf[6] = 8;                              // precision
  buf.writeUInt16BE(height, 7);
  buf.writeUInt16BE(width, 9);
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
  const buffer = options.screenshotBuffer ?? makeJpegBuffer(1280, 2400);
  // Install this buffer as the data backing createReadStream for the life
  // of this test.
  setMockFileBuffer(buffer);

  const hasVisibleModal = (options.modalElements ?? []).some(Boolean);

  const page = {
    url: () => options.url,
    evaluate: vi.fn(async (fn: Function, _arg?: unknown) => {
      const fnStr = fn.toString();
      // triggerLazyContent: uses viewportHeight/scrollHeight, returns scrollHeight
      if (fnStr.includes('viewportHeight') || fnStr.includes('scrollHeight')) {
        return options.scrollHeight ?? 3000;
      }
      // detectModals: uses querySelectorAll with dialog/[role="dialog"]
      if (fnStr.includes('dialog[open]')) {
        return hasVisibleModal;
      }
      return undefined;
    }),
    screenshot: vi.fn(async (_opts?: Record<string, unknown>) => {
      if (options.screenshotThrows) {
        throw new Error('Screenshot capture failed');
      }
      // Playwright would write to disk here; our mock stream already has the
      // bytes queued up. Return an empty buffer to confirm we are not relying
      // on the return value anywhere.
      return Buffer.alloc(0);
    }),
    locator: vi.fn((_selector: string) => ({} as Locator)),
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

  it('generates correct file paths from the page URL (default JPEG full-page)', async () => {
    const page = createMockPage({ url: 'https://example.com/about' });
    const outputDir = '/output/screenshots';

    const result = await captureScreenshots(page, 'https://example.com', outputDir);

    // Default format is now JPEG — full-page filename ends in .jpg.
    expect(result.fullPagePath).toContain('example.com');
    expect(result.fullPagePath).toMatch(/_full\.jpg$/);
    // Viewport stays PNG.
    expect(result.viewportPath).toContain('example.com');
    expect(result.viewportPath).toMatch(/_viewport\.png$/);
    expect(result.fullPagePath.startsWith(outputDir.replace(/\//g, sep))).toBe(true);
    expect(result.viewportPath.startsWith(outputDir.replace(/\//g, sep))).toBe(true);
  });

  it('writes PNG full-page when format=png', async () => {
    const pngBuffer = makePngBuffer(800, 600);
    const page = createMockPage({ url: 'https://example.com/about', screenshotBuffer: pngBuffer });

    const result = await captureScreenshots(page, 'https://example.com', '/out', undefined, {
      format: 'png',
    });

    expect(result.fullPagePath).toMatch(/_full\.png$/);
    expect(result.viewportPath).toMatch(/_viewport\.png$/);
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

    // First call: full-page JPEG by default.
    const firstCallArgs = screenshotMock.mock.calls[0][0];
    expect(firstCallArgs.fullPage).toBe(true);
    expect(firstCallArgs.path).toMatch(/_full\.jpg$/);
    expect(firstCallArgs.type).toBe('jpeg');
    expect(firstCallArgs.quality).toBe(80);

    // Second call: viewport-only PNG.
    const secondCallArgs = screenshotMock.mock.calls[1][0];
    expect(secondCallArgs.fullPage).toBeUndefined();
    expect(secondCallArgs.path).toMatch(/_viewport\.png$/);
    expect(secondCallArgs.type).toBeUndefined();
  });

  it('does NOT set type/quality when format=png', async () => {
    const pngBuffer = makePngBuffer(800, 600);
    const page = createMockPage({ url: 'https://example.com/', screenshotBuffer: pngBuffer });

    await captureScreenshots(page, 'https://example.com', '/out', undefined, { format: 'png' });

    const screenshotMock = page.screenshot as ReturnType<typeof vi.fn>;
    const firstCallArgs = screenshotMock.mock.calls[0][0];
    expect(firstCallArgs.type).toBeUndefined();
    expect(firstCallArgs.quality).toBeUndefined();
    expect(firstCallArgs.path).toMatch(/_full\.png$/);
  });

  it('does not hold the screenshot buffer in memory — passes `path` only', async () => {
    const page = createMockPage({ url: 'https://example.com/' });

    await captureScreenshots(page, 'https://example.com', '/out');

    const screenshotMock = page.screenshot as ReturnType<typeof vi.fn>;
    // Every call must include a path, never omit it (which would force the
    // buffer to stay in Node memory).
    for (const call of screenshotMock.mock.calls) {
      expect(call[0]).toHaveProperty('path');
      expect(typeof (call[0] as { path: string }).path).toBe('string');
    }
  });

  // -------------------------------------------------------------------------
  // Scrolling behavior
  // -------------------------------------------------------------------------

  it('runs lazy-content scrolling via a SINGLE page.evaluate roundtrip', async () => {
    const page = createMockPage({ url: 'https://example.com/', scrollHeight: 3000 });

    await captureScreenshots(page, 'https://example.com', '/out');

    const evaluateMock = page.evaluate as ReturnType<typeof vi.fn>;

    // The scroll loop runs inside the browser. The outer page.evaluate call
    // count for scrolling must be exactly 1 — no N+1 round-trips per step.
    const scrollCalls = evaluateMock.mock.calls.filter((call: unknown[]) => {
      const fnStr = (call[0] as Function).toString();
      return fnStr.includes('viewportHeight') && fnStr.includes('scrollTo');
    });
    expect(scrollCalls).toHaveLength(1);
  });

  it('modal detection runs in a single evaluate — no count/nth/isVisible calls', async () => {
    const page = createMockPage({ url: 'https://example.com/', modalElements: [true] });

    await captureScreenshots(page, 'https://example.com', '/out');

    // The new implementation does not use page.locator at all for detection.
    // It uses a single page.evaluate against the selector inside the browser.
    const evaluateMock = page.evaluate as ReturnType<typeof vi.fn>;
    const modalEvals = evaluateMock.mock.calls.filter((call: unknown[]) =>
      (call[0] as Function).toString().includes('dialog[open]'),
    );
    expect(modalEvals).toHaveLength(1);
  });

  // -------------------------------------------------------------------------
  // SHA-256 hash computation (streaming)
  // -------------------------------------------------------------------------

  it('computes SHA-256 hashes by streaming the file from disk', async () => {
    const jpegBuffer = makeJpegBuffer(800, 600);
    const expectedHash = createHash('sha256').update(jpegBuffer).digest('hex');

    const page = createMockPage({ url: 'https://example.com/', screenshotBuffer: jpegBuffer });

    const result = await captureScreenshots(page, 'https://example.com', '/out');

    // Both full-page and viewport stream from the same mock buffer, so both
    // hashes are identical to the buffer hash.
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
      modalElements: [true],
    });

    const result = await captureScreenshots(page, 'https://example.com', '/out');
    expect(result.modalDetected).toBe(true);
  });

  it('returns modalDetected false when no modals are present', async () => {
    const page = createMockPage({
      url: 'https://example.com/',
      modalElements: [],
    });

    const result = await captureScreenshots(page, 'https://example.com', '/out');
    expect(result.modalDetected).toBe(false);
  });

  it('returns modalDetected false when modals exist but are not visible', async () => {
    const page = createMockPage({
      url: 'https://example.com/',
      modalElements: [false, false],
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
  // PNG/JPEG dimension extraction
  // -------------------------------------------------------------------------

  it('extracts correct dimensions from a PNG full-page screenshot', async () => {
    const pngBuffer = makePngBuffer(1920, 3200);
    const page = createMockPage({ url: 'https://example.com/', screenshotBuffer: pngBuffer });

    const result = await captureScreenshots(page, 'https://example.com', '/out', undefined, {
      format: 'png',
    });

    expect(result.dimensions).toEqual({ width: 1920, height: 3200 });
  });

  it('extracts correct dimensions from a JPEG full-page screenshot', async () => {
    const jpegBuffer = makeJpegBuffer(1600, 900);
    const page = createMockPage({ url: 'https://example.com/', screenshotBuffer: jpegBuffer });

    const result = await captureScreenshots(page, 'https://example.com', '/out');

    expect(result.dimensions).toEqual({ width: 1600, height: 900 });
  });

  it('parseJpegDimensions returns zero for a buffer without SOF marker', () => {
    // Only SOI, no SOF0/SOF2 — should resolve to 0x0.
    const buf = Buffer.from([0xff, 0xd8, 0x00, 0x00]);
    expect(parseJpegDimensions(buf)).toEqual({ width: 0, height: 0 });
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
