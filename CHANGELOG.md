# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added
- `pa coverage <bundle> --tests <dir>` CLI command and programmatic API (`scanTestDirectory`, `computeCoverage`, `generateCoverageReportHtml` / `Json` / `Markdown` / `JUnit`): measure which crawl-discovered routes and API endpoints have a matching Playwright test. The scanner walks `.spec.ts` / `.test.ts` / `.mjs` / `.spec.mjs` files (skipping `node_modules`, `.git`, `dist`, `build`, `coverage`, etc.) and extracts literal URL arguments from `page.goto`, `page.navigate`, `request.<verb>`, and `apiRequestContext.<verb>` calls. Template literals resolve `${process.env.BASE_URL}`, `${BASE_URL}`, `${baseURL}`, and `${baseUrl}` to a caller-supplied `baseUrl`; unknown placeholders are replaced with a `__PA_TEMPLATE__` marker so the URL still parses. Routes are matched by pathname (query strings do not split coverage); API endpoints are matched by `(method, parameterizedPath)` so a test against `/users/42` covers the bundle's `/users/:id` endpoint. `--format html|json|markdown|junit|both` selects the output shape; the HTML report shares tokens with the crawl and diff reports (CSP meta, light/dark theme toggle, chip-bar filter for covered vs. uncovered). `--fail-on <pct>` gates CI; `--ignore <glob>` (repeatable) drops routes/APIs before totals are computed. `CoverageError` is exported from `playwright-archaeologist`; `src/coverage/bundle-loader.ts` reads only sitemap + api-map + manifest from the bundle. No new dependencies.
- `pa mcp <bundle>` CLI command and `startMcpServer` library export: serve a crawl bundle to Claude (or any MCP-compatible client) over an MCP stdio server. Registers six read-only tools over the bundle — `search_routes(query, status?, limit?)`, `list_forms(has_password?, method?, limit?)`, `find_forms_without_csrf()` (heuristic over `/csrf|_token|authenticity|xsrf/i` on field names and labels, excludes `GET` forms), `get_api_endpoint(method, pattern)` (falls back to `parameterizePath` so concrete URLs resolve to their parameterized group), `list_accessibility_violations(impact?, limit?)` (returns `{present:false}` when `--with-a11y` was not used), and `list_broken_routes(min_status?, limit?)`. Six resources mirror the on-disk artifacts — `bundle://manifest`, `bundle://sitemap`, `bundle://forms`, `bundle://api-map`, `bundle://flow-graph`, and `bundle://accessibility` (last is only registered when the file exists). The bundle is loaded once at startup; tool functions (`src/mcp/tools.ts`) are pure and unit-tested without the SDK. Graceful shutdown on SIGINT/SIGTERM and on stdin EOF. Server logs go to stderr so stdout stays a clean JSON-RPC channel. New runtime dependency: `@modelcontextprotocol/sdk ^1.29.0` (marked external in `tsup.config.ts`, so the tarball grows only by the source of `src/mcp/*`; SDK pulls in `zod`, which we already depend on). `startMcpServer` is exported from `playwright-archaeologist`.
- `pa diff-env <envAUrl> <envBUrl>` CLI command and `runDiffEnv` library export: crawl two environments in parallel and produce a regression diff in one command. Both crawls run via `Promise.all`; each result is bundled via `createBundle`; the two bundles are then compared via `diffBundles`. Output layout: `<out>/a/bundle/`, `<out>/b/bundle/`, `<out>/diff/report.{html,json,md,xml}` (format selected by `--format`, default `html`). New `--fail-on <type>` policy selects which change categories produce exit code 1 (`any`, `routes-removed`, `routes-changed`, `forms`, `api`, `screenshots`, `none`). `--label-a` / `--label-b` override the default hostname-derived labels. All `pa dig` crawl knobs (`--depth`, `--max-pages`, `--concurrency`, `--timeout`, `--include`, `--exclude`, `--auth`, `--cookies`, `--viewport`, `--allow-private`) are inherited and apply to both crawls. `DiffEnvOptions`, `DiffEnvResult`, `DiffEnvDeps`, `DiffEnvFormat`, `DiffEnvFailOn`, and `SharedCrawlConfig` types are exported from the public API; `evaluateFailOn` and `formatDiffEnvSummary` helpers are also exported. No new dependencies.
- `pa emit-tests <bundle>` CLI command and `emitTests` library export: read a crawl bundle and generate starter Playwright `.spec.ts` files (`smoke`, `forms/{page}.spec.ts`, `flows/{n}.spec.ts`, `api/{endpoint}.spec.ts`). Emitted tests import only `@playwright/test`; consumers supply their own Playwright install. `--base-url` rewrites URLs for CI against a different environment; `--flows-only`, `--forms-only`, and `--filter-by-tag` narrow what is produced. Flow files with more than 5 steps split into one test per step (shared `describe`); shorter flows collapse into a single test with `test.step` blocks. `EmitError` and `EmitOptions` are exported from the public API.
- `--resume` CLI flag: resume an interrupted crawl from the last checkpoint. Checkpoint state (frontier + visited URLs + errors + pagesVisited) is written to `.checkpoint.json` in the output directory every 30 seconds, and deleted on successful completion. Config hashing ignores path-local fields (outputDir, authScript, cookiesFile) so a rerun into a different output directory still resumes correctly; mismatched crawl-shaping fields (depth, maxPages, targetUrl, etc.) throw `CheckpointMismatchError` to prevent nonsensical resumes. New `src/crawl/config-hash.ts` (SHA-256 over canonical JSON) drives the compatibility check. Running without `--resume` while a checkpoint exists logs a warning but preserves the file.
- `CheckpointMismatchError` exported from `src/types/errors.ts`.
- `Frontier.snapshot()` method: non-destructive read of pending entries for checkpointing.
- `CrawlLoopInput.skipVisitedUrls` and `CrawlLoopInput.progressSink` wiring in `runCrawlLoop` for resume state threading.
- **Socket-level DNS pinning** (`src/security/pinned-fetch.ts`). First-party GET/HEAD requests are now fulfilled via a custom Node HTTPS/HTTP agent that connects directly to the IP the network guard pre-approved, rather than letting Playwright's Chromium call the OS resolver a second time. This closes the TOCTOU window between our resolver and the browser's own TCP connect — attackers who flip DNS between those two lookups no longer reach the browser. Preserves TLS SNI via `tls.connect({ servername })` and the original `Host:` header via request-header rewriting, so certificate validation and virtual hosting still work. Redirects are followed manually with per-hop re-pinning (max 5 hops). Response bodies are hard-capped at 50 MiB to prevent memory blowup. New `--no-socket-pinning` CLI flag and `socketPinning` config option (default `true`) opt out. Automatically disabled when `--allow-private` is set, since the user has already accepted the SSRF risk. Cross-origin subresources fall through to the OS resolver unless `pinCrossOrigin` is set via the programmatic API — pinning every CDN asset would add per-request overhead without closing a meaningful attack.

