/**
 * Multi-environment diff — crawl two environments in parallel and diff them.
 *
 * One-liner for CI: `pa diff-env https://staging https://prod`. This module
 * is pure glue. It reuses `dig()` to crawl each environment, `createBundle`
 * to turn each raw crawl output into a bundle directory, and `diffBundles`
 * to produce the regression report. No new crawl, bundle, or diff logic
 * lives here.
 *
 * Design notes:
 *   - Injection seams (`digImpl`, `createBundleImpl`, `diffBundlesImpl`) let
 *     unit tests stub the expensive pieces without touching `vi.mock` or
 *     spinning up Chromium.
 *   - Parallel crawls run via `Promise.all`. If one side fails, the error
 *     is wrapped so the caller can tell which environment failed — callers
 *     should NOT silently skip the diff.
 *   - `DiffEnvOptions.sharedCrawlConfig` is a shallow merge into each
 *     per-env `resolveConfig({ targetUrl, outputDir, ...shared })` call.
 *     `targetUrl` and `outputDir` inside `sharedCrawlConfig` are ignored —
 *     they are derived from the env URL and the `outputDir` layout.
 */

import { mkdir, writeFile, copyFile, access } from 'node:fs/promises';
import { join, resolve } from 'node:path';

import type { CrawlConfig, ResolvedConfig } from '../types/config.js';
import type { DigResult, DiffResult, DiffSummary, BundleManifest } from '../types/artifacts.js';
import { ConfigError } from '../types/errors.js';
import { resolveConfig } from '../types/config.js';

import { dig as defaultDig } from '../crawl/orchestrator.js';
import { createBundle as defaultCreateBundle } from '../bundle/bundle-creator.js';
import { diffBundles as defaultDiffBundles, type DiffBundlesOptions } from '../diff/diff-engine.js';
import { generateDiffReportHtml } from '../diff/diff-report.js';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export type DiffEnvFormat = 'html' | 'json' | 'junit' | 'markdown';

export type DiffEnvFailOn =
  | 'any'
  | 'routes-removed'
  | 'routes-changed'
  | 'forms'
  | 'api'
  | 'screenshots'
  | 'none';

/**
 * The subset of CrawlConfig fields that `diff-env` forwards to each
 * per-env `dig()` call. Narrower than `CrawlConfig` because some fields
 * (targetUrl, outputDir) are controlled by the orchestrator itself.
 */
export type SharedCrawlConfig = Partial<
  Omit<CrawlConfig, 'targetUrl' | 'outputDir'>
>;

export interface DiffEnvOptions {
  /** Entry URL for environment A (will be normalized). */
  envAUrl: string;
  /** Entry URL for environment B (will be normalized). */
  envBUrl: string;
  /** Output directory for both crawls + diff. Subdirs `a/`, `b/`, `diff/` are created under it. */
  outputDir: string;
  /** Options forwarded to `diffBundles`. */
  diffOptions?: DiffBundlesOptions;
  /** CrawlConfig fields applied to BOTH environments. */
  sharedCrawlConfig?: SharedCrawlConfig;
  /** Human label for env A (default: parsed from URL hostname). */
  labelA?: string;
  /** Human label for env B (default: parsed from URL hostname). */
  labelB?: string;
  /** Diff report format. Default 'html'. */
  format?: DiffEnvFormat;
  /** Exit-code policy. Default 'any'. */
  failOn?: DiffEnvFailOn;
}

export interface DiffEnvResult {
  /** Summary counts from the diff engine. */
  summary: DiffSummary;
  /** True when the failOn policy should produce a non-zero CLI exit. */
  shouldFail: boolean;
  /** Absolute path to env A's bundle directory. */
  bundleAPath: string;
  /** Absolute path to env B's bundle directory. */
  bundleBPath: string;
  /** Absolute path to the written diff report file. */
  diffReportPath: string;
  /** The raw diff result (useful for programmatic consumers). */
  diff: DiffResult;
  /** Labels (resolved, never undefined). */
  labelA: string;
  labelB: string;
}

/**
 * Dependency-injection seam. Production callers omit this and get the real
 * implementations. Tests supply stubs so they do not need a browser.
 */
