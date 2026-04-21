/**
 * ScreenshotCapturer collector — captures full-page and viewport screenshots.
 *
 * Receives a Playwright Page that has already navigated to the target URL.
 * Takes two screenshots per page:
 *   1. Full-page screenshot (captures entire scrollable area)
 *   2. Viewport-only screenshot (captures visible area only)
 *
 * Before capturing, performs limited scrolling (up to 3 viewport increments)
 * to trigger lazy-loaded content, then scrolls back to the top. The scrolling
 * is driven by a single page.evaluate() that loops in the browser, not N
 * separate round-trips per step.
 *
 * Detects visible modals/dialogs on the page for metadata.
 * Gracefully degrades: returns an empty result if screenshots fail.
 *
 * Memory: screenshots are streamed to disk via Playwright's `path` option
 * instead of being held in a Node Buffer. The hash is computed by streaming
 * the file back through createHash. This avoids keeping the entire screenshot
 * in memory alongside the disk write.
 */

import type { Page } from 'playwright';
import type { Viewport } from '../types/config.js';
import type { ScreenshotResult } from '../types/artifacts.js';
import { urlToFilename } from '../security/output-sanitizer.js';
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { mkdir, stat } from 'node:fs/promises';
import { join } from 'node:path';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const DEFAULT_VIEWPORT: Viewport = { width: 1280, height: 720 };
const MAX_SCROLL_INCREMENTS = 3;
const SCROLL_SETTLE_MS = 200;
const MAX_FULLPAGE_HEIGHT = 10_000;

/** Default JPEG quality for full-page screenshots. 80 balances size vs quality. */
const DEFAULT_JPEG_QUALITY = 80;

export type ScreenshotFormat = 'jpeg' | 'png';

