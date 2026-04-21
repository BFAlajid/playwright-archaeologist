/**
 * Unit tests for src/diff/screenshot-diff.ts
 *
 * Uses small synthetic PNGs generated with pngjs so tests run offline
 * and deterministically. Covers:
 *   - Identical images report 0% difference and no heatmap when not asked.
 *   - Differing images report a plausible percentage and emit a heatmap
 *     when `emitHeatmapTo` is set.
 *   - Dimension mismatch is reported via `mismatchReason` with NaN percentage.
 *   - Non-PNG inputs are surfaced as a format mismatch, not a thrown error.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PNG } from 'pngjs';
import { diffScreenshotPair } from '../../src/diff/screenshot-diff.js';

/** Build a solid-colour PNG buffer at the given size. */
function makePng(width: number, height: number, rgba: [number, number, number, number]): Buffer {
  const png = new PNG({ width, height });
  const [r, g, b, a] = rgba;
  for (let i = 0; i < png.data.length; i += 4) {
    png.data[i] = r;
    png.data[i + 1] = g;
    png.data[i + 2] = b;
    png.data[i + 3] = a;
  }
  return PNG.sync.write(png);
}

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'pa-ssdiff-'));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true }).catch(() => {});
});

describe('diffScreenshotPair', () => {
  it('reports 0% difference for identical PNGs', async () => {
    const buf = makePng(10, 10, [255, 0, 0, 255]);
    const oldPath = join(dir, 'old.png');
    const newPath = join(dir, 'new.png');
    await writeFile(oldPath, buf);
    await writeFile(newPath, buf);

    const result = await diffScreenshotPair(oldPath, newPath);
    expect(result.percentage).toBe(0);
    expect(result.differentPixels).toBe(0);
    expect(result.samePixels).toBe(100);
    expect(result.totalPixels).toBe(100);
    expect(result.width).toBe(10);
    expect(result.height).toBe(10);
    expect(result.heatmapPath).toBeUndefined();
    expect(result.mismatchReason).toBeUndefined();
  });

  it('reports non-zero difference and emits a heatmap for changed PNGs', async () => {
    const red = makePng(8, 8, [255, 0, 0, 255]);
    const blue = makePng(8, 8, [0, 0, 255, 255]);
    const oldPath = join(dir, 'old.png');
    const newPath = join(dir, 'new.png');
    const heatmapPath = join(dir, 'heatmap.png');
    await writeFile(oldPath, red);
    await writeFile(newPath, blue);

    const result = await diffScreenshotPair(oldPath, newPath, {
      emitHeatmapTo: heatmapPath,
    });

    expect(result.totalPixels).toBe(64);
    expect(result.differentPixels).toBeGreaterThan(0);
    expect(result.percentage).toBeGreaterThan(0);
    expect(result.percentage).toBeLessThanOrEqual(100);
    expect(result.heatmapPath).toBe(heatmapPath);
    // The heatmap file must be a valid PNG.
    const { readFile } = await import('node:fs/promises');
    const heatmapBuf = await readFile(heatmapPath);
    const decoded = PNG.sync.read(heatmapBuf);
    expect(decoded.width).toBe(8);
    expect(decoded.height).toBe(8);
  });

  it('flags dimension mismatch without throwing', async () => {
    const small = makePng(4, 4, [0, 255, 0, 255]);
    const large = makePng(8, 8, [0, 255, 0, 255]);
    const oldPath = join(dir, 'old.png');
    const newPath = join(dir, 'new.png');
    await writeFile(oldPath, small);
    await writeFile(newPath, large);

    const result = await diffScreenshotPair(oldPath, newPath);
    expect(Number.isNaN(result.percentage)).toBe(true);
    expect(result.totalPixels).toBe(0);
    expect(result.mismatchReason).toMatch(/Dimension mismatch/);
  });

  it('flags non-PNG input as a format mismatch rather than throwing', async () => {
    const oldPath = join(dir, 'old.png');
    const newPath = join(dir, 'new.png');
    // Valid PNG for one side, garbage for the other.
    await writeFile(oldPath, makePng(4, 4, [255, 255, 255, 255]));
    await writeFile(newPath, Buffer.from('not a png'));

    const result = await diffScreenshotPair(oldPath, newPath);
    expect(Number.isNaN(result.percentage)).toBe(true);
    expect(result.mismatchReason).toMatch(/not readable as PNG/i);
  });

  it('flags missing files with a readable error', async () => {
    const result = await diffScreenshotPair(
      join(dir, 'missing-old.png'),
      join(dir, 'missing-new.png'),
    );
    expect(Number.isNaN(result.percentage)).toBe(true);
    expect(result.mismatchReason).toMatch(/Failed to read screenshot/);
  });
});
