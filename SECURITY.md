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
