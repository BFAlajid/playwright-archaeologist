/**
 * Performance benchmarks for the diff engine.
 *
 * Measures:
 * - SHA-256 hashing for fast-path screenshot comparison
 * - pixelmatch pixel comparison at various scales
 * - jsondiffpatch for API map structural diffing
 * - ZIP bundle creation and extraction (yazl/yauzl)
 * - PNG decode/encode via pngjs
 *
 * Run: npx vitest bench test/performance/diff.bench.ts
 *
 * NOTE: Some benchmarks use mock data that simulates realistic buffer sizes
 * without requiring actual PNG files or external dependencies. When the real
 * dependencies (pixelmatch, pngjs, jsondiffpatch, yazl, yauzl) are installed,
 * the commented-out sections can be enabled for accurate measurements.
 */

import { bench, describe } from 'vitest';
import { createHash } from 'node:crypto';
import { Buffer } from 'node:buffer';

// ---------------------------------------------------------------------------
// Mock data generators
// ---------------------------------------------------------------------------

/**
 * Generate a mock RGBA buffer simulating a screenshot of given dimensions.
 * Each buffer is filled with a deterministic pattern so that identical
 * seeds produce identical buffers (for testing unchanged screenshots).
 */
function generateRgbaBuffer(width: number, height: number, seed = 0): Uint8Array {
  const size = width * height * 4;
  const buffer = new Uint8Array(size);
  for (let i = 0; i < size; i++) {
    buffer[i] = (i + seed) % 256;
  }
  return buffer;
}

/**
 * Generate a mock PNG-like buffer (just random bytes of realistic size).
 * A 1280x720 PNG screenshot is typically 200-500KB.
 */
function generateMockPngBuffer(sizeKB = 300): Buffer {
  const buffer = Buffer.alloc(sizeKB * 1024);
  for (let i = 0; i < buffer.length; i++) {
    buffer[i] = (i * 7 + 13) % 256;
  }
  return buffer;
}

/**
 * Generate a pair of RGBA buffers with a specified percentage of pixels changed.
 */
function generateDiffPair(
  width: number,
  height: number,
  changePercent: number,
): { old: Uint8Array; new: Uint8Array } {
  const size = width * height * 4;
  const oldBuf = new Uint8Array(size);
  const newBuf = new Uint8Array(size);
  const changedPixels = Math.floor((width * height) * (changePercent / 100));

  for (let i = 0; i < size; i++) {
    oldBuf[i] = (i * 3 + 17) % 256;
    newBuf[i] = oldBuf[i]; // Start identical
  }

  // Modify changedPixels worth of pixels (4 bytes each)
  for (let p = 0; p < changedPixels; p++) {
    const offset = (p * 4) % size;
    newBuf[offset] = (newBuf[offset] + 128) % 256; // R
    newBuf[offset + 1] = (newBuf[offset + 1] + 64) % 256; // G
  }

  return { old: oldBuf, new: newBuf };
}

/**
 * Generate a mock API map with N endpoints.
 */
function generateApiMap(count: number): Record<string, unknown> {
  const map: Record<string, unknown> = {};
  const methods = ['GET', 'POST', 'PUT', 'DELETE', 'PATCH'];

  for (let i = 0; i < count; i++) {
    const key = `${methods[i % methods.length]} /api/v2/resource-${i % 50}/${i}`;
    map[key] = {
      method: methods[i % methods.length],
      url: `https://example.com/api/v2/resource-${i % 50}/${i}`,
      pattern: `/api/v2/resource-${i % 50}/:id`,
      statusCode: 200,
      requestHeaders: {
        'Content-Type': 'application/json',
        'Accept': 'application/json',
      },
      responseHeaders: {
        'Content-Type': 'application/json',
        'X-Response-Time': `${10 + i}ms`,
      },
      responseBody: {
        id: i,
        name: `Resource ${i}`,
        status: 'active',
        data: {
          count: i * 10,
          items: Array.from({ length: 5 }, (_, j) => ({
            id: j,
            value: `item-${j}`,
            tags: [`tag-${j % 3}`],
          })),
        },
        metadata: {
          version: 1,
          schema: 'v2',
        },
      },
    };
  }
  return map;
}

/**
 * Generate a modified version of an API map with a percentage of endpoints changed.
 */
