/**
 * NetworkLogger collector — captures all network activity on a page.
 *
 * Attaches to Playwright Page events to record:
 *   - HTTP requests and responses (with header scrubbing)
 *   - Failed requests (network errors, CORS, timeouts)
 *   - GraphQL operations (detected from POST to /graphql endpoints)
 *   - WebSocket connections and sample messages
 *
 * Usage:
 *   const logger = createNetworkLogger(page, pageUrl);
 *   logger.start();
 *   // ... navigate, interact ...
 *   const result = logger.stop();
 */

import type { Page, Request, Response, WebSocket } from 'playwright';
import type {
  NetworkLogResult,
  CapturedRequest,
  CapturedResponse,
  FailedRequest,
  GraphQLOperation,
  WebSocketConnection,
  RequestClassification,
} from '../types/artifacts.js';
import { scrubHeaders } from '../security/credential-scrubber.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Maximum response body size to capture (100 KB). */
const MAX_BODY_SIZE = 100 * 1024;

/** Maximum sample messages per direction for WebSocket connections. */
const MAX_WS_MESSAGES_PER_DIRECTION = 5;

/** Known analytics domains (partial match against hostname). */
const ANALYTICS_DOMAINS = [
  'google-analytics.com',
  'googletagmanager.com',
  'analytics.google.com',
  'segment.io',
  'segment.com',
  'cdn.segment.com',
  'api.segment.io',
  'mixpanel.com',
  'hotjar.com',
  'fullstory.com',
  'heap.io',
  'heapanalytics.com',
  'amplitude.com',
  'plausible.io',
  'clarity.ms',
  'newrelic.com',
  'nr-data.net',
  'sentry.io',
  'datadog',
  'pendo.io',
];

/** Static resource file extensions. */
const STATIC_EXTENSIONS = new Set([
  '.css', '.js', '.png', '.jpg', '.jpeg', '.gif', '.svg',
  '.woff', '.woff2', '.ttf', '.eot', '.otf',
  '.ico', '.webp', '.avif', '.mp4', '.webm', '.mp3',
  '.ogg', '.wav', '.map',
]);

/** Playwright resource types considered static. */
const STATIC_RESOURCE_TYPES = new Set([
  'stylesheet', 'image', 'font', 'media',
]);

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface NetworkLoggerOptions {
  includeCookies?: boolean;
}

