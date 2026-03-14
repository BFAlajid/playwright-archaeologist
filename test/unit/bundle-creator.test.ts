/**
 * Unit tests for src/bundle/bundle-creator.ts
 *
 * Tests bundle creation: manifest generation, SHA-256 hashing,
 * file classification, and edge cases.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, writeFile, mkdir, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { createBundle, computeSha256 } from '../../src/bundle/bundle-creator.js';

let testDir: string;
let outputDir: string;
let bundleDir: string;

beforeEach(async () => {
  testDir = await mkdtemp(join(tmpdir(), 'pa-bundle-test-'));
  outputDir = join(testDir, 'output');
  bundleDir = join(testDir, 'bundle');
  await mkdir(outputDir, { recursive: true });
});

afterEach(async () => {
  await rm(testDir, { recursive: true, force: true });
});

describe('createBundle', () => {
  it('creates manifest with correct file list', async () => {
    // Set up output directory with sample files
    await writeFile(join(outputDir, 'sitemap.json'), JSON.stringify([
      { url: 'https://example.com/', title: 'Home', statusCode: 200, contentHash: 'abc', depth: 0, formCount: 0, apiCallCount: 0, hasScreenshot: true, discoveryMethod: 'entry' },
    ]));
    await writeFile(join(outputDir, 'forms.json'), JSON.stringify([]));
    await writeFile(join(outputDir, 'api-map.json'), JSON.stringify([]));

    const screenshotsDir = join(outputDir, 'screenshots');
    await mkdir(screenshotsDir, { recursive: true });
    await writeFile(join(screenshotsDir, 'home.png'), Buffer.from('fake-png-data'));

    const manifest = await createBundle(outputDir, bundleDir);

    expect(manifest.version).toBe(1);
    expect(manifest.tool).toBe('playwright-archaeologist');
    expect(manifest.files.length).toBe(4); // 3 JSON + 1 PNG
    expect(manifest.files.some((f) => f.path.includes('sitemap.json'))).toBe(true);
    expect(manifest.files.some((f) => f.path.includes('home.png'))).toBe(true);
  });

  it('computes SHA-256 hashes correctly', async () => {
    const content = 'test content for hashing';
    const testFile = join(outputDir, 'test.json');
    await writeFile(testFile, content);

    const expectedHash = createHash('sha256').update(content).digest('hex');
    const actualHash = await computeSha256(testFile);

    expect(actualHash).toBe(expectedHash);
  });

  it('creates manifest with correct SHA-256 hashes for files', async () => {
    const jsonContent = JSON.stringify({ test: true });
    await writeFile(join(outputDir, 'data.json'), jsonContent);

    const expectedHash = createHash('sha256').update(jsonContent).digest('hex');
    const manifest = await createBundle(outputDir, bundleDir);

    const fileEntry = manifest.files.find((f) => f.path.includes('data.json'));
    expect(fileEntry).toBeDefined();
    expect(fileEntry!.sha256).toBe(expectedHash);
  });

  it('handles empty output directory', async () => {
    const manifest = await createBundle(outputDir, bundleDir);

    expect(manifest.version).toBe(1);
    expect(manifest.files.length).toBe(0);
    expect(manifest.stats.pagesVisited).toBe(0);
    expect(manifest.stats.formsFound).toBe(0);
    expect(manifest.stats.apiEndpoints).toBe(0);
    expect(manifest.stats.screenshotCount).toBe(0);
  });

  it('includes correct file types', async () => {
    await writeFile(join(outputDir, 'sitemap.json'), '[]');
    const screenshotsDir = join(outputDir, 'screenshots');
    await mkdir(screenshotsDir, { recursive: true });
    await writeFile(join(screenshotsDir, 'page.png'), Buffer.from('png'));
    await writeFile(join(outputDir, 'capture.har'), '{}');
    await writeFile(join(outputDir, 'report.html'), '<html></html>');

    const manifest = await createBundle(outputDir, bundleDir);

    const types = manifest.files.map((f) => f.type);
    expect(types).toContain('json');
    expect(types).toContain('screenshot');
    expect(types).toContain('api-snapshot');
  });

  it('writes manifest.json to bundle directory', async () => {
    await writeFile(join(outputDir, 'sitemap.json'), '[]');

    await createBundle(outputDir, bundleDir);

    const manifestContent = await readFile(join(bundleDir, 'manifest.json'), 'utf-8');
    const manifest = JSON.parse(manifestContent);
    expect(manifest.version).toBe(1);
    expect(manifest.tool).toBe('playwright-archaeologist');
  });

  it('copies files into correct subdirectories', async () => {
    await writeFile(join(outputDir, 'sitemap.json'), '[]');
    const screenshotsDir = join(outputDir, 'screenshots');
    await mkdir(screenshotsDir, { recursive: true });
    await writeFile(join(screenshotsDir, 'test.png'), Buffer.from('png'));
    await writeFile(join(outputDir, 'report.html'), '<html></html>');

    await createBundle(outputDir, bundleDir);

    // JSON goes to data/
    const dataContent = await readFile(join(bundleDir, 'data', 'sitemap.json'), 'utf-8');
    expect(dataContent).toBe('[]');

    // Screenshots go to screenshots/
    const ssContent = await readFile(join(bundleDir, 'screenshots', 'test.png'));
    expect(ssContent.toString()).toBe('png');

    // report.html goes to root
    const reportContent = await readFile(join(bundleDir, 'report.html'), 'utf-8');
    expect(reportContent).toBe('<html></html>');
  });

  it('populates stats from artifact files', async () => {
    await writeFile(join(outputDir, 'sitemap.json'), JSON.stringify([
      { url: 'https://example.com/' },
      { url: 'https://example.com/about' },
    ]));
    await writeFile(join(outputDir, 'forms.json'), JSON.stringify([
      { action: '/login', method: 'POST' },
    ]));
    await writeFile(join(outputDir, 'api-map.json'), JSON.stringify([
      { pattern: '/api/users', method: 'GET' },
      { pattern: '/api/posts', method: 'GET' },
    ]));

    const manifest = await createBundle(outputDir, bundleDir);

    expect(manifest.stats.pagesVisited).toBe(2);
    expect(manifest.stats.formsFound).toBe(1);
    expect(manifest.stats.apiEndpoints).toBe(2);
  });

  it('throws BundleError when output directory does not exist', async () => {
    await expect(createBundle('/nonexistent/path', bundleDir)).rejects.toThrow(
      /Output directory not found/,
    );
  });

  it('uses forward slashes in file paths', async () => {
    await writeFile(join(outputDir, 'test.json'), '{}');
    const screenshotsDir = join(outputDir, 'screenshots');
    await mkdir(screenshotsDir, { recursive: true });
    await writeFile(join(screenshotsDir, 'page.png'), Buffer.from('png'));

    const manifest = await createBundle(outputDir, bundleDir);

    for (const file of manifest.files) {
      expect(file.path).not.toContain('\\');
    }
  });

  it('records file sizes correctly', async () => {
    const content = 'a'.repeat(1234);
    await writeFile(join(outputDir, 'sized.json'), content);

    const manifest = await createBundle(outputDir, bundleDir);

    const entry = manifest.files.find((f) => f.path.includes('sized.json'));
    expect(entry).toBeDefined();
    expect(entry!.size).toBe(1234);
  });

  it('sets createdAt to a valid ISO date', async () => {
    const manifest = await createBundle(outputDir, bundleDir);

    const date = new Date(manifest.createdAt);
    expect(date.getTime()).not.toBeNaN();
  });
});
