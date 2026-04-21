/**
 * playwright-archaeologist error types.
 *
 * Error hierarchy:
 *   ArchaeologistError (base)
 *   +-- ConfigError              Invalid CLI options or config file
 *   +-- AuthError                Auth script loading, execution, or validation failure
 *   +-- CrawlError (base)       Any error during the crawl phase
 *   |   +-- NavigationError      page.goto failure (timeout, network, HTTP >= 400)
 *   |   +-- CollectorError       A collector (scanner/prober/logger/capturer) failed on a page
 *   |   +-- BrowserContextError  Context crashed or was killed
 *   |   +-- FrontierError        URL queue corruption or checkpoint I/O failure
 *   |   +-- SecurityBlockError   SSRF or protocol violation blocked a request
 *   +-- AssemblerError           Data merging or dedup failure
 *   +-- ReportError              Report generation failure (HTML, JSON, OpenAPI, Mermaid)
 *   +-- DiffError                Bundle loading, comparison, or diff report failure
 *   +-- BundleError              .archaeologist bundle I/O or integrity failure
 *
 * Error propagation rules:
 *   - NavigationError on one page:  log + skip page, crawl continues
 *   - CollectorError on one page:   log + partial data, crawl continues
 *   - BrowserContextError:          recycle context, re-enqueue URL, crawl continues
 *   - FrontierError (checkpoint):   warn, crawl continues without checkpointing
 *   - SecurityBlockError:           log + skip URL, crawl continues
 *   - ConfigError:                  abort with user-facing message before crawl starts
 *   - AuthError:                    abort with user-facing message before crawl starts
 *   - AssemblerError:               abort, partial output may exist
 *   - ReportError:                  degrade gracefully (skip failed section, warn)
 *   - DiffError:                    abort with exit code 2
 *   - BundleError:                  abort with exit code 2
 */

// ---------------------------------------------------------------------------
// Base error
// ---------------------------------------------------------------------------

export class ArchaeologistError extends Error {
  /** Machine-readable error code for programmatic handling. */
  readonly code: string;

  constructor(message: string, code: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'ArchaeologistError';
    this.code = code;
  }
}

// ---------------------------------------------------------------------------
// Configuration errors (detected before crawl starts)
// ---------------------------------------------------------------------------

export class ConfigError extends ArchaeologistError {
  /** The config field that failed validation (e.g. "depth", "viewport"). */
  readonly field: string;
  /** The invalid value the user supplied. */
  readonly value: unknown;

  constructor(field: string, message: string, value?: unknown) {
    super(message, 'ERR_CONFIG');
    this.name = 'ConfigError';
    this.field = field;
    this.value = value;
  }
}

// ---------------------------------------------------------------------------
// Auth errors (detected before or at the start of crawl)
// ---------------------------------------------------------------------------

export type AuthErrorReason =
  | 'script_not_found'
  | 'script_import_failed'
  | 'script_no_default_export'
  | 'script_execution_failed'
  | 'script_dangerous_import'
  | 'script_user_declined'
  | 'cookie_file_not_found'
  | 'cookie_file_malformed'
  | 'auth_verification_failed';

export class AuthError extends ArchaeologistError {
  readonly reason: AuthErrorReason;
  readonly scriptPath?: string;

  constructor(reason: AuthErrorReason, message: string, scriptPath?: string, options?: ErrorOptions) {
    super(message, 'ERR_AUTH', options);
    this.name = 'AuthError';
    this.reason = reason;
    this.scriptPath = scriptPath;
  }
}

// ---------------------------------------------------------------------------
// Crawl errors (per-page or per-context failures during crawl)
// ---------------------------------------------------------------------------

export class CrawlError extends ArchaeologistError {
  /** The URL being processed when the error occurred. */
  readonly url: string;

  constructor(message: string, code: string, url: string, options?: ErrorOptions) {
    super(message, code, options);
    this.name = 'CrawlError';
    this.url = url;
  }
}

export type NavigationStatus =
  | 'timeout'
  | 'network_error'
  | 'http_error'
  | 'no_response'
  | 'aborted'
  | 'redirect_loop';

export class NavigationError extends CrawlError {
  readonly status: NavigationStatus;
  /** HTTP status code, if applicable (e.g. 404, 500). */
  readonly httpStatus?: number;

  constructor(url: string, status: NavigationStatus, message: string, httpStatus?: number, options?: ErrorOptions) {
    super(message, 'ERR_NAVIGATION', url, options);
    this.name = 'NavigationError';
    this.status = status;
    this.httpStatus = httpStatus;
  }
}

