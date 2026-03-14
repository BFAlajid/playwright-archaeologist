/**
 * playwright-archaeologist — programmatic API entry point.
 *
 * Usage:
 *   import { dig } from 'playwright-archaeologist';
 *   const result = await dig(config);
 */

export { dig } from './crawl/orchestrator.js';

// Configuration types
export type { CrawlConfig, ResolvedConfig, Viewport, OutputFormat, DiffConfig } from './types/config.js';
export { CrawlConfigSchema, DiffConfigSchema, ViewportSchema, parseViewport, normalizeEntryUrl } from './types/config.js';

// Artifact types
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

// Error types
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

// Logger
export { Logger, logger } from './utils/logger.js';

// Collectors
export { scanPage } from './collectors/page-scanner.js';
export { captureScreenshots } from './collectors/screenshot-capturer.js';
export { probeForms } from './collectors/form-prober.js';
export { createNetworkLogger } from './collectors/network-logger.js';

// Auth
export { executeAuth, detectAuthFailure, refreshAuth } from './auth/auth-handler.js';
export type { AuthOptions, AuthResult } from './auth/auth-handler.js';

// Crawl utilities
export { Frontier } from './crawl/frontier.js';
export { ContextPool } from './crawl/context-pool.js';
export { writeCheckpoint, readCheckpoint, deleteCheckpoint, createCheckpointState, setupAutoCheckpoint } from './crawl/checkpoint.js';

// Assembler
export { groupEndpoints } from './assembler/api-grouper.js';
export { buildFlowGraph, generateMermaidDefinition, detectCycles } from './assembler/flow-graph.js';

// Report
export { generateReportHtml } from './report/html/template.js';
export { escapeHtml, escapeAttribute, escapeJsonInHtml } from './report/html/escape.js';

// Progress
export { ProgressTracker } from './utils/progress.js';

// Bundle
export { createBundle } from './bundle/bundle-creator.js';

// Diff
export { diffBundles } from './diff/diff-engine.js';
export { generateDiffReportHtml } from './diff/diff-report.js';

// OpenAPI
export { generateOpenApiSpec, writeOpenApiSpec } from './report/openapi-output.js';
