/**
 * playwright-archaeologist artifact type definitions.
 *
 * Data flow through the system:
 *
 *   CLI (ResolvedConfig)
 *     |
 *     v
 *   Orchestrator ----> per-page collectors (parallel)
 *     |                  |
 *     |   PageScanner  ---> PageScanResult
 *     |   FormProber   ---> FormProbeResult
 *     |   NetworkLogger -> NetworkLogResult
 *     |   ScreenshotCapturer -> ScreenshotResult
 *     |                  |
 *     v                  v
 *   PageVisitResult  (aggregates all collector results for one URL)
 *     |
 *     v
 *   CrawlResult (all pages + crawl metadata + errors)
 *     |
 *     v
 *   Assembler  --->  AssembledArtifacts
 *     |               (deduplicated, correlated, structured)
 *     v
 *   ReportGenerator
 *     |-- HTML report  (ReportData -> report.html)
 *     |-- JSON output  (AssembledArtifacts -> *.json files)
 *     |-- OpenAPI spec (ApiEndpointGroup[] -> openapi.json)
 *     |-- Bundle       (AssembledArtifacts + screenshots -> .archaeologist ZIP)
 *     v
 *   DiffModule
 *     |-- loads two BundleManifest + their contents
 *     |-- produces DiffResult
 *     |-- renders diff report (HTML, JSON, JUnit, Markdown)
 */

import type { CrawlErrorEntry, CollectorName } from './errors.js';
import type { Viewport } from './config.js';

// ===========================================================================
// 1. COLLECTOR OUTPUTS (per-page, returned by each collector)
// ===========================================================================

// ---------------------------------------------------------------------------
// 1a. PageScanner output
// ---------------------------------------------------------------------------

export interface HeadingEntry {
  level: 1 | 2 | 3 | 4 | 5 | 6;
  text: string;
}

export interface MetaTag {
  name?: string;
  property?: string;
  content: string;
}

export interface LandmarkInfo {
  role: string;
  tagName: string;
  label?: string;
}

export interface LinkInfo {
  href: string;
  text: string;
  /** Whether the link is internal (same-origin) or external. */
  isExternal: boolean;
  /** Relationship attribute value if present (e.g. "nofollow"). */
  rel?: string;
}

export interface InteractiveElement {
  tagName: string;
  type?: string;
  text: string;
  role?: string;
  ariaLabel?: string;
  /** CSS selector that uniquely identifies this element on the page. */
  selector: string;
}

export interface PageTiming {
  /** Total time from navigation start to load event (ms). */
  loadTime: number;
  /** DOM content loaded time (ms). */
  domContentLoaded: number;
  /** First contentful paint (ms), if available. */
  firstContentfulPaint?: number;
}

/**
 * Output of the PageScanner collector for a single URL.
 * The Orchestrator receives this and stores it in PageVisitResult.
 */
export interface PageScanResult {
  url: string;
  /** Canonical URL if different from requested URL (e.g. after redirect). */
  canonicalUrl?: string;
  /** HTTP status code of the final response. */
  statusCode: number;
  /** Page <title> text. */
  title: string;
  /** Meta description and other meta tags. */
  metaTags: MetaTag[];
  /** Heading hierarchy. */
  headings: HeadingEntry[];
  /** Semantic landmark elements found on the page. */
  landmarks: LandmarkInfo[];
  /** All links discovered on the page (both <a href> and SPA navigation targets). */
  links: LinkInfo[];
  /** Buttons, dropdowns, and other interactive elements (not links). */
  interactiveElements: InteractiveElement[];
  /** Navigation Timing API data. */
  timing: PageTiming;
  /** SHA-256 hash of the page's main text content (for change detection). */
  contentHash: string;
  /** Whether hash-based routing was detected on this page. */
  hashRoutingDetected: boolean;
}

// ---------------------------------------------------------------------------
// 1b. FormProber output
// ---------------------------------------------------------------------------

export interface FormFieldOption {
  value: string;
  label: string;
  selected: boolean;
}

