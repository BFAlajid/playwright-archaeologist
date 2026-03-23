/**
 * playwright-archaeologist CLI entry point.
 *
 * Parses command-line arguments with Commander.js, validates configuration
 * with Zod, and dispatches to the appropriate handler (dig, diff, install).
 */

import { Command, Option } from 'commander';
import { createRequire } from 'node:module';
import { resolve, dirname } from 'node:path';
import { execSync } from 'node:child_process';
import { accessSync, constants } from 'node:fs';
import {
  CrawlConfigSchema,
  DiffConfigSchema,
  normalizeEntryUrl,
  parseViewport,
} from './types/config.js';
import type { ResolvedConfig, Viewport } from './types/config.js';
import { ConfigError, AuthError, ArchaeologistError, DiffError } from './types/errors.js';
import { logger } from './utils/logger.js';
import { dig } from './crawl/orchestrator.js';
import { diffBundles } from './diff/diff-engine.js';
import { generateDiffReportHtml } from './diff/diff-report.js';
import { createBundle } from './bundle/bundle-creator.js';

// ---------------------------------------------------------------------------
// Load package.json for version
// ---------------------------------------------------------------------------

const require = createRequire(import.meta.url);
const pkg = require('../package.json') as { version: string };

// ---------------------------------------------------------------------------
// Viewport parsing helper
// ---------------------------------------------------------------------------

/**
 * Parse a viewport string "WxH" or throw a ConfigError.
 */
function parseViewportStrict(input: string, fieldName: string): Viewport {
  const vp = parseViewport(input);
  if (!vp) {
    throw new ConfigError(
      fieldName,
      `Invalid viewport format "${input}". Expected WxH (e.g. 1280x720). Width must be 320-7680, height 240-4320.`,
      input,
    );
  }
  return vp;
}

/**
 * Parse a comma-separated list of viewport strings.
 */
function parseViewportList(input: string): Viewport[] {
  const parts = input.split(',').map((s) => s.trim()).filter(Boolean);
  if (parts.length === 0) {
    throw new ConfigError('viewports', 'No viewports specified in --viewports.', input);
  }
  return parts.map((part) => parseViewportStrict(part, 'viewports'));
}

/**
 * Collect repeatable --include / --exclude options into arrays.
 */
function collectArray(value: string, previous: string[]): string[] {
  return previous.concat(value);
}

/**
 * Parse an integer option with a descriptive name for errors.
 */
function parseIntOption(value: string, name: string): number {
  const n = parseInt(value, 10);
  if (!Number.isFinite(n)) {
    throw new ConfigError(name, `"${value}" is not a valid integer for --${name}.`, value);
  }
  return n;
}

// ---------------------------------------------------------------------------
// Program
// ---------------------------------------------------------------------------

const program = new Command();

program
  .name('playwright-archaeologist')
  .description('Generate a complete behavioral specification of any web app')
  .version(pkg.version, '-V, --version');

// ---------------------------------------------------------------------------
// `dig` command
// ---------------------------------------------------------------------------

