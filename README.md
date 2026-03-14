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
pa diff .archaeologist/bundle-old.zip .archaeologist/bundle-new.zip

# Generate an HTML diff report
pa diff old.zip new.zip --format-html diff-report.html

# Generate a JSON diff report
pa diff old.zip new.zip --format-json diff-report.json
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

### `pa diff` options

| Option | Description |
|---|---|
| `--format-html <path>` | Write an HTML diff report |
| `--format-json <path>` | Write a JSON diff report |

---

## Output Structure

After a crawl, the `.archaeologist/` directory contains:

```
.archaeologist/
  report.html            # Browsable HTML report with all findings
  sitemap.json           # Discovered pages with metadata
  forms.json             # Form catalog with field details
  api.json               # Observed API endpoints
  openapi.yaml           # Generated OpenAPI 3.0 specification
  flow-graph.svg         # Navigation flow diagram (Mermaid)
  screenshots/           # Full-page and viewport screenshots
    index.png
    about.png
    ...
  bundle.zip             # Snapshot bundle for regression diffing
  checkpoint.json        # Resume checkpoint (deleted on completion)
```

---

## Programmatic API

Use `playwright-archaeologist` as a library in your own tools:

```typescript
import { dig } from 'playwright-archaeologist';

const result = await dig({
  entryUrl: 'https://myapp.com',
  depth: 3,
  maxPages: 50,
  concurrency: 2,
  output: './my-output',
  screenshots: true,
  viewport: { width: 1280, height: 720 },
});

console.log(`Crawled ${result.pages.length} pages`);
console.log(`Found ${result.forms.length} forms`);
console.log(`Discovered ${result.apis.length} API endpoints`);
```

### Comparing snapshots programmatically

```typescript
import { diffBundles, generateDiffReportHtml } from 'playwright-archaeologist';

const diff = await diffBundles('./old-bundle.zip', './new-bundle.zip');

if (diff.hasChanges) {
  console.log('Changes detected:');
  console.log(`  Pages added: ${diff.pages.added.length}`);
  console.log(`  Pages removed: ${diff.pages.removed.length}`);
  console.log(`  APIs changed: ${diff.apis.modified.length}`);

  // Generate HTML report
  const html = generateDiffReportHtml(diff);
  await fs.writeFile('diff-report.html', html);
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
          npx pa diff ./baseline/bundle.zip ./current/bundle.zip \
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
git clone https://github.com/AshGw/playwright-archaeologist.git
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
  bundle/             # ZIP bundle creator
  security/           # SSRF guard, credential scrubber, output sanitizer
  types/              # TypeScript interfaces, Zod schemas, error hierarchy
  utils/              # Logger, URL utilities, progress tracker
```

---

## License

[MIT](./LICENSE)