export interface FormField {
  /** Input name attribute. */
  name: string;
  /** Input type (text, email, password, select, radio, checkbox, file, hidden, etc.). */
  type: string;
  /** Whether the field is required (HTML5 required attribute or aria-required). */
  required: boolean;
  /** Validation pattern attribute value. */
  pattern?: string;
  /** Placeholder text. */
  placeholder?: string;
  /** Associated label text (from <label>, aria-label, or aria-labelledby). */
  label?: string;
  /** For select, radio, and checkbox: the available options. */
  options?: FormFieldOption[];
  /** Min/max/step for numeric inputs. */
  min?: string;
  max?: string;
  step?: string;
  /** Maxlength constraint. */
  maxLength?: number;
  /** Whether the field accepts multiple values (e.g. multi-select, multiple file). */
  multiple?: boolean;
  /** Accept attribute for file inputs. */
  accept?: string;
  /** Default/current value (redacted for password fields). */
  defaultValue?: string;
}

export interface ValidationMessage {
  fieldName: string;
  message: string;
  /** Whether this is a browser-native validation or custom JS validation. */
  type: 'native' | 'custom';
}

/**
 * Output of the FormProber collector for a single URL.
 * A page may contain zero or more forms.
 */
export interface FormProbeResult {
  /** The page URL where these forms were found. */
  pageUrl: string;
  forms: FormInfo[];
}

export interface FormInfo {
  /** Form action URL (resolved to absolute). Empty string if no action attribute. */
  action: string;
  /** HTTP method (GET, POST, etc.). Default: GET. */
  method: string;
  /** Form id attribute, if present. */
  id?: string;
  /** Form name attribute, if present. */
  name?: string;
  /** Whether this is an explicit <form> or an implicit form (input group without wrapper). */
  isImplicit: boolean;
  /** All fields in the form. */
  fields: FormField[];
  /** Submit button text. */
  submitButtonText?: string;
  /** Encoding type (application/x-www-form-urlencoded, multipart/form-data, text/plain). */
  enctype?: string;
  /** Validation messages captured by attempting an empty submission. */
  validationMessages: ValidationMessage[];
  /** ARIA attributes on the form element. */
  ariaLabel?: string;
  /** Whether the form was hidden and required clicking (tab/accordion) to reveal. */
  wasHidden: boolean;
}

// ---------------------------------------------------------------------------
// 1c. NetworkLogger output
// ---------------------------------------------------------------------------

export type RequestClassification = 'api' | 'static' | 'analytics' | 'third-party' | 'websocket' | 'other';

export interface CapturedRequest {
  /** Unique request ID within this crawl. */
  requestId: string;
  /** Request URL. */
  url: string;
  /** HTTP method. */
  method: string;
  /** Request headers (sensitive headers scrubbed unless --include-cookies). */
  headers: Record<string, string>;
  /** Request body (truncated to 100KB, null for GET). */
  body?: string;
  /** Content type of the request body. */
  contentType?: string;
  /** Resource type as classified by the browser. */
  resourceType: string;
  /** Our classification of the request. */
  classification: RequestClassification;
  /** Whether this request was initiated by user interaction or automatic. */
  initiator: 'navigation' | 'script' | 'fetch' | 'xhr' | 'other';
}

export interface CapturedResponse {
  /** Corresponding request ID. */
  requestId: string;
  /** HTTP status code. */
  statusCode: number;
  /** Response headers (sensitive headers scrubbed unless --include-cookies). */
  headers: Record<string, string>;
  /** Response body (truncated to 100KB). Null for redirects and non-text responses. */
  body?: string;
  /** Content type of the response. */
  contentType?: string;
  /** Response body size in bytes (before truncation). */
  bodySize: number;
  /** Response timing in milliseconds. */
  timing: number;
}

export interface FailedRequest {
  requestId: string;
  url: string;
  method: string;
  /** Error message (e.g. "net::ERR_CONNECTION_REFUSED"). */
  errorText: string;
  classification: RequestClassification;
}