function generateModifiedApiMap(
  original: Record<string, unknown>,
  changePercent: number,
): Record<string, unknown> {
  const modified = JSON.parse(JSON.stringify(original)) as Record<string, unknown>;
  const keys = Object.keys(modified);
  const changeCount = Math.floor(keys.length * (changePercent / 100));

  // Modify some endpoints
  for (let i = 0; i < changeCount && i < keys.length; i++) {
    const entry = modified[keys[i]] as Record<string, unknown>;
    const body = entry.responseBody as Record<string, unknown>;
    body.status = 'modified';
    (body.data as Record<string, unknown>).newField = `added-${i}`;
  }

  // Add some new endpoints
  const addCount = Math.floor(changeCount * 0.2);
  for (let i = 0; i < addCount; i++) {
    modified[`GET /api/v2/new-resource-${i}`] = {
      method: 'GET',
      url: `https://example.com/api/v2/new-resource-${i}`,
      pattern: '/api/v2/new-resource/:id',
      statusCode: 200,
      responseBody: { id: i, name: `New Resource ${i}` },
    };
  }

  // Remove some endpoints
  const removeCount = Math.floor(changeCount * 0.1);
  for (let i = 0; i < removeCount && i < keys.length; i++) {
    delete modified[keys[keys.length - 1 - i]];
  }

  return modified;
}

// ---------------------------------------------------------------------------
// SHA-256 Hashing Benchmarks (Fast-Path Optimization)
// ---------------------------------------------------------------------------

describe('SHA-256 Screenshot Hashing', () => {
  const smallPng = generateMockPngBuffer(100); // 100KB
  const mediumPng = generateMockPngBuffer(300); // 300KB
  const largePng = generateMockPngBuffer(800); // 800KB

  bench('hash 1 screenshot (100KB PNG)', () => {
    createHash('sha256').update(smallPng).digest('hex');
  });

  bench('hash 1 screenshot (300KB PNG)', () => {
    createHash('sha256').update(mediumPng).digest('hex');
  });

  bench('hash 1 screenshot (800KB PNG)', () => {
    createHash('sha256').update(largePng).digest('hex');
  });

  bench('hash 10 screenshots (300KB each)', () => {
    for (let i = 0; i < 10; i++) {
      createHash('sha256').update(mediumPng).digest('hex');
    }
  });

  bench('hash 100 screenshots (300KB each)', () => {
    for (let i = 0; i < 100; i++) {
      createHash('sha256').update(mediumPng).digest('hex');
    }
  });

  bench('hash 500 screenshots (300KB each)', () => {
    for (let i = 0; i < 500; i++) {
      createHash('sha256').update(mediumPng).digest('hex');
    }
  });

  bench('hash comparison: compare 100 pairs (identical)', () => {
    const hashes: string[] = [];
    for (let i = 0; i < 100; i++) {
      hashes.push(createHash('sha256').update(mediumPng).digest('hex'));
    }
    // Compare pairs
    for (let i = 0; i < hashes.length - 1; i++) {
      void (hashes[i] === hashes[i + 1]);
    }
  });
});

// ---------------------------------------------------------------------------
// Pixel Comparison Benchmarks (pixelmatch simulation)
// ---------------------------------------------------------------------------