### Changed
- SSRF protection language upgraded from "best-effort DNS rebinding detection" to "socket-level pinning for first-party GET/HEAD, with best-effort rebinding detection as a second layer for cross-origin subresources and non-idempotent methods". See `SECURITY.md` for the explicit scope and opt-out mechanics.
- Performance bench files (`test/performance/*.bench.ts`) now exercise the real shipped modules from `src/` instead of inlined fake reimplementations:
  - `crawl-simulation.bench.ts` calls `Frontier`, `normalizeUrl`, `buildRouteTree`, and `buildAssembledArtifacts`.
  - `diff.bench.ts` calls `diffBundles` (over tmp bundle directories written synchronously per iteration) and `diffScreenshotPair` (over synthetic PNGs produced with `pngjs`).
  - `report-generation.bench.ts` calls `generateReportHtml` and `generateDiffReportHtml`.
- `test/performance/budget.json` metrics renamed and pruned to match the new bench names. Removed entries that no longer correspond to anything measured (`sha256Hash100Screenshots`, `pixelmatch10/100Screenshots`, `jsondiffpatch1000Endpoints`, `zipCreation100Pages`, `zipExtraction100Pages`, `base64Encode100/500Thumbnails`, `jsonSerializationTime`, `peakRssDuringGeneration`, `htmlFileSize100/500Pages`, `memoryAt100/10000/50000Urls`, `has10000UrlCheck`, `apiGrouperWith5000Requests`, `routeTreeWith500Urls`, `flowGraphWith500Nodes`, `size100/500Pages`, `rssMaxDuring500PageCrawl`). Added `report.htmlGeneration1000Pages`, `report.htmlGeneration10000Pages`, `report.diffReportGeneration`, `diff.pixelDiff100x100`, `diff.pixelDiff1000x1000`, `assembler.routeTreeWith1000Urls`, `assembler.buildAssembledArtifacts500Pages`. The matcher in `enforce-budget.test.ts` (`benchLower.includes(keyLower.slice(0, 8))`) is unchanged — bench names still contain the first 8 characters of their budget key.