program
  .command('dig')
  .description('Crawl a website and generate a behavioral specification')
  .argument('<url>', 'URL to crawl (https:// is prepended if no protocol)')

  // -- Discovery options --
  .option('-d, --depth <n>', 'Maximum crawl depth from entry URL (default: 5)', (v) => parseIntOption(v, 'depth'))
  .option('--max-pages <n>', 'Maximum total pages to visit (default: 1000)', (v) => parseIntOption(v, 'max-pages'))
  .option('--include <pattern>', 'URL glob patterns to include (repeatable)', collectArray, [])
  .option('--exclude <pattern>', 'URL glob patterns to exclude (repeatable)', collectArray, [])
  .option('--follow-external', 'Follow links to external origins', false)
  .option('--deep-click', 'Click non-link interactive elements to discover SPA states', false)
  .option('--include-iframes', 'Crawl cross-origin iframe content', false)

  // -- Performance options --
  .option('-c, --concurrency <n>', 'Number of parallel browser contexts (default: 3)', (v) => parseIntOption(v, 'concurrency'))
  .option('--delay <ms>', 'Delay between page visits per context in ms (default: 0)', (v) => parseIntOption(v, 'delay'))
  .option('--timeout <ms>', 'Per-page navigation timeout in ms (default: 30000)', (v) => parseIntOption(v, 'timeout'))
  .option('--max-time <s>', 'Global crawl timeout in seconds (default: 3600)', (v) => parseIntOption(v, 'max-time'))

  // -- Auth options --
  .option('--auth <script>', 'Path to auth script (.ts or .js)')
  .option('--cookies <file>', 'Path to cookies JSON file for session injection')
  .option('--include-cookies', 'Include cookies/auth headers in output (default: scrubbed)', false)

  // -- Output options --
  .option('-o, --output <dir>', 'Output directory (default: .archaeologist)')
  .option('-f, --format <fmt>', 'Output format: html, json, openapi, both (default: both)')
  .option('--no-screenshots', 'Skip screenshot capture')
  .option('--no-har', 'Skip HAR recording')

  // -- Display options --
  .option('--viewport <WxH>', 'Primary viewport dimensions (default: 1280x720)')
  .option('--viewports <list>', 'Additional viewports for responsive screenshots (comma-separated, e.g. 375x667,768x1024)')

  // -- Resume options --
  .option('--resume', 'Resume from last checkpoint in the output directory', false)
  .option('-y, --yes', 'Skip confirmation prompts', false)

  // -- Security options --
  .option('--allow-private', 'Allow crawling private/internal IP ranges', false)

  // -- Debug options --
  .option('-v, --verbose', 'Enable debug logging', false)

  .action(async (url: string, opts: Record<string, unknown>) => {
    // Enable debug logging first so all subsequent logs are visible
    if (opts.verbose) {
      logger.setLevel('debug');
    }

    logger.debug('Raw CLI options: %o', opts);

    try {
      // --- Normalize the entry URL ---
      const { url: normalizedUrl, warnings } = normalizeEntryUrl(url);
      for (const w of warnings) {
        logger.warn(w);
      }

      // --- Validate auth script path ---
      let authScript: string | undefined;
      if (typeof opts.auth === 'string') {
        authScript = resolve(opts.auth);
        try {
          accessSync(authScript, constants.R_OK);
        } catch {
          throw new AuthError(
            'script_not_found',
            `Auth script not found: ${authScript}`,
            authScript,
          );
        }
      }

      // --- Validate cookies file path ---
      let cookiesFile: string | undefined;
      if (typeof opts.cookies === 'string') {
        cookiesFile = resolve(opts.cookies);
        try {
          accessSync(cookiesFile, constants.R_OK);
        } catch {
          throw new AuthError(
            'cookie_file_not_found',
            `Cookies file not found: ${cookiesFile}`,
            cookiesFile,
          );
        }
      }

      // --- Parse viewport ---
      let viewport: Viewport | undefined;
      if (typeof opts.viewport === 'string') {
        viewport = parseViewportStrict(opts.viewport, 'viewport');
      }

      // --- Parse additional viewports ---
      let additionalViewports: Viewport[] | undefined;
      if (typeof opts.viewports === 'string') {
        additionalViewports = parseViewportList(opts.viewports);
      }

      // --- Resolve output directory ---
      const outputDir = resolve(typeof opts.output === 'string' ? opts.output : '.archaeologist');

      // Validate parent directory exists
      const parentDir = dirname(outputDir);
      try {
        accessSync(parentDir, constants.W_OK);
      } catch {
        throw new ConfigError(
          'outputDir',
          `Output directory parent does not exist or is not writable: ${parentDir}`,
          outputDir,
        );
      }

      // --- Build the raw config object for Zod validation ---
      const rawConfig: Record<string, unknown> = {
        targetUrl: normalizedUrl,
        outputDir,
      };

      if (opts.depth !== undefined) rawConfig.depth = opts.depth;
      if (opts.maxPages !== undefined) rawConfig.maxPages = opts.maxPages;
      if (opts.include && (opts.include as string[]).length > 0) rawConfig.include = opts.include;
      if (opts.exclude && (opts.exclude as string[]).length > 0) rawConfig.exclude = opts.exclude;
      if (opts.followExternal) rawConfig.followExternal = true;
      if (opts.deepClick) rawConfig.deepClick = true;
      if (opts.includeIframes) rawConfig.includeIframes = true;
      if (opts.concurrency !== undefined) rawConfig.concurrency = opts.concurrency;
      if (opts.delay !== undefined) rawConfig.delay = opts.delay;
      if (opts.timeout !== undefined) rawConfig.timeout = opts.timeout;
      if (opts.maxTime !== undefined) rawConfig.maxTime = opts.maxTime;
      if (authScript) rawConfig.authScript = authScript;
      if (cookiesFile) rawConfig.cookiesFile = cookiesFile;
      if (opts.includeCookies) rawConfig.includeCookies = true;
      if (typeof opts.format === 'string') rawConfig.format = opts.format;
      // Commander uses --no-screenshots to set opts.screenshots = false
      if (opts.screenshots === false) rawConfig.noScreenshots = true;
      if (opts.har === false) rawConfig.noHar = true;
      if (viewport) rawConfig.viewport = viewport;
      if (additionalViewports) rawConfig.additionalViewports = additionalViewports;
      if (opts.resume) rawConfig.resume = true;
      if (opts.yes) rawConfig.yes = true;
      if (opts.allowPrivate) rawConfig.allowPrivate = true;

      // --- Validate with Zod ---
      const parseResult = CrawlConfigSchema.safeParse(rawConfig);

      if (!parseResult.success) {
        const issues = parseResult.error.issues;
        const messages = issues.map((issue) => {
          const path = issue.path.join('.');
          return `  --${path}: ${issue.message}`;
        });
        throw new ConfigError(
          issues[0].path.join('.') || 'config',
          `Invalid configuration:\n${messages.join('\n')}`,
          rawConfig,
        );
      }

      const validatedConfig = parseResult.data;

      // --- Build ResolvedConfig ---
      const resolvedConfig: ResolvedConfig = {
        ...validatedConfig,
        outputDir: resolve(validatedConfig.outputDir),
        authScript: validatedConfig.authScript ? resolve(validatedConfig.authScript) : undefined,
        cookiesFile: validatedConfig.cookiesFile ? resolve(validatedConfig.cookiesFile) : undefined,
        warnings,
      };

      logger.debug('Resolved config: %o', resolvedConfig);

      // --- Run the crawl ---
      const result = await dig(resolvedConfig);

      logger.success(
        `Crawl complete. ${result.artifacts.meta.pagesVisited} pages visited in ${result.artifacts.meta.duration}ms.`,
      );

      if (result.errors.length > 0) {
        logger.warn(`${result.errors.length} error(s) encountered during crawl.`);
      }

      // Create regression baseline bundle
      const bundlePath = resolve(outputDir, 'bundle');
      try {
        const manifest = await createBundle(outputDir, bundlePath);
        logger.success(`Bundle created: ${bundlePath} (${manifest.files.length} files)`);
      } catch (bundleErr) {
        logger.warn(`Bundle creation failed: ${bundleErr instanceof Error ? bundleErr.message : String(bundleErr)}`);
      }

      process.exit(0);
    } catch (err) {
      handleError(err);
    }
  });

