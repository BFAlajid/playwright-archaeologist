/**
 * Unit tests for src/report/openapi-output.ts
 *
 * OpenAPI 3.0.3 spec generation: path conversion, parameter extraction,
 * schema inference, operation IDs, tags, status codes, request bodies,
 * and file output.
 */

import { describe, it, expect, vi } from 'vitest';
import type { ApiEndpointGroup } from '../../src/types/artifacts.js';
import {
  generateOpenApiSpec,
  writeOpenApiSpec,
  inferSchema,
  toOpenApiPath,
  extractPathParams,
  generateOperationId,
  extractTag,
  type OpenApiOptions,
  type OpenApiSpec,
} from '../../src/report/openapi-output.js';

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

function makeEndpoint(overrides: Partial<ApiEndpointGroup> = {}): ApiEndpointGroup {
  return {
    pattern: '/api/users',
    method: 'GET',
    classification: 'api',
    observedUrls: ['http://localhost:3000/api/users'],
    callCount: 1,
    callingPages: ['http://localhost:3000/'],
    exampleRequest: {
      url: 'http://localhost:3000/api/users',
      headers: {},
    },
    exampleResponse: {
      statusCode: 200,
      headers: {},
      bodySize: 0,
    },
    observedStatusCodes: [200],
    observedContentTypes: ['application/json'],
    isGraphQL: false,
    ...overrides,
  };
}

const DEFAULT_OPTIONS: OpenApiOptions = {
  title: 'Test API',
  targetUrl: 'http://localhost:3000',
};

// ---------------------------------------------------------------------------
// generateOpenApiSpec — basic structure
// ---------------------------------------------------------------------------

describe('generateOpenApiSpec', () => {
  it('generates valid OpenAPI 3.0.3 structure', () => {
    const spec = generateOpenApiSpec([], DEFAULT_OPTIONS);

    expect(spec.openapi).toBe('3.0.3');
    expect(spec.info.title).toBe('Test API');
    expect(spec.info.version).toBe('1.0.0');
    expect(spec.servers).toEqual([{ url: 'http://localhost:3000' }]);
    expect(spec.paths).toEqual({});
  });

  it('uses custom version and description', () => {
    const spec = generateOpenApiSpec([], {
      ...DEFAULT_OPTIONS,
      version: '2.5.0',
      description: 'Crawled API',
    });

    expect(spec.info.version).toBe('2.5.0');
    expect(spec.info.description).toBe('Crawled API');
  });

  it('strips trailing slash from server URL', () => {
    const spec = generateOpenApiSpec([], {
      ...DEFAULT_OPTIONS,
      targetUrl: 'http://localhost:3000/',
    });
    expect(spec.servers[0].url).toBe('http://localhost:3000');
  });

  it('handles empty endpoint list', () => {
    const spec = generateOpenApiSpec([], DEFAULT_OPTIONS);
    expect(Object.keys(spec.paths)).toHaveLength(0);
  });

  it('throws when title is empty', () => {
    expect(() =>
      generateOpenApiSpec([], { title: '', targetUrl: 'http://x.com' }),
    ).toThrow('title is required');
  });

  it('throws when targetUrl is empty', () => {
    expect(() =>
      generateOpenApiSpec([], { title: 'X', targetUrl: '' }),
    ).toThrow('targetUrl is required');
  });

  it('includes server URL', () => {
    const spec = generateOpenApiSpec([], {
      title: 'My API',
      targetUrl: 'https://example.com',
    });
    expect(spec.servers).toEqual([{ url: 'https://example.com' }]);
  });
});

// ---------------------------------------------------------------------------
// toOpenApiPath — colon params to curly brace
// ---------------------------------------------------------------------------