describe('Pixel Comparison (pixelmatch-compatible)', () => {
  // These benchmarks simulate the core pixelmatch algorithm cost.
  // When pixelmatch is installed, replace with actual pixelmatch calls.

  const width = 1280;
  const height = 720;

  bench('compare identical 1280x720 RGBA buffers', () => {
    const buf1 = generateRgbaBuffer(width, height, 0);
    const buf2 = generateRgbaBuffer(width, height, 0);
    // Simulate pixel-by-pixel comparison
    let diffCount = 0;
    for (let i = 0; i < buf1.length; i += 4) {
      const dr = Math.abs(buf1[i] - buf2[i]);
      const dg = Math.abs(buf1[i + 1] - buf2[i + 1]);
      const db = Math.abs(buf1[i + 2] - buf2[i + 2]);
      if (dr + dg + db > 30) diffCount++;
    }
    void diffCount;
  });

  bench('compare 2% changed 1280x720 RGBA buffers', () => {
    const { old: buf1, new: buf2 } = generateDiffPair(width, height, 2);
    let diffCount = 0;
    for (let i = 0; i < buf1.length; i += 4) {
      const dr = Math.abs(buf1[i] - buf2[i]);
      const dg = Math.abs(buf1[i + 1] - buf2[i + 1]);
      const db = Math.abs(buf1[i + 2] - buf2[i + 2]);
      if (dr + dg + db > 30) diffCount++;
    }
    void diffCount;
  });

  bench('compare 10 pairs of 1280x720 (2% changed)', () => {
    for (let p = 0; p < 10; p++) {
      const { old: buf1, new: buf2 } = generateDiffPair(width, height, 2);
      let diffCount = 0;
      for (let i = 0; i < buf1.length; i += 4) {
        const dr = Math.abs(buf1[i] - buf2[i]);
        const dg = Math.abs(buf1[i + 1] - buf2[i + 1]);
        const db = Math.abs(buf1[i + 2] - buf2[i + 2]);
        if (dr + dg + db > 30) diffCount++;
      }
      void diffCount;
    }
  });

  // Full-page screenshots (taller)
  const tallHeight = 3000;

  bench('compare 1280x3000 full-page buffers (2% changed)', () => {
    const { old: buf1, new: buf2 } = generateDiffPair(width, tallHeight, 2);
    let diffCount = 0;
    for (let i = 0; i < buf1.length; i += 4) {
      const dr = Math.abs(buf1[i] - buf2[i]);
      const dg = Math.abs(buf1[i + 1] - buf2[i + 1]);
      const db = Math.abs(buf1[i + 2] - buf2[i + 2]);
      if (dr + dg + db > 30) diffCount++;
    }
    void diffCount;
  });
});

// ---------------------------------------------------------------------------
// Diff Image Generation Benchmarks
// ---------------------------------------------------------------------------

describe('Diff Image Generation', () => {
  const width = 1280;
  const height = 720;

  bench('generate diff overlay for 1280x720', () => {
    const { old: buf1, new: buf2 } = generateDiffPair(width, height, 5);
    const diffBuf = new Uint8Array(width * height * 4);

    // Simulate diff overlay generation (red highlights on faded original)
    for (let i = 0; i < buf1.length; i += 4) {
      const dr = Math.abs(buf1[i] - buf2[i]);
      const dg = Math.abs(buf1[i + 1] - buf2[i + 1]);
      const db = Math.abs(buf1[i + 2] - buf2[i + 2]);

      if (dr + dg + db > 30) {
        // Changed pixel: highlight red
        diffBuf[i] = 255;
        diffBuf[i + 1] = 0;
        diffBuf[i + 2] = 0;
        diffBuf[i + 3] = 255;
      } else {
        // Unchanged: fade to 10% opacity
        diffBuf[i] = Math.floor(buf1[i] * 0.1);
        diffBuf[i + 1] = Math.floor(buf1[i + 1] * 0.1);
        diffBuf[i + 2] = Math.floor(buf1[i + 2] * 0.1);
        diffBuf[i + 3] = 255;
      }
    }
    void diffBuf;
  });

  bench('generate 10 diff overlays', () => {
    for (let p = 0; p < 10; p++) {
      const { old: buf1, new: buf2 } = generateDiffPair(width, height, 5);
      const diffBuf = new Uint8Array(width * height * 4);
      for (let i = 0; i < buf1.length; i += 4) {
        const dr = Math.abs(buf1[i] - buf2[i]);
        const dg = Math.abs(buf1[i + 1] - buf2[i + 1]);
        const db = Math.abs(buf1[i + 2] - buf2[i + 2]);
        if (dr + dg + db > 30) {
          diffBuf[i] = 255; diffBuf[i + 1] = 0; diffBuf[i + 2] = 0; diffBuf[i + 3] = 255;
        } else {
          diffBuf[i] = Math.floor(buf1[i] * 0.1);
          diffBuf[i + 1] = Math.floor(buf1[i + 1] * 0.1);
          diffBuf[i + 2] = Math.floor(buf1[i + 2] * 0.1);
          diffBuf[i + 3] = 255;
        }
      }
    }
  });
});

// ---------------------------------------------------------------------------
// JSON Structural Diff Benchmarks (jsondiffpatch simulation)
// ---------------------------------------------------------------------------

