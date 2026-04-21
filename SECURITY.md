# Security Policy

## Supported Versions

playwright-archaeologist is pre-1.0 and actively developed. Only the latest 0.1.x
release line receives security fixes.

| Version | Supported          |
| ------- | ------------------ |
| 0.1.x   | :white_check_mark: |
| < 0.1   | :x:                |

## Reporting a Vulnerability

Please **do not** open public issues for suspected security problems.

Use GitHub's private vulnerability reporting to disclose issues responsibly:

1. Go to the [Security Advisories page](https://github.com/BFAlajid/playwright-archaeologist/security/advisories/new)
2. Click **Report a vulnerability**
3. Provide a clear description, reproduction steps, affected versions, and any
   proof-of-concept artifacts.

You can expect:

- An acknowledgement within **5 business days**.
- A triage update within **14 days** confirming severity and expected timeline.
- Credit in release notes unless you prefer to remain anonymous.

## In-Scope Vulnerability Classes

The following are considered in scope for coordinated disclosure:

- **SSRF bypass** — crawl reaching targets that the network guard should
  block (loopback, link-local, metadata endpoints, RFC 1918 ranges).
- **Credential leakage** — secrets, cookies, tokens, or `Authorization`
  headers appearing in persisted artifacts, HTML reports, HAR files,
  flow graphs, or logs.
- **Sandbox escape** — the crawler (or a crawled page) executing arbitrary
  code on the host outside of the browser context, or escaping the
  Playwright context into the user's environment.
- **XSS in generated HTML reports** — injection via crawled URLs, form
  values, API responses, or page titles that executes when a report is
  opened.
- **Path traversal** in artifact write paths.

## SSRF Protections — Scope and Opt-Outs

The crawler applies SSRF protections in layers. Understanding what each
layer covers matters when you decide whether a finding is in scope.

1. **Pre-dequeue URL check** (`src/security/network-guard.ts`:`isBlockedUrl`).
   Before a URL is even added to the crawl frontier, its protocol is
   whitelisted (http/https only), its hostname is checked against the
   metadata blocklist, direct-private-IP forms (including octal/hex/decimal
   encodings) are rejected, and the hostname is resolved via DNS. If DNS
   returns a private IP, the URL is dropped with `fail-closed` semantics.

2. **Per-request route guard** (`ctx.route('**', createNetworkGuard(...))`).
   Every outbound request — including subresources like images, iframes,
   fetch/XHR — passes through `isBlockedUrl` again, plus a rebinding
   check: if the hostname's DNS answer has changed since we first cached
   it and the fresh answer includes a private IP, the request is blocked.

3. **Socket-level DNS pinning** (new — `src/security/pinned-fetch.ts`).
   For first-party GET/HEAD requests (same registrable-domain approximation
   as the entry URL), the guard stops calling `route.continue()` and
   instead fulfills the request itself via a Node HTTPS/HTTP agent that
   connects directly to the pinned IP. This eliminates the time-of-check /
   time-of-use window between our resolver and the browser's own
   `connect()` — an attacker cannot flip DNS between those two lookups,
   because the browser never performs the second lookup. TLS SNI uses
   the original hostname, so certificate validation still fires. The
   `Host:` header is preserved so virtual-hosted servers route correctly.

   Scope and caveats of layer 3:
   - Applies to **GET and HEAD only** today. Other methods fall through
     to the OS-resolver path (layer 2 still covers them).
   - Applies to **first-party subresources only** by default (hostname
     shares the last two labels of the entry URL's hostname). Third-party
     assets (CDNs, analytics, embeds) fall through — pinning every asset
     would add per-request overhead without closing a meaningful attack.
     The programmatic API accepts `pinCrossOrigin: true` to opt into
     pinning all origins.
   - **Disabled automatically under `--allow-private`.** If you told the
     crawler it may reach private IPs, layer 3 does not engage — you have
     already accepted the SSRF risk layer 3 exists to close.
   - **Disabled via `--no-socket-pinning`.** Useful only for debugging or
     for crawling HTTP/2-only origins that cannot negotiate HTTP/1.1.
   - **HTTP/2 and WebSockets are not pinned.** Node's http/https module
     speaks HTTP/1.1 at this layer. The custom agent forces
     `ALPNProtocols: ['http/1.1']` so HTTP/2-capable origins downgrade.
     Origins that refuse h1 will fail to connect through the pinned
     path; in that case the guard aborts the request (it does NOT
     silently fall back to `route.continue()` — doing so would defeat
     the guarantee that layer 3 exists to provide).
   - Response bodies are capped at 50 MiB. A hostile server streaming an
     unbounded body cannot exhaust the crawler's memory via this path.

**When `--allow-private` is set**, layers 1-3 are bypassed for private
ranges by design. The crawler assumes you are knowingly auditing an
internal target and accept the SSRF tradeoff.

## Out of Scope

- Vulnerabilities in transitive dependencies that have published upstream
  advisories — please report to the upstream project. We monitor Dependabot.
- Issues requiring an attacker to already have local shell access.
- Crashes or hangs without a security impact (file these as regular bugs).
- Findings from scanners without a concrete exploitation scenario.

## Safe Harbor

Good-faith security research, including automated testing against isolated
environments you control, is welcome. Please do not run experiments against
third-party sites without their authorization.