export interface CaptureScreenshotsOptions {
  /**
   * Format for the full-page screenshot. Default: 'jpeg' at quality 80.
   * JPEG is 3-5x smaller than PNG for typical screenshots and the quality
   * loss is imperceptible for regression-diff purposes. Viewport screenshots
   * remain PNG because they are small, crisp, and commonly shown in reports.
   */
  format?: ScreenshotFormat;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Capture full-page and viewport screenshots of a page.
 *
 * @param page      Playwright Page already navigated to the target URL.
 * @param baseUrl   The crawl's starting URL (unused here, kept for collector interface consistency).
 * @param outputDir Directory where screenshot files will be saved.
 * @param viewport  Viewport dimensions used for capture. Defaults to 1280x720.
 * @param options   Optional overrides (e.g. screenshot format).
 * @returns         ScreenshotResult with paths, hashes, and metadata.
 */
export async function captureScreenshots(
  page: Page,
  baseUrl: string,
  outputDir: string,
  viewport?: Viewport,
  options?: CaptureScreenshotsOptions,
): Promise<ScreenshotResult> {
  const effectiveViewport = viewport ?? DEFAULT_VIEWPORT;
  const format: ScreenshotFormat = options?.format ?? 'jpeg';
  const pageUrl = page.url();

  // Build deterministic file paths from the page URL. The full-page file's
  // extension follows the selected format; viewport stays PNG.
  const baseName = urlToFilename(pageUrl);
  const fullPageExt = format === 'jpeg' ? '.jpg' : '.png';
  const fullPageFilename = `${baseName}_full${fullPageExt}`;
  const viewportFilename = `${baseName}_viewport.png`;
  const fullPagePath = join(outputDir, fullPageFilename);
  const viewportPath = join(outputDir, viewportFilename);

  try {
    // Ensure the output directory exists
    await mkdir(outputDir, { recursive: true });

    // Scroll to trigger lazy-loaded content, then scroll back to top.
    // This single evaluate returns the final scrollHeight so we do not have
    // to round-trip a second time to check capping.
    const scrollHeight = await triggerLazyContent(page, effectiveViewport);
    const useCappedScreenshot = scrollHeight > MAX_FULLPAGE_HEIGHT;

    // Detect modals/dialogs before taking screenshots (single evaluate).
    const modalDetected = await detectModals(page);

    // Build the full-page screenshot options. Passing `path` lets Playwright
    // stream bytes to disk; we do NOT keep the buffer alongside.
    const fullPageBase: Record<string, unknown> = {
      path: fullPagePath,
    };
    if (format === 'jpeg') {
      fullPageBase.type = 'jpeg';
      fullPageBase.quality = DEFAULT_JPEG_QUALITY;
    }

    if (useCappedScreenshot) {
      await page.screenshot({
        ...fullPageBase,
        clip: { x: 0, y: 0, width: effectiveViewport.width, height: MAX_FULLPAGE_HEIGHT },
      });
    } else {
      await page.screenshot({
        ...fullPageBase,
        fullPage: true,
      });
    }

    // Viewport screenshot stays PNG (small, sharp).
    await page.screenshot({ path: viewportPath });

    // Stream-hash both screenshots back from disk. This avoids holding the
    // screenshot buffer in Node memory while Playwright already wrote it to
    // disk.
    const fullPageHash = await streamHash(fullPagePath);
    const viewportHash = await streamHash(viewportPath);

    // Dimensions: PNG files have an IHDR chunk; JPEG files have a different
    // structure. When the full-page image is JPEG we fall back to the
    // viewport dimensions (they are the closest available approximation).
    // Viewport file is always PNG so we can read IHDR from it.
    let dimensions: { width: number; height: number };
    if (format === 'png') {
      dimensions = await readPngDimensionsFromDisk(fullPagePath);
    } else {
      // JPEG: extract via the JPEG SOF marker. Fall back to zero if absent.
      dimensions = await readJpegDimensionsFromDisk(fullPagePath);
    }

    // Get file size of the full-page screenshot from disk.
    const fileSizeBytes = await getFileSize(fullPagePath);

    return {
      pageUrl,
      fullPagePath,
      viewportPath,
      viewport: effectiveViewport,
      fullPageHash,
      viewportHash,
      dimensions,
      fileSizeBytes,
      modalDetected,
    };
  } catch {
    // Graceful failure: return a result with empty paths and zero hashes
    return {
      pageUrl,
      fullPagePath: '',
      viewportPath: '',
      viewport: effectiveViewport,
      fullPageHash: '0'.repeat(64),
      viewportHash: '0'.repeat(64),
      dimensions: { width: 0, height: 0 },
      fileSizeBytes: 0,
      modalDetected: false,
    };
  }
}

// ---------------------------------------------------------------------------
// Lazy-content scrolling (single roundtrip)
// ---------------------------------------------------------------------------

/**
 * Scroll down in viewport-sized increments (up to MAX_SCROLL_INCREMENTS)
 * to trigger lazy-loaded images and content, then scroll back to top.
 *
 * Implementation: ONE page.evaluate that runs a scroll + sleep loop inside
 * the browser. Previously each scroll step cost its own page.evaluate()
 * round-trip — N+1 IPC hops per page. Now it is 1.
 *
 * Returns the final document.scrollHeight after all scrolling is done, so
 * the caller does not need a separate round-trip to check the height.
 */
async function triggerLazyContent(page: Page, viewport: Viewport): Promise<number> {
  return page.evaluate(
    async ({ viewportHeight, maxIncrements, settleMs }: {
      viewportHeight: number;
      maxIncrements: number;
      settleMs: number;
    }): Promise<number> => {
      const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
      const maxDistance = viewportHeight * maxIncrements;
      const targetScroll = Math.min(document.documentElement.scrollHeight, maxDistance);

      for (let y = viewportHeight; y <= targetScroll; y += viewportHeight) {
        window.scrollTo(0, y);
        await sleep(settleMs);
      }

      // Scroll back to the top so subsequent screenshots are stable.
      window.scrollTo(0, 0);

      return document.documentElement.scrollHeight;
    },
    {
      viewportHeight: viewport.height,
      maxIncrements: MAX_SCROLL_INCREMENTS,
      settleMs: SCROLL_SETTLE_MS,
    },
  );
}

// ---------------------------------------------------------------------------
// Modal/dialog detection (single roundtrip)
// ---------------------------------------------------------------------------

/**
 * Check if any modal or dialog overlay is currently visible on the page.
 *
 * Implementation: ONE page.evaluate that queries dialogs/alerts and checks
 * getComputedStyle().display/visibility in a single browser-side pass.
 * Previously ran count() + isVisible() per match — up to N+1 IPC round-trips.
 */
async function detectModals(page: Page): Promise<boolean> {
  try {
    return await page.evaluate((): boolean => {
      const selector = 'dialog[open], [role="dialog"], .modal.show, .modal.active';
      const elements = document.querySelectorAll(selector);
      for (const el of Array.from(elements)) {
        if (!(el instanceof Element)) continue;
        const style = window.getComputedStyle(el);
        if (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0') {
          continue;
        }
        // Matches Playwright's notion of visibility: an element with a
        // non-zero bounding rect that is not explicitly hidden.
        const rect = el.getBoundingClientRect();
        if (rect.width > 0 && rect.height > 0) return true;
      }
      return false;
    });
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Streaming hash
// ---------------------------------------------------------------------------

/**
 * Compute SHA-256 hex digest of a file by streaming chunks through
 * createHash. Keeps peak memory bounded to the stream buffer size instead
 * of loading the entire screenshot.
 */
function streamHash(filePath: string): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    const hash = createHash('sha256');
    const stream = createReadStream(filePath);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('end', () => resolve(hash.digest('hex')));
    stream.on('error', reject);
  });
}

