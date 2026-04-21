/**
 * Minimal bundle loader for the coverage command.
 *
 * The diff engine keeps its bundle-reading helpers private. We re-derive
 * only the subset we need here: target URL, sitemap routes, and API
 * endpoints. Everything else in the bundle (screenshots, HAR, manifest)
 * is irrelevant to coverage calculation.
 */

import { readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';

import type {
  ApiEndpointGroup,
  BundleManifest,
  RouteInfo,
} from '../types/artifacts.js';
import { CoverageError } from '../types/errors.js';

export interface LoadedBundleForCoverage {
  /** Bundle target URL — derived from manifest.config.targetUrl. */
  targetUrl: string;
  routes: RouteInfo[];
  apis: ApiEndpointGroup[];
}

async function loadJson<T>(path: string): Promise<T | undefined> {
  try {
    const raw = await readFile(path, 'utf-8');
    return JSON.parse(raw) as T;
  } catch {
    return undefined;
  }
}

/**
 * Locate a filename inside a bundle directory. Checks `data/` first (the
 * canonical bundle layout produced by `bundle-creator`) and falls back to
 * the bundle root (for users who point `pa coverage` at a raw crawl output
 * directory).
 */
async function findFile(bundleDir: string, name: string): Promise<string | undefined> {
  for (const root of [join(bundleDir, 'data'), bundleDir]) {
    const candidate = join(root, name);
    try {
      const st = await stat(candidate);
      if (st.isFile()) return candidate;
    } catch {
      // continue
    }
  }
  return undefined;
}

/**
 * Load the subset of a bundle needed for coverage computation.
 *
 * @param bundleDir - Bundle directory (or raw `.archaeologist` output dir).
 * @param baseUrlOverride - When present, replaces the target URL recorded
 *   in the manifest (useful when the bundle was crawled against staging
 *   but coverage is being checked against prod).
 */
export async function loadBundleForCoverage(
  bundleDir: string,
  baseUrlOverride?: string,
): Promise<LoadedBundleForCoverage> {
  // Validate the bundle directory exists.
  try {
    const st = await stat(bundleDir);
    if (!st.isDirectory()) {
      throw new CoverageError(
        'bundle_not_found',
        `Bundle path is not a directory: ${bundleDir}`,
        bundleDir,
      );
    }
  } catch (err) {
    if (err instanceof CoverageError) throw err;
    throw new CoverageError(
      'bundle_not_found',
      `Bundle directory not found: ${bundleDir}`,
      bundleDir,
      { cause: err instanceof Error ? err : undefined },
    );
  }

  // Read sitemap (required).
  const sitemapPath = await findFile(bundleDir, 'sitemap.json');
  if (!sitemapPath) {
    throw new CoverageError(
      'bundle_malformed',
      `Bundle is missing sitemap.json (searched data/ and root of ${bundleDir}).`,
      bundleDir,
    );
  }
  const routes = (await loadJson<RouteInfo[]>(sitemapPath)) ?? [];
  if (!Array.isArray(routes)) {
    throw new CoverageError(
      'bundle_malformed',
      `sitemap.json at ${sitemapPath} is not a JSON array.`,
      bundleDir,
    );
  }

  // Read API map (optional — a crawl with no API traffic produces no file).
  const apiPath = await findFile(bundleDir, 'api-map.json');
  const apis = (apiPath ? await loadJson<ApiEndpointGroup[]>(apiPath) : undefined) ?? [];

  // Determine target URL. Prefer the explicit override, then the bundle
  // manifest, then the crawl summary, then the first sitemap entry.
  let targetUrl = baseUrlOverride ?? '';
  if (!targetUrl) {
    const manifestPath = await findFile(bundleDir, 'manifest.json');
    if (manifestPath) {
      const manifest = await loadJson<BundleManifest>(manifestPath);
      if (manifest?.config?.targetUrl) {
        targetUrl = manifest.config.targetUrl;
      }
    }
  }
  if (!targetUrl) {
    const summaryPath = await findFile(bundleDir, 'crawl-summary.json');
    if (summaryPath) {
      const summary = await loadJson<{ targetUrl?: string }>(summaryPath);
      if (summary?.targetUrl) targetUrl = summary.targetUrl;
    }
  }
  if (!targetUrl && routes.length > 0) {
    targetUrl = routes[0].url;
  }

  return {
    targetUrl,
    routes,
    apis: Array.isArray(apis) ? apis : [],
  };
}
