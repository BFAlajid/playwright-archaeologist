/**
 * Pure query functions over a loaded bundle.
 *
 * These are the implementations of the MCP tools registered in
 * `src/mcp/server.ts`. Keeping them as pure functions over
 * `LoadedBundle` lets us unit-test them without spinning up the SDK or
 * stdio transport — the server wrapper just translates the MCP call to
 * one of these.
 *
 * Output shapes are stable JSON — tools always return plain objects the
 * MCP SDK can serialize straight through.
 */

import type {
  ApiEndpointGroup,
  FormField,
  FormInfo,
  RouteInfo,
} from '../types/artifacts.js';
import { parameterizePath } from '../assembler/api-grouper.js';
import type {
  AccessibilityPageResult,
  AccessibilityReport,
  LoadedBundle,
} from './bundle-loader.js';

// Max matches per tool call. Claude-side context is the bottleneck, not
// server memory, so truncating here keeps responses manageable.
export const DEFAULT_RESULT_LIMIT = 100;
const A11Y_DEFAULT_LIMIT = 50;

/**
 * Impact rank used to order/filter accessibility violations. The ranking
 * mirrors axe-core's own severity order.
 */
const A11Y_IMPACT_RANK: Record<string, number> = {
  critical: 4,
  serious: 3,
  moderate: 2,
  minor: 1,
};

/** Shape returned by `search_routes`. */
export interface SearchedRoute {
  url: string;
  title: string;
  statusCode: number;
  depth: number;
  hasScreenshot: boolean;
  formCount: number;
  apiCallCount: number;
}

export interface SearchRoutesInput {
  query: string;
  /**
   * Method is retained in the input schema for forward compatibility
   * with a richer bundle shape, but sitemap entries are not per-method
   * (they describe a page, not a request). When provided, it only
   * filters pages where at least one API call originates — for now we
   * surface a warning rather than silently returning zero.
   */
  method?: string;
  status?: number;
  limit?: number;
}

export interface SearchRoutesResult {
  matches: SearchedRoute[];
  /** True iff total matches exceeded the returned slice. */
  hasMore: boolean;
  /** Total number of matches before truncation. */
  total: number;
}

function toSearchedRoute(r: RouteInfo): SearchedRoute {
  return {
    url: r.url,
    title: r.title,
    statusCode: r.statusCode,
    depth: r.depth,
    hasScreenshot: r.hasScreenshot,
    formCount: r.formCount,
    apiCallCount: r.apiCallCount,
  };
}

/**
 * Case-insensitive text search over `url` and `title`. Empty query
 * returns every route (subject to other filters). `status` filters on
 * exact numeric match; `method` is ignored for now (sitemap entries
 * are per-page, not per-request).
 */
export function searchRoutes(
  bundle: LoadedBundle,
  input: SearchRoutesInput,
): SearchRoutesResult {
  const q = typeof input.query === 'string' ? input.query.trim().toLowerCase() : '';
  const statusFilter = typeof input.status === 'number' ? input.status : undefined;

  const all = bundle.sitemap.filter((r) => {
    if (statusFilter !== undefined && r.statusCode !== statusFilter) return false;
    if (q.length === 0) return true;
    const url = r.url.toLowerCase();
    const title = (r.title ?? '').toLowerCase();
    return url.includes(q) || title.includes(q);
  });

  const limit = Math.max(
    1,
    Math.min(input.limit ?? DEFAULT_RESULT_LIMIT, DEFAULT_RESULT_LIMIT),
  );
  return {
    matches: all.slice(0, limit).map(toSearchedRoute),
    hasMore: all.length > limit,
    total: all.length,
  };
}

// ---------------------------------------------------------------------------
// list_forms
// ---------------------------------------------------------------------------

export interface ListFormsInput {
  hasPassword?: boolean;
  method?: string;
  limit?: number;
}

export interface ListFormsResult {
  forms: FormInfo[];
  hasMore: boolean;
  total: number;
}

/** True iff any field on the form is password-typed. */
function formHasPassword(form: FormInfo): boolean {
  return form.fields.some((f) => f.type === 'password');
}

export function listForms(bundle: LoadedBundle, input: ListFormsInput): ListFormsResult {
  const methodFilter =
    typeof input.method === 'string' && input.method.length > 0
      ? input.method.toUpperCase()
      : undefined;

  const filtered = bundle.forms.filter((form) => {
    if (input.hasPassword !== undefined && formHasPassword(form) !== input.hasPassword) {
      return false;
    }
    if (methodFilter !== undefined && (form.method ?? 'GET').toUpperCase() !== methodFilter) {
      return false;
    }
    return true;
  });

  const limit = Math.max(
    1,
    Math.min(input.limit ?? DEFAULT_RESULT_LIMIT, DEFAULT_RESULT_LIMIT),
  );
  return {
    forms: filtered.slice(0, limit),
    hasMore: filtered.length > limit,
    total: filtered.length,
  };
}

// ---------------------------------------------------------------------------
// find_forms_without_csrf
// ---------------------------------------------------------------------------

/**
 * Heuristic to detect a CSRF-style hidden field. We match on the field
 * name (and fall back to the label when the name is blank) because
 * different frameworks use different conventions:
 *   Laravel       → `_token`
 *   Rails         → `authenticity_token`
 *   Django        → `csrfmiddlewaretoken`
 *   Angular/AJAX  → `X-XSRF-TOKEN` header (not a form field, but often
 *                  mirrored via a hidden `xsrf`/`xsrf_token` input)
 *   Generic       → `csrf`, `csrf_token`, `csrftoken`
 *
 * We deliberately only check hidden and text fields — `password` fields
 * are never treated as anti-CSRF even if named `token` because they are
 * user-controlled.
 */
