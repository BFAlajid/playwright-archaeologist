/**
 * ScreenshotCapturer collector — captures full-page and viewport screenshots.
 *
 * Receives a Playwright Page that has already navigated to the target URL.
 * Takes two screenshots per page:
 *   1. Full-page screenshot (captures entire scrollable area)
 *   2. Viewport-only screenshot (captures visible area only)
 *
 * Before capturing, performs limited scrolling (up to 3 viewport increments)
 * to trigger lazy-loaded content, then scrolls back to the top.
 *
 * Detects visible modals/dialogs on the page for metadata.
 * Gracefully degrades: returns an empty result if screenshots fail.
 */

import type { Page } from 'playwright';
import type { Viewport } from '../types/config.js';
import type { ScreenshotResult } from '../types/artifacts.js';
import { urlToFilename } from '../security/output-sanitizer.js';
import { createHash } from 'node:crypto';
import { mkdir, readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const DEFAULT_VIEWPORT: Viewport = { width: 1280, height: 720 };
const MAX_SCROLL_INCREMENTS = 3;
const SCROLL_SETTLE_MS = 200;
const MAX_FULLPAGE_HEIGHT = 10_000;

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
 * @returns         ScreenshotResult with paths, hashes, and metadata.
 */
export async function captureScreenshots(
  page: Page,
  baseUrl: string,
  outputDir: string,
  viewport?: Viewport,
): Promise<ScreenshotResult> {
  const effectiveViewport = viewport ?? DEFAULT_VIEWPORT;
  const pageUrl = page.url();

  // Build deterministic file paths from the page URL
  const baseName = urlToFilename(pageUrl);
  const fullPageFilename = `${baseName}_full.png`;
  const viewportFilename = `${baseName}_viewport.png`;
  const fullPagePath = join(outputDir, fullPageFilename);
  const viewportPath = join(outputDir, viewportFilename);

  try {
    // Ensure the output directory exists
    await mkdir(outputDir, { recursive: true });

    // Scroll to trigger lazy-loaded content, then scroll back to top
    await triggerLazyContent(page, effectiveViewport);

    // Detect modals/dialogs before taking screenshots
    const modalDetected = await detectModals(page);

    // Check scroll height and cap if too tall to prevent OOM
    const scrollHeight = await page.evaluate(() => document.documentElement.scrollHeight);
    const useCappedScreenshot = scrollHeight > MAX_FULLPAGE_HEIGHT;

    // Take full-page screenshot (capped if page is very tall)
    const fullPageBuffer = useCappedScreenshot
      ? await page.screenshot({
          clip: { x: 0, y: 0, width: effectiveViewport.width, height: MAX_FULLPAGE_HEIGHT },
          path: fullPagePath,
        })
      : await page.screenshot({ fullPage: true, path: fullPagePath });

    // Take viewport-only screenshot
    const viewportBuffer = await page.screenshot({ path: viewportPath });

    // Compute SHA-256 hashes
    const fullPageHash = computeSha256(fullPageBuffer);
    const viewportHash = computeSha256(viewportBuffer);

    // Extract dimensions from the full-page PNG buffer
    const dimensions = extractPngDimensions(fullPageBuffer);

    // Get file size of the full-page screenshot
    const fileSizeBytes = await getFileSize(fullPagePath, fullPageBuffer);

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
// Lazy-content scrolling
// ---------------------------------------------------------------------------

/**
 * Scroll down in viewport-sized increments (up to MAX_SCROLL_INCREMENTS)
 * to trigger lazy-loaded images and content, then scroll back to top.
 */
async function triggerLazyContent(page: Page, viewport: Viewport): Promise<void> {
  const scrollHeight = await page.evaluate(() => document.documentElement.scrollHeight);
  const viewportHeight = viewport.height;
  const maxScrollDistance = viewportHeight * MAX_SCROLL_INCREMENTS;
  const targetScroll = Math.min(scrollHeight, maxScrollDistance);

  for (let scrolled = viewportHeight; scrolled <= targetScroll; scrolled += viewportHeight) {
    await page.evaluate((y: number) => window.scrollTo(0, y), scrolled);
    // Brief wait for lazy content to begin loading
    await page.evaluate(
      (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)),
      SCROLL_SETTLE_MS,
    );
  }

  // Scroll back to top
  await page.evaluate(() => window.scrollTo(0, 0));
}

// ---------------------------------------------------------------------------
// Modal/dialog detection
// ---------------------------------------------------------------------------

/**
 * Check if any modal or dialog overlay is currently visible on the page.
 */
async function detectModals(page: Page): Promise<boolean> {
  const modalSelector = 'dialog[open], [role="dialog"], .modal.show, .modal.active';
  const locator = page.locator(modalSelector);
  try {
    const count = await locator.count();
    if (count === 0) return false;

    // Check if any matched element is actually visible
    for (let i = 0; i < count; i++) {
      const isVisible = await locator.nth(i).isVisible();
      if (isVisible) return true;
    }
    return false;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Hashing
// ---------------------------------------------------------------------------

/**
 * Compute SHA-256 hex digest of a buffer.
 */
function computeSha256(buffer: Buffer): string {
  return createHash('sha256').update(buffer).digest('hex');
}

// ---------------------------------------------------------------------------
// PNG dimension extraction
// ---------------------------------------------------------------------------

/**
 * Extract width and height from a PNG file buffer by reading the IHDR chunk.
 *
 * PNG structure: 8-byte signature, then IHDR chunk.
 * IHDR data starts at byte 16:
 *   - Bytes 16-19: width (big-endian uint32)
 *   - Bytes 20-23: height (big-endian uint32)
 */
function extractPngDimensions(buffer: Buffer): { width: number; height: number } {
  if (buffer.length < 24) {
    return { width: 0, height: 0 };
  }

  const width = buffer.readUInt32BE(16);
  const height = buffer.readUInt32BE(20);

  return { width, height };
}

// ---------------------------------------------------------------------------
// File size
// ---------------------------------------------------------------------------

/**
 * Get the file size. Uses stat if possible, falls back to buffer length.
 */
async function getFileSize(filePath: string, buffer: Buffer): Promise<number> {
  try {
    const stats = await stat(filePath);
    return stats.size;
  } catch {
    return buffer.length;
  }
}
