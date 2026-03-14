/**
 * Unit tests for src/assembler/api-grouper.ts
 *
 * API endpoint grouping: numeric ID detection, UUID detection,
 * slug detection, mixed segments, query parameter grouping,
 * HTTP method handling, and GraphQL operation grouping.
 */

import { describe, it, expect } from 'vitest';
import {
  isNumericId,
  isUuid,
  isSlug,
  parameterizePath,
  groupEndpoints,
  groupGraphQLOperations,
  type ApiEndpoint,
} from '../../src/assembler/api-grouper.js';

// ---------------------------------------------------------------------------
// isNumericId
// ---------------------------------------------------------------------------

describe('isNumericId', () => {
  it('detects simple integer', () => {
    expect(isNumericId('123')).toBe(true);
  });

  it('detects single digit', () => {
    expect(isNumericId('0')).toBe(true);
  });

  it('detects large number', () => {
    expect(isNumericId('9999999999')).toBe(true);
  });

  it('rejects non-numeric string', () => {
    expect(isNumericId('abc')).toBe(false);
  });

  it('rejects mixed alphanumeric', () => {
    expect(isNumericId('123abc')).toBe(false);
  });

  it('rejects empty string', () => {
    expect(isNumericId('')).toBe(false);
  });

  it('rejects version-like segments (v2)', () => {
    expect(isNumericId('v2')).toBe(false);
  });

  it('rejects floating point', () => {
    expect(isNumericId('3.14')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// isUuid
// ---------------------------------------------------------------------------

describe('isUuid', () => {
  it('detects standard UUID v4', () => {
    expect(isUuid('550e8400-e29b-41d4-a716-446655440000')).toBe(true);
  });

  it('detects uppercase UUID', () => {
    expect(isUuid('550E8400-E29B-41D4-A716-446655440000')).toBe(true);
  });

  it('detects UUID without hyphens', () => {
    // Some APIs use UUIDs without hyphens
    expect(isUuid('550e8400e29b41d4a716446655440000')).toBe(true);
  });

  it('rejects short hex string', () => {
    expect(isUuid('550e8400')).toBe(false);
  });

  it('rejects random string', () => {
    expect(isUuid('not-a-uuid-at-all')).toBe(false);
  });

  it('rejects empty string', () => {
    expect(isUuid('')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// isSlug
// ---------------------------------------------------------------------------

describe('isSlug', () => {
  it('detects hyphenated slug', () => {
    expect(isSlug('hello-world')).toBe(true);
  });

  it('detects multi-word slug', () => {
    expect(isSlug('my-first-blog-post')).toBe(true);
  });

  it('rejects single word without hyphens (could be a static segment)', () => {
    // "users" is a static path, not a slug
    expect(isSlug('users')).toBe(false);
  });

  it('rejects numeric-only string', () => {
    expect(isSlug('12345')).toBe(false);
  });

  it('detects slug with numbers', () => {
    expect(isSlug('post-123-title')).toBe(true);
  });

  it('rejects empty string', () => {
    expect(isSlug('')).toBe(false);
  });

  it('rejects UUID (handled by isUuid instead)', () => {
    expect(isSlug('550e8400-e29b-41d4-a716-446655440000')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// parameterizePath
// ---------------------------------------------------------------------------

describe('parameterizePath', () => {
  it('replaces numeric IDs with :id', () => {
    expect(parameterizePath('/users/123')).toBe('/users/:id');
  });

  it('replaces UUIDs with :id', () => {
    expect(
      parameterizePath('/items/550e8400-e29b-41d4-a716-446655440000')
    ).toBe('/items/:id');
  });

  it('replaces slugs with :slug', () => {
    expect(parameterizePath('/posts/hello-world')).toBe('/posts/:slug');
  });

  it('handles mixed dynamic segments', () => {
    expect(parameterizePath('/api/v2/users/123/posts/456')).toBe(
      '/api/v2/users/:id/posts/:id'
    );
  });

  it('preserves static segments', () => {
    expect(parameterizePath('/api/v2/health')).toBe('/api/v2/health');
  });

  it('preserves root path', () => {
    expect(parameterizePath('/')).toBe('/');
  });

  it('handles complex real-world paths', () => {
    const result = parameterizePath(
      '/api/v1/organizations/42/teams/7/members'
    );
    expect(result).toBe('/api/v1/organizations/:id/teams/:id/members');
  });

  it('does not replace version-like segments', () => {
    expect(parameterizePath('/api/v2/users')).toBe('/api/v2/users');
  });
});

// ---------------------------------------------------------------------------
// groupEndpoints
// ---------------------------------------------------------------------------

describe('groupEndpoints', () => {
  it('groups endpoints by parameterized pattern + method', () => {
    const endpoints: ApiEndpoint[] = [
      { method: 'GET', url: '/api/users/1', statusCode: 200 },
      { method: 'GET', url: '/api/users/2', statusCode: 200 },
      { method: 'GET', url: '/api/users/3', statusCode: 200 },
    ];

    const groups = groupEndpoints(endpoints);
    expect(groups).toHaveLength(1);
    expect(groups[0].pattern).toBe('/api/users/:id');
    expect(groups[0].method).toBe('GET');
    expect(groups[0].examples).toHaveLength(3);
  });

  it('separates different HTTP methods on the same path', () => {
    const endpoints: ApiEndpoint[] = [
      { method: 'GET', url: '/api/users/1' },
      { method: 'PUT', url: '/api/users/1' },
      { method: 'DELETE', url: '/api/users/1' },
    ];

    const groups = groupEndpoints(endpoints);
    expect(groups).toHaveLength(3);

    const methods = groups.map((g) => g.method).sort();
    expect(methods).toEqual(['DELETE', 'GET', 'PUT']);
  });

  it('keeps distinct patterns separate', () => {
    const endpoints: ApiEndpoint[] = [
      { method: 'GET', url: '/api/users/1' },
      { method: 'GET', url: '/api/posts/1' },
    ];

    const groups = groupEndpoints(endpoints);
    expect(groups).toHaveLength(2);

    const patterns = groups.map((g) => g.pattern).sort();
    expect(patterns).toEqual(['/api/posts/:id', '/api/users/:id']);
  });

  it('handles endpoints without dynamic segments', () => {
    const endpoints: ApiEndpoint[] = [
      { method: 'GET', url: '/api/health' },
      { method: 'GET', url: '/api/health' },
    ];

    const groups = groupEndpoints(endpoints);
    expect(groups).toHaveLength(1);
    expect(groups[0].pattern).toBe('/api/health');
  });

  it('handles empty endpoint list', () => {
    expect(groupEndpoints([])).toEqual([]);
  });

  it('groups slug-based URLs', () => {
    const endpoints: ApiEndpoint[] = [
      { method: 'GET', url: '/blog/first-post' },
      { method: 'GET', url: '/blog/second-post' },
      { method: 'GET', url: '/blog/another-article' },
    ];

    const groups = groupEndpoints(endpoints);
    expect(groups).toHaveLength(1);
    expect(groups[0].pattern).toBe('/blog/:slug');
  });

  it('groups UUID-based URLs', () => {
    const endpoints: ApiEndpoint[] = [
      {
        method: 'GET',
        url: '/items/550e8400-e29b-41d4-a716-446655440000',
      },
      {
        method: 'GET',
        url: '/items/6ba7b810-9dad-11d1-80b4-00c04fd430c8',
      },
    ];

    const groups = groupEndpoints(endpoints);
    expect(groups).toHaveLength(1);
    expect(groups[0].pattern).toBe('/items/:id');
  });
});

// ---------------------------------------------------------------------------
// Query parameter grouping
// ---------------------------------------------------------------------------

describe('query parameter grouping', () => {
  it('groups URLs with different query parameters', () => {
    const endpoints: ApiEndpoint[] = [
      { method: 'GET', url: '/api/search?q=foo&page=1' },
      { method: 'GET', url: '/api/search?q=bar&page=2' },
    ];

    const groups = groupEndpoints(endpoints);
    expect(groups).toHaveLength(1);
    expect(groups[0].pattern).toBe('/api/search');
  });
});

// ---------------------------------------------------------------------------
// GraphQL operation grouping
// ---------------------------------------------------------------------------

describe('groupGraphQLOperations', () => {
  it('groups by operation name extracted from request body', () => {
    const endpoints: ApiEndpoint[] = [
      {
        method: 'POST',
        url: '/graphql',
        requestBody: {
          query: 'query GetUser($id: ID!) { user(id: $id) { name } }',
          operationName: 'GetUser',
          variables: { id: '1' },
        },
      },
      {
        method: 'POST',
        url: '/graphql',
        requestBody: {
          query: 'query GetUser($id: ID!) { user(id: $id) { name } }',
          operationName: 'GetUser',
          variables: { id: '2' },
        },
      },
      {
        method: 'POST',
        url: '/graphql',
        requestBody: {
          query: 'mutation UpdateUser($id: ID!) { updateUser(id: $id) { ok } }',
          operationName: 'UpdateUser',
          variables: { id: '1' },
        },
      },
    ];

    const groups = groupGraphQLOperations(endpoints);

    expect(groups.size).toBe(2);
    expect(groups.has('GetUser')).toBe(true);
    expect(groups.has('UpdateUser')).toBe(true);
    expect(groups.get('GetUser')!).toHaveLength(2);
    expect(groups.get('UpdateUser')!).toHaveLength(1);
  });

  it('handles endpoints without operationName', () => {
    const endpoints: ApiEndpoint[] = [
      {
        method: 'POST',
        url: '/graphql',
        requestBody: {
          query: '{ viewer { name } }',
        },
      },
    ];

    const groups = groupGraphQLOperations(endpoints);
    // Should be grouped under a fallback key like "anonymous" or "unknown"
    expect(groups.size).toBe(1);
  });

  it('returns empty map for non-GraphQL endpoints', () => {
    const endpoints: ApiEndpoint[] = [
      { method: 'GET', url: '/api/users' },
    ];

    const groups = groupGraphQLOperations(endpoints);
    expect(groups.size).toBe(0);
  });
});
