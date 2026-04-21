/**
 * MCP stdio server exposing a bundle to Claude or any MCP-compatible
 * client.
 *
 * Resources mirror the raw artifact files (`bundle://manifest`,
 * `bundle://sitemap`, etc.) so clients with broad "read everything"
 * support get the same payload you would see on disk. Tools provide
 * the targeted queries (`search_routes`, `find_forms_without_csrf`,
 * ...) that are expensive to emulate by reading the whole bundle.
 *
 * Transport is stdio only. The server is deterministic: it reads the
 * bundle once on startup and holds it in memory. If the underlying
 * bundle files change, restart the server.
 */

import { z } from 'zod';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { loadBundle } from './bundle-loader.js';
import type { LoadedBundle } from './bundle-loader.js';
import {
  findFormsWithoutCsrf,
  getApiEndpoint,
  listAccessibilityViolations,
  listBrokenRoutes,
  listForms,
  searchRoutes,
} from './tools.js';
import { logger } from '../utils/logger.js';

/** Serialize a JS value as a single text content block (MCP-friendly). */
function jsonContent(value: unknown): {
  content: Array<{ type: 'text'; text: string }>;
} {
  return {
    content: [{ type: 'text' as const, text: JSON.stringify(value, null, 2) }],
  };
}

/** Serialize a resource as the standard JSON text/mime shape. */
function jsonResource(uri: string, value: unknown, mime = 'application/json') {
  return {
    contents: [
      {
        uri,
        mimeType: mime,
        text: typeof value === 'string' ? value : JSON.stringify(value, null, 2),
      },
    ],
  };
}

/**
 * Create and configure an McpServer for `bundle`. Exposed for tests; the
 * CLI path calls `startMcpServer` which wires stdio and blocks.
 */
