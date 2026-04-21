/**
 * Bundle Creator
 *
 * Scans a crawl output directory and creates a structured bundle directory
 * with a manifest.json at the root. The bundle layout:
 *
 *   manifest.json         -- BundleManifest describing all files
 *   screenshots/          -- PNG screenshot files
 *   data/                 -- JSON artifacts (sitemap.json, forms.json, api-map.json, etc.)
 *   report.html           -- HTML report (if present)
 *
 * No external dependencies -- uses Node.js built-in crypto and fs.
 */

import { createHash } from 'node:crypto';
import {
  readdir,
  readFile,
  stat,
  mkdir,
  copyFile,
  writeFile,
  rename,
  rm,
} from 'node:fs/promises';
import { join, basename, extname, relative, resolve, isAbsolute, sep } from 'node:path';
import type { BundleManifest, BundleFileEntry } from '../types/artifacts.js';
import { BundleError } from '../types/errors.js';
import { TOOL_VERSION } from '../security/browser-hardening.js';

/**
 * Return true iff `p` is a relative path that, when resolved against
 * `bundleRoot`, lies strictly under that root. Rejects:
 *   - `..` segments (classic traversal)
 *   - leading `/` (POSIX absolute)
 *   - Windows drive letters like `C:` or `c:/`
 *   - UNC-style `\\server\share\...`
 *   - percent-encoded traversal that decodes to `..`
 *
 * Used to vet every `path` in bundle manifests before the tool reads the
 * file — a malicious bundle otherwise lets an attacker read arbitrary
 * files on the machine running the diff.
 */
export function isSafeBundlePath(p: string, bundleRoot: string): boolean {
  if (typeof p !== 'string' || p.length === 0) return false;

  // Reject any control character (including NUL). A leading NUL would otherwise
  // bypass segment checks: `\x00..` is a distinct segment from `..`, but most
  // filesystems either reject NUL outright or treat it as a string terminator.
  if (/[\x00-\x1f]/.test(p)) return false;

  // Reject UNC prefix outright. The logic below expects a local relative path.
  if (p.startsWith('\\\\') || p.startsWith('//')) return false;

  // Normalize slashes for traversal-segment inspection.
  const normalized = p.replace(/\\/g, '/');

  // Disallow any `..` segment. Checking segment-by-segment is safer than
  // just string-containing `..` — that false-positives on e.g. `..foo`.
  const segments = normalized.split('/');
  if (segments.some((s) => s === '..')) return false;

  // Disallow percent-encoded traversal (%2e%2e, %2E%2E, etc.).
  try {
    const decoded = decodeURIComponent(normalized);
    const decodedSegments = decoded.split('/');
    if (decodedSegments.some((s) => s === '..')) return false;
  } catch {
    // Malformed percent-encoding → reject conservatively.
    return false;
  }

  // Reject absolute paths of any flavour.
  if (isAbsolute(p)) return false;
  if (normalized.startsWith('/')) return false;
  if (/^[A-Za-z]:[\\/]/.test(p)) return false;

  // Final safety check: after resolve() against the root, the result must
  // still be inside the root. Guards against any normalization corner
  // case the string checks above might miss.
  const resolvedRoot = resolve(bundleRoot);
  const resolvedPath = resolve(bundleRoot, p);
  return (
    resolvedPath === resolvedRoot ||
    resolvedPath.startsWith(resolvedRoot + sep) ||
    resolvedPath.startsWith(resolvedRoot + '/')
  );
}

/** File extensions mapped to bundle file types. */
function classifyFile(filePath: string): BundleFileEntry['type'] | null {
  const ext = extname(filePath).toLowerCase();
  switch (ext) {
    case '.json':
      return 'json';
    case '.png':
    case '.jpg':
    case '.jpeg':
    case '.webp':
      return 'screenshot';
    case '.har':
      return 'api-snapshot';
    case '.html':
      return 'json'; // HTML report stored alongside data
    default:
      return null;
  }
}

/** Compute SHA-256 hex digest of a file. */
export async function computeSha256(filePath: string): Promise<string> {
  const content = await readFile(filePath);
  return createHash('sha256').update(content).digest('hex');
}

/**
 * Recursively collect all files in a directory.
 * Returns absolute paths.
 */
async function collectFiles(dir: string): Promise<string[]> {
  const results: string[] = [];
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return results;
  }

  for (const entry of entries) {
    const fullPath = join(dir, entry.name);
    if (entry.isDirectory()) {
      const nested = await collectFiles(fullPath);
      results.push(...nested);
    } else if (entry.isFile()) {
      results.push(fullPath);
    }
  }
  return results;
}

/**
 * Determine the target subdirectory within the bundle for a given file.
 */
function targetSubdir(filePath: string): string {
  const ext = extname(filePath).toLowerCase();
  const name = basename(filePath).toLowerCase();

  if (name === 'report.html') return '';
  if (['.png', '.jpg', '.jpeg', '.webp'].includes(ext)) return 'screenshots';
  if (['.json', '.har', '.html'].includes(ext)) return 'data';
  return 'data';
}

/**
 * Load crawl stats from assembled JSON artifacts if available.
 */