// ---------------------------------------------------------------------------
// Dimensions (read from disk to avoid holding the full buffer)
// ---------------------------------------------------------------------------

/**
 * Extract width and height from a PNG file by reading only the first 24
 * bytes (PNG signature + IHDR header). Avoids buffering the full file.
 */
async function readPngDimensionsFromDisk(
  filePath: string,
): Promise<{ width: number; height: number }> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    let total = 0;
    const stream = createReadStream(filePath, { start: 0, end: 23 });
    stream.on('data', (chunk) => {
      const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      chunks.push(buf);
      total += buf.length;
    });
    stream.on('end', () => {
      const buffer = Buffer.concat(chunks, total);
      if (buffer.length < 24) {
        resolve({ width: 0, height: 0 });
        return;
      }
      resolve({
        width: buffer.readUInt32BE(16),
        height: buffer.readUInt32BE(20),
      });
    });
    stream.on('error', () => resolve({ width: 0, height: 0 }));
  });
}

/**
 * Extract width and height from a JPEG file's SOF0/SOF2 marker. Reads only
 * the header bytes — JPEGs store dimensions near the top after the SOI
 * marker and any EXIF metadata. Fall back to {0, 0} if the marker can't be
 * found in the first 64 KB.
 */
async function readJpegDimensionsFromDisk(
  filePath: string,
): Promise<{ width: number; height: number }> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    let total = 0;
    const stream = createReadStream(filePath, { start: 0, end: 64 * 1024 - 1 });
    stream.on('data', (chunk) => {
      const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      chunks.push(buf);
      total += buf.length;
    });
    stream.on('end', () => {
      const buffer = Buffer.concat(chunks, total);
      resolve(parseJpegDimensions(buffer));
    });
    stream.on('error', () => resolve({ width: 0, height: 0 }));
  });
}

/**
 * Parse the JPEG SOF (Start Of Frame) marker to extract image dimensions.
 * Exported for testing; not part of the public API.
 */
export function parseJpegDimensions(buffer: Buffer): { width: number; height: number } {
  // JPEG marker: 0xFF followed by a marker byte. SOF0=0xC0, SOF2=0xC2.
  // Baseline JPEGs almost always use SOF0; progressive uses SOF2.
  let i = 2; // skip SOI (0xFFD8)
  while (i < buffer.length - 9) {
    if (buffer[i] !== 0xff) {
      i++;
      continue;
    }
    const marker = buffer[i + 1];
    // SOF markers that carry dimensions: 0xC0-0xCF except 0xC4, 0xC8, 0xCC
    if (
      marker >= 0xc0 &&
      marker <= 0xcf &&
      marker !== 0xc4 &&
      marker !== 0xc8 &&
      marker !== 0xcc
    ) {
      // Segment length (2 bytes), precision (1), height (2), width (2)
      const height = buffer.readUInt16BE(i + 5);
      const width = buffer.readUInt16BE(i + 7);
      return { width, height };
    }
    // Skip this marker's data segment to continue searching.
    const segLen = buffer.readUInt16BE(i + 2);
    i += 2 + segLen;
  }
  return { width: 0, height: 0 };
}

// ---------------------------------------------------------------------------
// File size
// ---------------------------------------------------------------------------

/**
 * Get the file size from stat. Returns 0 on failure.
 */
async function getFileSize(filePath: string): Promise<number> {
  try {
    const stats = await stat(filePath);
    return stats.size;
  } catch {
    return 0;
  }
}
