# playwright-archaeologist

**Generate a complete behavioral specification of any running web app — no source code required.**

[![npm version](https://img.shields.io/npm/v/playwright-archaeologist)](https://www.npmjs.com/package/playwright-archaeologist)
[![license](https://img.shields.io/npm/l/playwright-archaeologist)](./LICENSE)
[![node](https://img.shields.io/node/v/playwright-archaeologist)](https://nodejs.org/)

Point `playwright-archaeologist` at a URL and get back a full behavioral spec: sitemap, form catalog, API map with OpenAPI 3.0 schema, screenshots, navigation flow graph, and a regression baseline you can diff later.

---

## Quick Start

```bash
# Install globally
npm install -g playwright-archaeologist

# Download Chromium (one-time)
pa install

# Crawl a site
pa dig https://example.com

# View the report
open .archaeologist/report.html
```

Or use `npx` without installing:

```bash
npx playwright-archaeologist install
npx playwright-archaeologist dig https://example.com
```

---

## Features

- **Zero source code access** — works on any running web app, staging or production
- **SPA-aware crawling** — Navigation API + History API patching + MutationObserver for client-side route detection
- **Authenticated crawling** — run auth scripts or inject cookies before crawling protected sites
- **Screenshot atlas** — full-page and viewport screenshots with a browsable gallery
- **API discovery** — auto-generates OpenAPI 3.0 specs from observed network traffic
- **Form catalog** — extracts every form with field metadata, validation rules, and structure
- **Flow graph** — Mermaid navigation diagrams showing how pages connect
- **Regression diff** — compare two crawl snapshots, detect structural and visual changes
- **Security-first** — SSRF protection, credential scrubbing, browser CSP hardening
- **Resume support** — checkpoint and resume interrupted crawls

---

## Installation

### Requirements

- Node.js >= 20.0.0
- Chromium is downloaded automatically via `pa install`

### npm

```bash
npm install -g playwright-archaeologist
pa install
```

### As a dev dependency

```bash
npm install --save-dev playwright-archaeologist
npx pa install
```

---

## Usage

### Crawl a website

```bash
# Basic crawl
pa dig https://myapp.com

# Limit depth and pages
pa dig https://myapp.com --depth 3 --max-pages 100

# Custom viewport
pa dig https://myapp.com --viewport 1440x900

# Skip screenshots for a faster crawl
pa dig https://myapp.com --no-screenshots

# Enable deep click exploration for SPAs
pa dig https://myapp.com --deep-click

# Custom output directory
pa dig https://myapp.com -o ./crawl-output

# Resume an interrupted crawl
pa dig https://myapp.com --resume
```

### Compare two snapshots

```bash
# Compare crawl bundles (exit code 0 = identical, 1 = changes)
pa diff ./baseline/bundle ./current/bundle

# Generate an HTML diff report
pa diff ./old-bundle ./new-bundle --format-html diff-report.html

# Generate a JSON diff report
pa diff ./old-bundle ./new-bundle --format-json diff-report.json
```

### Authenticated crawling

```bash
# Using an auth script
pa dig https://myapp.com --auth ./login.js

# Using cookies
pa dig https://myapp.com --cookies ./cookies.json
```

---

## Configuration Reference

### `pa dig` options

| Option | Default | Description |
|---|---|---|
| `-d, --depth <n>` | `5` | Maximum crawl depth from the entry URL |
| `--max-pages <n>` | `1000` | Maximum number of pages to visit |
| `-c, --concurrency <n>` | `3` | Number of parallel browser contexts |
| `--auth <script>` | — | Path to an auth script (runs before crawling) |
| `--cookies <file>` | — | Path to a cookies JSON file |
| `-o, --output <dir>` | `.archaeologist` | Output directory for all artifacts |
| `--no-screenshots` | `false` | Skip screenshot capture |
| `--viewport <WxH>` | `1280x720` | Viewport dimensions |
| `--viewports <list>` | — | Comma-separated viewport list for multi-viewport screenshots |
| `--deep-click` | `false` | Click interactive elements to discover SPA routes |
| `--resume` | `false` | Resume from the last checkpoint |
| `--include <pattern>` | — | URL patterns to include (repeatable) |
| `--exclude <pattern>` | — | URL patterns to exclude (repeatable) |
| `--follow-external` | `false` | Follow links to external origins |
| `--include-iframes` | `false` | Crawl cross-origin iframes |
| `--delay <ms>` | `0` | Delay between page visits (0-60000ms) |
| `--timeout <ms>` | `30000` | Per-page navigation timeout (1000-300000ms) |
| `--max-time <s>` | `3600` | Global crawl timeout in seconds (0=no limit, max 86400) |
| `--include-cookies` | `false` | Include cookies and auth data in output |
| `-f, --format <fmt>` | `both` | Output format: `html`, `json`, `openapi`, `both` |
| `--no-har` | `false` | Skip HAR recording |
| `--allow-private` | `false` | Bypass SSRF protection (allow private IPs) |
| `-y, --yes` | `false` | Skip confirmation prompts |
| `-v, --verbose` | `false` | Enable debug logging |

### `pa diff` options

| Option | Default | Description |
|---|---|---|
| `--format-html <path>` | — | Write an HTML diff report |
| `--format-json <path>` | — | Write a JSON diff report |
| `--format-junit <path>` | — | Write a JUnit XML report |
| `--format-markdown <path>` | — | Write a Markdown report |
| `-o, --output <dir>` | — | Output directory for diff artifacts |
| `--threshold <n>` | `0.1` | Pixel diff threshold (0-1) |
| `--max-ratio <n>` | `0.5` | Max allowed diff ratio (0-100) |
| `--ignore-fields <fields>` | `timestamp,createdAt,...` | Comma-separated fields to ignore in comparisons |
| `--normalize-dynamic` | `false` | Normalize UUIDs/timestamps before diff |
| `--detailed` | `false` | Show value-level diffs (not just schema-level) |
| `-v, --verbose` | `false` | Enable debug logging |

---

## Output Structure

After a crawl, the `.archaeologist/` directory contains:

```
.archaeologist/
  report.html            # Browsable HTML report with all findings
  sitemap.json           # Discovered pages with metadata
  forms.json             # Form catalog with field details
  api-map.json           # Observed API endpoints
  openapi.json           # Generated OpenAPI 3.0 specification
  flow-graph.mmd         # Navigation flow diagram (Mermaid text)
  screenshots/           # Full-page and viewport screenshots
    index_full.png
    index_viewport.png
    ...
  bundle/                # Snapshot bundle for regression diffing
    manifest.json
    data/
    screenshots/
  checkpoint.json        # Resume checkpoint (deleted on completion)
```

---

## Programmatic API

Use `playwright-archaeologist` as a library in your own tools:

```typescript
import { dig, CrawlConfigSchema } from 'playwright-archaeologist';

// Validate and resolve config via Zod schema
const config = CrawlConfigSchema.parse({
  targetUrl: 'https://myapp.com',
  depth: 3,
  maxPages: 50,
  concurrency: 2,
  outputDir: './my-output',
  noScreenshots: false,
  viewport: { width: 1280, height: 720 },
});

const result = await dig(config);

console.log(`Crawled ${result.artifacts.meta.pagesVisited} pages`);
console.log(`Found ${result.artifacts.forms.length} forms`);
console.log(`Discovered ${result.artifacts.apiEndpoints.length} API endpoints`);
```

### Comparing snapshots programmatically

```typescript
import { diffBundles, generateDiffReportHtml } from 'playwright-archaeologist';
import { writeFile } from 'node:fs/promises';

const diff = await diffBundles('./old-bundle', './new-bundle');

if (diff.hasChanges) {
  const s = diff.summary;
  console.log('Changes detected:');
  console.log(`  Routes added: ${s.routes.added}`);
  console.log(`  Routes removed: ${s.routes.removed}`);
  console.log(`  APIs changed: ${s.api.changed}`);

  // Generate HTML report
  const html = generateDiffReportHtml(diff);
  await writeFile('diff-report.html', html);
}
```

### Using individual collectors

```typescript
import { scanPage, probeForms, captureScreenshots } from 'playwright-archaeologist';
import { chromium } from 'playwright';

const browser = await chromium.launch();
const context = await browser.newContext();
const page = await context.newPage();

await page.goto('https://myapp.com/login');

// Scan page structure
const scan = await scanPage(page);

// Probe forms
const forms = await probeForms(page);

// Capture screenshots
const screenshots = await captureScreenshots(page, {
  viewport: { width: 1280, height: 720 },
});

await browser.close();
```

---

## Auth Script Example

Auth scripts run in a real browser context before crawling begins. They receive a Playwright `page` object:

```javascript
// login.js
export default async function authenticate(page) {
  await page.goto('https://myapp.com/login');
  await page.fill('#email', 'test@example.com');
  await page.fill('#password', process.env.TEST_PASSWORD);
  await page.click('button[type="submit"]');
  await page.waitForURL('**/dashboard');
}
```

```bash
TEST_PASSWORD=secret pa dig https://myapp.com --auth ./login.js
```

Auth scripts are statically analyzed before execution and require confirmation for scripts that access the filesystem, network, or run shell commands.

---

## Cookies File Format

The cookies file follows the Playwright cookie format:

```json
[
  {
    "name": "session",
    "value": "abc123",
    "domain": "myapp.com",
    "path": "/",
    "httpOnly": true,
    "secure": true
  }
]
```

---

## Security Considerations

`playwright-archaeologist` is designed to crawl potentially untrusted web applications. Several protections are built in:

- **SSRF protection** — Private/internal IP ranges (10.x, 172.16-31.x, 169.254.x, 127.x, ::1) are blocked by default. Only same-origin navigation is permitted unless explicitly expanded.
- **Credential scrubbing** — Authorization headers, cookies, and bearer tokens are redacted from all output artifacts by default.
- **Browser hardening** — `bypassCSP: true` for instrumentation, `serviceWorkers: 'block'`, `acceptDownloads: false`, and automatic dialog dismissal to prevent crawler hangs.
- **Auth script sandboxing** — Auth scripts undergo static analysis before execution. Scripts accessing `fs`, `child_process`, or making network requests outside the target domain trigger a confirmation prompt.
- **Output sanitization** — All target-sourced data is entity-encoded in HTML reports. Reports include a restrictive CSP meta tag.

---

## CI / Regression Testing

Use `playwright-archaeologist` in CI to catch behavioral regressions:

```yaml
# .github/workflows/behavioral-regression.yml
name: Behavioral Regression
on: [pull_request]

jobs:
  regression:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4

      - name: Start app
        run: npm start &

      - name: Install pa
        run: npx playwright-archaeologist install

      - name: Crawl
        run: npx pa dig http://localhost:3000 -o ./current

      - name: Download baseline
        uses: actions/download-artifact@v4
        with:
          name: behavioral-baseline
          path: ./baseline

      - name: Diff
        run: |
          npx pa diff ./baseline/bundle ./current/bundle \
            --format-html regression-report.html

      - name: Upload report
        if: failure()
        uses: actions/upload-artifact@v4
        with:
          name: regression-report
          path: regression-report.html
```

---

## Contributing

Contributions are welcome. Please open an issue first to discuss what you would like to change.

```bash
# Clone and install
git clone https://github.com/BFAlajid/playwright-archaeologist.git
cd playwright-archaeologist
npm install

# Build
npm run build

# Run tests
npm test

# Run tests in watch mode
npm run test:watch

# Run benchmarks
npm run bench
```

### Project structure

```
src/
  cli.ts              # CLI entry point (Commander.js)
  index.ts            # Programmatic API exports
  crawl/              # BFS crawler, frontier, context pool, checkpoints
  collectors/         # Page scanner, form prober, network logger, screenshots
  assembler/          # API grouper, flow graph builder
  auth/               # Auth script handler
  report/             # HTML report generator
  diff/               # Snapshot diff engine and reports
  bundle/             # Directory-based bundle creator
  security/           # SSRF guard, credential scrubber, output sanitizer
  types/              # TypeScript interfaces, Zod schemas, error hierarchy
  utils/              # Logger, URL utilities, progress tracker
```

---

## Troubleshooting

| Problem | Solution |
|---|---|
| `Chromium browser not found` | Run `pa install` to download Chromium |
| `SSRF: blocked private IP` on localhost | Use `--allow-private` to bypass SSRF protection for local development |
| Auth script rejected | Check for forbidden imports (`fs`, `child_process`, `net`). Confirm the prompt if the script is trusted. |
| Permission denied on output dir | Ensure the output directory is writable. Use `-o` to specify a different path. |
| Page navigation timeout | Increase with `--timeout 60000` (ms). Default is 30s. |
| Crawl taking too long | Reduce scope with `--max-pages` or `--depth`. Use `--no-screenshots` for faster crawls. |
| Resume not working | Ensure `checkpoint.json` exists in the output dir. Use the same `--output` path. |

---

## Error Codes

| Code | Error | When | Recovery |
|---|---|---|---|
| `ERR_CONFIG` | ConfigError | Invalid CLI options or config values | Check option syntax, run `pa dig --help` |
| `ERR_AUTH` | AuthError | Auth script not found, import failed, or execution error | Verify script path and exports |
| `ERR_NAVIGATION` | NavigationError | Page timeout, network error, HTTP error | Automatic skip; crawl continues |
| `ERR_COLLECTOR` | CollectorError | Scanner/prober/logger/capturer failure | Partial data collected; crawl continues |
| `ERR_BROWSER_CONTEXT` | BrowserContextError | Browser context crash | Context recycled; page re-enqueued |
| `ERR_FRONTIER` | FrontierError | Queue or checkpoint I/O failure | Crawl continues without checkpointing |
| `ERR_SECURITY_BLOCK` | SecurityBlockError | SSRF or protocol violation | URL skipped; crawl continues |
| `ERR_ASSEMBLER` | AssemblerError | Data merge/dedup failure | Crawl aborts; partial output may exist |
| `ERR_REPORT` | ReportError | Report generation failure | Section skipped; other outputs still written |
| `ERR_DIFF` | DiffError | Bundle not found or corrupt manifest | Check bundle paths; re-run crawl |
| `ERR_BUNDLE` | BundleError | Bundle I/O or integrity failure | Check disk space and permissions |

Exit codes: `0` = success (or identical diff), `1` = changes detected (diff), `2` = error.

---

## License

[MIT](./LICENSE)
