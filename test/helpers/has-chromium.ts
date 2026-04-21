/**
 * Chromium availability detection for tests.
 *
 * Centralizes the "is a Chromium binary actually installed?" check so tests
 * that require a real browser can opt out via `describe.skipIf(!hasChromium)`
 * instead of each test wrapping `dig()` in try/catch and silently swallowing
 * failures.
 *
 * The previous pattern (try { await dig() } catch { return; }) hid real
 * regressions — any crash inside `dig()` was indistinguishable from a
 * missing browser binary. This helper flips that: if Chromium is present,
 * tests run end-to-end and failures surface as real errors.
 */

import { chromium } from 'playwright';
import { existsSync, statSync } from 'node:fs';

/**
 * Check whether a Chromium binary is present on this machine.
 *
 * Returns true iff:
 *   1. `chromium.executablePath()` returns a non-empty string, AND
 *   2. The file at that path exists AND is a regular file.
 *
 * Both conditions are necessary because Playwright can return a path string
 * pointing at a binary that was never installed (e.g. fresh npm install,
 * no `playwright install chromium`).
 *
 * This is synchronous on the filesystem side — no browser launch — so it
 * is safe to call at module top level.
 */
export function detectChromium(): boolean {
  let execPath: string;
  try {
    execPath = chromium.executablePath();
  } catch {
    return false;
  }

  if (typeof execPath !== 'string' || execPath.length === 0) {
    return false;
  }

  if (!existsSync(execPath)) {
    return false;
  }

  try {
    const stat = statSync(execPath);
    return stat.isFile();
  } catch {
    return false;
  }
}

/**
 * One-time cached Chromium availability flag. Evaluated at module load so
 * `describe.skipIf(!hasChromium)` works without async.
 */
export const hasChromium = detectChromium();