export interface NetworkLogger {
  start(): void;
  stop(): NetworkLogResult;
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Create a NetworkLogger that captures all network activity on a page.
 *
 * @param page     Playwright Page to attach listeners to.
 * @param pageUrl  The page URL (used for origin comparison and GraphQL context).
 * @param options  Optional configuration (e.g. whether to include cookies).
 */
export function createNetworkLogger(
  page: Page,
  pageUrl: string,
  options?: NetworkLoggerOptions,
): NetworkLogger {
  const includeCookies = options?.includeCookies ?? false;

  // Internal state
  let counter = 0;
  const requestIdMap = new Map<Request, string>();
  const requestTimings = new Map<string, number>();
  const requests: CapturedRequest[] = [];
  const responses: CapturedResponse[] = [];
  const failedRequests: FailedRequest[] = [];
  const graphqlOperations: GraphQLOperation[] = [];
  const webSocketConnections: WebSocketConnection[] = [];

  // Parse the page origin for third-party classification
  let pageOrigin = '';
  try {
    pageOrigin = new URL(pageUrl).origin;
  } catch {
    // Invalid pageUrl — all requests will be classified as 'other'
  }

  // -----------------------------------------------------------------------
  // Classification helpers
  // -----------------------------------------------------------------------

  function classifyRequest(url: string, resourceType: string, contentType?: string): RequestClassification {
    if (resourceType === 'websocket') {
      return 'websocket';
    }

    // Check analytics domains
    try {
      const hostname = new URL(url).hostname;
      for (const domain of ANALYTICS_DOMAINS) {
        if (hostname.includes(domain)) {
          return 'analytics';
        }
      }
    } catch {
      // Invalid URL — fall through
    }

    // Check API patterns
    if (
      url.includes('/api/') ||
      url.includes('/graphql') ||
      (contentType && contentType.includes('application/json'))
    ) {
      return 'api';
    }

    // Check static resources
    if (STATIC_RESOURCE_TYPES.has(resourceType)) {
      return 'static';
    }

    // Check static file extensions
    try {
      const pathname = new URL(url).pathname;
      const dotIndex = pathname.lastIndexOf('.');
      if (dotIndex !== -1) {
        const ext = pathname.slice(dotIndex).toLowerCase();
        if (STATIC_EXTENSIONS.has(ext)) {
          return 'static';
        }
      }
    } catch {
      // Invalid URL — fall through
    }

    // Check third-party (different origin)
    if (pageOrigin) {
      try {
        const requestOrigin = new URL(url).origin;
        if (requestOrigin !== pageOrigin) {
          return 'third-party';
        }
      } catch {
        // Invalid URL — fall through
      }
    }

    return 'other';
  }

  function mapInitiator(resourceType: string): CapturedRequest['initiator'] {
    switch (resourceType) {
      case 'document':
        return 'navigation';
      case 'script':
      case 'stylesheet':
        return 'script';
      case 'fetch':
        return 'fetch';
      case 'xhr':
        return 'xhr';
      default:
        return 'other';
    }
  }

  // -----------------------------------------------------------------------
  // GraphQL detection
  // -----------------------------------------------------------------------

  function tryDetectGraphQL(
    request: Request,
    requestId: string,
    url: string,
    body: string | undefined,
  ): void {
    if (request.method() !== 'POST') return;
    if (!url.includes('graphql')) return;
    if (!body) return;

    try {
      const parsed = JSON.parse(body);
      const operationName = parsed.operationName ?? 'unknown';
      const query: string = parsed.query ?? '';
      const variables = parsed.variables;

      // Determine operation type from query string
      let operationType: GraphQLOperation['operationType'] = 'query';
      const trimmedQuery = query.trimStart();
      if (trimmedQuery.startsWith('mutation')) {
        operationType = 'mutation';
      } else if (trimmedQuery.startsWith('subscription')) {
        operationType = 'subscription';
      }

      const op: GraphQLOperation = {
        pageUrl,
        endpointUrl: url,
        operationName,
        operationType,
        query,
      };

      if (variables !== undefined && variables !== null) {
        op.variables = variables;
      }

      graphqlOperations.push(op);
    } catch {
      // Body is not valid JSON — skip GraphQL detection
    }
  }

  // -----------------------------------------------------------------------
  // Event handlers (stored as named functions for removal)
  // -----------------------------------------------------------------------

  function onRequest(request: Request): void {
    const id = `req_${counter++}`;
    requestIdMap.set(request, id);
    requestTimings.set(id, Date.now());

    const url = request.url();
    const resourceType = request.resourceType();
    const method = request.method();
    const rawHeaders = request.headers();
    const postData = request.postData() ?? undefined;
    const contentType = rawHeaders['content-type'] ?? undefined;

    const classification = classifyRequest(url, resourceType, contentType);
    const initiator = mapInitiator(resourceType);

    const captured: CapturedRequest = {
      requestId: id,
      url,
      method,
      headers: scrubHeaders(rawHeaders, { includeCookies }),
      resourceType,
      classification,
      initiator,
    };

    if (postData !== undefined) {
      captured.body = postData;
    }
    if (contentType !== undefined) {
      captured.contentType = contentType;
    }

    requests.push(captured);

    // GraphQL detection
    tryDetectGraphQL(request, id, url, postData);
  }

  async function onResponse(response: Response): Promise<void> {
    const request = response.request();
    const id = requestIdMap.get(request);
    if (!id) return;

    const startTime = requestTimings.get(id) ?? Date.now();
    const timing = Date.now() - startTime;

    const rawHeaders = response.headers();
    const statusCode = response.status();
    const contentType = rawHeaders['content-type'] ?? undefined;

    // Attempt to capture body for text-based responses
    let body: string | undefined;
    let bodySize = 0;

    try {
      const buffer = await response.body();
      bodySize = buffer.length;

      // Only capture text-based content types
      if (contentType && isTextContentType(contentType)) {
        const text = buffer.toString('utf-8');
        body = text.length > MAX_BODY_SIZE ? text.slice(0, MAX_BODY_SIZE) : text;
      }
    } catch {
      // Body may not be available (e.g. redirects, streaming)
    }

    const captured: CapturedResponse = {
      requestId: id,
      statusCode,
      headers: scrubHeaders(rawHeaders, { includeCookies }),
      bodySize,
      timing,
    };

    if (body !== undefined) {
      captured.body = body;
    }
    if (contentType !== undefined) {
      captured.contentType = contentType;
    }

    responses.push(captured);

    // Attach response data to GraphQL operations
    if (body) {
      const gqlOp = graphqlOperations.find(op => {
        // Match by the request that produced this response
        const matchingReq = requests.find(r => r.requestId === id);
        return matchingReq && op.endpointUrl === matchingReq.url;
      });
      if (gqlOp && gqlOp.responseData === undefined) {
        try {
          gqlOp.responseData = JSON.parse(body);
        } catch {
          // Non-JSON response
        }
      }
    }
  }

  function onRequestFailed(request: Request): void {
    const id = requestIdMap.get(request) ?? `req_${counter++}`;
    const url = request.url();
    const method = request.method();
    const resourceType = request.resourceType();
    const classification = classifyRequest(url, resourceType);

    const failure = request.failure();
    const errorText = failure?.errorText ?? 'Unknown error';

    failedRequests.push({
      requestId: id,
      url,
      method,
      errorText,
      classification,
    });
  }

  function onWebSocket(ws: WebSocket): void {
    const wsUrl = ws.url();
    let sentCount = 0;
    let receivedCount = 0;

    const connection: WebSocketConnection = {
      url: wsUrl,
      pageUrl,
      connected: true,
      messageCount: 0,
      sampleMessages: [],
    };

    webSocketConnections.push(connection);

    ws.on('framereceived', (data: { payload: string | Buffer }) => {
      connection.messageCount++;
      if (receivedCount < MAX_WS_MESSAGES_PER_DIRECTION) {
        receivedCount++;
        connection.sampleMessages.push({
          direction: 'received',
          data: typeof data.payload === 'string' ? data.payload : data.payload.toString('utf-8'),
          timestamp: new Date().toISOString(),
        });
      }
    });

    ws.on('framesent', (data: { payload: string | Buffer }) => {
      connection.messageCount++;
      if (sentCount < MAX_WS_MESSAGES_PER_DIRECTION) {
        sentCount++;
        connection.sampleMessages.push({
          direction: 'sent',
          data: typeof data.payload === 'string' ? data.payload : data.payload.toString('utf-8'),
          timestamp: new Date().toISOString(),
        });
      }
    });

    ws.on('close', () => {
      connection.connected = false;
    });
  }

  // -----------------------------------------------------------------------
  // Public interface
  // -----------------------------------------------------------------------

  return {
    start(): void {
      page.on('request', onRequest);
      page.on('response', onResponse);
      page.on('requestfailed', onRequestFailed);
      page.on('websocket', onWebSocket);
    },

    stop(): NetworkLogResult {
      page.off('request', onRequest);
      page.off('response', onResponse);
      page.off('requestfailed', onRequestFailed);
      page.off('websocket', onWebSocket);

      return {
        pageUrl,
        requests,
        responses,
        failedRequests,
        graphqlOperations,
        webSocketConnections,
        cookieMutations: [],
      };
    },
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Determine if a content-type is text-based and worth capturing the body.
 */
function isTextContentType(contentType: string): boolean {
  const lower = contentType.toLowerCase();
  return (
    lower.includes('text/') ||
    lower.includes('application/json') ||
    lower.includes('application/xml') ||
    lower.includes('application/javascript') ||
    lower.includes('application/xhtml') ||
    lower.includes('application/graphql') ||
    lower.includes('+json') ||
    lower.includes('+xml')
  );
}