export interface GraphQLOperation {
  /** The page URL where this operation was captured. */
  pageUrl: string;
  /** Endpoint URL (typically /graphql). */
  endpointUrl: string;
  /** Operation name from the query. */
  operationName: string;
  /** Operation type. */
  operationType: 'query' | 'mutation' | 'subscription';
  /** GraphQL variables sent with the operation. */
  variables?: Record<string, unknown>;
  /** Full query string. */
  query: string;
  /** Response data (truncated). */
  responseData?: unknown;
}

export interface WebSocketConnection {
  /** WebSocket URL. */
  url: string;
  /** The page URL that opened this WebSocket. */
  pageUrl: string;
  /** Whether the connection was successfully established. */
  connected: boolean;
  /** Number of messages observed (sent + received). */
  messageCount: number;
  /** Sample messages (first 5 sent, first 5 received). */
  sampleMessages: Array<{
    direction: 'sent' | 'received';
    data: string;
    timestamp: string;
  }>;
}

/**
 * Output of the NetworkLogger collector for a single URL.
 */
export interface NetworkLogResult {
  /** The page URL this network activity was captured on. */
  pageUrl: string;
  /** All captured request/response pairs. */
  requests: CapturedRequest[];
  responses: CapturedResponse[];
  /** Requests that failed (network error, CORS, timeout). */
  failedRequests: FailedRequest[];
  /** GraphQL operations detected. */
  graphqlOperations: GraphQLOperation[];
  /** WebSocket connections detected. */
  webSocketConnections: WebSocketConnection[];
  /** Cookie mutations observed (cookies set or deleted during page visit). */
  cookieMutations: Array<{
    name: string;
    action: 'set' | 'deleted';
    domain: string;
    path: string;
  }>;
}

// ---------------------------------------------------------------------------
// 1d. ScreenshotCapturer output
// ---------------------------------------------------------------------------

export interface ScreenshotResult {
  /** The page URL this screenshot was taken on. */
  pageUrl: string;
  /** Filesystem path where the full-page screenshot was saved. */
  fullPagePath: string;
  /** Filesystem path where the viewport-only screenshot was saved. */
  viewportPath: string;
  /** Viewport dimensions used for capture. */
  viewport: Viewport;
  /** SHA-256 hash of the full-page screenshot file. */
  fullPageHash: string;
  /** SHA-256 hash of the viewport screenshot file. */
  viewportHash: string;
  /** Full-page screenshot dimensions. */
  dimensions: { width: number; height: number };
  /** File size in bytes. */
  fileSizeBytes: number;
  /** Whether a dialog or modal was detected and captured. */
  modalDetected: boolean;
}

// ===========================================================================
// 2. ORCHESTRATOR AGGREGATES (per-page combined result)
// ===========================================================================

export type PageVisitStatus =
  | 'ok'
  | 'http_error'
  | 'timeout'
  | 'network_error'
  | 'no_response'
  | 'security_blocked'
  | 'skipped';

/**
 * The Orchestrator produces one PageVisitResult per visited URL.
 * It aggregates results from all collectors plus navigation metadata.
 * Passed to the Assembler in bulk via CrawlResult.
 */
export interface PageVisitResult {
  url: string;
  /** Final URL after redirects. */
  finalUrl: string;
  status: PageVisitStatus;
  /** HTTP status code (undefined if navigation failed before response). */
  httpStatus?: number;
  /** Crawl depth from the entry URL. */
  depth: number;
  /** Which page linked to this one (undefined for the entry URL). */
  referrer?: string;
  /** How this URL was discovered. */
  discoveryMethod: 'link' | 'pushState' | 'replaceState' | 'navigation-api' | 'click' | 'sitemap.xml' | 'entry';
  /** Timestamp when the page visit started. */
  visitedAt: string;
  /** Duration of the entire page visit (navigation + all collectors) in ms. */
  durationMs: number;