## [0.2.0] - 2026-04-21

### Added
- `resolveConfig(raw)` library helper that normalizes URLs, applies defaults, and resolves paths to absolute form. Programmatic API consumers no longer need to call `CrawlConfigSchema.parse` themselves.
- `--allow-auth-script` CLI flag: explicit opt-in required to execute user-supplied authentication scripts.
- `--har-include-bodies` CLI flag: opt in to capturing response bodies in HAR (default omits bodies).
- `--capture-js-bodies` CLI flag: opt in to capturing response bodies for `application/javascript` responses (default skips them because bundle files frequently contain hard-coded API keys).
- `--pretty` CLI flag: emits pretty-printed JSON artifacts.
- `sanitizeUrl` and `sanitizeSvg` helpers in the report-escape module.
- `isSafeBundlePath` helper: rejects `..`, absolute paths, UNC paths, and percent-encoded traversal in bundle manifests.
- Post-crawl HAR scrubber: headers, cookies, request/response bodies, and redirect URLs are passed through the credential scrubber before the HAR file is written.
- Best-effort DNS rebinding detection in the network guard: each outbound request re-resolves the hostname and blocks only when the fresh resolution returns a private IP not matching the pinned public address. Public-to-public rotation (CDN round-robin) is allowed. This does not fully close the TOCTOU window between the guard's resolver and the browser's own TCP connect — tightening that requires socket-level IP pinning, tracked for a future release.
- Context-level SSRF guard: `createNetworkGuard` is now wired via `context.route('**', ...)` so subresource fetches (images, iframes, XHR) are blocked in addition to top-level navigations.
- Hierarchical sitemap tree in generated reports (previously a flat list).
- Flow-diagram fallback: when SVG pre-render is unavailable, the report embeds the Mermaid definition as escaped `<pre>` content so users still see the graph text.
- GitHub Actions release workflow with npm provenance attestation.
- CodeQL analysis workflow.
- Dependabot configuration for npm and GitHub Actions.
- `SECURITY.md` with disclosure policy.
- `CONTRIBUTING.md` with contributor setup.

