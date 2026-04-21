/**
 * Bundle loader for the MCP server.
 *
 * Reads the artifacts an MCP client can query: manifest, sitemap, forms,
 * API map, flow graph (Mermaid text), accessibility results. Tolerates
 * both bundle layouts — `bundle/data/*.json` (post-`createBundle`) and a
 * raw crawl output directory — because the CLI points `pa mcp <bundle>`
 * at either.
 *
 * Missing optional files degrade to an empty result; a missing manifest
 * or sitemap aborts with BundleError since those are the minimum viable
 * payload for the MCP tools.
 */

import { readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import type {
  ApiEndpointGroup,
  BundleManifest,
  FormInfo,
  RouteInfo,
} from '../types/artifacts.js';
import { BundleError } from '../types/errors.js';

/**
 * Axe violation shape as emitted by `output-writer.writeAccessibilityJson`.
 * Kept structurally compatible with `AxeViolation` so the two file formats
 * can be read interchangeably.
 */
export interface AccessibilityPageResult {
  url: string;
  violations: Array<{
    id: string;
    impact: 'minor' | 'moderate' | 'serious' | 'critical' | string;
    nodes: number;
    help: string;
    helpUrl: string;
  }>;
}

export interface AccessibilityReport {
  totalViolations: number;
  byImpact: Record<string, number>;
  perPage: AccessibilityPageResult[];
}

/**
 * Everything the MCP server needs to answer tool + resource calls.
 * All fields except `manifest` and `sitemap` default to empty when the
 * underlying file is absent (e.g. no `--with-a11y` run).
 */
export interface LoadedBundle {
  bundleDir: string;
  manifest: BundleManifest;
  sitemap: RouteInfo[];
  forms: FormInfo[];
  apiMap: ApiEndpointGroup[];
  flowGraphMermaid: string;
  accessibility: AccessibilityReport | null;
}

/** Read a JSON file if it exists; undefined on missing/parse error. */
async function readJsonIfExists<T>(path: string): Promise<T | undefined> {
  try {
    const raw = await readFile(path, 'utf-8');
    return JSON.parse(raw) as T;
  } catch {
    return undefined;
  }
}

/** Read a text file if it exists; undefined on missing/read error. */
async function readTextIfExists(path: string): Promise<string | undefined> {
  try {
    return await readFile(path, 'utf-8');
  } catch {
    return undefined;
  }
}

/**
 * Locate `name` in either `bundleDir/data/` or `bundleDir/` directly.
 * Returns the first match or undefined.
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
 * Load every artifact the MCP tools and resources surface. Throws
 * BundleError only when the bundle cannot produce a minimal response
 * (no manifest, no sitemap).
 */
export async function loadBundle(bundleDir: string): Promise<LoadedBundle> {
  let st;
  try {
    st = await stat(bundleDir);
  } catch (err) {
    throw new BundleError(
      'missing_manifest',
      `Bundle directory not found: ${bundleDir}`,
      bundleDir,
      { cause: err },
    );
  }
  if (!st.isDirectory()) {
    throw new BundleError(
      'missing_manifest',
      `Bundle path is not a directory: ${bundleDir}`,
      bundleDir,
    );
  }

  // Manifest lives at the bundle root, not under data/. Fall back to
  // searching data/ for defensive compat with hand-assembled bundles.
  const manifestPath = (await findFile(bundleDir, 'manifest.json'));
  const manifest = manifestPath
    ? await readJsonIfExists<BundleManifest>(manifestPath)
    : undefined;

  if (!manifest) {
    throw new BundleError(
      'missing_manifest',
      `Bundle at ${bundleDir} is missing manifest.json. Create it with ` +
        `\`createBundle(outputDir, bundleDir)\` or point pa mcp at the raw crawl output dir.`,
      bundleDir,
    );
  }
  if (manifest.version !== 1) {
    throw new BundleError(
      'unsupported_version',
      `Unsupported bundle manifest version ${String(manifest.version)} in ${bundleDir}`,
      bundleDir,
    );
  }

  const sitemapPath = await findFile(bundleDir, 'sitemap.json');
  if (!sitemapPath) {
    throw new BundleError(
      'missing_manifest',
      `Bundle at ${bundleDir} is missing sitemap.json — nothing to query.`,
      bundleDir,
    );
  }
  const sitemapRaw = await readJsonIfExists<RouteInfo[]>(sitemapPath);
  if (!Array.isArray(sitemapRaw)) {
    throw new BundleError(
      'missing_manifest',
      `sitemap.json at ${sitemapPath} is not a JSON array.`,
      bundleDir,
    );
  }

  const formsPath = await findFile(bundleDir, 'forms.json');
  const apiPath = await findFile(bundleDir, 'api-map.json');
  const flowPath = await findFile(bundleDir, 'flow-graph.mmd');
  const a11yPath = await findFile(bundleDir, 'accessibility.json');

  const forms = formsPath
    ? (await readJsonIfExists<FormInfo[]>(formsPath)) ?? []
    : [];
  const apiMap = apiPath
    ? (await readJsonIfExists<ApiEndpointGroup[]>(apiPath)) ?? []
    : [];
  const flowGraphMermaid = flowPath ? (await readTextIfExists(flowPath)) ?? '' : '';
  const accessibility = a11yPath
    ? (await readJsonIfExists<AccessibilityReport>(a11yPath)) ?? null
    : null;

  return {
    bundleDir,
    manifest,
    sitemap: sitemapRaw,
    forms: Array.isArray(forms) ? forms : [],
    apiMap: Array.isArray(apiMap) ? apiMap : [],
    flowGraphMermaid,
    accessibility,
  };
}