  // Collector results (undefined if the collector failed or was disabled)
  pageScan?: PageScanResult;
  formProbe?: FormProbeResult;
  networkLog?: NetworkLogResult;
  screenshot?: ScreenshotResult;

  /** Per-collector errors (collector ran but threw). */
  collectorErrors: Array<{
    collector: CollectorName;
    message: string;
  }>;

  /**
   * Output of registered Collector plugins keyed by collector name. Keys
   * map 1:1 to the `name` on each `Collector` in the registry. Missing
   * keys mean the plugin either was not registered or failed (in which
   * case a string error appears in `pluginErrors`).
   */
  pluginData?: Record<string, unknown>;

  /**
   * Per-plugin errors. Unlike `collectorErrors` (built-in collectors)
   * these come from user-registered Collector plugins.
   */
  pluginErrors?: Array<{ collector: string; message: string }>;

  /** Navigation edges discovered from this page. */
  navigationEdges: NavigationEdge[];
}

// ===========================================================================
// 3. NAVIGATION GRAPH
// ===========================================================================

export type NavigationTrigger =
  | 'link'
  | 'form-submit'
  | 'redirect'
  | 'pushState'
  | 'replaceState'
  | 'navigation-api'
  | 'click'
  | 'meta-refresh'
  | 'js-redirect';

export interface NavigationEdge {
  from: string;
  to: string;
  trigger: NavigationTrigger;
  /** Text of the element that triggered navigation (link text, button text). */
  triggerText?: string;
  /** CSS selector of the element that triggered navigation. */
  triggerSelector?: string;
}

// ===========================================================================
// 4. CRAWL RESULT (full output of the Orchestrator)
// ===========================================================================

/**
 * CrawlResult is the complete output of the Orchestrator.
 * Passed to the Assembler for deduplication, correlation, and structuring.
 */
export interface CrawlResult {
  /** Crawl configuration that was used. */
  config: {
    targetUrl: string;
    depth: number;
    maxPages: number;
    concurrency: number;
    viewport: Viewport;
    followExternal: boolean;
    deepClick: boolean;
  };
  /** When the crawl started. */
  startedAt: string;
  /** When the crawl finished. */
  finishedAt: string;
  /** Total crawl duration in milliseconds. */
  durationMs: number;
  /** All page visit results, one per visited URL. */
  pages: PageVisitResult[];
  /** URLs that were discovered but not visited (depth/max-pages limit reached). */
  unvisitedUrls: string[];
  /** Errors encountered during the crawl. */
  errors: CrawlErrorEntry[];
  /** Whether the crawl completed fully or was interrupted. */
  completionStatus: 'complete' | 'max_pages_reached' | 'max_time_reached' | 'interrupted' | 'error';
}

// ===========================================================================
// 5. ASSEMBLER OUTPUT (deduplicated, structured artifacts)
// ===========================================================================

// ---------------------------------------------------------------------------
// 5a. Route tree (sitemap)
// ---------------------------------------------------------------------------

export interface RouteNode {
  /** URL path segment (e.g. "users" or ":id"). */
  segment: string;
  /** Full URL for this route. */
  url: string;
  /** Page title. */
  title: string;
  /** HTTP status code. */
  statusCode: number;
  /** Content hash for change detection. */
  contentHash: string;
  /** Headings on this page. */
  headings: HeadingEntry[];
  /** Landmarks on this page. */
  landmarks: LandmarkInfo[];
  /** Depth from root. */
  depth: number;
  /** Child route nodes. */
  children: RouteNode[];
  /** Number of forms on this page. */
  formCount: number;
  /** Number of API calls made from this page. */
  apiCallCount: number;
  /** Whether this page has a screenshot. */
  hasScreenshot: boolean;
}

// ---------------------------------------------------------------------------
// 5b. API endpoint groups
// ---------------------------------------------------------------------------

