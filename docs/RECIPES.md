# Recipes

Task-oriented snippets for common `playwright-archaeologist` workflows. Each
recipe assumes `pa` is installed globally (or run via `npx`) and that
`pa install` has downloaded Chromium.

---

## Crawling behind SSO / OAuth

Log in once in an auth script; `pa` reuses the resulting browser storage
state for every crawled page. Keep credentials in env vars, never in the
script file.

```bash
# login.mjs — runs once before crawling
export default async function login(page) {
  await page.goto('https://sso.myorg.com/login');
  await page.fill('#email', process.env.SSO_USER);
  await page.fill('#password', process.env.SSO_PASS);
  await page.click('button[type="submit"]');
  await page.waitForURL('**/dashboard');
}
```

```bash
SSO_USER=$USER SSO_PASS=$PASS pa dig https://app.myorg.com \
  --auth ./login.mjs --allow-auth-script
```

`--allow-auth-script` is required because the validator otherwise refuses to
execute user code.

---

## Staging vs. production diff in CI

Crawl both environments, diff the bundles, and fail the build when anything
changed. `pa diff` exits with code `1` on any change, `2` on error.

```bash
pa dig https://staging.myapp.com -o ./staging
pa dig https://prod.myapp.com -o ./prod

pa diff ./prod/bundle ./staging/bundle \
  --format-junit diff.xml \
  --format-html diff.html \
  --max-ratio 0.5
```

Upload `diff.html` as a CI artifact for visual triage and publish `diff.xml`
as a JUnit test result. The `--max-ratio` flag caps acceptable pixel
drift per screenshot.

---

## Staging vs. production in CI (single command)

`pa diff-env` collapses the two-step recipe above into one parallel command.
Both environments crawl simultaneously and the diff runs as soon as both
bundles are ready.

```bash
pa diff-env https://staging.myapp.com https://prod.myapp.com \
  --output ./diff-env-output \
  --format junit \
  --fail-on routes-removed \
  --label-a staging --label-b prod
```

Exit codes:

| `--fail-on` value | Exit 1 when... |
|---|---|
| `any` (default) | Any route, form, API, or screenshot changed |
| `routes-removed` | At least one route was removed |
| `routes-changed` | Routes were added, removed, or modified |
| `forms` | A form was added, removed, or modified |
| `api` | An API endpoint was added, removed, or modified |
| `screenshots` | A screenshot changed |
| `none` | Never fail (run for the report only) |

Output layout (under `--output`):

```
diff-env-output/
  a/                   Env A crawl (including bundle/)
  b/                   Env B crawl (including bundle/)
  diff/                Diff report + heatmaps
    report.xml         When --format junit
    report.html        When --format html
    report.json        When --format json
    report.md          When --format markdown
    heatmaps/*.png     Pixel-diff overlays
```

The one-line log summary at the end (`diff-env: A=<host> B=<host> | +N
routes, -M routes, ...`) is grep-friendly for CI dashboards. For a GitHub
Actions workflow, add:

```yaml
- name: Diff staging vs prod
  run: pa diff-env "$STAGING_URL" "$PROD_URL" --output ./diff-env-output --format junit --fail-on any
- name: Upload diff report
  uses: actions/upload-artifact@v4
  with:
    name: diff-env-output
    path: diff-env-output/
```

---

## Multi-viewport responsive audit

Pass a comma-separated viewport list. Each page is captured at every
viewport; the report renders a per-page grid.

```bash
pa dig https://myapp.com \
  --viewports "375x667,768x1024,1440x900"
```

In `report.html`, each sitemap row expands to show screenshots side by side
under "Viewports". Compare layouts without leaving the browser.

---

## Excluding admin / internal routes

Combine `--exclude` globs to drop noisy paths before they enter the
frontier. Repeat the flag for multiple patterns.

```bash
pa dig https://myapp.com \
  --exclude "**/admin/**" \
  --exclude "**/_next/**" \
  --exclude "**/api/internal/**"
```

Excluded URLs are never fetched, so scope reductions here cut crawl time
linearly. Use `--include` to invert the logic and whitelist only specific
sections.

---

## Storage-state reuse across runs

Authenticate once, then reuse the resulting cookies across multiple crawls
by exporting them to a JSON file and passing `--cookies`.

```bash
# Export cookies after logging in manually in Playwright inspector,
# then save them as cookies.json.
pa dig https://myapp.com --cookies ./cookies.json -o ./run-1
pa dig https://myapp.com --cookies ./cookies.json -o ./run-2
```

Cookie files follow the standard Playwright format (array of cookies with
`name`, `value`, `domain`, `path`). See the README "Cookies File Format"
section for the schema.