export function createConfiguredMcpServer(bundle: LoadedBundle): McpServer {
  const server = new McpServer(
    {
      name: 'playwright-archaeologist',
      version: bundle.manifest.toolVersion,
    },
    {
      instructions:
        `Query a playwright-archaeologist crawl bundle. ` +
        `Resources expose the raw artifacts (bundle://sitemap, bundle://forms, ` +
        `bundle://api-map, bundle://flow-graph, bundle://manifest, bundle://accessibility). ` +
        `Tools expose searches and filters over those artifacts.`,
    },
  );

  // -------------------------------------------------------------------------
  // Resources
  // -------------------------------------------------------------------------

  server.registerResource(
    'manifest',
    'bundle://manifest',
    {
      title: 'Bundle manifest',
      description: 'Raw manifest.json — file list, SHA-256 hashes, crawl stats.',
      mimeType: 'application/json',
    },
    async (uri) => jsonResource(uri.href, bundle.manifest),
  );

  server.registerResource(
    'sitemap',
    'bundle://sitemap',
    {
      title: 'Sitemap',
      description: 'Flat list of crawled routes with status codes and depth.',
      mimeType: 'application/json',
    },
    async (uri) => jsonResource(uri.href, bundle.sitemap),
  );

  server.registerResource(
    'forms',
    'bundle://forms',
    {
      title: 'Forms catalog',
      description: 'Every <form> discovered during the crawl, with field metadata.',
      mimeType: 'application/json',
    },
    async (uri) => jsonResource(uri.href, bundle.forms),
  );

  server.registerResource(
    'api-map',
    'bundle://api-map',
    {
      title: 'API map',
      description: 'API endpoints grouped by parameterized pattern.',
      mimeType: 'application/json',
    },
    async (uri) => jsonResource(uri.href, bundle.apiMap),
  );

  server.registerResource(
    'flow-graph',
    'bundle://flow-graph',
    {
      title: 'Navigation flow graph',
      description: 'Mermaid text describing observed page-to-page navigation edges.',
      mimeType: 'text/vnd.mermaid',
    },
    async (uri) => jsonResource(uri.href, bundle.flowGraphMermaid, 'text/vnd.mermaid'),
  );

  // Accessibility is optional — only expose the resource when data is
  // present so clients do not mistake an empty response for a zero-violation run.
  if (bundle.accessibility) {
    server.registerResource(
      'accessibility',
      'bundle://accessibility',
      {
        title: 'Accessibility audit',
        description: 'Per-page axe-core violation summary (present iff --with-a11y was used).',
        mimeType: 'application/json',
      },
      async (uri) => jsonResource(uri.href, bundle.accessibility),
    );
  }

  // -------------------------------------------------------------------------
  // Tools
  // -------------------------------------------------------------------------

  server.registerTool(
    'search_routes',
    {
      title: 'Search routes',
      description:
        'Grep over crawled URLs and page titles. Optional `status` filters by HTTP status code.',
      inputSchema: {
        query: z
          .string()
          .describe('Case-insensitive substring match on URL and title. Empty string matches all.'),
        method: z
          .string()
          .optional()
          .describe('Reserved — sitemap entries are per-page, not per-method.'),
        status: z.number().int().optional().describe('Exact HTTP status code to filter by.'),
        limit: z.number().int().positive().max(100).optional(),
      },
    },
    async (input) => jsonContent(searchRoutes(bundle, input)),
  );

  server.registerTool(
    'list_forms',
    {
      title: 'List forms',
      description: 'Filter the forms catalog by password presence and/or HTTP method.',
      inputSchema: {
        has_password: z
          .boolean()
          .optional()
          .describe('When true, only forms with a password field. False = forms without one.'),
        method: z.string().optional().describe('HTTP method (GET, POST, PUT, DELETE, ...).'),
        limit: z.number().int().positive().max(100).optional(),
      },
    },
    async (input) =>
      jsonContent(
        listForms(bundle, {
          hasPassword: input.has_password,
          method: input.method,
          limit: input.limit,
        }),
      ),
  );

  server.registerTool(
    'find_forms_without_csrf',
    {
      title: 'Forms without CSRF token',
      description:
        'Return non-GET forms that contain no field matching ' +
        '/csrf|_token|authenticity|xsrf/i. Useful for security reviews.',
      inputSchema: {},
    },
    async () => jsonContent(findFormsWithoutCsrf(bundle)),
  );

  server.registerTool(
    'get_api_endpoint',
    {
      title: 'Get API endpoint',
      description:
        'Look up a single API endpoint group by method + URL pattern. ' +
        'Pattern may be concrete (e.g. /api/users/42) — the tool will parameterize ' +
        'it (/api/users/:id) to find a matching group.',
      inputSchema: {
        method: z.string().describe('HTTP method.'),
        pattern: z.string().describe('URL path (or full URL). Concrete or parameterized.'),
      },
    },
    async (input) => jsonContent(getApiEndpoint(bundle, input)),
  );

  server.registerTool(
    'list_accessibility_violations',
    {
      title: 'List accessibility violations',
      description:
        'Flatten axe-core results across pages, filter by impact, return top N. ' +
        'Returns { present: false } if the bundle has no accessibility data.',
      inputSchema: {
        impact: z.enum(['minor', 'moderate', 'serious', 'critical']).optional(),
        limit: z.number().int().positive().max(100).optional(),
      },
    },
    async (input) => jsonContent(listAccessibilityViolations(bundle, input)),
  );

  server.registerTool(
    'list_broken_routes',
    {
      title: 'List broken routes',
      description:
        'Return every crawled route whose HTTP status >= min_status (default 400), ' +
        'sorted by status desc.',
      inputSchema: {
        min_status: z.number().int().min(100).max(599).optional(),
        limit: z.number().int().positive().max(100).optional(),
      },
    },
    async (input) =>
      jsonContent(listBrokenRoutes(bundle, { minStatus: input.min_status, limit: input.limit })),
  );

  return server;
}

/**
 * Start an MCP stdio server for the given bundle directory. Blocks
 * until stdin closes or SIGINT / SIGTERM is received.
 */
export async function startMcpServer(bundleDir: string): Promise<void> {
  const bundle = await loadBundle(bundleDir);
  logger.info(
    `MCP server: bundle loaded (${bundle.sitemap.length} routes, ` +
      `${bundle.forms.length} forms, ${bundle.apiMap.length} APIs, ` +
      `a11y=${bundle.accessibility ? 'yes' : 'no'})`,
  );

  const server = createConfiguredMcpServer(bundle);
  const transport = new StdioServerTransport();

  // Connect first — this starts the transport and blocks on stdin.
  await server.connect(transport);

  // Expose a promise that resolves on clean shutdown. StdioServerTransport
  // closes when stdin ends (EOF from the MCP client); we additionally
  // react to SIGINT/SIGTERM for ctrl-C in interactive use.
  await new Promise<void>((resolve) => {
    const shutdown = (signal: NodeJS.Signals) => {
      logger.debug(`MCP server: shutting down on ${signal}`);
      server.close().catch(() => {
        /* best-effort */
      });
      resolve();
    };
    process.once('SIGINT', shutdown);
    process.once('SIGTERM', shutdown);
    transport.onclose = () => {
      logger.debug('MCP server: transport closed by peer');
      resolve();
    };
  });
}