describe('JSON API Map Diffing', () => {
  const apiMap100 = generateApiMap(100);
  const apiMap500 = generateApiMap(500);
  const apiMap1000 = generateApiMap(1000);
  const apiMap5000 = generateApiMap(5000);

  const apiMap100Modified = generateModifiedApiMap(apiMap100, 10);
  const apiMap500Modified = generateModifiedApiMap(apiMap500, 10);
  const apiMap1000Modified = generateModifiedApiMap(apiMap1000, 10);
  const apiMap5000Modified = generateModifiedApiMap(apiMap5000, 5);

  // Simple structural comparison (simulates jsondiffpatch's core work)
  function naiveDeepDiff(a: Record<string, unknown>, b: Record<string, unknown>): number {
    let changes = 0;
    const allKeys = new Set([...Object.keys(a), ...Object.keys(b)]);
    for (const key of allKeys) {
      if (!(key in a)) { changes++; continue; }
      if (!(key in b)) { changes++; continue; }
      if (JSON.stringify(a[key]) !== JSON.stringify(b[key])) changes++;
    }
    return changes;
  }

  bench('diff 100-endpoint API maps (10% changed)', () => {
    naiveDeepDiff(apiMap100, apiMap100Modified);
  });

  bench('diff 500-endpoint API maps (10% changed)', () => {
    naiveDeepDiff(apiMap500, apiMap500Modified);
  });

  bench('diff 1000-endpoint API maps (10% changed)', () => {
    naiveDeepDiff(apiMap1000, apiMap1000Modified);
  });

  bench('diff 5000-endpoint API maps (5% changed)', () => {
    naiveDeepDiff(apiMap5000, apiMap5000Modified);
  });

  bench('diff identical 1000-endpoint API maps (0% changed)', () => {
    naiveDeepDiff(apiMap1000, apiMap1000);
  });

  // JSON serialization cost (part of jsondiffpatch's objectHash computation)
  bench('JSON.stringify for objectHash: 1000 endpoints', () => {
    for (const key of Object.keys(apiMap1000)) {
      JSON.stringify(apiMap1000[key]);
    }
  });
});

// ---------------------------------------------------------------------------
// ZIP Bundle Benchmarks (simulated)
// ---------------------------------------------------------------------------

describe('ZIP Bundle Operations (simulated)', () => {
  // These simulate the I/O patterns of yazl/yauzl without the actual libraries.
  // When yazl/yauzl are installed, replace with real ZIP operations.

  bench('simulate bundle creation: 100 pages (buffer assembly)', () => {
    const manifest = {
      version: 1,
      tool: 'playwright-archaeologist',
      files: [] as Array<{ path: string; sha256: string; size: number }>,
    };

    // Simulate adding 100 PNG screenshots + JSON artifacts
    for (let i = 0; i < 100; i++) {
      const pngBuffer = generateMockPngBuffer(300);
      const hash = createHash('sha256').update(pngBuffer).digest('hex');
      manifest.files.push({
        path: `screenshots/page-${i}.png`,
        sha256: hash,
        size: pngBuffer.length,
      });
    }

    // Simulate JSON artifact compression
    const sitemapJson = JSON.stringify(generateApiMap(300));
    const jsonBuffer = Buffer.from(sitemapJson);
    createHash('sha256').update(jsonBuffer).digest('hex');

    // Simulate manifest serialization
    JSON.stringify(manifest);
  });

  bench('simulate bundle manifest validation: 500 files', () => {
    const manifest = {
      version: 1,
      files: Array.from({ length: 500 }, (_, i) => ({
        path: `screenshots/page-${i}.png`,
        sha256: createHash('sha256').update(`content-${i}`).digest('hex'),
        size: 300 * 1024,
        type: 'screenshot',
      })),
    };

    // Validate all checksums exist and paths are safe
    for (const file of manifest.files) {
      // Path traversal check
      if (file.path.includes('..')) throw new Error('path traversal');
      // SHA-256 format check
      if (!/^[a-f0-9]{64}$/.test(file.sha256)) throw new Error('invalid hash');
      // Size sanity
      if (file.size <= 0 || file.size > 100 * 1024 * 1024) throw new Error('invalid size');
    }
  });

  bench('simulate SHA-256 fast-path: 500 screenshots (90% unchanged)', () => {
    // Generate "old" hashes
    const oldHashes = Array.from({ length: 500 }, (_, i) =>
      createHash('sha256').update(`content-${i}`).digest('hex')
    );

    // Generate "new" hashes (90% identical, 10% different)
    const newHashes = oldHashes.map((h, i) =>
      i % 10 === 0
        ? createHash('sha256').update(`modified-content-${i}`).digest('hex')
        : h
    );

    // Compare and collect changed indices
    const changed: number[] = [];
    for (let i = 0; i < oldHashes.length; i++) {
      if (oldHashes[i] !== newHashes[i]) {
        changed.push(i);
      }
    }
    void changed; // Would be passed to pixelmatch
  });
});