const CSRF_NAME_RE = /csrf|_token|authenticity|xsrf/i;

function looksLikeCsrfField(field: FormField): boolean {
  if (field.type === 'password') return false;
  const haystack = `${field.name ?? ''} ${field.label ?? ''}`;
  return CSRF_NAME_RE.test(haystack);
}

/**
 * Return the forms whose fields contain no plausible CSRF token. GET
 * forms are excluded from the result because they are state-retrieval
 * by HTTP convention and CSRF tokens on them are non-normative.
 */
export function findFormsWithoutCsrf(bundle: LoadedBundle): FormInfo[] {
  return bundle.forms.filter((form) => {
    const method = (form.method ?? 'GET').toUpperCase();
    if (method === 'GET') return false;
    return !form.fields.some((f) => looksLikeCsrfField(f));
  });
}

// ---------------------------------------------------------------------------
// get_api_endpoint
// ---------------------------------------------------------------------------

export interface GetApiEndpointInput {
  method: string;
  pattern: string;
}

/**
 * Look up an endpoint by method + pattern. `pattern` is matched exactly
 * first; if that misses we parameterize the input the same way the
 * assembler does (numeric IDs and UUIDs → `:id`, slugs → `:slug`) so
 * callers can pass a concrete URL like `/api/users/42` and still find
 * the `/api/users/:id` group.
 */
export function getApiEndpoint(
  bundle: LoadedBundle,
  input: GetApiEndpointInput,
): ApiEndpointGroup | null {
  const method = input.method.toUpperCase();
  // Pattern may include scheme+host; strip to path for robust matching.
  let rawPattern = input.pattern;
  try {
    const u = new URL(input.pattern);
    rawPattern = u.pathname;
  } catch {
    // Assume it's already a path.
  }

  // Exact match
  const exact = bundle.apiMap.find(
    (g) => g.method.toUpperCase() === method && g.pattern === rawPattern,
  );
  if (exact) return exact;

  // Fuzzy — parameterize the input and try again.
  const parameterized = parameterizePath(rawPattern);
  const param = bundle.apiMap.find(
    (g) => g.method.toUpperCase() === method && g.pattern === parameterized,
  );
  return param ?? null;
}

// ---------------------------------------------------------------------------
// list_accessibility_violations
// ---------------------------------------------------------------------------

export type A11yImpact = 'minor' | 'moderate' | 'serious' | 'critical';

export interface ListA11yInput {
  impact?: A11yImpact;
  limit?: number;
}

export interface ListA11yViolation {
  pageUrl: string;
  id: string;
  impact: string;
  nodes: number;
  help: string;
  helpUrl: string;
}

export interface ListA11yResult {
  violations: ListA11yViolation[];
  /** Totals by impact across the whole bundle. */
  totals: Record<string, number>;
  hasMore: boolean;
  total: number;
  /** Whether the bundle contains accessibility data at all. */
  present: boolean;
}

/**
 * Flatten the accessibility report into a per-page-per-rule list sorted
 * by impact severity. Returns `present: false` when the bundle has no
 * accessibility data — callers surface that as a hint rather than an error.
 */
export function listAccessibilityViolations(
  bundle: LoadedBundle,
  input: ListA11yInput,
): ListA11yResult {
  const a11y: AccessibilityReport | null = bundle.accessibility;
  if (!a11y) {
    return {
      violations: [],
      totals: {},
      hasMore: false,
      total: 0,
      present: false,
    };
  }

  const impactFilter = input.impact;
  const flattened: ListA11yViolation[] = [];
  for (const page of a11y.perPage as AccessibilityPageResult[]) {
    for (const v of page.violations) {
      if (impactFilter !== undefined && v.impact !== impactFilter) continue;
      flattened.push({
        pageUrl: page.url,
        id: v.id,
        impact: v.impact,
        nodes: v.nodes,
        help: v.help,
        helpUrl: v.helpUrl,
      });
    }
  }

  flattened.sort((a, b) => {
    const r = (A11Y_IMPACT_RANK[b.impact] ?? 0) - (A11Y_IMPACT_RANK[a.impact] ?? 0);
    if (r !== 0) return r;
    return b.nodes - a.nodes;
  });

  const limit = Math.max(1, Math.min(input.limit ?? A11Y_DEFAULT_LIMIT, DEFAULT_RESULT_LIMIT));
  return {
    violations: flattened.slice(0, limit),
    totals: { ...a11y.byImpact },
    hasMore: flattened.length > limit,
    total: flattened.length,
    present: true,
  };
}

// ---------------------------------------------------------------------------
// list_broken_routes
// ---------------------------------------------------------------------------

export interface ListBrokenInput {
  minStatus?: number;
  limit?: number;
}

export interface ListBrokenResult {
  routes: SearchedRoute[];
  hasMore: boolean;
  total: number;
}

/**
 * Filter to pages whose `statusCode >= minStatus` (default 400). Sorted
 * by status desc so 5xx routes surface before 4xx.
 */
export function listBrokenRoutes(
  bundle: LoadedBundle,
  input: ListBrokenInput,
): ListBrokenResult {
  const threshold = typeof input.minStatus === 'number' ? input.minStatus : 400;
  const filtered = bundle.sitemap
    .filter((r) => r.statusCode >= threshold)
    .sort((a, b) => b.statusCode - a.statusCode);

  const limit = Math.max(
    1,
    Math.min(input.limit ?? DEFAULT_RESULT_LIMIT, DEFAULT_RESULT_LIMIT),
  );
  return {
    routes: filtered.slice(0, limit).map(toSearchedRoute),
    hasMore: filtered.length > limit,
    total: filtered.length,
  };
}
