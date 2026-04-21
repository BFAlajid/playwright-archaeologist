/**
 * playwright-archaeologist — public programmatic API.
 *
 * This module is the stable 0.x entry point. Only the exports listed here are
 * covered by semver. Internal helpers that used to live here (scanPage,
 * probeForms, Frontier, escape helpers, etc.) have moved to the deep import
 * path `playwright-archaeologist/internal` and may change at any time.
 *
 * Usage:
 *   import { dig, resolveConfig } from 'playwright-archaeologist';
 *   const config = resolveConfig({ targetUrl: 'https://example.com' });
 *   const result = await dig(config);
 */

// ---------------------------------------------------------------------------
// Core entry point
// ---------------------------------------------------------------------------
export { dig } from './crawl/orchestrator.js';

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------
export type {
  CrawlConfig,
  ResolvedConfig,
  Viewport,
  OutputFormat,
  DiffConfig,
} from './types/config.js';
export {
  CrawlConfigSchema,
  DiffConfigSchema,
  ViewportSchema,
  parseViewport,
  normalizeEntryUrl,
  resolveConfig,
} from './types/config.js';

// ---------------------------------------------------------------------------
// Artifact / result types
// ---------------------------------------------------------------------------
export type {
  DigResult,
  CrawlResult,
  PageVisitResult,
  PageScanResult,
  FormProbeResult,
  NetworkLogResult,
  ScreenshotResult,
  AssembledArtifacts,
  DiffResult,
  BundleManifest,
} from './types/artifacts.js';

// ---------------------------------------------------------------------------
// Error hierarchy
// ---------------------------------------------------------------------------
export {
  ArchaeologistError,
  ConfigError,
  AuthError,
  CrawlError,
  NavigationError,
  CollectorError,
  DiffError,
  BundleError,
  EmitError,
  CoverageError,
} from './types/errors.js';

// ---------------------------------------------------------------------------
// Auth — types only. Auth execution is internal; callers supply an auth
// script path via config and let `dig` orchestrate the flow.
// ---------------------------------------------------------------------------
export type { AuthOptions, AuthResult } from './auth/auth-handler.js';

// ---------------------------------------------------------------------------
// Report generation
// ---------------------------------------------------------------------------
export { generateReportHtml } from './report/html/template.js';

// ---------------------------------------------------------------------------
// Bundle creation
// ---------------------------------------------------------------------------
export { createBundle } from './bundle/bundle-creator.js';

// ---------------------------------------------------------------------------
// Playwright test emission
// ---------------------------------------------------------------------------
export { emitTests } from './emit/test-emitter.js';
export type { EmitOptions, EmittedFile } from './emit/test-emitter.js';

// ---------------------------------------------------------------------------
// Diffing
// ---------------------------------------------------------------------------
export { diffBundles } from './diff/diff-engine.js';
export { generateDiffReportHtml } from './diff/diff-report.js';
export { diffScreenshotPair } from './diff/screenshot-diff.js';
export type { ScreenshotDiffOptions, ScreenshotDiffResult } from './diff/screenshot-diff.js';

// ---------------------------------------------------------------------------
// Multi-environment diff
// ---------------------------------------------------------------------------
export { runDiffEnv, formatDiffEnvSummary, evaluateFailOn } from './diff-env/diff-env.js';
export type {
  DiffEnvOptions,
  DiffEnvResult,
  DiffEnvDeps,
  DiffEnvFormat,
  DiffEnvFailOn,
  SharedCrawlConfig,
} from './diff-env/diff-env.js';

// ---------------------------------------------------------------------------
// OpenAPI
// ---------------------------------------------------------------------------
export { generateOpenApiSpec } from './report/openapi-output.js';

// ---------------------------------------------------------------------------
// Collector plugin contract — the supported extension point for adding
// per-page data capture. Prefer writing a Collector over importing individual
// internal collectors.
// ---------------------------------------------------------------------------
export { CollectorRegistry, DEFAULT_COLLECTOR_TIMEOUT_MS } from './plugins/registry.js';
export type { Collector, CollectorContext, CollectorResult } from './plugins/types.js';
export { AxeCollector } from './plugins/axe-collector.js';
export type { AxeResult, AxeViolation } from './plugins/axe-collector.js';

// ---------------------------------------------------------------------------
// MCP server — expose a bundle over the Model Context Protocol so Claude
// or any MCP client can query the crawl via tools + resources.
// ---------------------------------------------------------------------------
export { startMcpServer } from './mcp/server.js';

// ---------------------------------------------------------------------------
// Test coverage overlay — compare a Playwright test directory to a crawl
// bundle and report routes/APIs with no matching test.
// ---------------------------------------------------------------------------
export { scanTestDirectory } from './coverage/test-scanner.js';
export type { TestReference, ScanOptions } from './coverage/test-scanner.js';
export { computeCoverage } from './coverage/coverage-engine.js';
export type {
  CoverageReport,
  CoverageRouteEntry,
  CoverageApiEntry,
  CoverageSummary,
  ComputeCoverageInput,
  ComputeCoverageOptions,
} from './coverage/coverage-engine.js';
export {
  generateCoverageReportHtml,
  generateCoverageReportJson,
  generateCoverageReportMarkdown,
  generateCoverageReportJUnit,
} from './coverage/coverage-report.js';