describe('toOpenApiPath', () => {
  it('converts single colon param to curly brace', () => {
    expect(toOpenApiPath('/api/users/:id')).toBe('/api/users/{id}');
  });

  it('converts multiple colon params', () => {
    expect(toOpenApiPath('/api/users/:userId/posts/:postId')).toBe(
      '/api/users/{userId}/posts/{postId}',
    );
  });

  it('leaves paths without params unchanged', () => {
    expect(toOpenApiPath('/api/users')).toBe('/api/users');
  });

  it('handles params with underscores', () => {
    expect(toOpenApiPath('/items/:item_id')).toBe('/items/{item_id}');
  });
});

// ---------------------------------------------------------------------------
// extractPathParams
// ---------------------------------------------------------------------------

describe('extractPathParams', () => {
  it('extracts single parameter', () => {
    expect(extractPathParams('/api/users/:id')).toEqual(['id']);
  });

  it('extracts multiple parameters', () => {
    expect(extractPathParams('/api/users/:userId/posts/:postId')).toEqual([
      'userId',
      'postId',
    ]);
  });

  it('returns empty array when no params', () => {
    expect(extractPathParams('/api/users')).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// generateOperationId
// ---------------------------------------------------------------------------

describe('generateOperationId', () => {
  it('generates from GET and simple path', () => {
    expect(generateOperationId('GET', '/api/users')).toBe('getApiUsers');
  });

  it('generates from GET with param', () => {
    expect(generateOperationId('GET', '/api/users/:id')).toBe(
      'getApiUsersById',
    );
  });

  it('lowercases the method', () => {
    const result = generateOperationId('POST', '/api/users');
    expect(result).toBe('postApiUsers');
  });

  it('handles deeply nested paths', () => {
    const result = generateOperationId(
      'DELETE',
      '/api/users/:userId/posts/:postId',
    );
    expect(result).toMatch(/^delete/);
    expect(result).toContain('Users');
    expect(result).toContain('Posts');
  });
});

// ---------------------------------------------------------------------------
// extractTag
// ---------------------------------------------------------------------------

describe('extractTag', () => {
  it('extracts tag from /api/users', () => {
    expect(extractTag('/api/users')).toBe('users');
  });

  it('extracts tag from /api/v1/orders', () => {
    expect(extractTag('/api/v1/orders')).toBe('orders');
  });

  it('skips param segments', () => {
    expect(extractTag('/:tenant/api/items')).toBe('items');
  });

  it('returns undefined for empty path', () => {
    expect(extractTag('/')).toBeUndefined();
  });

  it('returns first non-prefix segment', () => {
    expect(extractTag('/rest/products')).toBe('products');
  });
});

// ---------------------------------------------------------------------------
// inferSchema
// ---------------------------------------------------------------------------

describe('inferSchema', () => {
  it('infers string type', () => {
    expect(inferSchema('hello')).toEqual({ type: 'string' });
  });

  it('infers integer type', () => {
    expect(inferSchema(42)).toEqual({ type: 'integer' });
  });

  it('infers number type for float', () => {
    expect(inferSchema(3.14)).toEqual({ type: 'number' });
  });

  it('infers boolean type', () => {
    expect(inferSchema(true)).toEqual({ type: 'boolean' });
  });

  it('infers nullable for null', () => {
    expect(inferSchema(null)).toEqual({ type: 'string', nullable: true });
  });

  it('infers nullable for undefined', () => {
    expect(inferSchema(undefined)).toEqual({ type: 'string', nullable: true });
  });

  it('infers object schema from JSON object', () => {
    const schema = inferSchema({ name: 'Alice', age: 30 });
    expect(schema).toEqual({
      type: 'object',
      properties: {
        name: { type: 'string' },
        age: { type: 'integer' },
      },
    });
  });

  it('infers array schema from JSON array', () => {
    const schema = inferSchema([{ id: 1 }]);
    expect(schema).toEqual({
      type: 'array',
      items: {
        type: 'object',
        properties: {
          id: { type: 'integer' },
        },
      },
    });
  });

  it('infers empty array schema', () => {
    expect(inferSchema([])).toEqual({ type: 'array', items: {} });
  });

  it('limits depth to 2 levels', () => {
    const deep = { a: { b: { c: { d: 'too deep' } } } };
    const schema = inferSchema(deep);
    // Level 0: object with properties
    // Level 1: a -> object with properties
    // Level 2: b -> { type: 'object' } (no properties, depth limit)
    expect(schema).toEqual({
      type: 'object',
      properties: {
        a: {
          type: 'object',
          properties: {
            b: { type: 'object' },
          },
        },
      },
    });
  });
});

// ---------------------------------------------------------------------------
// Status code descriptions
// ---------------------------------------------------------------------------

describe('status code mapping', () => {
  it.each([
    [200, 'Success'],
    [201, 'Created'],
    [204, 'No Content'],
    [400, 'Bad Request'],
    [401, 'Unauthorized'],
    [403, 'Forbidden'],
    [404, 'Not Found'],
    [500, 'Internal Server Error'],
  ])('maps %d to "%s"', (code, expected) => {
    const endpoint = makeEndpoint({
      observedStatusCodes: [code],
      exampleResponse: {
        statusCode: code,
        headers: {},
        bodySize: 0,
      },
    });

    const spec = generateOpenApiSpec([endpoint], DEFAULT_OPTIONS);
    const op = spec.paths['/api/users']['get'];
    expect(op.responses[String(code)].description).toBe(expected);
  });

  it('uses "Response" for unknown status codes', () => {
    const endpoint = makeEndpoint({
      observedStatusCodes: [418],
      exampleResponse: {
        statusCode: 418,
        headers: {},
        bodySize: 0,
      },
    });

    const spec = generateOpenApiSpec([endpoint], DEFAULT_OPTIONS);
    const op = spec.paths['/api/users']['get'];
    expect(op.responses['418'].description).toBe('Response');
  });
});

// ---------------------------------------------------------------------------
// Endpoints with no examples / response body
// ---------------------------------------------------------------------------

describe('endpoints with no response body', () => {
  it('handles endpoint with no response body', () => {
    const endpoint = makeEndpoint({
      observedStatusCodes: [204],
      exampleResponse: {
        statusCode: 204,
        headers: {},
        bodySize: 0,
      },
    });

    const spec = generateOpenApiSpec([endpoint], DEFAULT_OPTIONS);
    const op = spec.paths['/api/users']['get'];
    expect(op.responses['204'].description).toBe('No Content');
    expect(op.responses['204'].content).toBeUndefined();
  });

  it('handles endpoint with no observed status codes', () => {
    const endpoint = makeEndpoint({
      observedStatusCodes: [],
    });

    const spec = generateOpenApiSpec([endpoint], DEFAULT_OPTIONS);
    const op = spec.paths['/api/users']['get'];
    expect(op.responses['200'].description).toBe('Success');
  });
});

// ---------------------------------------------------------------------------
// Response body schema inference
// ---------------------------------------------------------------------------

describe('response body schema', () => {
  it('infers object schema from JSON response', () => {
    const endpoint = makeEndpoint({
      exampleResponse: {
        statusCode: 200,
        headers: {},
        body: JSON.stringify({ id: 1, name: 'Alice' }),
        contentType: 'application/json',
        bodySize: 30,
      },
    });

    const spec = generateOpenApiSpec([endpoint], DEFAULT_OPTIONS);
    const op = spec.paths['/api/users']['get'];
    const content = op.responses['200'].content;
    expect(content).toBeDefined();
    expect(content!['application/json'].schema).toEqual({
      type: 'object',
      properties: {
        id: { type: 'integer' },
        name: { type: 'string' },
      },
    });
    expect(content!['application/json'].example).toEqual({
      id: 1,
      name: 'Alice',
    });
  });

  it('infers array schema from JSON response', () => {
    const endpoint = makeEndpoint({
      exampleResponse: {
        statusCode: 200,
        headers: {},
        body: JSON.stringify([{ id: 1 }, { id: 2 }]),
        contentType: 'application/json',
        bodySize: 20,
      },
    });

    const spec = generateOpenApiSpec([endpoint], DEFAULT_OPTIONS);
    const op = spec.paths['/api/users']['get'];
    const schema = op.responses['200'].content!['application/json'].schema;
    expect(schema).toEqual({
      type: 'array',
      items: {
        type: 'object',
        properties: {
          id: { type: 'integer' },
        },
      },
    });
  });
});

// ---------------------------------------------------------------------------
// Multiple methods on same path
// ---------------------------------------------------------------------------

describe('multiple methods on same path', () => {
  it('groups GET and POST under the same path', () => {
    const getEndpoint = makeEndpoint({ method: 'GET' });
    const postEndpoint = makeEndpoint({
      method: 'POST',
      exampleRequest: {
        url: 'http://localhost:3000/api/users',
        headers: {},
        body: JSON.stringify({ name: 'Bob' }),
        contentType: 'application/json',
      },
    });

    const spec = generateOpenApiSpec(
      [getEndpoint, postEndpoint],
      DEFAULT_OPTIONS,
    );

    expect(spec.paths['/api/users']['get']).toBeDefined();
    expect(spec.paths['/api/users']['post']).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// Request body for POST/PUT/PATCH
// ---------------------------------------------------------------------------

describe('request body', () => {
  it('includes request body for POST', () => {
    const endpoint = makeEndpoint({
      method: 'POST',
      exampleRequest: {
        url: 'http://localhost:3000/api/users',
        headers: {},
        body: JSON.stringify({ name: 'Alice', email: 'a@b.com' }),
        contentType: 'application/json',
      },
    });

    const spec = generateOpenApiSpec([endpoint], DEFAULT_OPTIONS);
    const op = spec.paths['/api/users']['post'];
    expect(op.requestBody).toBeDefined();
    expect(op.requestBody!.content['application/json']).toBeDefined();
    expect(op.requestBody!.content['application/json'].schema).toEqual({
      type: 'object',
      properties: {
        name: { type: 'string' },
        email: { type: 'string' },
      },
    });
  });

  it('includes request body for PUT', () => {
    const endpoint = makeEndpoint({
      method: 'PUT',
      pattern: '/api/users/:id',
      exampleRequest: {
        url: 'http://localhost:3000/api/users/1',
        headers: {},
        body: JSON.stringify({ name: 'Updated' }),
        contentType: 'application/json',
      },
    });

    const spec = generateOpenApiSpec([endpoint], DEFAULT_OPTIONS);
    const op = spec.paths['/api/users/{id}']['put'];
    expect(op.requestBody).toBeDefined();
  });

  it('includes request body for PATCH', () => {
    const endpoint = makeEndpoint({
      method: 'PATCH',
      exampleRequest: {
        url: 'http://localhost:3000/api/users',
        headers: {},
        body: JSON.stringify({ active: true }),
        contentType: 'application/json',
      },
    });

    const spec = generateOpenApiSpec([endpoint], DEFAULT_OPTIONS);
    const op = spec.paths['/api/users']['patch'];
    expect(op.requestBody).toBeDefined();
  });

  it('omits request body for GET', () => {
    const endpoint = makeEndpoint({ method: 'GET' });
    const spec = generateOpenApiSpec([endpoint], DEFAULT_OPTIONS);
    const op = spec.paths['/api/users']['get'];
    expect(op.requestBody).toBeUndefined();
  });

  it('omits request body for DELETE', () => {
    const endpoint = makeEndpoint({ method: 'DELETE' });
    const spec = generateOpenApiSpec([endpoint], DEFAULT_OPTIONS);
    const op = spec.paths['/api/users']['delete'];
    expect(op.requestBody).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Path parameters in generated spec
// ---------------------------------------------------------------------------

describe('path parameters in spec', () => {
  it('extracts path parameters from pattern', () => {
    const endpoint = makeEndpoint({
      pattern: '/api/users/:id',
    });

    const spec = generateOpenApiSpec([endpoint], DEFAULT_OPTIONS);
    const op = spec.paths['/api/users/{id}']['get'];
    expect(op.parameters).toEqual([
      { name: 'id', in: 'path', required: true, schema: { type: 'string' } },
    ]);
  });

  it('extracts multiple path parameters', () => {
    const endpoint = makeEndpoint({
      pattern: '/api/users/:userId/posts/:postId',
    });

    const spec = generateOpenApiSpec([endpoint], DEFAULT_OPTIONS);
    const op = spec.paths['/api/users/{userId}/posts/{postId}']['get'];
    expect(op.parameters).toHaveLength(2);
    expect(op.parameters![0].name).toBe('userId');
    expect(op.parameters![1].name).toBe('postId');
  });

  it('omits parameters when path has none', () => {
    const endpoint = makeEndpoint();
    const spec = generateOpenApiSpec([endpoint], DEFAULT_OPTIONS);
    const op = spec.paths['/api/users']['get'];
    expect(op.parameters).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Tags
// ---------------------------------------------------------------------------

describe('tags', () => {
  it('assigns tag from first meaningful path segment', () => {
    const endpoint = makeEndpoint({ pattern: '/api/users' });
    const spec = generateOpenApiSpec([endpoint], DEFAULT_OPTIONS);
    const op = spec.paths['/api/users']['get'];
    expect(op.tags).toEqual(['users']);
  });

  it('skips api/version prefixes for tag', () => {
    const endpoint = makeEndpoint({ pattern: '/api/v1/orders' });
    const spec = generateOpenApiSpec([endpoint], DEFAULT_OPTIONS);
    const op = spec.paths['/api/v1/orders']['get'];
    expect(op.tags).toEqual(['orders']);
  });

  it('groups different endpoints under same tag', () => {
    const list = makeEndpoint({ pattern: '/api/products' });
    const detail = makeEndpoint({ pattern: '/api/products/:id' });

    const spec = generateOpenApiSpec([list, detail], DEFAULT_OPTIONS);
    expect(spec.paths['/api/products']['get'].tags).toEqual(['products']);
    expect(spec.paths['/api/products/{id}']['get'].tags).toEqual(['products']);
  });
});

// ---------------------------------------------------------------------------
// writeOpenApiSpec
// ---------------------------------------------------------------------------

describe('writeOpenApiSpec', () => {
  it('throws when output path is empty', async () => {
    const spec: OpenApiSpec = {
      openapi: '3.0.3',
      info: { title: 'X', version: '1.0.0' },
      servers: [],
      paths: {},
    };

    await expect(writeOpenApiSpec(spec, '')).rejects.toThrow(
      'Output path is required',
    );
  });
});

// ---------------------------------------------------------------------------
// Operation IDs — detailed
// ---------------------------------------------------------------------------

describe('operation IDs in generated spec', () => {
  it('generates correct operationId', () => {
    const endpoint = makeEndpoint({
      method: 'GET',
      pattern: '/api/users',
    });

    const spec = generateOpenApiSpec([endpoint], DEFAULT_OPTIONS);
    const op = spec.paths['/api/users']['get'];
    expect(op.operationId).toBe('getApiUsers');
  });

  it('generates unique operationIds for different methods', () => {
    const get = makeEndpoint({ method: 'GET' });
    const post = makeEndpoint({ method: 'POST' });

    const spec = generateOpenApiSpec([get, post], DEFAULT_OPTIONS);
    const getOp = spec.paths['/api/users']['get'];
    const postOp = spec.paths['/api/users']['post'];

    expect(getOp.operationId).not.toBe(postOp.operationId);
    expect(getOp.operationId).toBe('getApiUsers');
    expect(postOp.operationId).toBe('postApiUsers');
  });
});

// ---------------------------------------------------------------------------
// Summary
// ---------------------------------------------------------------------------

describe('summary', () => {
  it('generates summary from method and pattern', () => {
    const endpoint = makeEndpoint({
      method: 'GET',
      pattern: '/api/users/:id',
    });

    const spec = generateOpenApiSpec([endpoint], DEFAULT_OPTIONS);
    const op = spec.paths['/api/users/{id}']['get'];
    expect(op.summary).toBe('GET /api/users/:id');
  });
});