async function loadStats(
  outputDir: string,
): Promise<BundleManifest['stats']> {
  const defaults: BundleManifest['stats'] = {
    pagesVisited: 0,
    formsFound: 0,
    apiEndpoints: 0,
    screenshotCount: 0,
    duration: 0,
  };

  try {
    const sitemapPath = join(outputDir, 'sitemap.json');
    const sitemapContent = await readFile(sitemapPath, 'utf-8');
    const sitemap = JSON.parse(sitemapContent) as unknown[];
    if (Array.isArray(sitemap)) {
      defaults.pagesVisited = sitemap.length;
    }
  } catch {
    // sitemap may not exist
  }

  try {
    const formsPath = join(outputDir, 'forms.json');
    const formsContent = await readFile(formsPath, 'utf-8');
    const forms = JSON.parse(formsContent) as unknown[];
    if (Array.isArray(forms)) {
      defaults.formsFound = forms.length;
    }
  } catch {
    // forms may not exist
  }

  try {
    const apiPath = join(outputDir, 'api-map.json');
    const apiContent = await readFile(apiPath, 'utf-8');
    const api = JSON.parse(apiContent) as unknown[];
    if (Array.isArray(api)) {
      defaults.apiEndpoints = api.length;
    }
  } catch {
    // api-map may not exist
  }

  return defaults;
}

/**
 * Load crawl config from meta.json or sitemap.json if available.
 */
async function loadConfig(
  outputDir: string,
): Promise<BundleManifest['config']> {
  const defaults: BundleManifest['config'] = {
    targetUrl: '',
    depth: 0,
    viewport: { width: 1280, height: 720 },
    concurrency: 1,
    maxPages: 100,
    followExternal: false,
    deepClick: false,
  };

  try {
    const metaPath = join(outputDir, 'meta.json');
    const content = await readFile(metaPath, 'utf-8');
    const meta = JSON.parse(content) as Record<string, unknown>;
    if (typeof meta.targetUrl === 'string') defaults.targetUrl = meta.targetUrl;
    if (typeof meta.depth === 'number') defaults.depth = meta.depth;
    if (typeof meta.duration === 'number') {
      // stats duration from meta
    }
    if (
      meta.viewport &&
      typeof meta.viewport === 'object' &&
      'width' in meta.viewport &&
      'height' in meta.viewport
    ) {
      defaults.viewport = meta.viewport as { width: number; height: number };
    }
  } catch {
    // meta may not exist
  }

  return defaults;
}

/**
 * Create a bundle directory from crawl output.
 *
 * @param outputDir - The crawl output directory containing artifacts
 * @param bundlePath - The destination bundle directory to create
 * @returns The BundleManifest describing the bundle contents
 */
export async function createBundle(
  outputDir: string,
  bundlePath: string,
): Promise<BundleManifest> {
  // Validate outputDir exists
  try {
    const outputStat = await stat(outputDir);
    if (!outputStat.isDirectory()) {
      throw new BundleError(
        'create_failed',
        `Output path is not a directory: ${outputDir}`,
        bundlePath,
      );
    }
  } catch (err) {
    if (err instanceof BundleError) throw err;
    throw new BundleError(
      'create_failed',
      `Output directory not found: ${outputDir}`,
      bundlePath,
      { cause: err },
    );
  }

  // Atomic bundle creation: write to temp dir, then rename
  const tmpBundlePath = bundlePath + '.tmp';
  await rm(tmpBundlePath, { recursive: true, force: true });

  // Create bundle directory structure in temp location
  await mkdir(join(tmpBundlePath, 'screenshots'), { recursive: true });
  await mkdir(join(tmpBundlePath, 'data'), { recursive: true });

  // Collect all files from output directory
  const allFiles = await collectFiles(outputDir);
  const fileEntries: BundleFileEntry[] = [];
  let screenshotCount = 0;

  for (const filePath of allFiles) {
    const fileType = classifyFile(filePath);
    if (fileType === null) continue; // skip unknown file types

    const fileName = basename(filePath);
    const subdir = targetSubdir(filePath);
    const bundleRelPath = subdir ? join(subdir, fileName) : fileName;
    const destPath = join(tmpBundlePath, bundleRelPath);

    // Copy file to bundle
    await copyFile(filePath, destPath);

    // Compute hash and size
    const sha256 = await computeSha256(filePath);
    const fileStat = await stat(filePath);

    if (fileType === 'screenshot') {
      screenshotCount++;
    }

    fileEntries.push({
      path: bundleRelPath.replace(/\\/g, '/'), // normalize to forward slashes
      sha256,
      size: fileStat.size,
      type: fileType,
    });
  }

  // Load stats and config from output artifacts
  const [stats, config] = await Promise.all([
    loadStats(outputDir),
    loadConfig(outputDir),
  ]);
  stats.screenshotCount = screenshotCount;

  // Build manifest
  const manifest: BundleManifest = {
    version: 1,
    tool: 'playwright-archaeologist',
    toolVersion: TOOL_VERSION,
    createdAt: new Date().toISOString(),
    config,
    stats,
    files: fileEntries,
  };

  // Write manifest to temp bundle
  const manifestPath = join(tmpBundlePath, 'manifest.json');
  await writeFile(manifestPath, JSON.stringify(manifest, null, 2), 'utf-8');

  // Atomic rename: move completed bundle to final path
  await rm(bundlePath, { recursive: true, force: true });
  await rename(tmpBundlePath, bundlePath);

  return manifest;
}
