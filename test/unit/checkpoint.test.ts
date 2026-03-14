/**
 * Unit tests for src/crawl/checkpoint.ts
 *
 * Checkpoint persistence: atomic writes, schema validation, auto-checkpoint
 * timer, and file cleanup.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  writeCheckpoint,
  readCheckpoint,
  deleteCheckpoint,
  createCheckpointState,
  setupAutoCheckpoint,
  CheckpointStateSchema,
} from '../../src/crawl/checkpoint.js';
import type { CheckpointState } from '../../src/types/artifacts.js';

// ---------------------------------------------------------------------------
// Mock node:fs/promises
// ---------------------------------------------------------------------------

vi.mock('node:fs/promises', () => ({
  readFile: vi.fn(),
  writeFile: vi.fn(),
  rename: vi.fn(),
  unlink: vi.fn(),
  access: vi.fn(),
}));

import { readFile, writeFile, rename, unlink } from 'node:fs/promises';

const mockReadFile = vi.mocked(readFile);
const mockWriteFile = vi.mocked(writeFile);
const mockRename = vi.mocked(rename);
const mockUnlink = vi.mocked(unlink);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeValidState(overrides?: Partial<CheckpointState>): CheckpointState {
  return {
    version: 1,
    startedAt: '2026-01-15T10:00:00.000Z',
    checkpointedAt: '2026-01-15T10:05:00.000Z',
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

function enoentError(): NodeJS.ErrnoException {
  const err = new Error('ENOENT: no such file or directory') as NodeJS.ErrnoException;
  err.code = 'ENOENT';
  return err;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('checkpoint', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockWriteFile.mockResolvedValue(undefined);
    mockRename.mockResolvedValue(undefined);
    mockUnlink.mockResolvedValue(undefined);
  });

  // -----------------------------------------------------------------------
  // writeCheckpoint
  // -----------------------------------------------------------------------

  describe('writeCheckpoint', () => {
    it('writes JSON to the correct path via tmp + rename', async () => {
      const state = makeValidState();

      await writeCheckpoint(state, '/output');

      // Step 1: write to tmp
      expect(mockWriteFile).toHaveBeenCalledOnce();
      const [tmpPath, content, encoding] = mockWriteFile.mock.calls[0];
      expect(tmpPath).toContain('.checkpoint.json.tmp');
      expect(encoding).toBe('utf-8');

      // The content should be valid JSON matching the state
      const written = JSON.parse(content as string) as CheckpointState;
      expect(written.version).toBe(1);
      expect(written.frontier).toHaveLength(2);
      expect(written.visited).toEqual([
        'https://example.com/',
        'https://example.com/page-1',
      ]);

      // Step 2: rename tmp -> final
      expect(mockRename).toHaveBeenCalledOnce();
      const [from, to] = mockRename.mock.calls[0];
      expect(from).toContain('.checkpoint.json.tmp');
      expect(to).toContain('.checkpoint.json');
      expect(to).not.toContain('.tmp');
    });

    it('updates checkpointedAt timestamp before writing', async () => {
      const state = makeValidState({
        checkpointedAt: '2020-01-01T00:00:00.000Z',
      });

      const before = new Date().toISOString();
      await writeCheckpoint(state, '/output');
      const after = new Date().toISOString();

      // The state object should have been mutated
      expect(state.checkpointedAt).not.toBe('2020-01-01T00:00:00.000Z');
      expect(state.checkpointedAt >= before).toBe(true);
      expect(state.checkpointedAt <= after).toBe(true);

      // Written JSON should also reflect the updated timestamp
      const written = JSON.parse(
        mockWriteFile.mock.calls[0][1] as string,
      ) as CheckpointState;
      expect(written.checkpointedAt).toBe(state.checkpointedAt);
    });

    it('uses atomic write pattern (tmp file written before rename)', async () => {
      const callOrder: string[] = [];
      mockWriteFile.mockImplementation(async () => {
        callOrder.push('writeFile');
      });
      mockRename.mockImplementation(async () => {
        callOrder.push('rename');
      });

      await writeCheckpoint(makeValidState(), '/output');

      expect(callOrder).toEqual(['writeFile', 'rename']);
    });
  });

  // -----------------------------------------------------------------------
  // readCheckpoint
  // -----------------------------------------------------------------------

  describe('readCheckpoint', () => {
    it('returns parsed state when file exists and is valid', async () => {
      const state = makeValidState();
      mockReadFile.mockResolvedValue(JSON.stringify(state));

      const result = await readCheckpoint('/output');

      expect(result).not.toBeNull();
      expect(result!.version).toBe(1);
      expect(result!.pagesVisited).toBe(2);
      expect(result!.frontier).toHaveLength(2);
      expect(result!.configHash).toBe('abc123def456');
    });

    it('returns null when checkpoint file does not exist', async () => {
      mockReadFile.mockRejectedValue(enoentError());

      const result = await readCheckpoint('/output');

      expect(result).toBeNull();
    });

    it('throws on non-ENOENT read errors', async () => {
      const permErr = new Error('EACCES: permission denied') as NodeJS.ErrnoException;
      permErr.code = 'EACCES';
      mockReadFile.mockRejectedValue(permErr);

      await expect(readCheckpoint('/output')).rejects.toThrow('EACCES');
    });

    it('throws when file contains invalid JSON', async () => {
      mockReadFile.mockResolvedValue('not valid json {{{');

      await expect(readCheckpoint('/output')).rejects.toThrow(
        'not valid JSON',
      );
    });

    it('throws when file contains valid JSON but invalid schema', async () => {
      mockReadFile.mockResolvedValue(
        JSON.stringify({ version: 99, bad: 'data' }),
      );

      await expect(readCheckpoint('/output')).rejects.toThrow(
        'Invalid checkpoint data',
      );
    });
  });

  // -----------------------------------------------------------------------
  // deleteCheckpoint
  // -----------------------------------------------------------------------

  describe('deleteCheckpoint', () => {
    it('removes both checkpoint and tmp files', async () => {
      await deleteCheckpoint('/output');

      expect(mockUnlink).toHaveBeenCalledTimes(2);
      const paths = mockUnlink.mock.calls.map((c) => c[0] as string);
      expect(paths.some((p) => p.endsWith('.checkpoint.json'))).toBe(true);
      expect(paths.some((p) => p.endsWith('.checkpoint.json.tmp'))).toBe(true);
    });

    it('ignores ENOENT errors (files already missing)', async () => {
      mockUnlink.mockRejectedValue(enoentError());

      await expect(deleteCheckpoint('/output')).resolves.toBeUndefined();
    });

    it('rethrows non-ENOENT errors', async () => {
      const permErr = new Error('EACCES') as NodeJS.ErrnoException;
      permErr.code = 'EACCES';
      mockUnlink.mockRejectedValue(permErr);

      await expect(deleteCheckpoint('/output')).rejects.toThrow('EACCES');
    });
  });

  // -----------------------------------------------------------------------
  // createCheckpointState
  // -----------------------------------------------------------------------

  describe('createCheckpointState', () => {
    it('returns a valid initial checkpoint state', () => {
      const state = createCheckpointState({
        configHash: 'hash123',
        artifactsDir: 'output/artifacts',
      });

      expect(state.version).toBe(1);
      expect(state.frontier).toEqual([]);
      expect(state.visited).toEqual([]);
      expect(state.skipped).toEqual([]);
      expect(state.pagesVisited).toBe(0);
      expect(state.errors).toEqual([]);
      expect(state.configHash).toBe('hash123');
      expect(state.artifactsDir).toBe('output/artifacts');
      expect(state.startedAt).toBeTruthy();
      expect(state.checkpointedAt).toBeTruthy();
    });

    it('produces state that passes schema validation', () => {
      const state = createCheckpointState({
        configHash: 'hash123',
        artifactsDir: 'artifacts',
      });

      const result = CheckpointStateSchema.safeParse(state);
      expect(result.success).toBe(true);
    });

    it('throws when configHash is empty', () => {
      expect(() =>
        createCheckpointState({ configHash: '', artifactsDir: 'artifacts' }),
      ).toThrow('configHash');
    });

    it('throws when artifactsDir is empty', () => {
      expect(() =>
        createCheckpointState({ configHash: 'hash', artifactsDir: '' }),
      ).toThrow('artifactsDir');
    });
  });

  // -----------------------------------------------------------------------
  // CheckpointStateSchema
  // -----------------------------------------------------------------------

  describe('CheckpointStateSchema', () => {
    it('validates correct checkpoint data', () => {
      const data = makeValidState();
      const result = CheckpointStateSchema.safeParse(data);
      expect(result.success).toBe(true);
    });

    it('validates data with errors containing optional fields', () => {
      const data = makeValidState({
        errors: [
          {
            timestamp: '2026-01-15T10:02:00.000Z',
            url: 'https://example.com/broken',
            code: 'ERR_NAVIGATION',
            message: 'Timeout after 30s',
            status: 'timeout',
            httpStatus: 504,
          },
        ],
      });

      const result = CheckpointStateSchema.safeParse(data);
      expect(result.success).toBe(true);
    });

    it('validates frontier entries with optional referrer', () => {
      const data = makeValidState({
        frontier: [
          { url: 'https://example.com/a', depth: 0 },
          {
            url: 'https://example.com/b',
            depth: 1,
            referrer: 'https://example.com/a',
          },
        ],
      });

      const result = CheckpointStateSchema.safeParse(data);
      expect(result.success).toBe(true);
    });

    it('rejects data with wrong version', () => {
      const data = { ...makeValidState(), version: 2 };
      const result = CheckpointStateSchema.safeParse(data);
      expect(result.success).toBe(false);
    });

    it('rejects data missing required fields', () => {
      const result = CheckpointStateSchema.safeParse({
        version: 1,
        // Missing everything else
      });
      expect(result.success).toBe(false);
    });

    it('rejects data with invalid error collector value', () => {
      const data = makeValidState({
        errors: [
          {
            timestamp: '2026-01-15T10:02:00.000Z',
            url: 'https://example.com/broken',
            code: 'ERR_COLLECTOR',
            message: 'Failed',
            collector: 'invalid-collector' as any,
          },
        ],
      });

      const result = CheckpointStateSchema.safeParse(data);
      expect(result.success).toBe(false);
    });

    it('rejects non-numeric pagesVisited', () => {
      const data = { ...makeValidState(), pagesVisited: 'many' };
      const result = CheckpointStateSchema.safeParse(data);
      expect(result.success).toBe(false);
    });
  });

  // -----------------------------------------------------------------------
  // setupAutoCheckpoint
  // -----------------------------------------------------------------------

  describe('setupAutoCheckpoint', () => {
    beforeEach(() => {
      vi.useFakeTimers();
    });

    afterEach(() => {
      vi.useRealTimers();
    });

    it('calls writeCheckpoint periodically at the specified interval', async () => {
      const state = makeValidState();
      const getState = vi.fn(() => state);

      setupAutoCheckpoint(getState, '/output', 5000);

      // No calls before interval elapses
      expect(mockWriteFile).not.toHaveBeenCalled();

      // Advance past one interval
      await vi.advanceTimersByTimeAsync(5000);
      expect(getState).toHaveBeenCalledTimes(1);
      expect(mockWriteFile).toHaveBeenCalledTimes(1);

      // Advance past another interval
      await vi.advanceTimersByTimeAsync(5000);
      expect(getState).toHaveBeenCalledTimes(2);
      expect(mockWriteFile).toHaveBeenCalledTimes(2);
    });

    it('stop() clears the interval and prevents further writes', async () => {
      const state = makeValidState();
      const getState = vi.fn(() => state);

      const { stop } = setupAutoCheckpoint(getState, '/output', 5000);

      await vi.advanceTimersByTimeAsync(5000);
      expect(mockWriteFile).toHaveBeenCalledTimes(1);

      stop();

      await vi.advanceTimersByTimeAsync(15000);
      // No additional calls after stop
      expect(mockWriteFile).toHaveBeenCalledTimes(1);
    });

    it('uses default interval of 30000ms when not specified', async () => {
      const state = makeValidState();
      const getState = vi.fn(() => state);

      setupAutoCheckpoint(getState, '/output');

      await vi.advanceTimersByTimeAsync(29999);
      expect(getState).not.toHaveBeenCalled();

      await vi.advanceTimersByTimeAsync(1);
      expect(getState).toHaveBeenCalledTimes(1);
    });

    it('swallows write errors without crashing', async () => {
      const state = makeValidState();
      const getState = vi.fn(() => state);
      mockWriteFile.mockRejectedValue(new Error('Disk full'));

      setupAutoCheckpoint(getState, '/output', 1000);

      // Should not throw
      await vi.advanceTimersByTimeAsync(1000);
      expect(getState).toHaveBeenCalledTimes(1);

      // Timer should still be running
      mockWriteFile.mockResolvedValue(undefined);
      await vi.advanceTimersByTimeAsync(1000);
      expect(getState).toHaveBeenCalledTimes(2);
    });

    it('throws when intervalMs is not positive', () => {
      expect(() =>
        setupAutoCheckpoint(() => makeValidState(), '/output', 0),
      ).toThrow('positive');

      expect(() =>
        setupAutoCheckpoint(() => makeValidState(), '/output', -100),
      ).toThrow('positive');
    });
  });
});