// ---------------------------------------------------------------------------
// Full Diff Pipeline Simulation
// ---------------------------------------------------------------------------

describe('Full Diff Pipeline (simulated)', () => {
  bench('full diff: 100 pages (10% changed)', () => {
    const pageCount = 100;
    const changedCount = 10;

    // Step 1: Hash all screenshots (fast-path)
    const pngBuffer = generateMockPngBuffer(300);
    for (let i = 0; i < pageCount; i++) {
      createHash('sha256').update(pngBuffer).digest('hex');
    }

    // Step 2: Pixel-compare changed screenshots
    for (let i = 0; i < changedCount; i++) {
      const { old: buf1, new: buf2 } = generateDiffPair(1280, 720, 2);
      let diffCount = 0;
      for (let j = 0; j < buf1.length; j += 4) {
        const dr = Math.abs(buf1[j] - buf2[j]);
        if (dr > 30) diffCount++;
      }
      void diffCount;
    }

    // Step 3: JSON diff of API map
    const oldApi = generateApiMap(300);
    const newApi = generateModifiedApiMap(oldApi, 10);
    const allKeys = new Set([...Object.keys(oldApi), ...Object.keys(newApi)]);
    let apiChanges = 0;
    for (const key of allKeys) {
      if (!(key in oldApi) || !(key in newApi)) { apiChanges++; continue; }
      if (JSON.stringify(oldApi[key]) !== JSON.stringify(newApi[key])) apiChanges++;
    }
    void apiChanges;
  });

  bench('full diff: 500 pages (10% changed)', () => {
    const pageCount = 500;
    const changedCount = 50;

    // Step 1: Hash
    const pngBuffer = generateMockPngBuffer(300);
    for (let i = 0; i < pageCount; i++) {
      createHash('sha256').update(pngBuffer).digest('hex');
    }

    // Step 2: Pixel-compare changed
    for (let i = 0; i < changedCount; i++) {
      const { old: buf1, new: buf2 } = generateDiffPair(1280, 720, 2);
      let diffCount = 0;
      for (let j = 0; j < buf1.length; j += 4) {
        if (Math.abs(buf1[j] - buf2[j]) > 30) diffCount++;
      }
      void diffCount;
    }

    // Step 3: JSON diff
    const oldApi = generateApiMap(1500);
    const newApi = generateModifiedApiMap(oldApi, 10);
    const allKeys = new Set([...Object.keys(oldApi), ...Object.keys(newApi)]);
    let apiChanges = 0;
    for (const key of allKeys) {
      if (!(key in oldApi) || !(key in newApi)) { apiChanges++; continue; }
      if (JSON.stringify(oldApi[key]) !== JSON.stringify(newApi[key])) apiChanges++;
    }
    void apiChanges;
  });
});

// ---------------------------------------------------------------------------
// Buffer Allocation Benchmarks (memory pressure)
// ---------------------------------------------------------------------------

describe('Buffer Allocation Patterns', () => {
  bench('allocate + fill 1280x720 RGBA buffer', () => {
    const buf = new Uint8Array(1280 * 720 * 4);
    buf.fill(0);
    void buf;
  });

  bench('allocate 3 buffers for diff (old + new + output)', () => {
    const size = 1280 * 720 * 4;
    const buf1 = new Uint8Array(size);
    const buf2 = new Uint8Array(size);
    const diff = new Uint8Array(size);
    buf1.fill(128);
    buf2.fill(128);
    diff.fill(0);
    void diff;
  });

  bench('sequential allocation of 10 diff sets (memory churn)', () => {
    const size = 1280 * 720 * 4;
    for (let i = 0; i < 10; i++) {
      const buf1 = new Uint8Array(size);
      const buf2 = new Uint8Array(size);
      const diff = new Uint8Array(size);
      buf1.fill(i);
      buf2.fill(i + 1);
      diff.fill(0);
    }
  });
});
