/**
 * Coverage engine — match Playwright test URL references against a crawl
 * bundle's sitemap and API map, producing a per-route / per-endpoint
 * coverage report.
 *
 * Matching rules:
 *   - A route is covered if any TestReference's resolved URL shares the
 *     same pathname as the route URL (after `normalizeUrl`).
 *   - An API endpoint is covered if a test's method matches AND the test
 *     URL's path, after `parameterizePath` substitution, equals the
 *     endpoint's pattern.
 *   - `ignorePatterns` are glob-matched against the route URL via the
 *     existing `matchesGlob` helper and drop the route before it counts
 *     toward totals.
 *
 * We intentionally don't do fuzzy matching (e.g. hostname-less URL
 * comparison across environments) — the caller can pass `--base-url` to
 * override the crawled origin when tests target a different environment.
 */

import type { ApiEndpointGroup, RouteInfo } from '../types/artifacts.js';
import { normalizeUrl, matchesGlob } from '../crawl/url-utils.js';
import { parameterizePath } from '../assembler/api-grouper.js';
import type { TestReference } from './test-scanner.js';

// ---------------------------------------------------------------------------
// Public result types
// ---------------------------------------------------------------------------

export interface CoverageRouteEntry {
  url: string;
  method: string;
  covered: boolean;
  coveringTests: TestReference[];
}

export interface CoverageApiEntry {
  method: string;
  pattern: string;
  covered: boolean;
  coveringTests: TestReference[];
}

export interface CoverageSummary {
  routesTotal: number;
  routesCovered: number;
  routesPercentage: number;
  apisTotal: number;
  apisCovered: number;
  apisPercentage: number;
  overallPercentage: number;
}

export interface CoverageReport {
  summary: CoverageSummary;
  routes: CoverageRouteEntry[];
  apis: CoverageApiEntry[];
  bundleTarget: string;
  testDir: string;
  scannedAt: string;
  ignoredPatterns: string[];
}

export interface ComputeCoverageInput {
  routes: RouteInfo[];
  apis: ApiEndpointGroup[];
  bundleTarget: string;
  testDir: string;
}

