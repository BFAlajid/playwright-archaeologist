/**
 * Pixel-level screenshot diffing.
 *
 * Wraps pixelmatch to report actual percentage-of-pixels-changed between two
 * screenshots and to optionally emit a heatmap PNG that highlights changed
 * pixels. The wider diff engine calls this per screenshot pair.
 *
 * Constraints:
 *   - Input must be PNG. JPEG inputs are reported as a dimension / format
 *     mismatch (the diff engine falls back to hash comparison in that case).
 *   - Dimensions must match. If they do not, returns a result with
 *     `percentage: NaN` so the caller can report "dimension mismatch" rather
 *     than a misleading number.
 *
 * Pixelmatch is synchronous and CPU-bound. The orchestrating diff engine
 * caps concurrency; this module does not.
 */

import { readFile, writeFile } from 'node:fs/promises';
import { PNG } from 'pngjs';
import pixelmatch from 'pixelmatch';

export interface ScreenshotDiffOptions {
  /**
   * Pixelmatch threshold in the 0-1 range (lower = more sensitive).
   * Defaults to 0.1, matching pixelmatch's own default.
   */
  threshold?: number;
  /**
   * If set, a heatmap PNG is written to this path highlighting every
   * changed pixel in red. Missing parent directories are NOT created —
   * the caller must ensure the directory exists.
   */
  emitHeatmapTo?: string;
}

export interface ScreenshotDiffResult {
  /** Number of matching pixels (totalPixels - differentPixels). */
  samePixels: number;
  /** Number of differing pixels. */
  differentPixels: number;
  /**
   * Percentage of pixels that changed, 0-100. NaN when the images cannot
   * be compared (dimension mismatch, unreadable PNGs, etc.).
   */
  percentage: number;
  /** Total pixels compared. 0 when comparison could not proceed. */
  totalPixels: number;
  /** Image width if the comparison ran. */
  width?: number;
  /** Image height if the comparison ran. */
  height?: number;
  /** Absolute path to the heatmap PNG if one was emitted. */
  heatmapPath?: string;
  /**
   * Human-readable reason the comparison could not run (e.g. dimension
   * mismatch). Only set when `percentage` is NaN.
   */
  mismatchReason?: string;
}

function parsePng(buffer: Buffer): PNG | null {
  try {
    return PNG.sync.read(buffer);
  } catch {
    return null;
  }
}

/**
 * Diff two PNG screenshots and optionally emit a heatmap.
 *
 * Never throws for content-level errors — bad input produces a result
 * with `percentage: NaN` and a `mismatchReason`. Only filesystem I/O
 * errors on `emitHeatmapTo` propagate to the caller.
 */
export async function diffScreenshotPair(
  oldPath: string,
  newPath: string,
  options: ScreenshotDiffOptions = {},
): Promise<ScreenshotDiffResult> {
  let oldBuffer: Buffer;
  let newBuffer: Buffer;
  try {
    oldBuffer = await readFile(oldPath);
    newBuffer = await readFile(newPath);
  } catch (err: unknown) {
    return {
      samePixels: 0,
      differentPixels: 0,
      percentage: Number.NaN,
      totalPixels: 0,
      mismatchReason: `Failed to read screenshot: ${err instanceof Error ? err.message : String(err)}`,
    };
  }

  const oldPng = parsePng(oldBuffer);
  const newPng = parsePng(newBuffer);
  if (!oldPng || !newPng) {
    return {
      samePixels: 0,
      differentPixels: 0,
      percentage: Number.NaN,
      totalPixels: 0,
      mismatchReason: 'One or both screenshots are not readable as PNG (format mismatch or corruption)',
    };
  }

  if (oldPng.width !== newPng.width || oldPng.height !== newPng.height) {
    return {
      samePixels: 0,
      differentPixels: 0,
      percentage: Number.NaN,
      totalPixels: 0,
      mismatchReason: `Dimension mismatch: ${oldPng.width}x${oldPng.height} vs ${newPng.width}x${newPng.height}`,
    };
  }

  const { width, height } = oldPng;
  const totalPixels = width * height;
  const diffPng = options.emitHeatmapTo ? new PNG({ width, height }) : undefined;

  const differentPixels = pixelmatch(
    oldPng.data,
    newPng.data,
    diffPng?.data,
    width,
    height,
    { threshold: options.threshold ?? 0.1 },
  );

  const samePixels = totalPixels - differentPixels;
  const percentage = totalPixels === 0 ? 0 : (differentPixels / totalPixels) * 100;

  let heatmapPath: string | undefined;
  if (diffPng && options.emitHeatmapTo) {
    await writeFile(options.emitHeatmapTo, PNG.sync.write(diffPng));
    heatmapPath = options.emitHeatmapTo;
  }

  return {
    samePixels,
    differentPixels,
    percentage,
    totalPixels,
    width,
    height,
    heatmapPath,
  };
}
