/**
 * Unit tests for src/assembler/api-endpoints.ts
 */

import { describe, it, expect } from 'vitest';
import type { PageVisitResult } from '../../src/types/artifacts.js';
import { buildApiEndpointGroupsFromPages } from '../../src/assembler/api-endpoints.js';

function pv(overrides: Partial<PageVisitResult>): PageVisitResult {
  return {
    url: 'https://example.com/',
    finalUrl: 'https://example.com/',
    status: 'ok',
    httpStatus: 200,
    depth: 0,
    discoveryMethod: 'entry',
    visitedAt: '2026-04-20T00:00:00Z',
    durationMs: 10,
    collectorErrors: [],
    navigationEdges: [],
    ...overrides,
  };
}

function mkRequest(url: string, method: string, reqId: string) {
  return {
    requestId: reqId,
    url,
    method,
    headers: { 'x-trace': reqId },
    resourceType: 'xhr',
    classification: 'api' as const,
    initiator: 'fetch' as const,
  };
}

function mkResponse(reqId: string, statusCode: number, contentType?: string) {
  return {
    requestId: reqId,
    statusCode,
    headers: {},
    contentType,
    bodySize: 10,
    timing: 5,
  };
}

describe('buildApiEndpointGroupsFromPages', () => {
  it('returns empty array when no pages have network logs', () => {
    expect(buildApiEndpointGroupsFromPages([])).toEqual([]);
    expect(buildApiEndpointGroupsFromPages([pv({})])).toEqual([]);
  });

  it('skips non-api classification requests', () => {
    const page = pv({
      networkLog: {
        pageUrl: 'https://a.com/',
        requests: [
          { ...mkRequest('https://a.com/static.css', 'GET', 'r1'), classification: 'static' },
        ],
        responses: [mkResponse('r1', 200)],
        failedRequests: [],
        graphqlOperations: [],
        webSocketConnections: [],
        cookieMutations: [],
      },
    });
    expect(buildApiEndpointGroupsFromPages([page])).toEqual([]);
  });

  it('groups by method + parameterized pattern', () => {
    const page = pv({
      networkLog: {
        pageUrl: 'https://a.com/',
        requests: [
          mkRequest('https://a.com/api/users/1', 'GET', 'r1'),
          mkRequest('https://a.com/api/users/2', 'GET', 'r2'),
          mkRequest('https://a.com/api/users/3', 'POST', 'r3'),
        ],
        responses: [
          mkResponse('r1', 200, 'application/json'),
          mkResponse('r2', 200, 'application/json'),
          mkResponse('r3', 201, 'application/json'),
        ],
        failedRequests: [],
        graphqlOperations: [],
        webSocketConnections: [],
        cookieMutations: [],
      },
    });
    const groups = buildApiEndpointGroupsFromPages([page]);
    expect(groups).toHaveLength(2);
    const getGroup = groups.find(g => g.method === 'GET')!;
    expect(getGroup.pattern).toBe('/api/users/:id');
    expect(getGroup.callCount).toBe(2);
    expect(getGroup.observedStatusCodes).toEqual([200]);
    const postGroup = groups.find(g => g.method === 'POST')!;
    expect(postGroup.callCount).toBe(1);
    expect(postGroup.observedStatusCodes).toEqual([201]);
  });

  it('records calling pages across multiple visits', () => {
    const page1 = pv({
      url: 'https://a.com/p1',
      networkLog: {
        pageUrl: 'https://a.com/p1',
        requests: [mkRequest('https://a.com/api/items', 'GET', 'r1')],
        responses: [mkResponse('r1', 200)],
        failedRequests: [],
        graphqlOperations: [],
        webSocketConnections: [],
        cookieMutations: [],
      },
    });
    const page2 = pv({
      url: 'https://a.com/p2',
      networkLog: {
        pageUrl: 'https://a.com/p2',
        requests: [mkRequest('https://a.com/api/items', 'GET', 'r2')],
        responses: [mkResponse('r2', 200)],
        failedRequests: [],
        graphqlOperations: [],
        webSocketConnections: [],
        cookieMutations: [],
      },
    });
    const [group] = buildApiEndpointGroupsFromPages([page1, page2]);
    expect(group.callingPages.sort()).toEqual(['https://a.com/p1', 'https://a.com/p2']);
  });

  it('folds in graphql operation names', () => {
    const page = pv({
      networkLog: {
        pageUrl: 'https://a.com/',
        requests: [mkRequest('https://a.com/graphql', 'POST', 'r1')],
        responses: [mkResponse('r1', 200, 'application/json')],
        failedRequests: [],
        graphqlOperations: [
          {
            pageUrl: 'https://a.com/',
            endpointUrl: 'https://a.com/graphql',
            operationName: 'GetUsers',
            operationType: 'query',
            query: 'query GetUsers { users { id } }',
          },
        ],
        webSocketConnections: [],
        cookieMutations: [],
      },
    });
    const [group] = buildApiEndpointGroupsFromPages([page]);
    expect(group.isGraphQL).toBe(true);
    expect(group.graphqlOperations).toEqual(['GetUsers']);
  });

  it('handles unparseable request URLs gracefully', () => {
    const page = pv({
      networkLog: {
        pageUrl: 'https://a.com/',
        requests: [mkRequest('::::broken', 'GET', 'r1')],
        responses: [mkResponse('r1', 500)],
        failedRequests: [],
        graphqlOperations: [],
        webSocketConnections: [],
        cookieMutations: [],
      },
    });
    // Should not throw; raw URL is used as pattern.
    const groups = buildApiEndpointGroupsFromPages([page]);
    expect(groups).toHaveLength(1);
  });
});