export interface DiffEnvDeps {
  digImpl?: (config: ResolvedConfig) => Promise<DigResult>;
  createBundleImpl?: (sourceDir: string, bundleDir: string) => Promise<BundleManifest>;
  diffBundlesImpl?: (oldDir: string, newDir: string, options?: DiffBundlesOptions) => Promise<DiffResult>;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Derive a short human label from a URL. Used when the caller does not
 * override `labelA` / `labelB`. Hostname is sufficient for most CI
 * scenarios ("staging.myapp.com" vs "myapp.com").
 */
function labelFromUrl(url: string): string {
  try {
    const parsed = new URL(url);
    return parsed.hostname;
  } catch {
    // Fall back to the raw string — URL normalization happens before this
    // helper runs, so the only way we get here is genuinely malformed input.
    return url;
  }
}

/**
 * Build a `ResolvedConfig` for one environment by merging the shared config
 * with env-specific fields. `targetUrl` and `outputDir` in `shared` are
 * ignored — we own them here.
 */
function buildEnvConfig(
  targetUrl: string,
  outputDir: string,
  shared: SharedCrawlConfig | undefined,
): ResolvedConfig {
  const raw: Record<string, unknown> = {
    ...(shared ?? {}),
    targetUrl,
    outputDir,
  };
  return resolveConfig(raw);
}

/**
 * Evaluate the failOn policy against a DiffSummary. Returns true when the
 * caller should exit non-zero.
 */
export function evaluateFailOn(summary: DiffSummary, failOn: DiffEnvFailOn): boolean {
  switch (failOn) {
    case 'none':
      return false;
    case 'any':
      return (
        summary.routes.added + summary.routes.removed + summary.routes.changed +
        summary.forms.added + summary.forms.removed + summary.forms.changed +
        summary.api.added + summary.api.removed + summary.api.changed +
        summary.screenshots.added + summary.screenshots.removed + summary.screenshots.changed > 0
      );
    case 'routes-removed':
      return summary.routes.removed > 0;
    case 'routes-changed':
      return summary.routes.added + summary.routes.removed + summary.routes.changed > 0;
    case 'forms':
      return summary.forms.added + summary.forms.removed + summary.forms.changed > 0;
    case 'api':
      return summary.api.added + summary.api.removed + summary.api.changed > 0;
    case 'screenshots':
      return summary.screenshots.added + summary.screenshots.removed + summary.screenshots.changed > 0;
    default: {
      const _exhaustive: never = failOn;
      return Boolean(_exhaustive);
    }
  }
}

/**
 * Render the diff report in the requested format. Returns the path the
 * report was written to.
 *
 * html     -> report.html
 * json     -> report.json
 * markdown -> report.md
 * junit    -> report.xml
 */
async function writeDiffReport(
  diff: DiffResult,
  diffDir: string,
  format: DiffEnvFormat,
  labelA: string,
  labelB: string,
): Promise<string> {
  let filename: string;
  let body: string;

  switch (format) {
    case 'html': {
      filename = 'report.html';
      body = generateDiffReportHtml(diff);
      break;
    }
    case 'json': {
      filename = 'report.json';
      body = JSON.stringify(diff, null, 2);
      break;
    }
    case 'markdown': {
      filename = 'report.md';
      body = renderMarkdownSummary(diff, labelA, labelB);
      break;
    }
    case 'junit': {
      filename = 'report.xml';
      body = renderJunitSummary(diff, labelA, labelB);
      break;
    }
    default: {
      const _exhaustive: never = format;
      throw new Error(`Unsupported diff format: ${String(_exhaustive)}`);
    }
  }

  const outPath = join(diffDir, filename);
  await writeFile(outPath, body, 'utf-8');
  return outPath;
}

/** Minimal Markdown summary — one line per change category. */
function renderMarkdownSummary(diff: DiffResult, labelA: string, labelB: string): string {
  const { summary } = diff;
  const lines: string[] = [];
  lines.push(`# Diff: ${labelA} vs ${labelB}`);
  lines.push('');
  lines.push(`Compared at: ${diff.meta.comparedAt}`);
  lines.push('');
  lines.push('| Category | Added | Removed | Changed | Unchanged |');
  lines.push('|---|---:|---:|---:|---:|');
  lines.push(`| Routes | ${summary.routes.added} | ${summary.routes.removed} | ${summary.routes.changed} | ${summary.routes.unchanged} |`);
  lines.push(`| Forms | ${summary.forms.added} | ${summary.forms.removed} | ${summary.forms.changed} | ${summary.forms.unchanged} |`);
  lines.push(`| API | ${summary.api.added} | ${summary.api.removed} | ${summary.api.changed} | ${summary.api.unchanged} |`);
  lines.push(`| Screenshots | ${summary.screenshots.added} | ${summary.screenshots.removed} | ${summary.screenshots.changed} | ${summary.screenshots.unchanged} |`);
  lines.push('');
  lines.push(diff.hasChanges ? '_Changes detected._' : '_No changes detected._');
  return lines.join('\n') + '\n';
}

/**
 * Minimal JUnit XML summary. One `<testsuite>` with four `<testcase>`
 * entries (routes/forms/api/screenshots); a case "fails" when its
 * category shows any add/remove/change. Enough to light up JUnit-aware
 * CI consoles without pulling in a new dep.
 */
function renderJunitSummary(diff: DiffResult, labelA: string, labelB: string): string {
  const { summary } = diff;
  const cats: Array<{ name: string; counts: { added: number; removed: number; changed: number } }> = [
    { name: 'routes', counts: summary.routes },
    { name: 'forms', counts: summary.forms },
    { name: 'api', counts: summary.api },
    { name: 'screenshots', counts: summary.screenshots },
  ];

  const failures = cats.filter((c) => c.counts.added + c.counts.removed + c.counts.changed > 0);

  const esc = (s: string): string =>
    s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

  const cases = cats.map((c) => {
    const changes = c.counts.added + c.counts.removed + c.counts.changed;
    if (changes === 0) {
      return `    <testcase name="${esc(c.name)}" classname="diff-env.${esc(labelA)}.${esc(labelB)}"/>`;
    }
    const msg = `added=${c.counts.added} removed=${c.counts.removed} changed=${c.counts.changed}`;
    return `    <testcase name="${esc(c.name)}" classname="diff-env.${esc(labelA)}.${esc(labelB)}">\n` +
      `      <failure message="${esc(msg)}"/>\n` +
      `    </testcase>`;
  });

  return `<?xml version="1.0" encoding="UTF-8"?>
<testsuite name="diff-env" tests="${cats.length}" failures="${failures.length}">
${cases.join('\n')}
</testsuite>
`;
}

/**
 * Copy the source crawl's HTML report into the diff output tree so a
 * reviewer opening `diff/report.html` can navigate back to either
 * environment's full report via a relative link. Failure here is
 * non-fatal — the diff report is still valid without the mirrors.
 */
async function mirrorCrawlReport(
  sourceReportPath: string | undefined,
  destDir: string,
): Promise<string | undefined> {
  if (!sourceReportPath) return undefined;
  try {
    await access(sourceReportPath);
  } catch {
    return undefined;
  }
  const destPath = join(destDir, 'report.html');
  try {
    await copyFile(sourceReportPath, destPath);
    return destPath;
  } catch {
    return undefined;
  }
}

// ---------------------------------------------------------------------------
// Main entry point
// ---------------------------------------------------------------------------

/**
 * Crawl two environments in parallel, bundle each result, and produce a
 * diff report. The caller's CLI wrapper is responsible for converting
 * `shouldFail` into a process exit code.
 *
 * @throws {ConfigError} When either env URL is missing or invalid after
 *   resolveConfig normalization.
 * @throws {Error} When either underlying `dig()` call throws. The error
 *   message is prefixed with `crawl of env A failed:` or `crawl of env B
 *   failed:` so CI logs can attribute the failure.
 */
export async function runDiffEnv(
  options: DiffEnvOptions,
  deps: DiffEnvDeps = {},
): Promise<DiffEnvResult> {
  if (!options.envAUrl || typeof options.envAUrl !== 'string') {
    throw new ConfigError('envAUrl', 'envAUrl is required', options.envAUrl);
  }
  if (!options.envBUrl || typeof options.envBUrl !== 'string') {
    throw new ConfigError('envBUrl', 'envBUrl is required', options.envBUrl);
  }
  if (!options.outputDir || typeof options.outputDir !== 'string') {
    throw new ConfigError('outputDir', 'outputDir is required', options.outputDir);
  }

  const digImpl = deps.digImpl ?? defaultDig;
  const createBundleImpl = deps.createBundleImpl ?? defaultCreateBundle;
  const diffBundlesImpl = deps.diffBundlesImpl ?? defaultDiffBundles;

  const format: DiffEnvFormat = options.format ?? 'html';
  const failOn: DiffEnvFailOn = options.failOn ?? 'any';

  // --- Set up the output directory structure ---
  const outputDir = resolve(options.outputDir);
  const aOutputDir = join(outputDir, 'a');
  const bOutputDir = join(outputDir, 'b');
  const diffDir = join(outputDir, 'diff');

  await mkdir(aOutputDir, { recursive: true });
  await mkdir(bOutputDir, { recursive: true });
  await mkdir(diffDir, { recursive: true });

  // --- Build each environment's resolved config ---
  // resolveConfig normalizes the URL (prepends https://) and validates it.
  // We do this BEFORE launching the crawls so a bad URL fails fast with
  // ConfigError rather than halfway through one of the crawls.
  const configA = buildEnvConfig(options.envAUrl, aOutputDir, options.sharedCrawlConfig);
  const configB = buildEnvConfig(options.envBUrl, bOutputDir, options.sharedCrawlConfig);

  // Labels — use the resolved URL's hostname if the caller didn't provide one.
  const labelA = options.labelA ?? labelFromUrl(configA.targetUrl);
  const labelB = options.labelB ?? labelFromUrl(configB.targetUrl);

  // --- Crawl both envs in parallel ---
  // We want a clear attribution ("env A failed") when one side fails, so
  // wrap each dig() to tag its own rejection before Promise.all sees it.
  const digA = digImpl(configA).then(
    (r) => ({ env: 'a' as const, result: r }),
    (err: unknown) => {
      const msg = err instanceof Error ? err.message : String(err);
      throw new Error(`crawl of env A (${labelA}) failed: ${msg}`);
    },
  );
  const digB = digImpl(configB).then(
    (r) => ({ env: 'b' as const, result: r }),
    (err: unknown) => {
      const msg = err instanceof Error ? err.message : String(err);
      throw new Error(`crawl of env B (${labelB}) failed: ${msg}`);
    },
  );

  const [resA, resB] = await Promise.all([digA, digB]);

  // --- Build a bundle per environment ---
  // The diff engine consumes bundle directories (manifest.json + data/...),
  // not raw crawl output directories. `createBundle` is the same helper the
  // `pa dig` CLI runs after a crawl completes.
  const bundleAPath = join(aOutputDir, 'bundle');
  const bundleBPath = join(bOutputDir, 'bundle');
  await createBundleImpl(resA.result.outputPaths.outputDir, bundleAPath);
  await createBundleImpl(resB.result.outputPaths.outputDir, bundleBPath);

  // --- Mirror each crawl's HTML report into the diff tree ---
  // Non-fatal: a missing report just means the diff report won't link
  // back. The diff itself still produces.
  await mirrorCrawlReport(resA.result.outputPaths.reportHtml, aOutputDir);
  await mirrorCrawlReport(resB.result.outputPaths.reportHtml, bOutputDir);

  // --- Run the diff ---
  // Place heatmaps in the diff dir so the HTML report's `<img src>` paths
  // resolve relative to report.html.
  const diffOptions: DiffBundlesOptions = {
    ...(options.diffOptions ?? {}),
    heatmapDir: options.diffOptions?.heatmapDir ?? join(diffDir, 'heatmaps'),
  };
  const diff = await diffBundlesImpl(bundleAPath, bundleBPath, diffOptions);

  // --- Emit the report in the requested format ---
  const diffReportPath = await writeDiffReport(diff, diffDir, format, labelA, labelB);

  // --- Decide the exit-code policy ---
  const shouldFail = evaluateFailOn(diff.summary, failOn);

  return {
    summary: diff.summary,
    shouldFail,
    bundleAPath,
    bundleBPath,
    diffReportPath,
    diff,
    labelA,
    labelB,
  };
}

/**
 * Build the one-line CI summary the CLI prints.
 * Format:
 *   diff-env: A=<labelA> B=<labelB> | +N routes, -M routes, ~K changed, Q forms changed, P APIs changed
 */
export function formatDiffEnvSummary(result: DiffEnvResult): string {
  const { summary, labelA, labelB } = result;
  const parts = [
    `+${summary.routes.added} routes`,
    `-${summary.routes.removed} routes`,
    `~${summary.routes.changed} changed`,
    `${summary.forms.added + summary.forms.removed + summary.forms.changed} forms changed`,
    `${summary.api.added + summary.api.removed + summary.api.changed} APIs changed`,
  ];
  return `diff-env: A=${labelA} B=${labelB} | ${parts.join(', ')}`;
}