export type CollectorName = 'page-scanner' | 'form-prober' | 'network-logger' | 'screenshot-capturer';

export class CollectorError extends CrawlError {
  readonly collector: CollectorName;

  constructor(collector: CollectorName, url: string, message: string, options?: ErrorOptions) {
    super(message, 'ERR_COLLECTOR', url, options);
    this.name = 'CollectorError';
    this.collector = collector;
  }
}

export class BrowserContextError extends CrawlError {
  readonly contextId: number;

  constructor(contextId: number, url: string, message: string, options?: ErrorOptions) {
    super(message, 'ERR_BROWSER_CONTEXT', url, options);
    this.name = 'BrowserContextError';
    this.contextId = contextId;
  }
}

export class FrontierError extends ArchaeologistError {
  readonly operation: 'enqueue' | 'dequeue' | 'checkpoint_write' | 'checkpoint_read';

  constructor(operation: FrontierError['operation'], message: string, options?: ErrorOptions) {
    super(message, 'ERR_FRONTIER', options);
    this.name = 'FrontierError';
    this.operation = operation;
  }
}

/**
 * Thrown when the Frontier's seen-set grows beyond the configured
 * `maxSeen` bound. The crawler cannot continue to dedupe without
 * unbounded memory growth, so we abort with guidance to raise the limit.
 *
 * Future work: swap the seen-set for a Bloom filter above N million
 * entries; that would trade a tiny false-positive rate (missed re-visit)
 * for flat memory. Out of scope for this wave.
 */
export class FrontierOverflowError extends ArchaeologistError {
  readonly seenCount: number;
  readonly maxSeen: number;

  constructor(seenCount: number, maxSeen: number) {
    super(
      `Frontier seen-set exceeded ${maxSeen} URLs (current: ${seenCount}). ` +
        `Raise the limit with Frontier({ maxSeen: N }), split the crawl with ` +
        `--include patterns, or narrow --depth / --max-pages.`,
      'ERR_FRONTIER_OVERFLOW',
    );
    this.name = 'FrontierOverflowError';
    this.seenCount = seenCount;
    this.maxSeen = maxSeen;
  }
}

export type SecurityBlockReason =
  | 'private_ip'
  | 'blocked_protocol'
  | 'dns_rebinding'
  | 'metadata_endpoint'
  | 'redirect_to_private';

export class SecurityBlockError extends CrawlError {
  readonly reason: SecurityBlockReason;
  /** The resolved IP address that triggered the block, if applicable. */
  readonly resolvedIp?: string;

  constructor(url: string, reason: SecurityBlockReason, message: string, resolvedIp?: string, options?: ErrorOptions) {
    super(message, 'ERR_SECURITY_BLOCK', url, options);
    this.name = 'SecurityBlockError';
    this.reason = reason;
    this.resolvedIp = resolvedIp;
  }
}

// ---------------------------------------------------------------------------
// Assembler errors (post-crawl data merging)
// ---------------------------------------------------------------------------

export class AssemblerError extends ArchaeologistError {
  readonly phase: 'merge' | 'deduplicate' | 'route_tree' | 'api_grouping' | 'flow_graph';

  constructor(phase: AssemblerError['phase'], message: string, options?: ErrorOptions) {
    super(message, 'ERR_ASSEMBLER', options);
    this.name = 'AssemblerError';
    this.phase = phase;
  }
}

// ---------------------------------------------------------------------------
// Report errors (output generation failures)
// ---------------------------------------------------------------------------

export type ReportSection =
  | 'html_template'
  | 'sitemap'
  | 'forms'
  | 'api_map'
  | 'screenshots'
  | 'flow_graph'
  | 'mermaid_render'
  | 'json_output'
  | 'openapi_output'
  | 'thumbnail_generation';

export class ReportError extends ArchaeologistError {
  readonly section: ReportSection;
  /**
   * Whether this section failure is recoverable (report can still be produced
   * without it). Mermaid render failure is recoverable; html_template is not.
   */
  readonly recoverable: boolean;

  constructor(section: ReportSection, message: string, recoverable: boolean, options?: ErrorOptions) {
    super(message, 'ERR_REPORT', options);
    this.name = 'ReportError';
    this.section = section;
    this.recoverable = recoverable;
  }
}

// ---------------------------------------------------------------------------
// Diff errors
// ---------------------------------------------------------------------------

