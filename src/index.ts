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
// Diffing
// ---------------------------------------------------------------------------
export { diffBundles } from './diff/diff-engine.js';
export { generateDiffReportHtml } from './diff/diff-report.js';
export { diffScreenshotPair } from './diff/screenshot-diff.js';
export type { ScreenshotDiffOptions, ScreenshotDiffResult } from './diff/screenshot-diff.js';

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
