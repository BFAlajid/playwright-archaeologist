/**
 * API endpoint grouping from network logs.
 *
 * Walks every page's network log, collects API-classified requests and
 * their matching responses, and groups them by `${method} ${parameterizedPath}`.
 * GraphQL operation names are folded into the matching group.
 */

import type { ApiEndpointGroup, PageVisitResult } from '../types/artifacts.js';
import { parameterizePath } from './api-grouper.js';

/**
 * Build ApiEndpointGroup[] from network logs across all pages.
 *
 * Requests classified as 'api' (see network-logger) are parameterized by
 * path and grouped by `${method} ${pattern}`. For each group, the first
 * observed request and response are retained as examples and the set of
 * unique status codes / content types is recorded.
 */
export function buildApiEndpointGroupsFromPages(pages: PageVisitResult[]): ApiEndpointGroup[] {
  // Collect all API requests with their responses across all pages.
  const groupMap = new Map<string, {
    pattern: string;
    method: string;
    urls: string[];
    callingPages: Set<string>;
    statusCodes: Set<number>;
    contentTypes: Set<string>;
    isGraphQL: boolean;
    graphqlOps: Set<string>;
    firstRequest?: { url: string; headers: Record<string, string>; body?: string; contentType?: string };
    firstResponse?: { statusCode: number; headers: Record<string, string>; body?: string; contentType?: string; bodySize: number };
  }>();

  for (const page of pages) {
    if (!page.networkLog) continue;
    const log = page.networkLog;

    // Build a response index ONCE per page so the inner loop is O(1) per
    // lookup instead of O(responses) per request. Previous impl was
    // O(requests × responses) per page — painful on API-heavy pages.
    const responsesByRequestId = new Map<string, typeof log.responses[number]>();
    for (const r of log.responses) {
      responsesByRequestId.set(r.requestId, r);
    }

    for (const req of log.requests) {
      if (req.classification !== 'api') continue;

      let urlPath: string;
      try {
        urlPath = new URL(req.url).pathname;
      } catch {
        urlPath = req.url;
      }

      const pattern = parameterizePath(urlPath);
      const key = `${req.method} ${pattern}`;

      let group = groupMap.get(key);
      if (!group) {
        group = {
          pattern,
          method: req.method,
          urls: [],
          callingPages: new Set(),
          statusCodes: new Set(),
          contentTypes: new Set(),
          isGraphQL: req.url.includes('graphql'),
          graphqlOps: new Set(),
        };
        groupMap.set(key, group);
      }

      group.urls.push(req.url);
      group.callingPages.add(page.url);

      const resp = responsesByRequestId.get(req.requestId);

      if (resp) {
        group.statusCodes.add(resp.statusCode);
        if (resp.contentType) group.contentTypes.add(resp.contentType);
      }

      // Store first request/response as example.
      if (!group.firstRequest) {
        group.firstRequest = {
          url: req.url,
          headers: req.headers,
          body: req.body,
          contentType: req.contentType,
        };
      }
      if (!group.firstResponse && resp) {
        group.firstResponse = {
          statusCode: resp.statusCode,
          headers: resp.headers,
          body: resp.body,
          contentType: resp.contentType,
          bodySize: resp.bodySize,
        };
      }
    }

    // Collect GraphQL operations.
    for (const gqlOp of log.graphqlOperations) {
      let gqlPath: string;
      try {
        gqlPath = new URL(gqlOp.endpointUrl).pathname;
      } catch {
        gqlPath = gqlOp.endpointUrl;
      }
      const key = `POST ${parameterizePath(gqlPath)}`;
      const group = groupMap.get(key);
      if (group) {
        group.isGraphQL = true;
        group.graphqlOps.add(gqlOp.operationName);
      }
    }
  }

  // Convert to ApiEndpointGroup[].
  const result: ApiEndpointGroup[] = [];
  for (const g of groupMap.values()) {
    result.push({
      pattern: g.pattern,
      method: g.method,
      classification: 'api',
      observedUrls: g.urls,
      callCount: g.urls.length,
      callingPages: Array.from(g.callingPages),
      exampleRequest: g.firstRequest ?? {
        url: g.urls[0] ?? '',
        headers: {},
      },
      exampleResponse: g.firstResponse ?? {
        statusCode: 0,
        headers: {},
        bodySize: 0,
      },
      observedStatusCodes: Array.from(g.statusCodes),
      observedContentTypes: Array.from(g.contentTypes),
      isGraphQL: g.isGraphQL,
      graphqlOperations: g.graphqlOps.size > 0 ? Array.from(g.graphqlOps) : undefined,
    });
  }

  return result;
}
