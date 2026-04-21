/**
 * Output writer — writes all crawl artifacts to disk.
 *
 * Centralises the file writes the orchestrator used to perform inline:
 *   - sitemap.json
 *   - crawl-summary.json
 *   - forms.json (only when forms exist)
 *   - api-map.json (only when endpoints exist)
 *   - flow-graph.mmd (only when definition exists)
 *   - openapi.json (only when endpoints exist)
 *   - report.html (always, with Mermaid fallback SVG)
 *
 * Individual writes are isolated: a failure in one section logs a warning
 * and continues, matching the graceful-degradation contract in
 * src/types/artifacts.ts.
 */

import * as fs from 'node:fs/promises';
import * as path from 'node:path';

import type {
  AssembledArtifacts,
  CrawlResult,
  PageVisitResult,
} from '../types/artifacts.js';
import { generateOpenApiSpec, writeOpenApiSpec } from '../report/openapi-output.js';
import { generateMermaidSvgString, generateReportHtml } from '../report/html/template.js';
import { logger } from '../utils/logger.js';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface WriteOutputOptions {
  /** When true, JSON files are pretty-printed with 2-space indent. */
  prettyJson?: boolean;
  /** Visited-page count shown in the HTML report. */
  pagesVisited: number;
}

export interface WrittenFiles {
  sitemapJson?: string;
  crawlSummaryJson?: string;
  formsJson?: string;
  apiMapJson?: string;
  flowGraphMmd?: string;
  openapiJson?: string;
  reportHtml?: string;
  accessibilityJson?: string;
}

// ---------------------------------------------------------------------------
// Sitemap + summary (always written when possible)
// ---------------------------------------------------------------------------

async function writeSitemap(
  outputDir: string,
  pages: PageVisitResult[],
  indent: number | undefined,
): Promise<string> {
  const sitemap = pages
    .filter((p) => p.status === 'ok')
    .map((p) => ({
      url: p.url,
      title: p.pageScan?.title || '',
      depth: p.depth,
      statusCode: p.httpStatus,
      links: p.pageScan?.links.length ?? 0,
    }));

  const sitemapPath = path.join(outputDir, 'sitemap.json');
  await fs.writeFile(sitemapPath, JSON.stringify(sitemap, null, indent), 'utf-8');
  return sitemapPath;
}

async function writeCrawlSummary(
  outputDir: string,
  crawlResult: CrawlResult,
  indent: number | undefined,
): Promise<string> {
  const summary = {
    targetUrl: crawlResult.config.targetUrl,
    startedAt: crawlResult.startedAt,
    finishedAt: crawlResult.finishedAt,
    durationMs: crawlResult.durationMs,
    pagesVisited: crawlResult.pages.length,
    pagesDiscovered: crawlResult.pages.length + crawlResult.unvisitedUrls.length,
    completionStatus: crawlResult.completionStatus,
    errors: crawlResult.errors.length,
  };
  const summaryPath = path.join(outputDir, 'crawl-summary.json');
  await fs.writeFile(summaryPath, JSON.stringify(summary, null, indent), 'utf-8');
  return summaryPath;
}

// ---------------------------------------------------------------------------
// Artifacts — conditional writes
// ---------------------------------------------------------------------------

async function writeFormsJson(
  outputDir: string,
  artifacts: AssembledArtifacts,
  indent: number | undefined,
): Promise<string | undefined> {
  if (artifacts.forms.length === 0) return undefined;
  const p = path.join(outputDir, 'forms.json');
  await fs.writeFile(p, JSON.stringify(artifacts.forms, null, indent), 'utf-8');
  logger.info(`  Forms: ${artifacts.forms.length} found`);
  return p;
}

async function writeApiMapJson(
  outputDir: string,
  artifacts: AssembledArtifacts,
  indent: number | undefined,
): Promise<string | undefined> {
  if (artifacts.apiEndpoints.length === 0) return undefined;
  const p = path.join(outputDir, 'api-map.json');
  await fs.writeFile(p, JSON.stringify(artifacts.apiEndpoints, null, indent), 'utf-8');
  logger.info(`  API endpoints: ${artifacts.apiEndpoints.length} groups`);
  return p;
}

async function writeFlowGraphMmd(
  outputDir: string,
  artifacts: AssembledArtifacts,
): Promise<string | undefined> {
  const mermaidDef = artifacts.flowDiagrams.overview.definition;
  if (!mermaidDef) return undefined;
  const p = path.join(outputDir, 'flow-graph.mmd');
  await fs.writeFile(p, mermaidDef, 'utf-8');
  logger.info(
    `  Flow graph: ${artifacts.flowGraph.nodes.length} nodes, ${artifacts.flowGraph.edges.length} edges`,
  );
  return p;
}