export type DiffErrorReason =
  | 'bundle_not_found'
  | 'bundle_corrupt'
  | 'manifest_invalid'
  | 'incompatible_config'
  | 'screenshot_size_mismatch'
  | 'diff_generation_failed';

export class DiffError extends ArchaeologistError {
  readonly reason: DiffErrorReason;

  constructor(reason: DiffErrorReason, message: string, options?: ErrorOptions) {
    super(message, 'ERR_DIFF', options);
    this.name = 'DiffError';
    this.reason = reason;
  }
}

// ---------------------------------------------------------------------------
// Bundle errors (.archaeologist ZIP I/O)
// ---------------------------------------------------------------------------

export type BundleErrorReason =
  | 'create_failed'
  | 'extract_failed'
  | 'integrity_check_failed'
  | 'missing_manifest'
  | 'unsupported_version'
  | 'output_dir_not_writable';

// ---------------------------------------------------------------------------
// Installation errors (browser missing / unable to launch)
// ---------------------------------------------------------------------------

/**
 * Thrown when Playwright Chromium cannot be launched because the browser
 * binary is missing or otherwise unavailable. Matches common Playwright
 * error shapes (ENOENT, "Executable doesn't exist", "Failed to launch").
 */
export class InstallationError extends ArchaeologistError {
  constructor(message: string, options?: ErrorOptions) {
    super(message, 'ERR_INSTALLATION', options);
    this.name = 'InstallationError';
  }
}

export class BundleError extends ArchaeologistError {
  readonly reason: BundleErrorReason;
  readonly bundlePath?: string;

  constructor(reason: BundleErrorReason, message: string, bundlePath?: string, options?: ErrorOptions) {
    super(message, 'ERR_BUNDLE', options);
    this.name = 'BundleError';
    this.reason = reason;
    this.bundlePath = bundlePath;
  }
}

// ---------------------------------------------------------------------------
// Security errors (explicit security-gate failures)
// ---------------------------------------------------------------------------

export type SecurityErrorReason =
  | 'auth_script_dangerous'
  | 'path_traversal'
  | 'dns_rebinding'
  | 'disallowed_url';

export class SecurityError extends ArchaeologistError {
  readonly reason: SecurityErrorReason;

  constructor(reason: SecurityErrorReason, message: string, options?: ErrorOptions) {
    super(message, 'ERR_SECURITY', options);
    this.name = 'SecurityError';
    this.reason = reason;
  }
}

// ---------------------------------------------------------------------------
// Error classification helpers
// ---------------------------------------------------------------------------

/** Errors that should stop the entire crawl. */
export function isFatalError(err: unknown): boolean {
  if (err instanceof ConfigError) return true;
  if (err instanceof AuthError) return true;
  if (err instanceof AssemblerError) return true;
  if (err instanceof BundleError && err.reason === 'output_dir_not_writable') return true;
  if (err instanceof SecurityError) return true;
  return false;
}

/** Errors that allow the crawl to continue after logging. */
export function isRecoverableError(err: unknown): boolean {
  if (err instanceof NavigationError) return true;
  if (err instanceof CollectorError) return true;
  if (err instanceof SecurityBlockError) return true;
  if (err instanceof BrowserContextError) return true;
  if (err instanceof FrontierError && err.operation === 'checkpoint_write') return true;
  if (err instanceof ReportError && err.recoverable) return true;
  return false;
}

/** Errors that require context recycling (close and recreate browser context). */
export function requiresContextRecycle(err: unknown): boolean {
  return err instanceof BrowserContextError;
}

// ---------------------------------------------------------------------------
// Crawl error log entry (for structured logging and report error summary)
// ---------------------------------------------------------------------------

export interface CrawlErrorEntry {
  timestamp: string;
  url: string;
  code: string;
  message: string;
  collector?: CollectorName;
  status?: NavigationStatus;
  httpStatus?: number;
  securityReason?: SecurityBlockReason;
}

export function toCrawlErrorEntry(err: CrawlError): CrawlErrorEntry {
  const entry: CrawlErrorEntry = {
    timestamp: new Date().toISOString(),
    url: err.url,
    code: err.code,
    message: err.message,
  };
  if (err instanceof CollectorError) entry.collector = err.collector;
  if (err instanceof NavigationError) {
    entry.status = err.status;
    entry.httpStatus = err.httpStatus;
  }
  if (err instanceof SecurityBlockError) entry.securityReason = err.reason;
  return entry;
}