### Changed
- `recordHar.content` defaults to `'omit'` instead of `'embed'`. Bundles no longer ship full response bodies in the HAR by default.
- GraphQL `variables` are scrubbed through `scrubJsonObject` before being captured. Argument-style secrets in the `query` string (e.g., `password: "..."`) are masked.
- URLs with embedded credentials (`https://user:pass@host`) are stripped during normalization before the URL is stored or logged.
- Metadata hostname blocklist expanded to cover Azure IMDS, Alibaba, Oracle, IPv6 link-local metadata, and IPv4 broadcast.
- The orchestrator now uses the shared `scanPage` collector instead of a duplicated inline implementation; real HTTP status codes are recorded (previously defaulted to 200).
- `tsup` `splitting` disabled (the Node CLI does not benefit from code splitting).
- `dig()` no longer rebuilds the flow graph twice. Route tree construction is hierarchical (was flat-under-root).
- `DiffConfigSchema` fields (`diffThreshold`, `diffMaxRatio`, `diffIgnoreFields`) moved off `CrawlConfigSchema`; they live only on the diff config now.

### Removed
- `src/instrumentation/click-strategy.ts` (unused, pre-M1 scaffolding).
- Unused helpers in `src/instrumentation/init-script.ts` (`NavigationCollector` class, `setupPageInstrumentation`, `setupContextInstrumentation`, `instrumentPage`). `getInitScript` is retained.
- Unused `MAX_REDIRECTS` and `AWS_SECRET_KEY_RE` constants.
- Stale `<script type="application/json" id="report-data">` block from the HTML template (nothing read it).
- Public re-exports from `src/index.ts` for checkpoint helpers and `ContextPool` until they are wired (they were advertising unimplemented resume/concurrency features).
- `--resume` CLI flag, pending checkpoint wiring.
- Sourcemaps from the published npm tarball (still emitted for local debugging).

### Fixed
- Report: form field names of empty strings now render as `(unnamed)` rather than `": text"`. The `badge-required` class is only applied to required fields; a new `badge-sensitive` class flags `password`, `email`, `tel` inputs.
- Report: `crawlDate` uses the real crawl start time, not the post-launch timestamp. `duration` is consistently milliseconds.
- Report: flow diagram section now renders (was hard-disabled).
- `dig()` O(n²) passes over routes × pages replaced with a single `Map<url, page>` lookup.
- README programmatic API example now compiles against the current `dig()` signature.
- `executeAuthScript` calls `validateAuthScript` before importing; warnings block execution unless `--allow-auth-script` is set.
- Bundle manifest paths are validated against traversal before use in the diff engine.
- Release build produces a single `cli.js` and `index.js` instead of hash-suffixed split chunks.

### Security
- HAR credential scrubbing post-capture (headers, cookies, postData, URLs, response bodies).
- Auth-script execution gated behind `--allow-auth-script` with validator-enforced static analysis.
- Best-effort DNS rebinding detection — blocks when re-resolution reveals a new private IP, allows public-to-public rotation, and documents the residual TOCTOU window vs. the browser's own connect.
- Context-level SSRF guard (`ctx.route('**', ...)`) so subresource requests are subject to the same private-IP and rebinding checks as top-level navigation.
- SVG content is sanitized before inclusion in reports; `sanitizeUrl` rejects non-`http(s)` schemes in generated href attributes.
- Bundle manifest paths validated against traversal; NUL bytes and other control characters are rejected.
- Cloud metadata blocklist expanded (Azure IMDS, Alibaba, Oracle, IPv6 link-local metadata, IPv4 broadcast).
- ContextPool race condition fixed — `pendingCreations` counter is incremented synchronously before awaiting `browser.newContext()`, so concurrent `acquire()` calls cannot over-allocate contexts beyond the configured concurrency.

## [0.1.1] - 2026-03-24

### Fixed
- Hardened security posture, accessibility, build pipeline, and documentation.

## [0.1.0] - 2026-03-12

### Added
- Initial release of `playwright-archaeologist`.
- `dig` command: crawl a running web app and emit sitemap, forms, API catalog, screenshots, flow graph, and an HTML report.
- `diff` command: compare two crawl bundles and emit a diff report.
- `install` command: install the Playwright Chromium build used by the crawler.
- Zod-based configuration schema with sensible defaults.
- SSRF guard, credential scrubbing, and output-path sanitization.
