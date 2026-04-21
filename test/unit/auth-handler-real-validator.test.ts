/**
 * Auth handler tests that DO NOT mock the auth validator.
 *
 * The sibling `auth-handler.test.ts` mocks `src/security/auth-validator`
 * end-to-end, which makes the validation assertions tautological (the
 * test asserts `mockValidateAuthScript` was called, not that a dangerous
 * script is actually blocked).
 *
 * This file unmocks the validator and writes real temp scripts on disk,
 * so the full static-analysis path runs for real: read file → scan for
 * dangerous module imports → reject with `SecurityError` when found
 * (unless `allowAuthScript: true` overrides).
 *
 * The Playwright page/context is still stubbed — the scripts we feed are
 * benign enough to no-op (or purposefully dangerous enough to be rejected
 * before import).
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { Page, BrowserContext } from 'playwright';

import { executeAuth } from '../../src/auth/auth-handler.js';

// ---------------------------------------------------------------------------
// Stubs for Playwright Page/BrowserContext — only the methods our script paths
// actually touch.
// ---------------------------------------------------------------------------

function stubPage(url = 'https://app.example.com/dashboard'): Page {
  return {
    url: () => url,
    // Needed by detectAuthFailure after a successful script run.
    evaluate: async () => ({ responseStatus: 200 }),
  } as unknown as Page;
}

function stubContext(): BrowserContext {
  return {
    cookies: async () => [],
    clearCookies: async () => {},
    addCookies: async () => {},
    addInitScript: async () => {},
    storageState: async () => ({ cookies: [], origins: [] }),
  } as unknown as BrowserContext;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('executeAuth — real auth validator integration', () => {
  let tmp: string;

  beforeEach(async () => {
    tmp = await mkdtemp(join(tmpdir(), 'pa-auth-real-validator-'));
  });

  afterEach(async () => {
    await rm(tmp, { recursive: true, force: true }).catch(() => {});
  });

  it('rejects an auth script that imports child_process (no allowAuthScript)', async () => {
    // Real dangerous script on disk — the static-analysis scanner must
    // detect the `child_process` require and abort before import.
    const scriptPath = join(tmp, 'evil-auth.mjs');
    await writeFile(
      scriptPath,
      [
        "import { execSync } from 'node:child_process';",
        "export default async function login(page) {",
        "  execSync('echo pwned');",
        "}",
        '',
      ].join('\n'),
      'utf-8',
    );

    const result = await executeAuth(stubPage(), stubContext(), {
      authScript: scriptPath,
      // allowAuthScript intentionally NOT set — security gate should fire.
    });

    expect(result.success).toBe(false);
    expect(result.method).toBe('script');
    // The handler wraps SecurityError messages; we look for the signal
    // terms the handler adds.
    expect(result.error).toMatch(/failed static analysis|child_process|dangerous/i);
  });

  it('rejects an auth script that uses eval() (no allowAuthScript)', async () => {
    const scriptPath = join(tmp, 'eval-auth.mjs');
    await writeFile(
      scriptPath,
      [
        "export default async function login(page) {",
        "  eval('1 + 1');",
        "}",
        '',
      ].join('\n'),
      'utf-8',
    );

    const result = await executeAuth(stubPage(), stubContext(), {
      authScript: scriptPath,
    });

    expect(result.success).toBe(false);
    expect(result.error).toMatch(/eval|dangerous|static analysis/i);
  });

  it('rejects an auth script that imports fs (no allowAuthScript)', async () => {
    const scriptPath = join(tmp, 'fs-auth.mjs');
    await writeFile(
      scriptPath,
      [
        "import { readFileSync } from 'node:fs';",
        "export default async function login(page) {",
        "  const data = readFileSync('/etc/passwd', 'utf-8');",
        "  await page.fill('#password', data);",
        "}",
        '',
      ].join('\n'),
      'utf-8',
    );

    const result = await executeAuth(stubPage(), stubContext(), {
      authScript: scriptPath,
    });

    expect(result.success).toBe(false);
    expect(result.error).toMatch(/fs|dangerous|static analysis/i);
  });

  it('runs a benign auth script when static analysis passes', async () => {
    // No dangerous imports, no eval — the validator returns
    // { valid: true, warnings: [] }. The handler should then import the
    // module, call its default export, and mark success.
    const scriptPath = join(tmp, 'benign-auth.mjs');
    await writeFile(
      scriptPath,
      [
        "export default async function login(page) {",
        "  // Uses only the page argument — no filesystem or process access.",
        "  await Promise.resolve();",
        "}",
        '',
      ].join('\n'),
      'utf-8',
    );

    const result = await executeAuth(stubPage(), stubContext(), {
      authScript: scriptPath,
    });

    // The script's default export returns without doing anything
    // interesting, so detectAuthFailure sees a non-login URL + 200
    // response → success=true.
    expect(result.method).toBe('script');
    expect(result.success).toBe(true);
  });

  it('rejects a missing auth script with a not-found error', async () => {
    const result = await executeAuth(stubPage(), stubContext(), {
      authScript: join(tmp, 'nonexistent.mjs'),
    });

    expect(result.success).toBe(false);
    expect(result.method).toBe('script');
    expect(result.error).toMatch(/not found|ENOENT/i);
  });
});
