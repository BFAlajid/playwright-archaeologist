/**
 * HAR merger for multi-context crawls.
 *
 * With a ContextPool of N contexts we end up with N separate HAR files
 * (one per context's `recordHar` setting). Users expect a single
 * `crawl.har` in the output directory. This module:
 *   1. Reads every HAR file in a given list
 *   2. Merges `log.entries` across them (preserving start times)
 *   3. Writes a single combined HAR at the target path
 *   4. Unlinks the intermediates
 *
 * The merged file keeps the metadata (creator, browser) of the first
 * non-empty source. Empty / missing sources are silently skipped so a
 * crashed context does not break the merge.
 */

import * as fs from 'node:fs/promises';

interface HarEntry {
  startedDateTime?: string;
  [k: string]: unknown;
}

interface HarLog {
  version?: string;
  creator?: unknown;
  browser?: unknown;
  pages?: unknown[];
  entries?: HarEntry[];
  [k: string]: unknown;
}

interface HarFile {
  log: HarLog;
  [k: string]: unknown;
}

/**
 * Merge the HARs at `sources` into a single file at `targetPath`.
 * Missing / unreadable source files are skipped. Source files are deleted
 * on success. Returns the number of entries merged.
 */
export async function mergeHarFiles(sources: string[], targetPath: string): Promise<number> {
  const mergedEntries: HarEntry[] = [];
  let template: HarLog | undefined;

  for (const src of sources) {
    let raw: string;
    try {
      raw = await fs.readFile(src, 'utf-8');
    } catch {
      continue; // missing HAR file — likely a context that never ran
    }

    let parsed: HarFile;
    try {
      parsed = JSON.parse(raw) as HarFile;
    } catch {
      continue; // corrupt HAR — skip rather than abort the merge
    }

    if (!parsed.log || typeof parsed.log !== 'object') continue;

    if (!template) {
      // Keep the first log as the template (version, creator, browser, pages).
      template = {
        version: parsed.log.version,
        creator: parsed.log.creator,
        browser: parsed.log.browser,
        pages: parsed.log.pages,
        entries: [],
      };
    } else if (Array.isArray(parsed.log.pages) && Array.isArray(template.pages)) {
      // Concatenate pages across contexts so the HAR remains playable.
      template.pages = [...(template.pages ?? []), ...parsed.log.pages];
    }

    if (Array.isArray(parsed.log.entries)) {
      for (const entry of parsed.log.entries) {
        mergedEntries.push(entry);
      }
    }
  }

  if (!template) {
    // Nothing to merge — leave the target alone.
    return 0;
  }

  // Sort entries by startedDateTime so the merged file is chronological.
  mergedEntries.sort((a, b) => {
    const ta = typeof a.startedDateTime === 'string' ? Date.parse(a.startedDateTime) : 0;
    const tb = typeof b.startedDateTime === 'string' ? Date.parse(b.startedDateTime) : 0;
    return ta - tb;
  });

  template.entries = mergedEntries;

  const merged: HarFile = { log: template };
  await fs.writeFile(targetPath, JSON.stringify(merged), 'utf-8');

  // Best-effort: delete intermediates that are not the target file itself.
  for (const src of sources) {
    if (src === targetPath) continue;
    try {
      await fs.unlink(src);
    } catch {
      // Ignore — intermediate may have already been removed.
    }
  }

  return mergedEntries.length;
}