---

## Large-site crawls

Cap breadth, depth, and concurrency explicitly. Expect roughly
`150 MB + 30 MB × concurrency` of resident memory; the frontier alone is
bounded to ~50 MB of URLs by default.

```bash
pa dig https://big-site.com \
  --depth 4 \
  --max-pages 5000 \
  --concurrency 6 \
  --max-time 3600 \
  --no-screenshots
```

Drop `--no-screenshots` if you need visual regression later. `--concurrency`
scales linearly until the target's rate limits push back; start at 3, double
until crawl time plateaus.

---

## Resuming a long crawl

Every `pa dig` run writes `.checkpoint.json` to the output directory every
30 seconds while crawling. If the run is interrupted (SIGINT, crash,
budget timeout), relaunch with `--resume` to pick up where it left off.

```bash
# First run — gets interrupted after a few hundred pages.
pa dig https://big-site.com --depth 4 --max-pages 10000 -o ./crawl-out

# Ctrl-C here. The checkpoint file captures the frontier + visited set.

# Resume the crawl. Same command + --resume.
pa dig https://big-site.com --depth 4 --max-pages 10000 -o ./crawl-out --resume
```

Resuming requires an **identical config hash**. Config fields that shape
the crawl (targetUrl, depth, maxPages, include/exclude, viewport,
concurrency, etc.) must match the original run. Fields that are purely
path-local (outputDir, authScript, cookiesFile) are ignored by the hash,
so you can rerun into a different output path without losing your
checkpoint.

If the hash mismatches, `pa` refuses to resume with a clear error — delete
`.checkpoint.json` or rerun without `--resume` to start fresh. A fresh
run with an existing checkpoint logs a warning but preserves the file
(so you can recover if `--resume` was simply forgotten).

On successful crawl completion the checkpoint file is deleted; on
partial/interrupted/error completion it is preserved for the next
`--resume`.

---

## CI integration with GitHub Actions

Crawl on every pull request, store the bundle as a cache-able artifact, and
comment the diff summary on the PR.

```yaml
- name: Crawl current branch
  run: npx pa dig http://localhost:3000 -o ./current

- name: Restore baseline
  uses: actions/download-artifact@v4
  with: { name: pa-baseline, path: ./baseline }

- name: Diff
  run: npx pa diff ./baseline/bundle ./current/bundle \
         --format-markdown diff.md --format-junit diff.xml

- uses: marocchino/sticky-pull-request-comment@v2
  if: always()
  with: { path: diff.md }
```

The sticky-comment action keeps one PR comment in sync instead of adding a
new one on every run. `diff.md` is designed to render directly as a PR
comment.

---

## Accessibility audit gate

Run axe-core with `--with-a11y`, then use `jq` to extract violations and
fail the build when the count exceeds a threshold.

```bash
pa dig https://myapp.com --with-a11y
VIOLATIONS=$(jq '[.[] | .violations[]] | length' \
  .archaeologist/accessibility.json)
echo "a11y violations: $VIOLATIONS"
test "$VIOLATIONS" -le 5
```

The JSON is an array of per-page results. Each entry has `url`, `violations`,
`passes`, and `incomplete`. The `jq` expression above counts total
violations across all pages.

---

## Starter Playwright suite from a crawl

Skip scripting the first cut of a Playwright suite by hand — crawl once,
emit, review. The generated specs are intentionally conservative (no
flaky assertions, no timing guesses), so they are safe to keep as a
baseline while you tighten expectations over time.

```bash
# Crawl once to produce ./staging/bundle.
pa dig https://staging.myapp.com -o ./staging

# Emit a starter suite. smoke + one file per page with forms,
# one file per connected flow cluster, one file per API group.
pa emit-tests ./staging/bundle -o ./tests/generated

# Run with your own Playwright install (the tool does not bundle one).
npx playwright test ./tests/generated
```

Target a different environment without re-crawling by rewriting the base:

```bash
pa emit-tests ./staging/bundle -o ./tests/prod-smoke \
  --base-url https://prod.myapp.com
```

The header in every emitted file points back to the source bundle and
carries a `starting point — review assertions` marker. Treat the output
as a `git add -p` checkpoint, not final code: broaden locators, tighten
status assertions, and move shared setup into `beforeEach` as the suite
stabilises.

Narrowing by route segment (useful when only part of the app is changing):

```bash
# Only emit tests whose URL path contains "/admin" or "/billing"
pa emit-tests ./staging/bundle -o ./tests/sensitive \
  --filter-by-tag admin,billing
```

---

## Which crawl-discovered routes have no test?