export interface ApiEndpointGroup {
  /** URL pattern with parameter placeholders (e.g. "/api/users/:id"). */
  pattern: string;
  /** HTTP method. */
  method: string;
  /** Classification. */
  classification: RequestClassification;
  /** All observed concrete URLs that matched this pattern. */
  observedUrls: string[];
  /** Number of times this endpoint was called across the crawl. */
  callCount: number;
  /** Pages that called this endpoint. */
  callingPages: string[];
  /** Example request (first observed). */
  exampleRequest: {
    url: string;
    headers: Record<string, string>;
    body?: string;
    contentType?: string;
  };
  /** Example response (first observed). */
  exampleResponse: {
    statusCode: number;
    headers: Record<string, string>;
    body?: string;
    contentType?: string;
    bodySize: number;
  };
  /** All unique status codes observed. */
  observedStatusCodes: number[];
  /** Response content types observed. */
  observedContentTypes: string[];
  /** Whether this endpoint appears to be GraphQL. */
  isGraphQL: boolean;
  /** GraphQL operation names if applicable. */
  graphqlOperations?: string[];
}

// ---------------------------------------------------------------------------
// 5c. Flow graph
// ---------------------------------------------------------------------------

export interface FlowGraph {
  /** All unique nodes (URLs). */
  nodes: Array<{
    url: string;
    title: string;
    /** Route group this node belongs to (for clustering). */
    cluster: string;
  }>;
  /** All navigation edges. */
  edges: NavigationEdge[];
  /** Entry point URL. */
  entryPoint: string;
  /** Dead-end pages (no outgoing links). */
  deadEnds: string[];
  /** Pages that form cycles. */
  cycles: string[][];
}

export interface FlowDiagramSet {
  /** Top-level overview diagram (max 50 nodes). */
  overview: MermaidDiagram;
  /** Per-section sub-diagrams. */
  sections: Array<{
    /** Route prefix for this section (e.g. "/users"). */
    prefix: string;
    diagram: MermaidDiagram;
  }>;
}

export interface MermaidDiagram {
  /** Raw Mermaid definition text (for .mmd file output). */
  definition: string;
  /** Pre-rendered SVG string (for HTML report embedding). Undefined if rendering failed. */
  svg?: string;
}

// ---------------------------------------------------------------------------
// 5d. Screenshot manifest
// ---------------------------------------------------------------------------

export interface ScreenshotManifestEntry {
  /** Page URL. */
  url: string;
  /** Page title. */
  title: string;
  /** Relative path to the full-page screenshot (from output dir). */
  fullPagePath: string;
  /** Relative path to the viewport screenshot. */
  viewportPath: string;
  /** Viewport dimensions. */
  viewport: Viewport;
  /** Full-page image dimensions. */
  dimensions: { width: number; height: number };
  /** SHA-256 hash of the full-page screenshot. */
  fullPageHash: string;
  /** Base64-encoded JPEG thumbnail (320px wide, quality 60). */
  thumbnailBase64: string;
}

// ---------------------------------------------------------------------------
// 5e. Assembled artifacts (Assembler output)
// ---------------------------------------------------------------------------

/**
 * AssembledArtifacts is the structured, deduplicated output of the Assembler.
 * This is the primary input to the ReportGenerator.
 */
export interface AssembledArtifacts {
  /** Crawl metadata. */
  meta: CrawlMeta;
  /** Hierarchical route tree. */
  routeTree: RouteNode;
  /** Flat list of all discovered routes (for search/filter). */
  routes: RouteInfo[];
  /** All forms discovered, deduplicated by (pageUrl + action + method). */
  forms: FormInfo[];
  /** API endpoints grouped by URL pattern. */
  apiEndpoints: ApiEndpointGroup[];
  /** GraphQL operations discovered. */
  graphqlOperations: GraphQLOperation[];
  /** WebSocket connections discovered. */
  webSocketConnections: WebSocketConnection[];
  /** Navigation flow graph. */
  flowGraph: FlowGraph;
  /** Mermaid diagrams (overview + sections). */
  flowDiagrams: FlowDiagramSet;
  /** Screenshot manifest with thumbnail data. */
  screenshots: ScreenshotManifestEntry[];
  /** Crawl errors summary. */
  errors: CrawlErrorEntry[];
}

