/**
 * OpenAPI 3.0.3 Specification Generator
 *
 * Converts discovered ApiEndpointGroup[] into a valid OpenAPI 3.0.3 spec.
 * Used to produce machine-readable API documentation from crawl results.
 */

import { writeFile, mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';
import type { ApiEndpointGroup } from '../types/artifacts.js';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface OpenApiOptions {
  /** Title for the API specification. */
  title: string;
  /** Base URL of the crawled site (used for servers[].url). */
  targetUrl: string;
  /** API version string. Defaults to "1.0.0". */
  version?: string;
  /** Optional human-readable description. */
  description?: string;
}

export interface OpenApiSpec {
  openapi: '3.0.3';
  info: { title: string; version: string; description?: string };
  servers: Array<{ url: string }>;
  paths: Record<string, Record<string, OpenApiOperation>>;
}

export interface OpenApiOperation {
  summary: string;
  operationId: string;
  parameters?: OpenApiParameter[];
  requestBody?: {
    content: Record<string, { schema: unknown; example?: unknown }>;
  };
  responses: Record<
    string,
    {
      description: string;
      content?: Record<string, { schema: unknown; example?: unknown }>;
    }
  >;
  tags?: string[];
}

export interface OpenApiParameter {
  name: string;
  in: 'path' | 'query';
  required: boolean;
  schema: { type: string };
}

// ---------------------------------------------------------------------------
// Status code descriptions
// ---------------------------------------------------------------------------

const STATUS_DESCRIPTIONS: Record<number, string> = {
  200: 'Success',
  201: 'Created',
  204: 'No Content',
  400: 'Bad Request',
  401: 'Unauthorized',
  403: 'Forbidden',
  404: 'Not Found',
  500: 'Internal Server Error',
};

// ---------------------------------------------------------------------------
// Schema inference (max 2 levels deep)
// ---------------------------------------------------------------------------

/**
 * Infer a JSON Schema from a value. Limited to 2 levels of nesting
 * to keep generated specs manageable.
 */
export function inferSchema(value: unknown, depth = 0): Record<string, unknown> {
  if (value === null || value === undefined) {
    return { type: 'string', nullable: true };
  }

  if (Array.isArray(value)) {
    if (value.length === 0 || depth >= 2) {
      return { type: 'array', items: {} };
    }
    return { type: 'array', items: inferSchema(value[0], depth + 1) };
  }

  if (typeof value === 'object') {
    if (depth >= 2) {
      return { type: 'object' };
    }
    const properties: Record<string, unknown> = {};
    for (const [key, val] of Object.entries(value as Record<string, unknown>)) {
      properties[key] = inferSchema(val, depth + 1);
    }
    return { type: 'object', properties };
  }

  if (typeof value === 'number') {
    return Number.isInteger(value) ? { type: 'integer' } : { type: 'number' };
  }

  if (typeof value === 'boolean') {
    return { type: 'boolean' };
  }

  return { type: 'string' };
}

// ---------------------------------------------------------------------------
// Path conversion helpers
// ---------------------------------------------------------------------------

/**
 * Convert colon-style path parameters to OpenAPI curly-brace style.
 * `/api/users/:id` becomes `/api/users/{id}`.
 */
export function toOpenApiPath(pattern: string): string {
  return pattern.replace(/:([a-zA-Z_][a-zA-Z0-9_]*)/g, '{$1}');
}

/**
 * Extract parameter names from a colon-style pattern.
 * `/api/users/:id/posts/:postId` returns `['id', 'postId']`.
 */
export function extractPathParams(pattern: string): string[] {
  const params: string[] = [];
  const re = /:([a-zA-Z_][a-zA-Z0-9_]*)/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(pattern)) !== null) {
    params.push(match[1]);
  }
  return params;
}

// ---------------------------------------------------------------------------
// Operation ID generation
// ---------------------------------------------------------------------------

/**
 * Generate an operationId from HTTP method and URL pattern.
 * `GET /api/users/:id` -> `getApiUsersById`
 */
export function generateOperationId(method: string, pattern: string): string {
  const segments = pattern
    .split('/')
    .filter(Boolean)
    .map((seg) => {
      if (seg.startsWith(':')) {
        // :userId -> ByUserId
        const paramName = seg.slice(1);
        return 'By' + paramName.charAt(0).toUpperCase() + paramName.slice(1);
      }
      return seg.charAt(0).toUpperCase() + seg.slice(1);
    });

  return method.toLowerCase() + segments.join('');
}

// ---------------------------------------------------------------------------
// Tag extraction
// ---------------------------------------------------------------------------

/**
 * Extract a tag from the endpoint pattern.
 * Uses the first meaningful path segment (skips common prefixes like "api").
 */
