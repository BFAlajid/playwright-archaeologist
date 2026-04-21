# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

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