async function writeOpenApiJson(
  outputDir: string,
  artifacts: AssembledArtifacts,
  targetUrl: string,
): Promise<string | undefined> {
  if (artifacts.apiEndpoints.length === 0) return undefined;
  try {
    const spec = generateOpenApiSpec(artifacts.apiEndpoints, {
      title: `API - ${targetUrl}`,
      targetUrl,
    });
    const p = path.join(outputDir, 'openapi.json');
    await writeOpenApiSpec(spec, p);
    logger.info('  OpenAPI spec written');
    return p;
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    logger.warn(`OpenAPI generation failed: ${message}`);
    return undefined;
  }
}

/**
 * Collect axe plugin data from page visits into an `accessibility.json`
 * payload plus a summary for the HTML report. Returns undefined when no
 * page carries axe data (axe collector was not registered, or every
 * run failed).
 */
function buildAccessibilityPayload(pages: PageVisitResult[]): {
  perPage: Array<{ url: string; violations: number; byImpact: Record<string, number> }>;
  totalViolations: number;
  byImpact: Record<string, number>;
  rawPerPage: Array<{ url: string; result: unknown }>;
} | undefined {
  const perPage: Array<{ url: string; violations: number; byImpact: Record<string, number> }> = [];
  const rawPerPage: Array<{ url: string; result: unknown }> = [];
  const byImpact: Record<string, number> = {};
  let totalViolations = 0;
  let anyFound = false;

  for (const p of pages) {
    if (p.status !== 'ok') continue;
    const axeData = p.pluginData?.axe;
    if (!axeData || typeof axeData !== 'object') continue;
    anyFound = true;
    rawPerPage.push({ url: p.url, result: axeData });

    const violations = Array.isArray((axeData as { violations?: unknown }).violations)
      ? ((axeData as { violations: Array<{ impact?: string; nodes?: number }> }).violations)
      : [];

    const pageByImpact: Record<string, number> = {};
    for (const v of violations) {
      const impact = typeof v.impact === 'string' && v.impact.length > 0 ? v.impact : 'unknown';
      pageByImpact[impact] = (pageByImpact[impact] ?? 0) + 1;
      byImpact[impact] = (byImpact[impact] ?? 0) + 1;
    }
    const pageTotal = violations.length;
    totalViolations += pageTotal;
    perPage.push({ url: p.url, violations: pageTotal, byImpact: pageByImpact });
  }

  if (!anyFound) return undefined;
  return { perPage, totalViolations, byImpact, rawPerPage };
}

async function writeAccessibilityJson(
  outputDir: string,
  pages: PageVisitResult[],
  indent: number | undefined,
): Promise<{ path?: string; reportInput?: { totalViolations: number; byImpact: Record<string, number>; perPage: Array<{ url: string; violations: number; byImpact: Record<string, number> }> } }> {
  const payload = buildAccessibilityPayload(pages);
  if (!payload) return {};

  const outPath = path.join(outputDir, 'accessibility.json');
  await fs.writeFile(
    outPath,
    JSON.stringify(
      {
        totalViolations: payload.totalViolations,
        byImpact: payload.byImpact,
        perPage: payload.rawPerPage,
      },
      null,
      indent,
    ),
    'utf-8',
  );
  logger.info(`  Accessibility: ${payload.totalViolations} violation(s) across ${payload.perPage.length} page(s)`);
  return {
    path: outPath,
    reportInput: {
      totalViolations: payload.totalViolations,
      byImpact: payload.byImpact,
      perPage: payload.perPage,
    },
  };
}

