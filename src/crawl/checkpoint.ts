/**
 * Checkpoint module -- pause/resume support for large crawls.
 *
 * Persists crawl state to disk so that an interrupted crawl can be
 * resumed from the last checkpoint rather than restarting from scratch.
 *
 * Uses atomic writes (write to .tmp, then rename) to prevent corruption
 * if the process is killed mid-write.
 */

import { readFile, writeFile, rename, unlink, access } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';
import type { CheckpointState } from '../types/artifacts.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const CHECKPOINT_FILENAME = '.checkpoint.json';
const CHECKPOINT_TMP_FILENAME = '.checkpoint.json.tmp';
const DEFAULT_AUTO_CHECKPOINT_INTERVAL_MS = 30_000;

// ---------------------------------------------------------------------------
// Zod schema for validation
// ---------------------------------------------------------------------------

export const CheckpointStateSchema = z.object({
  version: z.literal(1),
  startedAt: z.string(),
  checkpointedAt: z.string(),
  frontier: z.array(
    z.object({
      url: z.string(),
      depth: z.number(),
      referrer: z.string().optional(),
    }),
  ),
  visited: z.array(z.string()),
  skipped: z.array(z.string()),
  artifactsDir: z.string(),
  pagesVisited: z.number(),
  errors: z.array(
    z.object({
      timestamp: z.string(),
      url: z.string(),
      code: z.string(),
      message: z.string(),
      collector: z
        .enum(['page-scanner', 'form-prober', 'network-logger', 'screenshot-capturer'])
        .optional(),
      status: z
        .enum(['timeout', 'network_error', 'http_error', 'no_response', 'aborted', 'redirect_loop'])
        .optional(),
      httpStatus: z.number().optional(),
      securityReason: z
        .enum([
          'private_ip',
          'blocked_protocol',
          'dns_rebinding',
          'metadata_endpoint',
          'redirect_to_private',
        ])
        .optional(),
    }),
  ),
  configHash: z.string(),
});

// ---------------------------------------------------------------------------
// writeCheckpoint
// ---------------------------------------------------------------------------

/**
 * Persist checkpoint state to disk using an atomic write strategy.
 *
 * Writes to a temporary file first, then renames it to the final path.
 * This prevents a half-written file if the process is killed mid-write.
 *
 * Updates `state.checkpointedAt` to the current timestamp before writing.
 */
export async function writeCheckpoint(
  state: CheckpointState,
  outputDir: string,
): Promise<void> {
  if (!outputDir) {
    throw new Error('outputDir must be a non-empty string');
  }

  state.checkpointedAt = new Date().toISOString();

  const tmpPath = join(outputDir, CHECKPOINT_TMP_FILENAME);
  const finalPath = join(outputDir, CHECKPOINT_FILENAME);
  const json = JSON.stringify(state, null, 2);

  await writeFile(tmpPath, json, 'utf-8');
  await rename(tmpPath, finalPath);
}

// ---------------------------------------------------------------------------
// readCheckpoint
// ---------------------------------------------------------------------------

/**
 * Read and validate a checkpoint file from disk.
 *
 * Returns `null` if no checkpoint file exists.
 * Throws if the file exists but contains invalid data.
 */
export async function readCheckpoint(
  outputDir: string,
): Promise<CheckpointState | null> {
  if (!outputDir) {
    throw new Error('outputDir must be a non-empty string');
  }

  const filePath = join(outputDir, CHECKPOINT_FILENAME);

  let raw: string;
  try {
    raw = await readFile(filePath, 'utf-8');
  } catch (err: unknown) {
    if (isNodeError(err) && err.code === 'ENOENT') {
      return null;
    }
    throw err;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error(`Checkpoint file is not valid JSON: ${filePath}`);
  }

  const result = CheckpointStateSchema.safeParse(parsed);
  if (!result.success) {
    throw new Error(
      `Invalid checkpoint data in ${filePath}: ${result.error.message}`,
    );
  }

  return result.data as CheckpointState;
}

// ---------------------------------------------------------------------------
// deleteCheckpoint
// ---------------------------------------------------------------------------

/**
 * Remove checkpoint files (both the main file and any leftover tmp file).
 * Silently ignores files that do not exist.
 */
export async function deleteCheckpoint(outputDir: string): Promise<void> {
  if (!outputDir) {
    throw new Error('outputDir must be a non-empty string');
  }

  const filesToRemove = [
    join(outputDir, CHECKPOINT_FILENAME),
    join(outputDir, CHECKPOINT_TMP_FILENAME),
  ];

  await Promise.all(
    filesToRemove.map(async (filePath) => {
      try {
        await unlink(filePath);
      } catch (err: unknown) {
        if (isNodeError(err) && err.code === 'ENOENT') {
          return; // File doesn't exist -- nothing to do
        }
        throw err;
      }
    }),
  );
}

// ---------------------------------------------------------------------------
// createCheckpointState
// ---------------------------------------------------------------------------

/**
 * Create an initial empty checkpoint state.
 *
 * Used at the start of a new crawl to initialize the checkpoint
 * before any pages have been visited.
 */
export function createCheckpointState(params: {
  configHash: string;
  artifactsDir: string;
}): CheckpointState {
  if (!params.configHash) {
    throw new Error('configHash must be a non-empty string');
  }
  if (!params.artifactsDir) {
    throw new Error('artifactsDir must be a non-empty string');
  }

  const now = new Date().toISOString();

  return {
    version: 1,
    startedAt: now,
    checkpointedAt: now,
    frontier: [],
    visited: [],
    skipped: [],
    artifactsDir: params.artifactsDir,
    pagesVisited: 0,
    errors: [],
    configHash: params.configHash,
  };
}

// ---------------------------------------------------------------------------
// setupAutoCheckpoint
// ---------------------------------------------------------------------------

/**
 * Start a periodic auto-checkpoint timer.
 *
 * Calls `writeCheckpoint` every `intervalMs` milliseconds with the
 * current state obtained from `getState()`.
 *
 * Returns an object with a `stop()` method that clears the interval.
 */
export function setupAutoCheckpoint(
  getState: () => CheckpointState,
  outputDir: string,
  intervalMs: number = DEFAULT_AUTO_CHECKPOINT_INTERVAL_MS,
): { stop: () => void } {
  if (!outputDir) {
    throw new Error('outputDir must be a non-empty string');
  }
  if (intervalMs <= 0) {
    throw new Error('intervalMs must be a positive number');
  }

  const timer = setInterval(() => {
    const state = getState();
    writeCheckpoint(state, outputDir).catch(() => {
      // Checkpoint write failures are non-fatal per the graceful
      // degradation contract (see artifacts.ts section 11).
      // The crawl continues without checkpointing.
    });
  }, intervalMs);

  // Allow the Node.js process to exit even if the timer is still active.
  if (typeof timer === 'object' && 'unref' in timer) {
    timer.unref();
  }

  return {
    stop: () => {
      clearInterval(timer);
    },
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

interface NodeError extends Error {
  code?: string;
}

function isNodeError(err: unknown): err is NodeError {
  return err instanceof Error && 'code' in err;
}