export function extractTag(pattern: string): string | undefined {
  const segments = pattern.split('/').filter(Boolean);
  // Skip common API prefixes
  const prefixes = new Set(['api', 'v1', 'v2', 'v3', 'v4', 'rest']);
  for (const seg of segments) {
    if (seg.startsWith(':')) continue;
    if (prefixes.has(seg.toLowerCase())) continue;
    return seg;
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// Methods that typically carry a request body
// ---------------------------------------------------------------------------

const BODY_METHODS = new Set(['POST', 'PUT', 'PATCH']);

// ---------------------------------------------------------------------------
// Main generator
// ---------------------------------------------------------------------------

/**
 * Generate an OpenAPI 3.0.3 specification from discovered API endpoint groups.
 */
export function generateOpenApiSpec(
  endpoints: ApiEndpointGroup[],
  options: OpenApiOptions,
): OpenApiSpec {
  if (!options.title) {
    throw new Error('OpenAPI title is required');
  }
  if (!options.targetUrl) {
    throw new Error('OpenAPI targetUrl is required');
  }

  const info: OpenApiSpec['info'] = {
    title: options.title,
    version: options.version ?? '1.0.0',
  };
  if (options.description) {
    info.description = options.description;
  }

  // Strip trailing slash from server URL
  const serverUrl = options.targetUrl.replace(/\/+$/, '');

  const paths: OpenApiSpec['paths'] = {};

  for (const endpoint of endpoints) {
    const openApiPath = toOpenApiPath(endpoint.pattern);
    const methodKey = endpoint.method.toLowerCase();

    if (!paths[openApiPath]) {
      paths[openApiPath] = {};
    }

    const operation = buildOperation(endpoint);
    paths[openApiPath][methodKey] = operation;
  }

  return {
    openapi: '3.0.3',
    info,
    servers: [{ url: serverUrl }],
    paths,
  };
}

/**
 * Build a single OpenAPI operation from an endpoint group.
 */
function buildOperation(endpoint: ApiEndpointGroup): OpenApiOperation {
  const operationId = generateOperationId(endpoint.method, endpoint.pattern);
  const summary = `${endpoint.method} ${endpoint.pattern}`;

  const operation: OpenApiOperation = {
    summary,
    operationId,
    responses: {},
  };

  // Path parameters
  const paramNames = extractPathParams(endpoint.pattern);
  if (paramNames.length > 0) {
    operation.parameters = paramNames.map((name) => ({
      name,
      in: 'path' as const,
      required: true,
      schema: { type: 'string' },
    }));
  }

  // Tags
  const tag = extractTag(endpoint.pattern);
  if (tag) {
    operation.tags = [tag];
  }

  // Request body (for POST, PUT, PATCH)
  if (BODY_METHODS.has(endpoint.method.toUpperCase()) && endpoint.exampleRequest.body) {
    const contentType = endpoint.exampleRequest.contentType ?? 'application/json';
    let parsed: unknown;
    try {
      parsed = JSON.parse(endpoint.exampleRequest.body);
    } catch {
      parsed = endpoint.exampleRequest.body;
    }
    operation.requestBody = {
      content: {
        [contentType]: {
          schema: inferSchema(parsed),
          example: parsed,
        },
      },
    };
  }

  // Responses
  for (const statusCode of endpoint.observedStatusCodes) {
    const description =
      STATUS_DESCRIPTIONS[statusCode] ?? 'Response';

    const responseEntry: { description: string; content?: Record<string, { schema: unknown; example?: unknown }> } = {
      description,
    };

    // Attach response body schema only for the example response status code
    if (
      statusCode === endpoint.exampleResponse.statusCode &&
      endpoint.exampleResponse.body
    ) {
      const contentType = endpoint.exampleResponse.contentType ?? 'application/json';
      let parsed: unknown;
      try {
        parsed = JSON.parse(endpoint.exampleResponse.body);
      } catch {
        parsed = endpoint.exampleResponse.body;
      }
      responseEntry.content = {
        [contentType]: {
          schema: inferSchema(parsed),
          example: parsed,
        },
      };
    }

    operation.responses[String(statusCode)] = responseEntry;
  }

  // If no status codes observed, add a default 200
  if (endpoint.observedStatusCodes.length === 0) {
    operation.responses['200'] = { description: 'Success' };
  }

  return operation;
}

// ---------------------------------------------------------------------------
// File writer
// ---------------------------------------------------------------------------

/**
 * Write an OpenAPI spec to disk as JSON with 2-space indentation.
 */
export async function writeOpenApiSpec(
  spec: OpenApiSpec,
  outputPath: string,
): Promise<void> {
  if (!outputPath) {
    throw new Error('Output path is required');
  }
  await mkdir(dirname(outputPath), { recursive: true });
  const json = JSON.stringify(spec, null, 2) + '\n';
  await writeFile(outputPath, json, 'utf-8');
}