export interface RouteInfo {
  url: string;
  title: string;
  statusCode: number;
  contentHash: string;
  depth: number;
  formCount: number;
  apiCallCount: number;
  hasScreenshot: boolean;
  discoveryMethod: PageVisitResult['discoveryMethod'];
}

export interface CrawlMeta {
  /** Tool version (from package.json). */
  toolVersion: string;
  /** Target URL that was crawled. */
  targetUrl: string;
  /** When the crawl started (ISO 8601). */
  crawlDate: string;
  /** Total crawl duration in milliseconds. */
  duration: number;
  /** Total pages visited. */
  pagesVisited: number;
  /** Total pages discovered (visited + unvisited). */
  pagesDiscovered: number;
  /** Total forms found. */
  formsFound: number;
  /** Total unique API endpoint patterns found. */
  apiEndpointsFound: number;
  /** Total screenshots taken. */
  screenshotsTaken: number;
  /** Total errors encountered. */
  errorCount: number;
  /** How the crawl ended. */
  completionStatus: CrawlResult['completionStatus'];
  /** Viewport used for primary screenshots. */
  viewport: Viewport;
}

// ===========================================================================
// 6. REPORT DATA (input to ReportGenerator)
// ===========================================================================

/**
 * ReportData is exactly what gets embedded in the HTML report as JSON
 * inside <script type="application/json" id="report-data">.
 * It is a subset of AssembledArtifacts optimized for client-side rendering.
 */
export interface ReportData {
  meta: CrawlMeta;
  sitemap: RouteNode;
  forms: FormInfo[];
  apiMap: ApiEndpointGroup[];
  screenshots: ScreenshotManifestEntry[];
  flowGraph: {
    overviewSvg?: string;
    sections: Array<{ prefix: string; svg?: string }>;
    mermaidDefinition: string;
  };
  errors: CrawlErrorEntry[];
}

// ===========================================================================
// 7. BUNDLE FORMAT (.archaeologist ZIP)
// ===========================================================================

export interface BundleManifest {
  /** Schema version for forward compatibility. */
  version: 1;
  /** Tool identifier. */
  tool: 'playwright-archaeologist';
  /** Tool version that created this bundle. */
  toolVersion: string;
  /** When the bundle was created (ISO 8601). */
  createdAt: string;
  /** Crawl configuration (for diff compatibility checking). */
  config: {
    targetUrl: string;
    depth: number;
    viewport: Viewport;
    concurrency: number;
    maxPages: number;
    followExternal: boolean;
    deepClick: boolean;
  };
  /** Crawl statistics. */
  stats: {
    pagesVisited: number;
    formsFound: number;
    apiEndpoints: number;
    screenshotCount: number;
    duration: number;
  };
  /** All files in the bundle with checksums. */
  files: BundleFileEntry[];
}

export interface BundleFileEntry {
  /** Relative path within the ZIP archive. */
  path: string;
  /** SHA-256 hex digest. */
  sha256: string;
  /** Uncompressed size in bytes. */
  size: number;
  /** File category. */
  type: 'screenshot' | 'json' | 'api-snapshot' | 'manifest';
}

// ===========================================================================
// 8. DIFF RESULT (output of the Diff module)
// ===========================================================================

export interface DiffResult {
  /** Metadata about the comparison. */
  meta: {
    /**
     * `reportUrl` is optional — when present, the diff report will link
     * each row back to the corresponding entry in that bundle's main report.
     */
    oldBundle: {
      path: string;
      createdAt: string;
      targetUrl: string;
      toolVersion: string;
      reportUrl?: string;
    };
    newBundle: {
      path: string;
      createdAt: string;
      targetUrl: string;
      toolVersion: string;
      reportUrl?: string;
    };
    comparedAt: string;
  };
  /** Overall change status. */
  hasChanges: boolean;
  /** Route/sitemap diff. */
  sitemap: SitemapDiff;
  /** Form diff. */
  forms: FormDiff;
  /** API endpoint diff. */
  api: ApiDiff;
  /** Screenshot diff. */
  screenshots: ScreenshotDiff;
  /** Summary counts for terminal and CI output. */
  summary: DiffSummary;
}