// ---------------------------------------------------------------------------
// `install` command
// ---------------------------------------------------------------------------

program
  .command('install')
  .description('Install Playwright Chromium browser')
  .action(() => {
    try {
      logger.info('Installing Playwright Chromium browser...');
      execSync('npx playwright install chromium', {
        stdio: 'inherit',
        timeout: 300_000, // 5 minute timeout
      });
      logger.success('Chromium browser installed successfully.');
    } catch (err) {
      logger.error('Failed to install Chromium browser.');
      if (err instanceof Error) {
        logger.debug(err.message);
      }
      process.exit(1);
    }
  });

// ---------------------------------------------------------------------------
// `diff` command
// ---------------------------------------------------------------------------

program
  .command('diff')
  .description('Compare two .archaeologist bundles and generate a diff report')
  .argument('<old>', 'Path to the older .archaeologist bundle')
  .argument('<new>', 'Path to the newer .archaeologist bundle')
  .option('-o, --output <dir>', 'Output directory for the diff report')
  .option('--threshold <n>', 'Pixel diff threshold 0-1 (default: 0.1)', parseFloat)
  .option('--max-ratio <n>', 'Max diff ratio 0-100 before marking changed (default: 0.5)', parseFloat)
  .option('--ignore-fields <fields>', 'Comma-separated fields to ignore in API diff')
  .option('--normalize-dynamic', 'Normalize dynamic values (UUIDs, timestamps) before diffing', false)
  .option('--detailed', 'Show detailed value-level diffs (default: schema-level only)', false)
  .option('--format-html <path>', 'Output HTML diff report to this path')
  .option('--format-json <path>', 'Output JSON diff report to this path')
  .option('--format-junit <path>', 'Output JUnit XML diff report to this path')
  .option('--format-markdown <path>', 'Output Markdown diff report to this path')
  .option('-v, --verbose', 'Enable debug logging', false)
  .action(async (oldBundle: string, newBundle: string, opts: Record<string, unknown>) => {
    if (opts.verbose) {
      logger.setLevel('debug');
    }

    try {
      // Validate bundle paths exist
      const oldPath = resolve(oldBundle);
      const newPath = resolve(newBundle);

      try {
        accessSync(oldPath, constants.R_OK);
      } catch {
        throw new ConfigError('oldBundle', `Old bundle not found: ${oldPath}`, oldPath);
      }

      try {
        accessSync(newPath, constants.R_OK);
      } catch {
        throw new ConfigError('newBundle', `New bundle not found: ${newPath}`, newPath);
      }

      // Build diff config
      const rawDiffConfig: Record<string, unknown> = {
        oldBundle: oldPath,
        newBundle: newPath,
      };

      if (typeof opts.output === 'string') rawDiffConfig.outputDir = opts.output;
      if (opts.threshold !== undefined) rawDiffConfig.diffThreshold = opts.threshold;
      if (opts.maxRatio !== undefined) rawDiffConfig.diffMaxRatio = opts.maxRatio;
      if (typeof opts.ignoreFields === 'string') {
        rawDiffConfig.diffIgnoreFields = opts.ignoreFields.split(',').map((s: string) => s.trim()).filter(Boolean);
      }
      if (opts.normalizeDynamic) rawDiffConfig.normalizeDynamicValues = true;
      if (opts.detailed) rawDiffConfig.detailed = true;

      // Build output formats
      const outputFormats: Record<string, string> = {};
      if (typeof opts.formatHtml === 'string') outputFormats.html = opts.formatHtml;
      if (typeof opts.formatJson === 'string') outputFormats.json = opts.formatJson;
      if (typeof opts.formatJunit === 'string') outputFormats.junit = opts.formatJunit;
      if (typeof opts.formatMarkdown === 'string') outputFormats.markdown = opts.formatMarkdown;
      if (Object.keys(outputFormats).length > 0) rawDiffConfig.outputFormats = outputFormats;

      // Validate with Zod
      const parseResult = DiffConfigSchema.safeParse(rawDiffConfig);

      if (!parseResult.success) {
        const issues = parseResult.error.issues;
        const messages = issues.map((issue) => {
          const path = issue.path.join('.');
          return `  --${path}: ${issue.message}`;
        });
        throw new ConfigError(
          issues[0].path.join('.') || 'config',
          `Invalid diff configuration:\n${messages.join('\n')}`,
          rawDiffConfig,
        );
      }

      logger.info(`Comparing bundles:\n  old: ${oldPath}\n  new: ${newPath}`);

      // Run diff engine
      const diffResult = await diffBundles(oldPath, newPath);

      // Terminal summary
      const s = diffResult.summary;
      const totalChanges =
        s.routes.added + s.routes.removed + s.routes.changed +
        s.forms.added + s.forms.removed + s.forms.changed +
        s.api.added + s.api.removed + s.api.changed +
        s.screenshots.changed + s.screenshots.added + s.screenshots.removed;
      logger.info(`Diff complete: ${totalChanges} change(s) found`);
      if (s.routes.added > 0) logger.info(`  Routes added: ${s.routes.added}`);
      if (s.routes.removed > 0) logger.info(`  Routes removed: ${s.routes.removed}`);
      if (s.routes.changed > 0) logger.info(`  Routes modified: ${s.routes.changed}`);
      if (s.forms.changed > 0) logger.info(`  Forms changed: ${s.forms.changed}`);
      if (s.api.changed > 0) logger.info(`  API endpoints changed: ${s.api.changed}`);
      if (s.screenshots.changed > 0) logger.info(`  Screenshots changed: ${s.screenshots.changed}`);

      // Write outputs
      const { writeFile: writeFileAsync, mkdir: mkdirAsync } = await import('node:fs/promises');

      if (typeof opts.formatHtml === 'string') {
        const html = generateDiffReportHtml(diffResult);
        await writeFileAsync(resolve(opts.formatHtml), html, 'utf-8');
        logger.success(`HTML diff report: ${opts.formatHtml}`);
      }

      if (typeof opts.formatJson === 'string') {
        await writeFileAsync(resolve(opts.formatJson), JSON.stringify(diffResult, null, 2), 'utf-8');
        logger.success(`JSON diff report: ${opts.formatJson}`);
      }

      if (typeof opts.output === 'string') {
        const outDir = resolve(opts.output as string);
        await mkdirAsync(outDir, { recursive: true });
        const html = generateDiffReportHtml(diffResult);
        await writeFileAsync(resolve(outDir, 'diff-report.html'), html, 'utf-8');
        await writeFileAsync(resolve(outDir, 'diff.json'), JSON.stringify(diffResult, null, 2), 'utf-8');
        logger.success(`Diff reports written to: ${outDir}`);
      }

      // Exit codes: 0 = identical, 1 = changes detected
      process.exit(totalChanges > 0 ? 1 : 0);
    } catch (err) {
      handleError(err);
    }
  });

// ---------------------------------------------------------------------------
// Error handler
// ---------------------------------------------------------------------------

function handleError(err: unknown): never {
  if (err instanceof ConfigError) {
    logger.error(`Configuration error: ${err.message}`);
    process.exit(1);
  }

  if (err instanceof AuthError) {
    logger.error(`Authentication error: ${err.message}`);
    process.exit(1);
  }

  if (err instanceof DiffError) {
    logger.error(`Diff error: ${err.message}`);
    process.exit(2);
  }

  if (err instanceof ArchaeologistError) {
    logger.error(`${err.name}: ${err.message}`);
    if (err.cause instanceof Error) {
      logger.debug(`Caused by: ${err.cause.message}`);
    }
    process.exit(2);
  }

  if (err instanceof Error) {
    logger.error(err.message);
    logger.debug(err.stack ?? '');
    process.exit(1);
  }

  logger.error(`Unexpected error: ${String(err)}`);
  process.exit(1);
}

// ---------------------------------------------------------------------------
// Parse and run
// ---------------------------------------------------------------------------

program.parse();
