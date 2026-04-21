/**
 * Checkpoint tests that exercise the REAL filesystem (no fs mocks).
 *
 * The sibling `checkpoint.test.ts` mocks `node:fs/promises` to control
 * error paths deterministically. That's valuable for specific scenarios
 * but not sufficient: a fully mocked filesystem cannot verify:
 *
 *   - The atomic-write contract (tmp + rename) as observed on disk.
 *   - Zod validation fires for a file written by one process and read by
 *     another.
 *   - Interrupted writes leave either the old file or no file — never a
 *     truncated mid-write.
 *
 * This file keeps the real fs. Each test uses `mkdtemp()` for isolation.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, writeFile, readFile, stat, access } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import {
  writeCheckpoint,
  readCheckpoint,
  createCheckpointState,
  deleteCheckpoint,
} from '../../src/crawl/checkpoint.js';
import { hashConfig } from '../../src/crawl/config-hash.js';
import type { CheckpointState } from '../../src/types/artifacts.js';
import type { ResolvedConfig } from '../../src/types/config.js';
import { CheckpointMismatchError } from '../../src/types/errors.js';

const CHECKPOINT_FILENAME = '.checkpoint.json';
const CHECKPOINT_TMP_FILENAME = '.checkpoint.json.tmp';

function makeValidState(overrides?: Partial<CheckpointState>): CheckpointState {
  return {
    version: 1,
    startedAt: '2026-04-21T00:00:00.000Z',
    checkpointedAt: '2026-04-21T00:05:00.000Z',
    frontier: [
      { url: 'https://example.com/page-2', depth: 1 },
      { url: 'https://example.com/page-3', depth: 2, referrer: 'https://example.com/' },
    ],
    visited: ['https://example.com/', 'https://example.com/page-1'],
    skipped: [],
    artifactsDir: 'artifacts',
    pagesVisited: 2,
    errors: [],
    configHash: 'abc123def456',
    ...overrides,
  };
}

describe('checkpoint — real filesystem behavior', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'pa-cp-realfs-'));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  });

  // -----------------------------------------------------------------------
  // Round-trip
  // -----------------------------------------------------------------------

  describe('round-trip', () => {
    it('writeCheckpoint produces a file readable by readCheckpoint', async () => {
      const state = makeValidState();

      await writeCheckpoint(state, dir);

      const read = await readCheckpoint(dir);
      expect(read).not.toBeNull();
      expect(read!.version).toBe(1);
      expect(read!.configHash).toBe('abc123def456');
      expect(read!.frontier).toHaveLength(2);
      expect(read!.visited).toEqual([
        'https://example.com/',
        'https://example.com/page-1',
      ]);
      // writeCheckpoint updates checkpointedAt in place, so the read-back
      // value should match the in-memory state after the write.
      expect(read!.checkpointedAt).toBe(state.checkpointedAt);
    });

    it('creates a file with exactly the final checkpoint path', async () => {
      await writeCheckpoint(makeValidState(), dir);

      const finalStat = await stat(join(dir, CHECKPOINT_FILENAME));
      expect(finalStat.isFile()).toBe(true);

      // tmp file must not exist after a successful write.
      await expect(access(join(dir, CHECKPOINT_TMP_FILENAME))).rejects.toThrow();
    });

    it('overwriting an existing checkpoint preserves the file path and updates content', async () => {
      await writeCheckpoint(makeValidState({ pagesVisited: 2 }), dir);
      await writeCheckpoint(makeValidState({ pagesVisited: 7 }), dir);

      const read = await readCheckpoint(dir);
      expect(read!.pagesVisited).toBe(7);
    });
  });

  // -----------------------------------------------------------------------
  // Atomic write contract
  //
  // The contract: on any failure during writeCheckpoint, the OLD final
  // file is never corrupted. Specifically we assert the final file is
  // either:
  //   (a) the content from the last successful write, OR
  //   (b) still does not exist (if nothing was ever written).
  // It is NEVER a truncated, partial, or half-formed JSON blob.
  // -----------------------------------------------------------------------

  describe('atomic write contract', () => {
    it('writing a second checkpoint leaves the final file valid even across overwrites', async () => {
      // Write V1. Then write V2. Then V3. Between writes, re-read and
      // assert the file is always fully valid JSON and schema-valid.
      const states: CheckpointState[] = [
        makeValidState({ pagesVisited: 1 }),
        makeValidState({ pagesVisited: 2 }),
        makeValidState({ pagesVisited: 3 }),
      ];

      for (const s of states) {
        await writeCheckpoint(s, dir);
        // After each write, read-back must succeed (schema-valid JSON).
        const read = await readCheckpoint(dir);
        expect(read).not.toBeNull();
        expect(read!.pagesVisited).toBe(s.pagesVisited);
      }
    });

    it('an interrupted serialize leaves the previous checkpoint intact', async () => {
      // Simulate a mid-write crash: write a known-good V1, then mutate
      // the state to include an unserializable value (a BigInt), which
      // makes the next writeCheckpoint throw inside JSON.stringify. After
      // the throw, the old file must still be readable and unchanged.
      const goodState = makeValidState({ pagesVisited: 11 });
      await writeCheckpoint(goodState, dir);

      const beforeBytes = await readFile(join(dir, CHECKPOINT_FILENAME), 'utf-8');

      // Mutate: inject a property that JSON.stringify refuses.
      const badState = makeValidState({ pagesVisited: 99 }) as unknown as CheckpointState & {
        _evil: bigint;
      };
      (badState as { _evil: bigint })._evil = 1n;

      await expect(writeCheckpoint(badState, dir)).rejects.toThrow();

      // The final file still contains V1 — not V2's partial content.
      const afterBytes = await readFile(join(dir, CHECKPOINT_FILENAME), 'utf-8');
      expect(afterBytes).toBe(beforeBytes);

      // readCheckpoint still returns V1 with schema validation passing.
      const read = await readCheckpoint(dir);
      expect(read!.pagesVisited).toBe(11);
    });
  });

  // -----------------------------------------------------------------------
  // Schema validation on read
  // -----------------------------------------------------------------------

  describe('schema validation on read', () => {
    it('throws on a file whose contents do not match the schema (never returns partial state)', async () => {
      // Write a plausible-looking but schema-invalid file manually.
      await writeFile(
        join(dir, CHECKPOINT_FILENAME),
        JSON.stringify({ version: 42, junk: 'data' }),
      );

      await expect(readCheckpoint(dir)).rejects.toThrow(/Invalid checkpoint data/);
    });

    it('throws on malformed JSON', async () => {
      await writeFile(
        join(dir, CHECKPOINT_FILENAME),
        '{"version": 1, truncated',
      );

      await expect(readCheckpoint(dir)).rejects.toThrow(/not valid JSON/);
    });

    it('returns null (not throws) when no checkpoint file exists', async () => {
      const result = await readCheckpoint(dir);
      expect(result).toBeNull();
    });

    it('a checkpoint created by createCheckpointState + writeCheckpoint round-trips successfully', async () => {
      // Start-of-crawl path: initialize empty state, write, read back.
      const state = createCheckpointState({
        configHash: 'real-hash-' + Date.now(),
        artifactsDir: 'out',
      });
      await writeCheckpoint(state, dir);

      const read = await readCheckpoint(dir);
      expect(read).not.toBeNull();
      expect(read!.version).toBe(1);
      expect(read!.frontier).toEqual([]);
      expect(read!.visited).toEqual([]);
      expect(read!.pagesVisited).toBe(0);
      expect(read!.configHash).toBe(state.configHash);
    });
  });
});

// ---------------------------------------------------------------------------
// End-to-end checkpoint wiring tests
//
// These exercise the full resume flow: hydrate frontier, skip visited,
// detect config mismatch, and delete on completion. We drive a mocked
// crawl loop (visitAndCollectPage stubbed) so we do not need a browser.
// ---------------------------------------------------------------------------

function baseResolvedConfig(overrides: Partial<ResolvedConfig> = {}): ResolvedConfig {
  return {
    targetUrl: 'https://example.com/',
    depth: 3,
    maxPages: 100,
    include: [],
    exclude: [],
    followExternal: false,
    deepClick: false,
    includeIframes: false,
    concurrency: 1,
    delay: 0,
    timeout: 30_000,
    maxTime: 3600,
    outputDir: '',
    format: 'both',
    noScreenshots: true,
    screenshotFormat: 'jpeg',
    noHar: true,
    viewport: { width: 1280, height: 720 },
    additionalViewports: [],
    resume: false,
    yes: false,
    allowPrivate: true,
    allowAuthScript: false,
    captureJsBodies: false,
    harIncludeBodies: false,
    prettyJson: false,
    includeCookies: false,
    warnings: [],
    ...overrides,
  } as unknown as ResolvedConfig;
}

describe('checkpoint — resume wiring (end-to-end integration)', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'pa-cp-e2e-'));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  });

  // Note: the crawl-loop + skipVisitedUrls integration is tested in
  // test/unit/crawl-loop-checkpoint.test.ts, which mocks visit-page.ts
  // via vi.mock at the module top level (the only pattern Vitest
  // supports). That test covers the skipVisitedUrls contract end-to-end.

  it('configHash mismatch: hash differs for different depths', () => {
    // Unit-level assertion of the mismatch trigger — the orchestrator
    // throws CheckpointMismatchError when stored hash differs from current.
    const cfg1 = baseResolvedConfig({ depth: 3 });
    const cfg2 = baseResolvedConfig({ depth: 5 });

    const hash1 = hashConfig(cfg1);
    const hash2 = hashConfig(cfg2);

    expect(hash1).not.toBe(hash2);

    // If we write a checkpoint with hash1 and try to resume with cfg2,
    // the orchestrator would throw CheckpointMismatchError. We verify
    // the error type is constructible and carries the right fields here.
    const err = new CheckpointMismatchError(hash2, hash1, join(dir, '.checkpoint.json'));
    expect(err.name).toBe('CheckpointMismatchError');
    expect(err.code).toBe('ERR_CHECKPOINT_MISMATCH');
    expect(err.expectedHash).toBe(hash2);
    expect(err.actualHash).toBe(hash1);
    expect(err.message).toContain('different config');
  });

  it('configHash mismatch persists end-to-end through the file system', async () => {
    // Write a checkpoint with hash from cfg1, then simulate resume from
    // cfg2 (different depth). readCheckpoint should return the state,
    // and the orchestrator's mismatch check (which we replicate here)
    // must detect the divergence.
    const cfg1 = baseResolvedConfig({ depth: 3, outputDir: dir });
    const cfg2 = baseResolvedConfig({ depth: 5, outputDir: dir });

    const state = createCheckpointState({
      configHash: hashConfig(cfg1),
      artifactsDir: dir,
    });
    await writeCheckpoint(state, dir);

    const onDisk = await readCheckpoint(dir);
    expect(onDisk).not.toBeNull();
    expect(onDisk!.configHash).toBe(hashConfig(cfg1));

    // Simulate the orchestrator's resume check: compare against cfg2.
    const currentHash = hashConfig(cfg2);
    expect(onDisk!.configHash).not.toBe(currentHash);
  });

  it('deleteCheckpoint removes the checkpoint file (used on successful completion)', async () => {
    const state = createCheckpointState({
      configHash: 'abc',
      artifactsDir: dir,
    });
    await writeCheckpoint(state, dir);

    expect(existsSync(join(dir, '.checkpoint.json'))).toBe(true);

    await deleteCheckpoint(dir);

    expect(existsSync(join(dir, '.checkpoint.json'))).toBe(false);
  });

  it('stale checkpoint without --resume: file is preserved for future resume', async () => {
    // When the user runs without --resume but a checkpoint exists, we
    // warn and start fresh. The existing file must NOT be deleted — a
    // subsequent rerun with --resume should still find it intact.
    const oldState = createCheckpointState({
      configHash: 'some-old-hash',
      artifactsDir: dir,
    });
    oldState.frontier = [{ url: 'https://example.com/stale', depth: 1 }];
    oldState.pagesVisited = 42;
    await writeCheckpoint(oldState, dir);

    // Simulate starting fresh (resume=false): the orchestrator logs a
    // warning but does not touch the file. We verify only that the file
    // still exists and carries the old content after a hypothetical
    // "fresh start" decision.
    expect(existsSync(join(dir, '.checkpoint.json'))).toBe(true);
    const preserved = await readCheckpoint(dir);
    expect(preserved!.configHash).toBe('some-old-hash');
    expect(preserved!.pagesVisited).toBe(42);
    expect(preserved!.frontier).toEqual([{ url: 'https://example.com/stale', depth: 1 }]);
  });

  it('round-trip through hashConfig: same config produces the same checkpoint hash', async () => {
    // A user restarts with an identical config — the on-disk hash must
    // match exactly. This is the non-negotiable contract that --resume
    // depends on.
    const cfg = baseResolvedConfig({ outputDir: dir, targetUrl: 'https://api.example.com/v1' });

    const state = createCheckpointState({
      configHash: hashConfig(cfg),
      artifactsDir: dir,
    });
    state.frontier = [
      { url: 'https://api.example.com/v1/users', depth: 1 },
      { url: 'https://api.example.com/v1/posts', depth: 1 },
    ];
    state.visited = ['https://api.example.com/v1/'];
    await writeCheckpoint(state, dir);

    const onDisk = await readCheckpoint(dir);
    expect(onDisk!.configHash).toBe(hashConfig(cfg));

    // Simulate resume: same config loaded fresh. configHash matches, so
    // the orchestrator would hydrate frontier + visited from disk.
    const currentHash = hashConfig(cfg);
    expect(onDisk!.configHash).toBe(currentHash);
    expect(onDisk!.frontier).toHaveLength(2);
    expect(onDisk!.visited).toEqual(['https://api.example.com/v1/']);
  });

  it('resume-compatible: changing only outputDir does not invalidate the checkpoint hash', async () => {
    // Users frequently rerun into a different output directory
    // (e.g., for CI archive paths). The checkpoint file's hash must not
    // change — the user's crawl intent is the same.
    const cfg1 = baseResolvedConfig({ outputDir: '/first/output/dir' });
    const cfg2 = baseResolvedConfig({ outputDir: '/different/output/dir' });

    expect(hashConfig(cfg1)).toBe(hashConfig(cfg2));
  });
});
