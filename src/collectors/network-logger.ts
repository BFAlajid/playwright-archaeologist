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
import {
  scrubHeaders,
  scrubBody,
  scrubJsonObject,
} from '../security/credential-scrubber.js';

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
  /**
   * Capture JavaScript response bodies. Off by default — raw JS bundles
   * frequently contain hardcoded API keys, tokens, and feature-flag
   * secrets that the credential scrubber cannot reliably detect.
   */
  captureJsBodies?: boolean;
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
  const captureJsBodies = options?.captureJsBodies ?? false;

  // Internal state
  let counter = 0;
  const requestIdMap = new Map<Request, string>();
  const requestTimings = new Map<string, number>();
  const requests: CapturedRequest[] = [];
  const responses: CapturedResponse[] = [];
  const failedRequests: FailedRequest[] = [];
  const graphqlOperations: GraphQLOperation[] = [];
  const webSocketConnections: WebSocketConnection[] = [];
  /**
   * Per-request classification for O(1) lookup in the response handler.
   * Used to gate the expensive `response.body()` IPC for static/analytics
   * responses that we never want to capture body text for.
   */
  const requestClassifications = new Map<string, RequestClassification>();
  /**
   * Index of GraphQL operations keyed by their originating request id.
   * Replaces the O(Gql × Req) scan that previously matched operations
   * back to responses.
   */
  const gqlOpsByRequestId = new Map<string, GraphQLOperation>();

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
      const rawQuery: string = parsed.query ?? '';
      const rawVariables = parsed.variables;

      // Determine operation type from the raw query string (scrubbing the
      // query text below can replace mutation/subscription keywords that
      // happen to appear inside argument values).
      let operationType: GraphQLOperation['operationType'] = 'query';
      const trimmedQuery = rawQuery.trimStart();
      if (trimmedQuery.startsWith('mutation')) {
        operationType = 'mutation';
      } else if (trimmedQuery.startsWith('subscription')) {
        operationType = 'subscription';
      }

      // Scrub inline argument-style secrets embedded in the query text, e.g.
      // `mutation { login(email: "x", password: "hunter2") { ... } }`.
      const query = rawQuery.replace(
        /\b(password|passwd|secret|client_secret|token|access_token|refresh_token|api_key|apikey|aws_access_key|aws_secret_key)\s*:\s*("(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|[^,)\s]+)/gi,
        '$1: "[REDACTED]"',
      );

      const op: GraphQLOperation = {
        pageUrl,
        endpointUrl: url,
        operationName,
        operationType,
        query,
      };

      if (rawVariables !== undefined && rawVariables !== null) {
        // Variables frequently contain passwords, API keys, and session
        // tokens. Route them through the same JSON scrubber we use on
        // request/response bodies so sensitive fields are redacted before
        // we store them in the network log.
        op.variables =
          typeof rawVariables === 'object'
            ? scrubJsonObject(rawVariables)
            : rawVariables;
      }

      graphqlOperations.push(op);
      // Index by requestId so the response handler can find the matching
      // operation in O(1) instead of scanning every op per response.
      gqlOpsByRequestId.set(requestId, op);
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

    // Record classification for O(1) lookup during response handling.
    requestClassifications.set(id, classification);

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
      captured.body = scrubBody(postData);
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

    // Determine this response's classification by looking up the matching
    // request. Classification was already computed when the request fired;
    // we reuse it here to gate the expensive `response.body()` IPC round-trip.
    const matchingReqClassification = requestClassifications.get(id);

    // Attempt to capture body only when the classification warrants it.
    // Skipping static/analytics/WebSocket/third-party asset bodies eliminates
    // 30-70% of per-page IPC on asset-heavy pages. API responses are always
    // captured; other text responses (HTML, XML, etc.) are captured unless
    // classified as static/analytics.
    let body: string | undefined;
    let bodySize = 0;

    const shouldCaptureBody =
      matchingReqClassification === 'api' ||
      (
        contentType !== undefined &&
        isTextContentType(contentType, captureJsBodies) &&
        matchingReqClassification !== 'static' &&
        matchingReqClassification !== 'analytics' &&
        matchingReqClassification !== 'websocket'
      );

    if (shouldCaptureBody) {
      try {
        const buffer = await response.body();
        bodySize = buffer.length;

        // API responses still need the content-type check for text decoding.
        // Binary API responses (e.g., protobuf) fall through without a body.
        if (contentType && isTextContentType(contentType, captureJsBodies)) {
          const text = buffer.toString('utf-8');
          body = text.length > MAX_BODY_SIZE ? text.slice(0, MAX_BODY_SIZE) : text;
        }
      } catch {
        // Body may not be available (e.g. redirects, streaming)
      }
    }

    const captured: CapturedResponse = {
      requestId: id,
      statusCode,
      headers: scrubHeaders(rawHeaders, { includeCookies }),
      bodySize,
      timing,
    };

    if (body !== undefined) {
      captured.body = scrubBody(body);
    }
    if (contentType !== undefined) {
      captured.contentType = contentType;
    }

    responses.push(captured);

    // Attach response data to the matching GraphQL operation.
    // O(1) lookup via requestId index — replaces the previous
    // O(Gql × Req) nested scan.
    if (body) {
      const gqlOp = gqlOpsByRequestId.get(id);
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
        const rawData = typeof data.payload === 'string' ? data.payload : data.payload.toString('utf-8');
        connection.sampleMessages.push({
          direction: 'received',
          data: scrubBody(rawData),
          timestamp: new Date().toISOString(),
        });
      }
    });

    ws.on('framesent', (data: { payload: string | Buffer }) => {
      connection.messageCount++;
      if (sentCount < MAX_WS_MESSAGES_PER_DIRECTION) {
        sentCount++;
        const rawData = typeof data.payload === 'string' ? data.payload : data.payload.toString('utf-8');
        connection.sampleMessages.push({
          direction: 'sent',
          data: scrubBody(rawData),
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
 *
 * JavaScript bundles (`application/javascript`, `text/javascript`) are
 * excluded by default. Raw JS bodies often contain hardcoded API keys
 * that the credential scrubber cannot reliably detect. Set
 * `captureJsBodies = true` to opt back in for debugging specific bundles.
 */
function isTextContentType(contentType: string, captureJsBodies = false): boolean {
  const lower = contentType.toLowerCase();

  const isJs =
    lower.includes('application/javascript') ||
    lower.includes('text/javascript');
  if (isJs) return captureJsBodies;

  return (
    lower.includes('text/') ||
    lower.includes('application/json') ||
    lower.includes('application/xml') ||
    lower.includes('application/xhtml') ||
    lower.includes('application/graphql') ||
    lower.includes('+json') ||
    lower.includes('+xml')
  );
}
