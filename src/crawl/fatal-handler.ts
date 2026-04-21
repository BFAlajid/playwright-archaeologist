/**
 * Fatal error handler — shared partial-result path.
 *
 * When the orchestrator's top-level try-block throws (browser crash,
 * output dir unwritable mid-crawl, etc.) we still want to return a
 * well-formed DigResult and write whatever partial artifacts we can.
 *
 * Previously this logic was duplicated inside orchestrator.ts. Now both
 * happy-path wrap-up and fatal-path fallback build a CrawlResult the
 * same way, so assembler + writer see the same shape regardless.
 */

import type { ResolvedConfig } from '../types/config.js';
import type {
  CrawlResult,
  DigResult,
  PageVisitResult,
} from '../types/artifacts.js';
import type { CrawlErrorEntry } from '../types/errors.js';

import { buildAssembledArtifacts } from '../assembler/artifacts.js';
import { writeCrawlOutputs } from './output-writer.js';
import * as fs from 'node:fs/promises';
import { logger } from '../utils/logger.js';

export interface FatalHandlerInput {
  error: unknown;
  config: ResolvedConfig;
  startedAt: Date;
  pages: PageVisitResult[];
  errors: CrawlErrorEntry[];
}

/**
 * Build a CrawlResult from config + partial state. Used by both the
 * happy-path and the fatal path so both produce structurally identical
 * artifacts.
 */
export function buildCrawlResult(
  config: ResolvedConfig,
  startedAt: Date,
  finishedAt: Date,
  pages: PageVisitResult[],
  unvisitedUrls: string[],
  errors: CrawlErrorEntry[],
  completionStatus: CrawlResult['completionStatus'],
): CrawlResult {
  return {
    config: {
      targetUrl: config.targetUrl,
      depth: config.depth,
      maxPages: config.maxPages,
      concurrency: config.concurrency,
      viewport: config.viewport,
      followExternal: config.followExternal,
      // TODO: deepClick is not yet implemented — threaded through but unused.
      deepClick: config.deepClick,
    },
    startedAt: startedAt.toISOString(),
    finishedAt: finishedAt.toISOString(),
    durationMs: finishedAt.getTime() - startedAt.getTime(),
    pages,
    unvisitedUrls,
    errors,
    completionStatus,
  };
}

/**
 * Handle a fatal crawl error: log, append to errors, best-effort write
 * partial artifacts, and return a DigResult with completionStatus='error'.
 *
 * Never throws — if writing partial outputs fails, we swallow that too
 * so the caller always gets a DigResult back.
 */
export async function handleFatalCrawlFailure(
  input: FatalHandlerInput,
): Promise<DigResult> {
  const { error, config, startedAt, pages, errors } = input;
  const message = error instanceof Error ? error.message : String(error);
  logger.error(`Fatal crawl error: ${message}`);

  errors.push({
    timestamp: new Date().toISOString(),
    url: config.targetUrl,
    code: 'ERR_FATAL',
    message,
  });

  const finishedAt = new Date();
  const crawlResult = buildCrawlResult(
    config,
    startedAt,
    finishedAt,
    pages,
    [],
    errors,
    'error',
  );

  const artifacts = buildAssembledArtifacts(crawlResult, pages);

  // Best-effort write — output dir may not exist/be writable.
  try {
    await fs.mkdir(config.outputDir, { recursive: true });
    await writeCrawlOutputs(config.outputDir, crawlResult, pages, artifacts, {
      prettyJson: config.prettyJson,
      pagesVisited: pages.length,
    });
  } catch {
    // Deliberately swallow — partial write is best-effort.
  }

  return {
    artifacts,
    outputPaths: { outputDir: config.outputDir },
    errors,
    completionStatus: 'error',
  };
}