export interface DiffSummary {
  routes: { added: number; removed: number; changed: number; unchanged: number };
  forms: { added: number; removed: number; changed: number; unchanged: number };
  api: { added: number; removed: number; changed: number; unchanged: number };
  screenshots: { changed: number; unchanged: number; added: number; removed: number };
}

// ---------------------------------------------------------------------------
// 8a. Sitemap diff
// ---------------------------------------------------------------------------

export interface SitemapDiff {
  added: RouteInfo[];
  removed: RouteInfo[];
  changed: SitemapRouteChange[];
  unchangedCount: number;
}

export interface SitemapRouteChange {
  url: string;
  changes: {
    title?: { old: string; new: string };
    statusCode?: { old: number; new: number };
    contentHash?: { old: string; new: string };
  };
}

// ---------------------------------------------------------------------------
// 8b. Form diff
// ---------------------------------------------------------------------------

export interface FormDiff {
  added: FormInfo[];
  removed: FormInfo[];
  changed: FormChange[];
  unchangedCount: number;
}

export interface FormChange {
  /** Identity key (action:method or id). */
  formId: string;
  /** Page URL where the form lives. */
  pageUrl: string;
  changes: {
    fieldsAdded?: FormField[];
    fieldsRemoved?: FormField[];
    fieldsChanged?: FieldChange[];
    actionChanged?: { old: string; new: string };
    methodChanged?: { old: string; new: string };
  };
}

export interface FieldChange {
  name: string;
  changes: {
    type?: { old: string; new: string };
    required?: { old: boolean; new: boolean };
    options?: { added: string[]; removed: string[] };
    validationPattern?: { old: string; new: string };
    placeholder?: { old: string; new: string };
  };
}

// ---------------------------------------------------------------------------
// 8c. API diff
// ---------------------------------------------------------------------------

export interface ApiDiff {
  added: ApiEndpointGroup[];
  removed: ApiEndpointGroup[];
  changed: ApiEndpointChange[];
  unchangedCount: number;
}

export interface ApiEndpointChange {
  /** Endpoint pattern (e.g. "GET /api/users/:id"). */
  endpointId: string;
  changes: {
    /** Status codes that appeared/disappeared. */
    statusCodesAdded?: number[];
    statusCodesRemoved?: number[];
    /** Response content type changed. */
    contentTypeChanged?: { old: string; new: string };
    /** Response schema fields added/removed (jsondiffpatch delta). */
    schemaDelta?: unknown;
    /** Response body size changed significantly. */
    bodySizeChange?: { old: number; new: number; percentChange: number };
  };
}

// ---------------------------------------------------------------------------
// 8d. Screenshot diff
// ---------------------------------------------------------------------------

export interface ScreenshotDiff {
  added: Array<{ url: string; screenshotPath: string }>;
  removed: Array<{ url: string }>;
  changed: ScreenshotChange[];
  unchangedCount: number;
}

export interface ScreenshotChange {
  url: string;
  /** Percentage of pixels that differ (0-100). */
  diffPercentage: number;
  /** Number of pixels that differ. */
  diffPixelCount: number;
  /** Total pixels in the image. */
  totalPixels: number;
  /** Path to the diff image (red overlay on semi-transparent original). */
  diffImagePath: string;
  /**
   * Path to the heatmap PNG produced by pixelmatch (highlights changed
   * pixels in red). Only populated when the pixel-diff path ran; falls
   * back to an empty string / undefined for the hash-only code path.
   */
  heatmapPath?: string;
  /** Path to the old screenshot. */
  oldScreenshotPath: string;
  /** Path to the new screenshot. */
  newScreenshotPath: string;
  /** Whether the image dimensions changed. */
  dimensionChange?: {
    old: { width: number; height: number };
    new: { width: number; height: number };
  };
  /**
   * Human-readable reason the pixel diff could not run (e.g. "dimension
   * mismatch"). Present only when `diffPercentage` could not be
   * computed accurately.
   */
  diffUnavailableReason?: string;
}

