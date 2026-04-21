/**
 * Unit tests for src/collectors/network-logger.ts
 *
 * Tests the createNetworkLogger function with mocked Playwright Page objects.
 * Verifies request/response capture, classification, GraphQL detection,
 * header scrubbing, body truncation, and listener cleanup.
 */

import { describe, it, expect, vi } from 'vitest';
import { createNetworkLogger } from '../../src/collectors/network-logger.js';
import type { Page, Request, Response, WebSocket } from 'playwright';

// ---------------------------------------------------------------------------
// Mock helpers
// ---------------------------------------------------------------------------

type EventHandler = (...args: unknown[]) => void;

/**
 * Create a mock Playwright Page with event registration tracking.
 * Callers can fire events by calling the returned `emit` function.
 */
function createMockPage() {
  const listeners = new Map<string, Set<EventHandler>>();

  const page = {
    on: vi.fn((event: string, handler: EventHandler) => {
      if (!listeners.has(event)) {
        listeners.set(event, new Set());
      }
      listeners.get(event)!.add(handler);
    }),
    off: vi.fn((event: string, handler: EventHandler) => {
      listeners.get(event)?.delete(handler);
    }),
  } as unknown as Page;

  function emit(event: string, ...args: unknown[]) {
    const handlers = listeners.get(event);
    if (handlers) {
      for (const handler of handlers) {
        handler(...args);
      }
    }
  }

  function listenerCount(event: string): number {
    return listeners.get(event)?.size ?? 0;
  }

  return { page, emit, listenerCount };
}

/**
 * Create a mock Playwright Request.
 */
function createMockRequest(options: {
  url: string;
  method?: string;
  resourceType?: string;
  headers?: Record<string, string>;
  postData?: string | null;
}): Request {
  return {
    url: () => options.url,
    method: () => options.method ?? 'GET',
    resourceType: () => options.resourceType ?? 'fetch',
    headers: () => options.headers ?? { 'content-type': 'text/html' },
    postData: () => options.postData ?? null,
    failure: () => null,
  } as unknown as Request;
}

/**
 * Create a mock Playwright Response linked to a specific Request mock.
 */
function createMockResponse(options: {
  request: Request;
  status?: number;
  headers?: Record<string, string>;
  body?: string;
}): Response {
  const bodyBuffer = Buffer.from(options.body ?? '');
  return {
    request: () => options.request,
    status: () => options.status ?? 200,
    headers: () => options.headers ?? { 'content-type': 'application/json' },
    body: vi.fn(async () => bodyBuffer),
  } as unknown as Response;
}

/**
 * Create a mock Playwright WebSocket.
 */