Feed an existing Playwright test suite into `pa coverage` alongside a crawl
bundle and find out which pages and APIs your suite doesn't exercise yet.
Use it as a CI gate by setting `--fail-on`.

```bash
# Crawl your app once.
pa dig https://staging.myapp.com -o ./staging

# Compare a local Playwright suite against the crawl.
pa coverage ./staging/bundle \
  --tests ./tests/e2e \
  -o ./coverage.html
```

Example output (truncated):

```
INFO  Coverage: routes 47/62 (75.81%), APIs 12/28 (42.86%), overall 65.56%
OK    Coverage report: ./coverage.html
```

Gate a PR on a minimum overall percentage and emit JUnit XML so Jenkins /
GitLab / CircleCI pipelines render the results as test failures:

```bash
pa coverage ./staging/bundle \
  --tests ./tests/e2e \
  --format junit \
  --fail-on 80 \
  -o ./coverage-junit.xml
```

A common pattern is to ignore telemetry / admin routes that your E2E suite
will never exercise:

```bash
pa coverage ./staging/bundle \
  --tests ./tests/e2e \
  --ignore '**/api/internal/**' \
  --ignore '**/admin/**' \
  --ignore '**/healthz' \
  -o ./coverage.html
```

When the bundle was crawled against a different environment than the test
suite targets (e.g. crawl against staging, tests against prod), use
`--base-url` to tell the scanner what origin `${process.env.BASE_URL}` and
similar placeholders should expand to:

```bash
pa coverage ./prod-bundle \
  --tests ./tests/e2e \
  --base-url https://prod.example.com \
  -o ./coverage.html
```

Matching rules (heuristic, not a full TypeScript parser):

- Routes are matched by pathname. `?q=foo` and `?q=bar` are treated as the
  same logical page.
- APIs are matched by `(method, parameterizedPath)` — a test hitting
  `/users/42` covers a bundle endpoint at `/users/:id`.
- Tests with non-literal URL arguments (`page.goto(someVariable)`) are not
  counted; the scanner only classifies literal string arguments.

---

## Programmatic plugin example

Implement the `Collector` contract, register it, and let `dig` drive it on
every page. This example records the total transferred JavaScript size per
page.

```typescript
import { dig, resolveConfig, type Collector } from 'playwright-archaeologist';

const bundleSizeCollector: Collector<{ totalJsBytes: number }> = {
  name: 'bundle-size',
  async collect({ page }) {
    const entries = await page.evaluate(() =>
      performance.getEntriesByType('resource')
        .filter((e: any) => e.initiatorType === 'script')
        .map((e: any) => e.transferSize ?? 0),
    );
    return { totalJsBytes: entries.reduce((a, b) => a + b, 0) };
  },
};

const result = await dig(resolveConfig({
  targetUrl: 'https://myapp.com',
  collectors: [bundleSizeCollector],
}));

for (const p of result.pages) {
  console.log(p.url, p.pluginData?.['bundle-size']);
}
```

Collectors run with a 30-second per-plugin timeout. Throwing inside
`collect` records the error on that page only; sibling collectors and the
crawl continue.

---

## Query your crawl from Claude (MCP)

Rather than parsing `api-map.json` or `accessibility.json` by hand, point
Claude (Desktop or Code) at the bundle over MCP and ask questions in
English. `pa mcp` starts a local stdio MCP server that exposes the
bundle as queryable tools and resources.

```bash
# One-time crawl
pa dig https://staging.myapp.com --with-a11y -o ./staging

# Start the server (Claude Desktop config does this for you; shown
# here so you can smoke-test before wiring it into Claude).
pa mcp ./staging/bundle
```

Claude Desktop config (`~/Library/Application Support/Claude/claude_desktop_config.json`
on macOS, `%APPDATA%\Claude\claude_desktop_config.json` on Windows):

```jsonc
{
  "mcpServers": {
    "playwright-archaeologist": {
      "command": "pa",
      "args": ["mcp", "/absolute/path/to/staging/bundle"]
    }
  }
}
```

Useful prompts once it is wired up:

- *"Using playwright-archaeologist, list every POST form that has no
  CSRF token."* → calls `find_forms_without_csrf`.
- *"Show me the top 20 critical a11y violations with their help URLs."*
  → calls `list_accessibility_violations` with `impact: 'critical'`.
- *"Which routes returned 5xx during the crawl?"* → calls
  `list_broken_routes` with `min_status: 500`.
- *"What does the `/api/users/:id` endpoint return?"* → calls
  `get_api_endpoint` and surfaces the `exampleResponse`.

The server is read-only, local, and never touches the network. It
reads the bundle once at startup — re-run `pa mcp` after regenerating
the bundle.