export interface ComputeCoverageOptions {
  /** Glob patterns; matching routes/APIs are excluded from coverage. */
  ignorePatterns?: string[];
  /** ISO timestamp override (for deterministic output in tests). */
  scannedAt?: string;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Return the pathname (path + search) of a URL string. Falls back to the
 * raw string when the URL is unparseable. Used as the cross-origin-safe
 * key for matching test URLs to crawl routes.
 */
function extractPath(u: string): string {
  try {
    const parsed = new URL(u);
    // Include search params — two routes differing only by query should not
    // collapse into the same coverage bucket.
    return parsed.pathname + (parsed.search || '');
  } catch {
    // If it parses as a relative URL against a dummy origin, use that.
    try {
      const parsed = new URL(u, 'http://pa.local/');
      return parsed.pathname + (parsed.search || '');
    } catch {
      return u;
    }
  }
}

/**
 * Normalize a URL for comparison. We use normalizeUrl's insertion-order
 * query sort and trailing-slash stripping so two URLs that differ only
 * in those superficial ways still match.
 */
function normalizeForCompare(u: string): string {
  return normalizeUrl(u);
}

/**
 * Build an index of test references keyed by `${method}|${path}` after
 * parameterization. Multiple references can land in the same bucket (two
 * tests hitting `/users/42` and `/users/99` both key to `GET|/users/:id`).
 */
interface TestIndex {
  /** Maps parameterized `${method}|${pattern}` to the refs that produce it. */
  byParameterizedKey: Map<string, TestReference[]>;
  /** Maps normalized pathname (no parameterization) to refs. */
  byPathname: Map<string, TestReference[]>;
  /** All refs grouped by method for fallback matching. */
  byMethod: Map<string, TestReference[]>;
}

function indexTests(refs: TestReference[]): TestIndex {
  const byParameterizedKey = new Map<string, TestReference[]>();
  const byPathname = new Map<string, TestReference[]>();
  const byMethod = new Map<string, TestReference[]>();

  for (const ref of refs) {
    const path = extractPath(ref.resolvedUrl);
    const pattern = parameterizePath(path);
    const method = (ref.method || 'GET').toUpperCase();
    const paramKey = `${method}|${pattern}`;

    appendToMultimap(byParameterizedKey, paramKey, ref);
    appendToMultimap(byPathname, path, ref);
    appendToMultimap(byMethod, method, ref);
  }

  return { byParameterizedKey, byPathname, byMethod };
}

function appendToMultimap<V>(m: Map<string, V[]>, key: string, v: V): void {
  const arr = m.get(key);
  if (arr) {
    arr.push(v);
  } else {
    m.set(key, [v]);
  }
}

/**
 * Return true if any `ignorePatterns` glob matches the URL.
 */
function isIgnored(url: string, ignorePatterns: string[]): boolean {
  if (ignorePatterns.length === 0) return false;
  return matchesGlob(url, ignorePatterns);
}

// ---------------------------------------------------------------------------
// Public entry point
// ---------------------------------------------------------------------------

/**
 * Compute a coverage report by intersecting bundle routes / APIs with
 * TestReferences.
 */
export function computeCoverage(
  input: ComputeCoverageInput,
  tests: TestReference[],
  options: ComputeCoverageOptions = {},
): CoverageReport {
  const ignorePatterns = options.ignorePatterns ?? [];
  const index = indexTests(tests);

  // -------------------------------------------------------------------------
  // Route coverage
  // -------------------------------------------------------------------------

  const routeEntries: CoverageRouteEntry[] = [];
  for (const route of input.routes) {
    if (isIgnored(route.url, ignorePatterns)) continue;

    const normalized = normalizeForCompare(route.url);
    const routePath = extractPath(normalized);
    // Also consider the parameterized form of the path so `/users/42` in
    // the bundle matches a test hitting `/users/${userId}` (once resolved
    // through our placeholder replacement that's `/users/__PA_TEMPLATE__`,
    // which parameterizePath leaves as a slug) — we broaden by comparing
    // parameterized paths as a secondary signal.
    const routePattern = parameterizePath(routePath);

    // Primary: exact pathname match.
    const byExact = index.byPathname.get(routePath) ?? [];
    // Secondary: parameterized pattern match against GET tests.
    const byGetPattern = index.byParameterizedKey.get(`GET|${routePattern}`) ?? [];

    // Merge and dedup by (filePath, lineNumber, rawUrl).
    const coveringTests = dedupRefs([...byExact, ...byGetPattern]);

    routeEntries.push({
      url: route.url,
      method: 'GET',
      covered: coveringTests.length > 0,
      coveringTests,
    });
  }

  // -------------------------------------------------------------------------
  // API coverage
  // -------------------------------------------------------------------------

  const apiEntries: CoverageApiEntry[] = [];
  for (const api of input.apis) {
    // Treat the endpoint pattern as the url for ignore-pattern matching.
    // Use the first observed URL if available for more accurate filtering.
    const sampleUrl = api.observedUrls[0] ?? api.pattern;
    if (isIgnored(sampleUrl, ignorePatterns)) continue;
    if (isIgnored(api.pattern, ignorePatterns)) continue;

    const method = api.method.toUpperCase();
    const key = `${method}|${api.pattern}`;
    const matches = index.byParameterizedKey.get(key) ?? [];

    apiEntries.push({
      method,
      pattern: api.pattern,
      covered: matches.length > 0,
      coveringTests: dedupRefs(matches),
    });
  }

  // -------------------------------------------------------------------------
  // Summary
  // -------------------------------------------------------------------------

  const routesCovered = routeEntries.filter((r) => r.covered).length;
  const apisCovered = apiEntries.filter((a) => a.covered).length;
  const routesTotal = routeEntries.length;
  const apisTotal = apiEntries.length;

  const summary: CoverageSummary = {
    routesTotal,
    routesCovered,
    routesPercentage: routesTotal === 0 ? 100 : percent(routesCovered, routesTotal),
    apisTotal,
    apisCovered,
    apisPercentage: apisTotal === 0 ? 100 : percent(apisCovered, apisTotal),
    overallPercentage: overallPct(routesCovered, routesTotal, apisCovered, apisTotal),
  };

  return {
    summary,
    routes: routeEntries,
    apis: apiEntries,
    bundleTarget: input.bundleTarget,
    testDir: input.testDir,
    scannedAt: options.scannedAt ?? new Date().toISOString(),
    ignoredPatterns: ignorePatterns,
  };
}

// ---------------------------------------------------------------------------
// Small numeric helpers
// ---------------------------------------------------------------------------

function percent(covered: number, total: number): number {
  if (total === 0) return 100;
  // Two decimal places is enough for a display percentage.
  return Math.round((covered / total) * 10000) / 100;
}

function overallPct(rC: number, rT: number, aC: number, aT: number): number {
  const total = rT + aT;
  if (total === 0) return 100;
  return Math.round(((rC + aC) / total) * 10000) / 100;
}

function dedupRefs(refs: TestReference[]): TestReference[] {
  const seen = new Set<string>();
  const out: TestReference[] = [];
  for (const r of refs) {
    const k = `${r.filePath}|${r.lineNumber}|${r.rawUrl}|${r.method}`;
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(r);
  }
  return out;
}
