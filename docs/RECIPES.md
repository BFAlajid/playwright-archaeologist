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