// ===========================================================================
// 9. CHECKPOINT (for resume support)
// ===========================================================================

export interface CheckpointState {
  /** Schema version. */
  version: 1;
  /** When the crawl started. */
  startedAt: string;
  /** When this checkpoint was written. */
  checkpointedAt: string;
  /** URLs still in the frontier queue (to visit). */
  frontier: Array<{ url: string; depth: number; referrer?: string }>;
  /** URLs already visited (normalized). */
  visited: string[];
  /** URLs that were skipped (security block, scope violation, etc.). */
  skipped: string[];
  /** Partial artifacts path (relative to output dir). */
  artifactsDir: string;
  /** Number of pages visited so far. */
  pagesVisited: number;
  /** Errors accumulated so far. */
  errors: CrawlErrorEntry[];
  /** Crawl config hash to verify resume compatibility. */
  configHash: string;
}

// ===========================================================================
// 10. PROGRAMMATIC API (for `import { dig } from 'playwright-archaeologist'`)
// ===========================================================================

/**
 * The public programmatic API returns AssembledArtifacts plus file paths
 * to the generated output.
 */
export interface DigResult {
  artifacts: AssembledArtifacts;
  outputPaths: {
    outputDir: string;
    reportHtml?: string;
    sitemapJson?: string;
    formsJson?: string;
    apiMapJson?: string;
    openapiJson?: string;
    flowGraphMmd?: string;
    harFile?: string;
    screenshotsDir?: string;
    bundle?: string;
  };
  errors: CrawlErrorEntry[];
  completionStatus: CrawlResult['completionStatus'];
}

// ===========================================================================
// 11. GRACEFUL DEGRADATION RULES
// ===========================================================================

/**
 * Graceful degradation contract:
 *
 * | Failure                        | Report still produced? | Missing section | User notification  |
 * |--------------------------------|------------------------|-----------------|-------------------|
 * | Screenshots fail entirely      | Yes                    | Gallery empty   | Warning in report |
 * | Network logging fails          | Yes                    | API Map empty   | Warning in report |
 * | Mermaid SVG rendering fails    | Yes                    | No diagram SVG  | Text definition shown instead |
 * | One form throws during probing | Yes                    | Form skipped    | Error logged     |
 * | HAR recording fails            | Yes                    | No .har file    | Warning in report |
 * | Thumbnail generation fails     | Yes                    | No thumbnails   | Full-size paths only |
 * | OpenAPI generation fails       | Yes                    | No openapi.json | Warning in report |
 * | Checkpoint write fails         | Yes (crawl continues)  | No resume       | Warning logged   |
 * | Flow graph too complex (>2000) | Yes                    | Simplified diagram | Warning in report |
 * | JSON output write fails        | Report may still work  | Missing file(s) | Error logged     |
 * | HTML report generation fails   | No (fatal for HTML)    | N/A             | Error with path  |
 * | Bundle creation fails          | Report still works     | No .archaeologist | Error logged    |
 */

/**
 * Sections that can be independently disabled in the report
 * when their underlying data is missing or their generation failed.
 */
export type DegradedSection =
  | 'screenshots'
  | 'api_map'
  | 'flow_diagram_svg'
  | 'forms'
  | 'openapi'
  | 'har'
  | 'thumbnails';

export interface DegradationReport {
  /** Sections that degraded (data missing or generation failed). */
  degradedSections: Array<{
    section: DegradedSection;
    reason: string;
  }>;
  /** Whether the report was produced despite degradations. */
  reportProduced: boolean;
}