async function writeReportHtml(
  outputDir: string,
  artifacts: AssembledArtifacts,
  pages: PageVisitResult[],
  targetUrl: string,
  crawlStartedAt: string,
  durationMs: number,
  pagesVisited: number,
  errorCount: number,
  accessibility?: { totalViolations: number; byImpact: Record<string, number>; perPage: Array<{ url: string; violations: number; byImpact: Record<string, number> }> },
): Promise<string | undefined> {
  try {
    const mermaidDef = artifacts.flowDiagrams.overview.definition;
    const flowDiagramHtml = mermaidDef ? generateMermaidSvgString(mermaidDef) : undefined;

    const reportInput = {
      targetUrl,
      crawlDate: crawlStartedAt,
      duration: durationMs,
      pagesVisited,
      errors: errorCount,
      pages: pages
        .filter((p) => p.status === 'ok')
        .map((p) => ({
          url: p.url,
          title: p.pageScan?.title || '',
          status: p.httpStatus || 0,
          depth: p.depth,
          contentHash: p.pageScan?.contentHash,
        })),
      forms: artifacts.forms.map((f) => ({
        url: f.action || '',
        action: f.action,
        method: f.method,
        fields: f.fields.map((field) => ({
          name: field.name,
          type: field.type,
          required: field.required,
        })),
      })),
      apiEndpoints: artifacts.apiEndpoints.map((g) => ({
        pattern: g.pattern,
        method: g.method,
        examples: g.observedUrls.slice(0, 5).map((url) => ({
          url,
          status: g.exampleResponse.statusCode,
        })),
      })),
      flowDiagramSvg: flowDiagramHtml,
      accessibility,
    };
    const html = generateReportHtml(reportInput);
    const reportPath = path.join(outputDir, 'report.html');
    await fs.writeFile(reportPath, html, 'utf-8');
    logger.success(`HTML report: ${reportPath}`);
    return reportPath;
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    logger.warn(`Report generation failed: ${message}`);
    return undefined;
  }
}

// ---------------------------------------------------------------------------
// writeCrawlOutputs — single public entry point
// ---------------------------------------------------------------------------

/**
 * Write every output file for a completed crawl.
 *
 * Errors writing an individual file are logged but do not halt the
 * overall operation. Returned paths are only set for files that were
 * actually written; missing entries signal graceful degradation.
 */
export async function writeCrawlOutputs(
  outputDir: string,
  crawlResult: CrawlResult,
  pages: PageVisitResult[],
  artifacts: AssembledArtifacts,
  options: WriteOutputOptions,
): Promise<WrittenFiles> {
  const indent: number | undefined = options.prettyJson ? 2 : undefined;
  const written: WrittenFiles = {};

  // Core outputs (sitemap + summary).
  try {
    written.sitemapJson = await writeSitemap(outputDir, pages, indent);
  } catch (err: unknown) {
    logger.error(`Failed to write sitemap.json: ${err instanceof Error ? err.message : String(err)}`);
  }

  try {
    written.crawlSummaryJson = await writeCrawlSummary(outputDir, crawlResult, indent);
  } catch (err: unknown) {
    logger.error(`Failed to write crawl-summary.json: ${err instanceof Error ? err.message : String(err)}`);
  }

  // Additional artifact outputs. Wrap in try/catch so a single failure
  // does not abort the rest.
  try {
    written.formsJson = await writeFormsJson(outputDir, artifacts, indent);
  } catch (err: unknown) {
    logger.warn(`Forms JSON write failed: ${err instanceof Error ? err.message : String(err)}`);
  }

  try {
    written.apiMapJson = await writeApiMapJson(outputDir, artifacts, indent);
  } catch (err: unknown) {
    logger.warn(`API map write failed: ${err instanceof Error ? err.message : String(err)}`);
  }

  try {
    written.flowGraphMmd = await writeFlowGraphMmd(outputDir, artifacts);
  } catch (err: unknown) {
    logger.warn(`Flow graph write failed: ${err instanceof Error ? err.message : String(err)}`);
  }

  written.openapiJson = await writeOpenApiJson(
    outputDir,
    artifacts,
    crawlResult.config.targetUrl,
  );

  // Accessibility artifacts (only if any axe plugin data was collected).
  let accessibilityReportInput:
    | { totalViolations: number; byImpact: Record<string, number>; perPage: Array<{ url: string; violations: number; byImpact: Record<string, number> }> }
    | undefined;
  try {
    const { path: a11yPath, reportInput } = await writeAccessibilityJson(outputDir, pages, indent);
    if (a11yPath) written.accessibilityJson = a11yPath;
    accessibilityReportInput = reportInput;
  } catch (err: unknown) {
    logger.warn(`Accessibility JSON write failed: ${err instanceof Error ? err.message : String(err)}`);
  }

  written.reportHtml = await writeReportHtml(
    outputDir,
    artifacts,
    pages,
    crawlResult.config.targetUrl,
    crawlResult.startedAt,
    crawlResult.durationMs,
    options.pagesVisited,
    crawlResult.errors.length,
    accessibilityReportInput,
  );

  return written;
}
