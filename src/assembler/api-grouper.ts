/**
 * API Endpoint Grouper
 *
 * Groups discovered API endpoints by URL pattern, replacing dynamic
 * segments with parameter placeholders:
 * - Numeric IDs: /users/123 -> /users/:id
 * - UUIDs: /items/550e8400-... -> /items/:id
 * - Slugs: /posts/hello-world -> /posts/:slug
 */

export interface ApiEndpoint {
  method: string;
  url: string;
  statusCode?: number;
  requestBody?: unknown;
  responseBody?: unknown;
  headers?: Record<string, string>;
}

export interface ApiGroup {
  pattern: string;
  method: string;
  examples: ApiEndpoint[];
  parameterTypes: Record<string, 'id' | 'uuid' | 'slug' | 'unknown'>;
}

/** UUID v4 pattern: 8-4-4-4-12 hex digits, with or without dashes. */
const UUID_WITH_DASHES = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const UUID_WITHOUT_DASHES = /^[0-9a-f]{32}$/i;

/**
 * Detect if a URL path segment is a numeric ID.
 */
export function isNumericId(segment: string): boolean {
  return /^\d+$/.test(segment);
}

/**
 * Detect if a URL path segment is a UUID.
 */
export function isUuid(segment: string): boolean {
  return UUID_WITH_DASHES.test(segment) || UUID_WITHOUT_DASHES.test(segment);
}

/**
 * Detect if a URL path segment is a slug.
 * A slug contains at least one hyphen, is all lowercase alphanumeric + hyphens,
 * and has more than one "word" (segment between hyphens).
 * UUIDs are excluded since they are handled separately.
 */
export function isSlug(segment: string): boolean {
  if (!segment || !segment.includes('-')) return false;

  // Must be lowercase alphanumeric and hyphens only
  if (!/^[a-z0-9]+(-[a-z0-9]+)+$/.test(segment)) return false;

  // Exclude UUIDs
  if (isUuid(segment)) return false;

  return true;
}

/**
 * Convert a concrete URL path to a parameterized pattern.
 * /api/v2/users/123/posts/456 -> /api/v2/users/:id/posts/:id
 */
export function parameterizePath(path: string): string {
  // Strip query string before parameterizing
  const pathOnly = path.split('?')[0];

  const segments = pathOnly.split('/');

  const parameterized = segments.map((segment) => {
    if (!segment) return segment; // preserve empty segments from leading/trailing slashes

    if (isUuid(segment)) return ':id';
    if (isNumericId(segment)) return ':id';
    if (isSlug(segment)) return ':slug';

    return segment;
  });

  return parameterized.join('/');
}

/**
 * Determine the parameter type for a segment.
 */
function getParameterType(segment: string): 'id' | 'uuid' | 'slug' | 'unknown' {
  if (isUuid(segment)) return 'uuid';
  if (isNumericId(segment)) return 'id';
  if (isSlug(segment)) return 'slug';
  return 'unknown';
}

/**
 * Build a parameterTypes map from a concrete path by comparing it
 * against its parameterized version.
 */
function extractParameterTypes(path: string): Record<string, 'id' | 'uuid' | 'slug' | 'unknown'> {
  const pathOnly = path.split('?')[0];
  const segments = pathOnly.split('/');
  const result: Record<string, 'id' | 'uuid' | 'slug' | 'unknown'> = {};
  let idIndex = 0;
  let slugIndex = 0;

  for (const segment of segments) {
    if (!segment) continue;

    if (isUuid(segment)) {
      result[`:id_${idIndex++}`] = 'uuid';
    } else if (isNumericId(segment)) {
      result[`:id_${idIndex++}`] = 'id';
    } else if (isSlug(segment)) {
      result[`:slug_${slugIndex++}`] = 'slug';
    }
  }

  return result;
}

/**
 * Group a list of API endpoints by their parameterized pattern + method.
 */
export function groupEndpoints(endpoints: ApiEndpoint[]): ApiGroup[] {
  if (endpoints.length === 0) return [];

  const groupMap = new Map<string, ApiGroup>();

  for (const endpoint of endpoints) {
    const pattern = parameterizePath(endpoint.url);
    const key = `${endpoint.method} ${pattern}`;

    const existing = groupMap.get(key);
    if (existing) {
      existing.examples.push(endpoint);
    } else {
      groupMap.set(key, {
        pattern,
        method: endpoint.method,
        examples: [endpoint],
        parameterTypes: extractParameterTypes(endpoint.url),
      });
    }
  }

  return Array.from(groupMap.values());
}

/**
 * Detect GraphQL operations and group by operation name.
 */
export function groupGraphQLOperations(
  endpoints: ApiEndpoint[]
): Map<string, ApiEndpoint[]> {
  const result = new Map<string, ApiEndpoint[]>();

  for (const endpoint of endpoints) {
    // Only consider POST requests to /graphql
    if (endpoint.method !== 'POST') continue;

    const pathOnly = endpoint.url.split('?')[0];
    if (!pathOnly.endsWith('/graphql') && pathOnly !== '/graphql') continue;

    const body = endpoint.requestBody as Record<string, unknown> | undefined;
    if (!body || typeof body !== 'object') continue;

    const operationName =
      typeof body.operationName === 'string' ? body.operationName : 'anonymous';

    const existing = result.get(operationName);
    if (existing) {
      existing.push(endpoint);
    } else {
      result.set(operationName, [endpoint]);
    }
  }

  return result;
}