function createMockWebSocket(url: string) {
  const wsListeners = new Map<string, Set<EventHandler>>();

  const ws = {
    url: () => url,
    on: vi.fn((event: string, handler: EventHandler) => {
      if (!wsListeners.has(event)) {
        wsListeners.set(event, new Set());
      }
      wsListeners.get(event)!.add(handler);
    }),
  } as unknown as WebSocket;

  function emitWs(event: string, ...args: unknown[]) {
    const handlers = wsListeners.get(event);
    if (handlers) {
      for (const handler of handlers) {
        handler(...args);
      }
    }
  }

  return { ws, emitWs };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('createNetworkLogger', () => {
  const PAGE_URL = 'https://example.com/app';

  // -----------------------------------------------------------------------
  // Basic request/response capture
  // -----------------------------------------------------------------------

  it('captures a basic request/response pair', async () => {
    const { page, emit } = createMockPage();
    const logger = createNetworkLogger(page, PAGE_URL);
    logger.start();

    const request = createMockRequest({
      url: 'https://example.com/api/users',
      method: 'GET',
      resourceType: 'fetch',
      headers: { 'content-type': 'application/json', 'accept': 'application/json' },
    });

    emit('request', request);

    const response = createMockResponse({
      request,
      status: 200,
      headers: { 'content-type': 'application/json' },
      body: '{"users": []}',
    });

    await emit('response', response);
    // Allow the async response handler to complete
    await new Promise(resolve => setTimeout(resolve, 10));

    const result = logger.stop();

    expect(result.requests).toHaveLength(1);
    expect(result.requests[0].url).toBe('https://example.com/api/users');
    expect(result.requests[0].method).toBe('GET');

    expect(result.responses).toHaveLength(1);
    expect(result.responses[0].statusCode).toBe(200);
    expect(result.responses[0].body).toBe('{"users":[]}');
  });

  // -----------------------------------------------------------------------
  // Request classification
  // -----------------------------------------------------------------------

  it('classifies API requests correctly', () => {
    const { page, emit } = createMockPage();
    const logger = createNetworkLogger(page, PAGE_URL);
    logger.start();

    // URL contains /api/
    const req1 = createMockRequest({
      url: 'https://example.com/api/v1/data',
      resourceType: 'fetch',
    });
    emit('request', req1);

    // URL contains /graphql
    const req2 = createMockRequest({
      url: 'https://example.com/graphql',
      method: 'POST',
      resourceType: 'fetch',
      headers: { 'content-type': 'application/json' },
      postData: '{"query": "{ users { id } }"}',
    });
    emit('request', req2);

    // Content-type is application/json (different path)
    const req3 = createMockRequest({
      url: 'https://example.com/data-endpoint',
      resourceType: 'fetch',
      headers: { 'content-type': 'application/json' },
    });
    emit('request', req3);

    const result = logger.stop();

    expect(result.requests[0].classification).toBe('api');
    expect(result.requests[1].classification).toBe('api');
    expect(result.requests[2].classification).toBe('api');
  });

  it('classifies static resources correctly', () => {
    const { page, emit } = createMockPage();
    const logger = createNetworkLogger(page, PAGE_URL);
    logger.start();

    // By resource type
    const imgReq = createMockRequest({
      url: 'https://example.com/logo.png',
      resourceType: 'image',
      headers: {},
    });
    emit('request', imgReq);

    // By file extension
    const cssReq = createMockRequest({
      url: 'https://example.com/styles/main.css',
      resourceType: 'other',
      headers: {},
    });
    emit('request', cssReq);

    // Font by resource type
    const fontReq = createMockRequest({
      url: 'https://example.com/fonts/roboto.woff2',
      resourceType: 'font',
      headers: {},
    });
    emit('request', fontReq);

    const result = logger.stop();

    expect(result.requests[0].classification).toBe('static');
    expect(result.requests[1].classification).toBe('static');
    expect(result.requests[2].classification).toBe('static');
  });

  it('classifies third-party requests by origin', () => {
    const { page, emit } = createMockPage();
    const logger = createNetworkLogger(page, PAGE_URL);
    logger.start();

    const req = createMockRequest({
      url: 'https://cdn.other-site.com/widget',
      resourceType: 'other',
      headers: {},
    });
    emit('request', req);

    const result = logger.stop();

    expect(result.requests[0].classification).toBe('third-party');
  });

  it('classifies analytics requests by domain', () => {
    const { page, emit } = createMockPage();
    const logger = createNetworkLogger(page, PAGE_URL);
    logger.start();

    const req = createMockRequest({
      url: 'https://www.google-analytics.com/collect?v=1',
      resourceType: 'other',
      headers: {},
    });
    emit('request', req);

    const result = logger.stop();

    expect(result.requests[0].classification).toBe('analytics');
  });

  it('classifies same-origin non-api requests as other', () => {
    const { page, emit } = createMockPage();
    const logger = createNetworkLogger(page, PAGE_URL);
    logger.start();

    const req = createMockRequest({
      url: 'https://example.com/some-page',
      resourceType: 'document',
      headers: { 'content-type': 'text/html' },
    });
    emit('request', req);

    const result = logger.stop();

    expect(result.requests[0].classification).toBe('other');
  });

  // -----------------------------------------------------------------------
  // Initiator mapping
  // -----------------------------------------------------------------------

  it('maps resource types to correct initiators', () => {
    const { page, emit } = createMockPage();
    const logger = createNetworkLogger(page, PAGE_URL);
    logger.start();

    const docReq = createMockRequest({ url: 'https://example.com/', resourceType: 'document', headers: {} });
    const scriptReq = createMockRequest({ url: 'https://example.com/app.js', resourceType: 'script', headers: {} });
    const fetchReq = createMockRequest({ url: 'https://example.com/api/data', resourceType: 'fetch', headers: {} });
    const xhrReq = createMockRequest({ url: 'https://example.com/api/old', resourceType: 'xhr', headers: {} });
    const imgReq = createMockRequest({ url: 'https://example.com/img.png', resourceType: 'image', headers: {} });

    emit('request', docReq);
    emit('request', scriptReq);
    emit('request', fetchReq);
    emit('request', xhrReq);
    emit('request', imgReq);

    const result = logger.stop();

    expect(result.requests[0].initiator).toBe('navigation');
    expect(result.requests[1].initiator).toBe('script');
    expect(result.requests[2].initiator).toBe('fetch');
    expect(result.requests[3].initiator).toBe('xhr');
    expect(result.requests[4].initiator).toBe('other');
  });

  // -----------------------------------------------------------------------
  // GraphQL detection
  // -----------------------------------------------------------------------

  it('detects GraphQL operations from POST requests', () => {
    const { page, emit } = createMockPage();
    const logger = createNetworkLogger(page, PAGE_URL);
    logger.start();

    const body = JSON.stringify({
      operationName: 'GetUsers',
      query: 'query GetUsers { users { id name } }',
      variables: { limit: 10 },
    });

    const req = createMockRequest({
      url: 'https://example.com/graphql',
      method: 'POST',
      resourceType: 'fetch',
      headers: { 'content-type': 'application/json' },
      postData: body,
    });

    emit('request', req);

    const result = logger.stop();

    expect(result.graphqlOperations).toHaveLength(1);
    expect(result.graphqlOperations[0].operationName).toBe('GetUsers');
    expect(result.graphqlOperations[0].operationType).toBe('query');
    expect(result.graphqlOperations[0].variables).toEqual({ limit: 10 });
    expect(result.graphqlOperations[0].endpointUrl).toBe('https://example.com/graphql');
    expect(result.graphqlOperations[0].pageUrl).toBe(PAGE_URL);
  });

  it('detects mutation operations in GraphQL', () => {
    const { page, emit } = createMockPage();
    const logger = createNetworkLogger(page, PAGE_URL);
    logger.start();

    const body = JSON.stringify({
      operationName: 'CreateUser',
      query: 'mutation CreateUser($input: UserInput!) { createUser(input: $input) { id } }',
      variables: { input: { name: 'Alice' } },
    });

    const req = createMockRequest({
      url: 'https://example.com/graphql',
      method: 'POST',
      resourceType: 'fetch',
      headers: { 'content-type': 'application/json' },
      postData: body,
    });

    emit('request', req);

    const result = logger.stop();

    expect(result.graphqlOperations[0].operationType).toBe('mutation');
  });

  it('does not detect GraphQL for GET requests', () => {
    const { page, emit } = createMockPage();
    const logger = createNetworkLogger(page, PAGE_URL);
    logger.start();

    const req = createMockRequest({
      url: 'https://example.com/graphql',
      method: 'GET',
      resourceType: 'fetch',
      headers: {},
    });

    emit('request', req);

    const result = logger.stop();

    expect(result.graphqlOperations).toHaveLength(0);
  });

  // -----------------------------------------------------------------------
  // Header scrubbing
  // -----------------------------------------------------------------------

  it('scrubs sensitive headers from captured requests', () => {
    const { page, emit } = createMockPage();
    const logger = createNetworkLogger(page, PAGE_URL);
    logger.start();

    const req = createMockRequest({
      url: 'https://example.com/api/data',
      headers: {
        'authorization': 'Bearer secret-token-123',
        'content-type': 'application/json',
        'x-api-key': 'my-api-key',
        'cookie': 'session=abc123',
      },
    });

    emit('request', req);

    const result = logger.stop();

    expect(result.requests[0].headers['authorization']).toBe('[REDACTED]');
    expect(result.requests[0].headers['x-api-key']).toBe('[REDACTED]');
    expect(result.requests[0].headers['cookie']).toBe('[REDACTED]');
    expect(result.requests[0].headers['content-type']).toBe('application/json');
  });

  it('preserves cookies when includeCookies option is set', () => {
    const { page, emit } = createMockPage();
    const logger = createNetworkLogger(page, PAGE_URL, { includeCookies: true });
    logger.start();

    const req = createMockRequest({
      url: 'https://example.com/api/data',
      headers: {
        'authorization': 'Bearer secret',
        'cookie': 'session=abc123',
      },
    });

    emit('request', req);

    const result = logger.stop();

    expect(result.requests[0].headers['authorization']).toBe('[REDACTED]');
    expect(result.requests[0].headers['cookie']).toBe('session=abc123');
  });

  // -----------------------------------------------------------------------
  // Response body truncation
  // -----------------------------------------------------------------------

  it('truncates large response bodies to 100KB', async () => {
    const { page, emit } = createMockPage();
    const logger = createNetworkLogger(page, PAGE_URL);
    logger.start();

    const request = createMockRequest({
      url: 'https://example.com/api/large',
      resourceType: 'fetch',
      headers: { 'content-type': 'application/json' },
    });

    emit('request', request);

    // Create a body larger than 100KB
    const largeBody = 'x'.repeat(200 * 1024);
    const response = createMockResponse({
      request,
      headers: { 'content-type': 'application/json' },
      body: largeBody,
    });

    emit('response', response);
    await new Promise(resolve => setTimeout(resolve, 10));

    const result = logger.stop();

    expect(result.responses).toHaveLength(1);
    expect(result.responses[0].body!.length).toBe(100 * 1024);
    expect(result.responses[0].bodySize).toBe(200 * 1024);
  });

  // -----------------------------------------------------------------------
  // Failed requests
  // -----------------------------------------------------------------------

  it('captures failed requests with error text', () => {
    const { page, emit } = createMockPage();
    const logger = createNetworkLogger(page, PAGE_URL);
    logger.start();

    const req = {
      url: () => 'https://example.com/api/broken',
      method: () => 'GET',
      resourceType: () => 'fetch',
      headers: () => ({}),
      postData: () => null,
      failure: () => ({ errorText: 'net::ERR_CONNECTION_REFUSED' }),
    } as unknown as Request;

    // First emit as request so it gets an ID
    emit('request', req);
    emit('requestfailed', req);

    const result = logger.stop();

    expect(result.failedRequests).toHaveLength(1);
    expect(result.failedRequests[0].url).toBe('https://example.com/api/broken');
    expect(result.failedRequests[0].errorText).toBe('net::ERR_CONNECTION_REFUSED');
    expect(result.failedRequests[0].classification).toBe('api');
  });

  it('handles requestfailed for requests without prior request event', () => {
    const { page, emit } = createMockPage();
    const logger = createNetworkLogger(page, PAGE_URL);
    logger.start();

    const req = {
      url: () => 'https://example.com/missing',
      method: () => 'GET',
      resourceType: () => 'document',
      headers: () => ({}),
      postData: () => null,
      failure: () => ({ errorText: 'net::ERR_NAME_NOT_RESOLVED' }),
    } as unknown as Request;

    emit('requestfailed', req);

    const result = logger.stop();

    expect(result.failedRequests).toHaveLength(1);
    expect(result.failedRequests[0].errorText).toBe('net::ERR_NAME_NOT_RESOLVED');
  });

  // -----------------------------------------------------------------------
  // Unique request IDs
  // -----------------------------------------------------------------------

  it('generates unique request IDs with req_ prefix', () => {
    const { page, emit } = createMockPage();
    const logger = createNetworkLogger(page, PAGE_URL);
    logger.start();

    const req1 = createMockRequest({ url: 'https://example.com/a', headers: {} });
    const req2 = createMockRequest({ url: 'https://example.com/b', headers: {} });
    const req3 = createMockRequest({ url: 'https://example.com/c', headers: {} });

    emit('request', req1);
    emit('request', req2);
    emit('request', req3);

    const result = logger.stop();

    const ids = result.requests.map(r => r.requestId);
    expect(ids[0]).toBe('req_0');
    expect(ids[1]).toBe('req_1');
    expect(ids[2]).toBe('req_2');

    // All unique
    expect(new Set(ids).size).toBe(3);
  });

  // -----------------------------------------------------------------------
  // stop() removes listeners and returns result
  // -----------------------------------------------------------------------

  it('removes all event listeners on stop', () => {
    const { page, listenerCount } = createMockPage();
    const logger = createNetworkLogger(page, PAGE_URL);
    logger.start();

    expect(listenerCount('request')).toBe(1);
    expect(listenerCount('response')).toBe(1);
    expect(listenerCount('requestfailed')).toBe(1);
    expect(listenerCount('websocket')).toBe(1);

    logger.stop();

    expect(listenerCount('request')).toBe(0);
    expect(listenerCount('response')).toBe(0);
    expect(listenerCount('requestfailed')).toBe(0);
    expect(listenerCount('websocket')).toBe(0);
  });

  it('returns a complete NetworkLogResult on stop', () => {
    const { page } = createMockPage();
    const logger = createNetworkLogger(page, PAGE_URL);
    logger.start();

    const result = logger.stop();

    expect(result.pageUrl).toBe(PAGE_URL);
    expect(result.requests).toEqual([]);
    expect(result.responses).toEqual([]);
    expect(result.failedRequests).toEqual([]);
    expect(result.graphqlOperations).toEqual([]);
    expect(result.webSocketConnections).toEqual([]);
    expect(result.cookieMutations).toEqual([]);
  });

  // -----------------------------------------------------------------------
  // Empty page (no requests)
  // -----------------------------------------------------------------------

  it('handles a page with no requests gracefully', () => {
    const { page } = createMockPage();
    const logger = createNetworkLogger(page, PAGE_URL);
    logger.start();
    const result = logger.stop();

    expect(result.pageUrl).toBe(PAGE_URL);
    expect(result.requests).toHaveLength(0);
    expect(result.responses).toHaveLength(0);
    expect(result.failedRequests).toHaveLength(0);
    expect(result.graphqlOperations).toHaveLength(0);
    expect(result.webSocketConnections).toHaveLength(0);
  });

  // -----------------------------------------------------------------------
  // WebSocket capture
  // -----------------------------------------------------------------------

  it('captures WebSocket connections and sample messages', () => {
    const { page, emit } = createMockPage();
    const logger = createNetworkLogger(page, PAGE_URL);
    logger.start();

    const { ws, emitWs } = createMockWebSocket('wss://example.com/ws');
    emit('websocket', ws);

    // Send some messages
    emitWs('framesent', { payload: 'hello server' });
    emitWs('framereceived', { payload: 'hello client' });
    emitWs('framesent', { payload: 'ping' });
    emitWs('framereceived', { payload: 'pong' });

    const result = logger.stop();

    expect(result.webSocketConnections).toHaveLength(1);
    expect(result.webSocketConnections[0].url).toBe('wss://example.com/ws');
    expect(result.webSocketConnections[0].pageUrl).toBe(PAGE_URL);
    expect(result.webSocketConnections[0].connected).toBe(true);
    expect(result.webSocketConnections[0].messageCount).toBe(4);
    expect(result.webSocketConnections[0].sampleMessages).toHaveLength(4);

    const sent = result.webSocketConnections[0].sampleMessages.filter(m => m.direction === 'sent');
    const received = result.webSocketConnections[0].sampleMessages.filter(m => m.direction === 'received');
    expect(sent).toHaveLength(2);
    expect(received).toHaveLength(2);
    expect(sent[0].data).toBe('hello server');
    expect(received[0].data).toBe('hello client');
  });

  it('limits WebSocket sample messages to 5 per direction', () => {
    const { page, emit } = createMockPage();
    const logger = createNetworkLogger(page, PAGE_URL);
    logger.start();

    const { ws, emitWs } = createMockWebSocket('wss://example.com/ws');
    emit('websocket', ws);

    // Send 10 messages in each direction
    for (let i = 0; i < 10; i++) {
      emitWs('framesent', { payload: `sent-${i}` });
      emitWs('framereceived', { payload: `received-${i}` });
    }

    const result = logger.stop();
    const conn = result.webSocketConnections[0];

    expect(conn.messageCount).toBe(20);

    const sent = conn.sampleMessages.filter(m => m.direction === 'sent');
    const received = conn.sampleMessages.filter(m => m.direction === 'received');
    expect(sent).toHaveLength(5);
    expect(received).toHaveLength(5);
  });

  it('marks WebSocket as disconnected on close', () => {
    const { page, emit } = createMockPage();
    const logger = createNetworkLogger(page, PAGE_URL);
    logger.start();

    const { ws, emitWs } = createMockWebSocket('wss://example.com/ws');
    emit('websocket', ws);

    expect(logger.stop().webSocketConnections[0].connected).toBe(true);

    // Restart to test close
    const logger2 = createNetworkLogger(page, PAGE_URL);
    logger2.start();

    const { ws: ws2, emitWs: emitWs2 } = createMockWebSocket('wss://example.com/ws2');
    emit('websocket', ws2);
    emitWs2('close');

    const result = logger2.stop();
    expect(result.webSocketConnections[0].connected).toBe(false);
  });

  // -----------------------------------------------------------------------
  // Response body capture
  // -----------------------------------------------------------------------

  it('does not capture body for non-text content types', async () => {
    const { page, emit } = createMockPage();
    const logger = createNetworkLogger(page, PAGE_URL);
    logger.start();

    const request = createMockRequest({
      url: 'https://example.com/image.png',
      resourceType: 'image',
      headers: {},
    });

    emit('request', request);

    const response = createMockResponse({
      request,
      headers: { 'content-type': 'image/png' },
      body: 'binary-data',
    });

    emit('response', response);
    await new Promise(resolve => setTimeout(resolve, 10));

    const result = logger.stop();

    expect(result.responses).toHaveLength(1);
    expect(result.responses[0].body).toBeUndefined();
  });

  // -----------------------------------------------------------------------
  // Content type and body on request
  // -----------------------------------------------------------------------

  it('captures request body and content type for POST requests', () => {
    const { page, emit } = createMockPage();
    const logger = createNetworkLogger(page, PAGE_URL);
    logger.start();

    const req = createMockRequest({
      url: 'https://example.com/api/submit',
      method: 'POST',
      resourceType: 'fetch',
      headers: { 'content-type': 'application/json' },
      postData: '{"name":"Alice"}',
    });

    emit('request', req);

    const result = logger.stop();

    expect(result.requests[0].body).toBe('{"name":"Alice"}');
    expect(result.requests[0].contentType).toBe('application/json');
  });

  it('omits body and contentType when not present', () => {
    const { page, emit } = createMockPage();
    const logger = createNetworkLogger(page, PAGE_URL);
    logger.start();

    const req = createMockRequest({
      url: 'https://example.com/page',
      resourceType: 'document',
      headers: {},
    });

    emit('request', req);

    const result = logger.stop();

    expect(result.requests[0].body).toBeUndefined();
    expect(result.requests[0].contentType).toBeUndefined();
  });

  // -----------------------------------------------------------------------
  // Response timing
  // -----------------------------------------------------------------------

  it('records response timing in milliseconds', async () => {
    const { page, emit } = createMockPage();
    const logger = createNetworkLogger(page, PAGE_URL);
    logger.start();

    const request = createMockRequest({
      url: 'https://example.com/api/data',
      resourceType: 'fetch',
      headers: { 'content-type': 'application/json' },
    });

    emit('request', request);

    // Small delay to ensure timing > 0
    await new Promise(resolve => setTimeout(resolve, 5));

    const response = createMockResponse({
      request,
      headers: { 'content-type': 'application/json' },
      body: '{}',
    });

    emit('response', response);
    await new Promise(resolve => setTimeout(resolve, 10));

    const result = logger.stop();

    expect(result.responses[0].timing).toBeGreaterThanOrEqual(0);
  });

  // -----------------------------------------------------------------------
  // Scrubs response headers too
  // -----------------------------------------------------------------------

  it('scrubs sensitive response headers', async () => {
    const { page, emit } = createMockPage();
    const logger = createNetworkLogger(page, PAGE_URL);
    logger.start();

    const request = createMockRequest({
      url: 'https://example.com/api/data',
      resourceType: 'fetch',
      headers: { 'content-type': 'application/json' },
    });

    emit('request', request);

    const response = createMockResponse({
      request,
      headers: {
        'content-type': 'application/json',
        'set-cookie': 'session=secret; Path=/',
        'x-api-key': 'server-key-123',
      },
      body: '{}',
    });

    emit('response', response);
    await new Promise(resolve => setTimeout(resolve, 10));

    const result = logger.stop();

    expect(result.responses[0].headers['set-cookie']).toBe('[REDACTED]');
    expect(result.responses[0].headers['x-api-key']).toBe('[REDACTED]');
    expect(result.responses[0].headers['content-type']).toBe('application/json');
  });

  // -----------------------------------------------------------------------
  // Response body gating by classification
  //
  // Performance: the body() IPC round-trip is the single most expensive
  // operation in the response handler. We must skip it entirely for static
  // assets, analytics, and WebSocket classifications — never just skip the
  // buffer-to-text decode. Asset-heavy pages can have 100+ static requests;
  // that many IPC round-trips is the hot path we are killing here.
  // -----------------------------------------------------------------------

  describe('response body gating by classification', () => {
    it('skips body() IPC for static assets (images, fonts, CSS)', async () => {
      const { page, emit } = createMockPage();
      const logger = createNetworkLogger(page, PAGE_URL);
      logger.start();

      const request = createMockRequest({
        url: 'https://example.com/logo.png',
        resourceType: 'image',
        headers: {},
      });
      emit('request', request);

      const response = createMockResponse({
        request,
        headers: { 'content-type': 'image/png' },
        body: 'binary-png-data',
      });
      emit('response', response);
      await new Promise(resolve => setTimeout(resolve, 10));

      const result = logger.stop();

      // Body must NOT have been fetched — static classification short-circuits.
      expect(response.body).not.toHaveBeenCalled();
      // Classification recorded, but no body captured.
      expect(result.requests[0].classification).toBe('static');
      expect(result.responses[0].body).toBeUndefined();
    });

    it('skips body() IPC for analytics requests', async () => {
      const { page, emit } = createMockPage();
      const logger = createNetworkLogger(page, PAGE_URL);
      logger.start();

      const request = createMockRequest({
        url: 'https://www.google-analytics.com/collect?v=1',
        resourceType: 'other',
        headers: {},
      });
      emit('request', request);

      const response = createMockResponse({
        request,
        headers: { 'content-type': 'application/json' },
        body: '{"track":true}',
      });
      emit('response', response);
      await new Promise(resolve => setTimeout(resolve, 10));

      const result = logger.stop();

      expect(response.body).not.toHaveBeenCalled();
      expect(result.requests[0].classification).toBe('analytics');
      expect(result.responses[0].body).toBeUndefined();
    });

    it('always captures body for API requests', async () => {
      const { page, emit } = createMockPage();
      const logger = createNetworkLogger(page, PAGE_URL);
      logger.start();

      const request = createMockRequest({
        url: 'https://example.com/api/users',
        resourceType: 'fetch',
        headers: {},
      });
      emit('request', request);

      const response = createMockResponse({
        request,
        headers: { 'content-type': 'application/json' },
        body: '{"id":1}',
      });
      emit('response', response);
      await new Promise(resolve => setTimeout(resolve, 10));

      const result = logger.stop();

      expect(response.body).toHaveBeenCalled();
      expect(result.requests[0].classification).toBe('api');
      expect(result.responses[0].body).toBe('{"id":1}');
    });

    it('captures body for same-origin HTML documents (classified as "other")', async () => {
      const { page, emit } = createMockPage();
      const logger = createNetworkLogger(page, PAGE_URL);
      logger.start();

      const request = createMockRequest({
        url: 'https://example.com/page',
        resourceType: 'document',
        headers: {},
      });
      emit('request', request);

      const response = createMockResponse({
        request,
        headers: { 'content-type': 'text/html' },
        body: '<html></html>',
      });
      emit('response', response);
      await new Promise(resolve => setTimeout(resolve, 10));

      const result = logger.stop();

      expect(response.body).toHaveBeenCalled();
      expect(result.responses[0].body).toBe('<html></html>');
    });

    it('still reports bodySize=0 for skipped bodies (no IPC, no size)', async () => {
      const { page, emit } = createMockPage();
      const logger = createNetworkLogger(page, PAGE_URL);
      logger.start();

      const request = createMockRequest({
        url: 'https://example.com/assets/bg.jpg',
        resourceType: 'image',
        headers: {},
      });
      emit('request', request);

      const response = createMockResponse({
        request,
        headers: { 'content-type': 'image/jpeg' },
        body: 'abc',
      });
      emit('response', response);
      await new Promise(resolve => setTimeout(resolve, 10));

      const result = logger.stop();
      // Body read was skipped so we cannot report a real size; zero is fine
      // for the static-asset case where we never needed the body anyway.
      expect(result.responses[0].bodySize).toBe(0);
    });
  });
});
