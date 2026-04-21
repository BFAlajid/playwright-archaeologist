/**
 * Unit tests for src/crawl/har-merger.ts
 *
 * Multi-context crawls produce one HAR per context. The merger combines
 * them into a single chronologically-ordered crawl.har and deletes the
 * intermediates.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';

import { mergeHarFiles } from '../../src/crawl/har-merger.js';

function makeHar(entries: Array<{ url: string; time: string }>): string {
  return JSON.stringify({
    log: {
      version: '1.2',
      creator: { name: 'playwright-archaeologist', version: 'test' },
      browser: { name: 'chromium', version: 'test' },
      pages: [],
      entries: entries.map((e) => ({
        startedDateTime: e.time,
        request: { method: 'GET', url: e.url, headers: [] },
        response: { status: 200, headers: [] },
      })),
    },
  });
}

describe('mergeHarFiles', () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'pa-harmerge-'));
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
  });

  it('returns 0 when no source files exist', async () => {
    const target = path.join(tmpDir, 'out.har');
    const n = await mergeHarFiles([path.join(tmpDir, 'ghost1.har'), path.join(tmpDir, 'ghost2.har')], target);
    expect(n).toBe(0);
  });

  it('merges entries from multiple HAR files in chronological order', async () => {
    const f1 = path.join(tmpDir, 'c1.har');
    const f2 = path.join(tmpDir, 'c2.har');
    await fs.writeFile(
      f1,
      makeHar([
        { url: 'https://a.com/1', time: '2026-04-20T10:00:00Z' },
        { url: 'https://a.com/3', time: '2026-04-20T10:00:02Z' },
      ]),
    );
    await fs.writeFile(
      f2,
      makeHar([{ url: 'https://a.com/2', time: '2026-04-20T10:00:01Z' }]),
    );

    const target = path.join(tmpDir, 'merged.har');
    const n = await mergeHarFiles([f1, f2], target);
    expect(n).toBe(3);

    const merged = JSON.parse(await fs.readFile(target, 'utf-8'));
    expect(merged.log.entries).toHaveLength(3);
    const urls = merged.log.entries.map((e: { request: { url: string } }) => e.request.url);
    expect(urls).toEqual([
      'https://a.com/1',
      'https://a.com/2',
      'https://a.com/3',
    ]);
  });

  it('deletes source files after merging', async () => {
    const f1 = path.join(tmpDir, 'a.har');
    const f2 = path.join(tmpDir, 'b.har');
    await fs.writeFile(f1, makeHar([{ url: 'https://x.com/', time: '2026-04-20T10:00:00Z' }]));
    await fs.writeFile(f2, makeHar([{ url: 'https://y.com/', time: '2026-04-20T10:00:00Z' }]));

    await mergeHarFiles([f1, f2], path.join(tmpDir, 'out.har'));

    const e1 = await fs.stat(f1).catch(() => null);
    const e2 = await fs.stat(f2).catch(() => null);
    expect(e1).toBeNull();
    expect(e2).toBeNull();
  });

  it('skips corrupt HAR files rather than aborting', async () => {
    const good = path.join(tmpDir, 'good.har');
    const bad = path.join(tmpDir, 'bad.har');
    await fs.writeFile(good, makeHar([{ url: 'https://a.com/', time: '2026-04-20T10:00:00Z' }]));
    await fs.writeFile(bad, 'not json');

    const target = path.join(tmpDir, 'out.har');
    const n = await mergeHarFiles([bad, good], target);
    expect(n).toBe(1);

    const merged = JSON.parse(await fs.readFile(target, 'utf-8'));
    expect(merged.log.entries).toHaveLength(1);
  });

  it('preserves version/creator from the first non-empty source', async () => {
    const f1 = path.join(tmpDir, 'a.har');
    await fs.writeFile(f1, makeHar([{ url: 'https://a.com/', time: '2026-04-20T10:00:00Z' }]));
    const target = path.join(tmpDir, 'out.har');
    await mergeHarFiles([f1], target);
    const merged = JSON.parse(await fs.readFile(target, 'utf-8'));
    expect(merged.log.version).toBe('1.2');
    expect(merged.log.creator.name).toBe('playwright-archaeologist');
  });

  it('does not delete the target file even if it appears in sources', async () => {
    const target = path.join(tmpDir, 'out.har');
    await fs.writeFile(target, makeHar([{ url: 'https://x.com/', time: '2026-04-20T10:00:00Z' }]));
    const n = await mergeHarFiles([target], target);
    expect(n).toBe(1);
    const exists = await fs.stat(target).catch(() => null);
    expect(exists?.isFile()).toBe(true);
  });
});
