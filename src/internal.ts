/**
 * playwright-archaeologist — internal helpers.
 *
 * This module is reachable via `import { ... } from 'playwright-archaeologist/internal'`
 * but is NOT part of the stable 0.x public API. The signatures, names, and
 * behaviors of every export below may change or disappear in any release,
 * including patch releases.
 *
 * Use this path only if:
 *   - you are writing tests that need direct access to internals, or
 *   - you are a power user willing to pin to an exact version and re-verify
 *     on every upgrade.
 *
 * For a stable API, import from the package root:
 *   import { dig, resolveConfig, CollectorRegistry } from 'playwright-archaeologist';
 */

// ---------------------------------------------------------------------------
// Logger (internal infrastructure)
// ---------------------------------------------------------------------------
export { Logger, logger } from './utils/logger.js';
export { ProgressTracker } from './utils/progress.js';

// ---------------------------------------------------------------------------
// Individual collectors — superseded by the Collector plugin contract
// (see `CollectorRegistry` in the public API). These remain exported here
// for tests and for callers that already depended on them.
// ---------------------------------------------------------------------------
export { scanPage } from './collectors/page-scanner.js';
export { captureScreenshots } from './collectors/screenshot-capturer.js';
export { probeForms } from './collectors/form-prober.js';
export { createNetworkLogger } from './collectors/network-logger.js';

// ---------------------------------------------------------------------------
// Auth execution primitives — normally driven by `dig`, exposed here for
// advanced embedding scenarios.
// ---------------------------------------------------------------------------
export { executeAuth, detectAuthFailure, refreshAuth } from './auth/auth-handler.js';

// ---------------------------------------------------------------------------
// Crawl queue
// ---------------------------------------------------------------------------
export { Frontier } from './crawl/frontier.js';

// ---------------------------------------------------------------------------
// Assembler helpers — convert raw crawl data into the shapes the report
// and OpenAPI generator expect.
// ---------------------------------------------------------------------------
export { groupEndpoints } from './assembler/api-grouper.js';
export {
  buildFlowGraph,
  generateMermaidDefinition,
  detectCycles,
} from './assembler/flow-graph.js';

// ---------------------------------------------------------------------------
// HTML report internals — escape helpers and Mermaid rendering are used
// internally to build `report.html`. Prefer `generateReportHtml` from the
// public API.
// ---------------------------------------------------------------------------
export { generateMermaidSvgString } from './report/html/template.js';
export { escapeHtml, escapeAttribute, escapeJsonInHtml } from './report/html/escape.js';

// ---------------------------------------------------------------------------
// OpenAPI filesystem helper — writes the spec to disk. Library users who
// want the in-memory spec should call `generateOpenApiSpec` from the public
// API.
// ---------------------------------------------------------------------------
export { writeOpenApiSpec } from './report/openapi-output.js';
