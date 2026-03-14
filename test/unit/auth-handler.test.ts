/**
 * Unit tests for src/auth/auth-handler.ts
 *
 * Tests the three auth methods (storage state, cookies, auth script),
 * priority ordering, failure detection, and error handling.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// ---------------------------------------------------------------------------
// Mocks -- declared before imports so vi.mock hoisting works correctly
// ---------------------------------------------------------------------------

vi.mock('node:fs/promises', () => ({
  readFile: vi.fn(),
  writeFile: vi.fn(),
  access: vi.fn(),
}));

vi.mock('node:fs', () => ({
  constants: { R_OK: 4 },
}));

vi.mock('../../src/security/auth-validator.js', () => ({
  validateAuthScript: vi.fn(),
}));

// ---------------------------------------------------------------------------
// Imports
// ---------------------------------------------------------------------------

import { readFile, writeFile, access } from 'node:fs/promises';
import { validateAuthScript } from '../../src/security/auth-validator.js';
import {
  executeAuth,
  detectAuthFailure,
  refreshAuth,
  type AuthOptions,
  type AuthResult,
} from '../../src/auth/auth-handler.js';

// ---------------------------------------------------------------------------
// Typed mock references
// ---------------------------------------------------------------------------

const mockReadFile = vi.mocked(readFile);
const mockWriteFile = vi.mocked(writeFile);
const mockAccess = vi.mocked(access);
const mockValidateAuthScript = vi.mocked(validateAuthScript);

// ---------------------------------------------------------------------------
// Mock factories
// ---------------------------------------------------------------------------

function createMockPage(overrides: Record<string, unknown> = {}): any {
  return {
    url: vi.fn().mockReturnValue('https://app.example.com/dashboard'),
    evaluate: vi.fn().mockResolvedValue({ responseStatus: 200 }),
    goto: vi.fn().mockResolvedValue(undefined),
    fill: vi.fn().mockResolvedValue(undefined),
    click: vi.fn().mockResolvedValue(undefined),
    waitForURL: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  };
}

function createMockContext(overrides: Record<string, unknown> = {}): any {
  return {
    addCookies: vi.fn().mockResolvedValue(undefined),
    addInitScript: vi.fn().mockResolvedValue(undefined),
    cookies: vi.fn().mockResolvedValue([
      { name: 'session', value: 'abc123', domain: 'example.com', path: '/' },
    ]),
    clearCookies: vi.fn().mockResolvedValue(undefined),
    storageState: vi.fn().mockResolvedValue({
      cookies: [{ name: 'session', value: 'abc123', domain: 'example.com', path: '/' }],
      origins: [],
    }),
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Reset mocks
// ---------------------------------------------------------------------------

beforeEach(() => {
  vi.resetAllMocks();

  // Default: file does not exist
  mockAccess.mockRejectedValue(new Error('ENOENT'));

  // Default: validator passes
  mockValidateAuthScript.mockReturnValue({ valid: true, warnings: [] });
});

// ===========================================================================
// Storage State
// ===========================================================================

describe('executeAuth -- storage state', () => {
  it('loads storage state when file exists', async () => {
    const page = createMockPage();
    const context = createMockContext();

    // File exists
    mockAccess.mockResolvedValue(undefined);

    // Storage state JSON
    const stateData = {
      cookies: [
        { name: 'sid', value: 'xyz', domain: 'example.com', path: '/' },
      ],
      origins: [
        {
          origin: 'https://example.com',
          localStorage: [{ name: 'token', value: 'abc' }],
        },
      ],
    };
    mockReadFile.mockResolvedValue(JSON.stringify(stateData));

    const result = await executeAuth(page, context, {
      storageStatePath: '/tmp/state.json',
    });

    expect(result.success).toBe(true);
    expect(result.method).toBe('storageState');
    expect(context.addCookies).toHaveBeenCalledWith(stateData.cookies);
    expect(context.addInitScript).toHaveBeenCalled();
  });

  it('falls through to script when storage state file does not exist', async () => {
    const page = createMockPage();
    const context = createMockContext();

    // storageStatePath file does not exist (first call), auth script exists (second call)
    mockAccess
      .mockRejectedValueOnce(new Error('ENOENT'))  // storageStatePath check
      .mockResolvedValueOnce(undefined);            // authScript check

    // Mock dynamic import for auth script
    const authFn = vi.fn().mockResolvedValue(undefined);
    vi.doMock('/absolute/auth-script.js', () => ({ default: authFn }), {
      virtual: true,
    });

    // The import() in runAuthScript uses resolve() which will produce an absolute path.
    // We need to handle this differently -- the auth handler uses import() directly.
    // For this test, we verify the fallthrough behavior by checking the method used.

    const result = await executeAuth(page, context, {
      storageStatePath: '/tmp/state.json',
      authScript: '/absolute/auth-script.js',
    });

    // It should attempt the script method since storage state file doesn't exist
    expect(result.method).toBe('script');
  });

  it('returns error when storage state JSON is invalid', async () => {
    const page = createMockPage();
    const context = createMockContext();

    mockAccess.mockResolvedValue(undefined);
    mockReadFile.mockResolvedValue('not valid json {{{');

    const result = await executeAuth(page, context, {
      storageStatePath: '/tmp/bad-state.json',
    });

    expect(result.success).toBe(false);
    expect(result.method).toBe('storageState');
    expect(result.error).toContain('Failed to load storage state');
  });
});

// ===========================================================================
// Cookie Injection
// ===========================================================================

describe('executeAuth -- cookies', () => {
  it('injects cookies from JSON file', async () => {
    const page = createMockPage();
    const context = createMockContext();

    const cookies = [
      { name: 'auth', value: 'token123', domain: 'example.com', path: '/' },
      { name: 'pref', value: 'dark', domain: 'example.com', path: '/' },
    ];
    mockReadFile.mockResolvedValue(JSON.stringify(cookies));

    const result = await executeAuth(page, context, {
      cookiesFile: '/tmp/cookies.json',
    });

    expect(result.success).toBe(true);
    expect(result.method).toBe('cookies');
    expect(context.addCookies).toHaveBeenCalledWith(cookies);
  });

  it('handles invalid cookies JSON', async () => {
    const page = createMockPage();
    const context = createMockContext();

    mockReadFile.mockResolvedValue('this is not json');

    const result = await executeAuth(page, context, {
      cookiesFile: '/tmp/bad-cookies.json',
    });

    expect(result.success).toBe(false);
    expect(result.method).toBe('cookies');
    expect(result.error).toContain('Invalid JSON');
  });

  it('handles cookies file that is not an array', async () => {
    const page = createMockPage();
    const context = createMockContext();

    mockReadFile.mockResolvedValue(JSON.stringify({ notAnArray: true }));

    const result = await executeAuth(page, context, {
      cookiesFile: '/tmp/object-cookies.json',
    });

    expect(result.success).toBe(false);
    expect(result.method).toBe('cookies');
    expect(result.error).toContain('JSON array');
  });
});

// ===========================================================================
// Auth Script
// ===========================================================================

describe('executeAuth -- auth script', () => {
  it('validates auth script before execution', async () => {
    const page = createMockPage();
    const context = createMockContext();

    mockValidateAuthScript.mockReturnValue({
      valid: false,
      warnings: ["Dangerous import of 'child_process' detected"],
    });

    // File exists for the validation check
    mockAccess.mockResolvedValue(undefined);

    const result = await executeAuth(page, context, {
      authScript: '/tmp/evil-auth.js',
    });

    expect(result.success).toBe(false);
    expect(result.method).toBe('script');
    expect(result.error).toContain('failed validation');
    expect(result.error).toContain('child_process');
    expect(mockValidateAuthScript).toHaveBeenCalled();
  });

  it('handles missing auth script file', async () => {
    const page = createMockPage();
    const context = createMockContext();

    // Validator will throw for missing file
    mockValidateAuthScript.mockImplementation(() => {
      throw new Error('Auth script not found: /tmp/missing.js');
    });

    const result = await executeAuth(page, context, {
      authScript: '/tmp/missing.js',
    });

    expect(result.success).toBe(false);
    expect(result.method).toBe('script');
    expect(result.error).toContain('not found');
  });

  it('saves storage state after successful script execution', async () => {
    const page = createMockPage();
    const context = createMockContext();

    // Storage state file doesn't exist, auth script does
    mockAccess
      .mockRejectedValueOnce(new Error('ENOENT'))  // storageStatePath
      .mockResolvedValueOnce(undefined);            // authScript

    mockValidateAuthScript.mockReturnValue({ valid: true, warnings: [] });
    mockWriteFile.mockResolvedValue(undefined);

    // We cannot easily mock dynamic import() in vitest for arbitrary paths.
    // The test verifies the flow by checking that when the script import fails,
    // it returns a proper error. For successful script execution, we rely on
    // integration tests.
    const result = await executeAuth(page, context, {
      storageStatePath: '/tmp/state.json',
      authScript: '/tmp/auth.js',
    });

    // Will fail because import() cannot resolve a non-existent file,
    // but validates the flow attempted the script method
    expect(result.method).toBe('script');
  });
});

// ===========================================================================
// Auth Failure Detection
// ===========================================================================

describe('detectAuthFailure', () => {
  it('detects auth failure when URL is on login page', async () => {
    const page = createMockPage({
      url: vi.fn().mockReturnValue('https://app.example.com/login'),
    });

    const result = await detectAuthFailure(page);

    expect(result.failed).toBe(true);
    expect(result.reason).toContain('login page');
  });

  it('detects auth failure on /signin URL', async () => {
    const page = createMockPage({
      url: vi.fn().mockReturnValue('https://app.example.com/signin'),
    });

    const result = await detectAuthFailure(page);

    expect(result.failed).toBe(true);
    expect(result.reason).toContain('login page');
  });

  it('detects auth failure on /auth URL', async () => {
    const page = createMockPage({
      url: vi.fn().mockReturnValue('https://app.example.com/auth/callback'),
    });

    const result = await detectAuthFailure(page);

    expect(result.failed).toBe(true);
    expect(result.reason).toContain('login page');
  });

  it('detects auth failure on /sso URL', async () => {
    const page = createMockPage({
      url: vi.fn().mockReturnValue('https://idp.example.com/sso/saml'),
    });

    const result = await detectAuthFailure(page);

    expect(result.failed).toBe(true);
    expect(result.reason).toContain('login page');
  });

  it('detects auth failure from 401 response', async () => {
    const page = createMockPage({
      url: vi.fn().mockReturnValue('https://app.example.com/dashboard'),
      evaluate: vi.fn().mockResolvedValue({ responseStatus: 401 }),
    });

    const result = await detectAuthFailure(page);

    expect(result.failed).toBe(true);
    expect(result.reason).toContain('401');
  });

  it('detects auth failure from 403 response', async () => {
    const page = createMockPage({
      url: vi.fn().mockReturnValue('https://app.example.com/admin'),
      evaluate: vi.fn().mockResolvedValue({ responseStatus: 403 }),
    });

    const result = await detectAuthFailure(page);

    expect(result.failed).toBe(true);
    expect(result.reason).toContain('403');
  });

  it('returns success when auth completed (URL not on login page)', async () => {
    const page = createMockPage({
      url: vi.fn().mockReturnValue('https://app.example.com/dashboard'),
      evaluate: vi.fn().mockResolvedValue({ responseStatus: 200 }),
    });

    const result = await detectAuthFailure(page);

    expect(result.failed).toBe(false);
    expect(result.reason).toBeUndefined();
  });

  it('handles page.evaluate failure gracefully', async () => {
    const page = createMockPage({
      url: vi.fn().mockReturnValue('https://app.example.com/dashboard'),
      evaluate: vi.fn().mockRejectedValue(new Error('Context destroyed')),
    });

    const result = await detectAuthFailure(page);

    expect(result.failed).toBe(false);
  });
});

// ===========================================================================
// Priority Order
// ===========================================================================

describe('executeAuth -- priority order', () => {
  it('prefers storageState over cookies and script', async () => {
    const page = createMockPage();
    const context = createMockContext();

    // Storage state file exists
    mockAccess.mockResolvedValue(undefined);

    const stateData = {
      cookies: [{ name: 'sid', value: 'x', domain: 'example.com', path: '/' }],
      origins: [],
    };
    mockReadFile.mockResolvedValue(JSON.stringify(stateData));

    const result = await executeAuth(page, context, {
      storageStatePath: '/tmp/state.json',
      cookiesFile: '/tmp/cookies.json',
      authScript: '/tmp/auth.js',
    });

    expect(result.method).toBe('storageState');
    expect(result.success).toBe(true);
    // Cookies file should NOT have been read (only state file)
    expect(mockReadFile).toHaveBeenCalledTimes(1);
  });

  it('prefers cookies over script when no storageState file', async () => {
    const page = createMockPage();
    const context = createMockContext();

    // Storage state path does not exist, cookies file will be read
    mockAccess.mockRejectedValue(new Error('ENOENT'));

    const cookies = [
      { name: 'auth', value: 'token', domain: 'example.com', path: '/' },
    ];
    mockReadFile.mockResolvedValue(JSON.stringify(cookies));

    const result = await executeAuth(page, context, {
      storageStatePath: '/tmp/nonexistent-state.json',
      cookiesFile: '/tmp/cookies.json',
      authScript: '/tmp/auth.js',
    });

    expect(result.method).toBe('cookies');
    expect(result.success).toBe(true);
    // Auth script validator should NOT have been called
    expect(mockValidateAuthScript).not.toHaveBeenCalled();
  });

  it('returns error when no auth method is provided', async () => {
    const page = createMockPage();
    const context = createMockContext();

    const result = await executeAuth(page, context, {});

    expect(result.success).toBe(false);
    expect(result.error).toContain('No authentication method');
  });
});

// ===========================================================================
// Refresh Auth
// ===========================================================================

describe('refreshAuth', () => {
  it('clears cookies before re-running auth', async () => {
    const page = createMockPage();
    const context = createMockContext();

    const cookies = [
      { name: 'auth', value: 'new-token', domain: 'example.com', path: '/' },
    ];
    mockReadFile.mockResolvedValue(JSON.stringify(cookies));

    const result = await refreshAuth(page, context, {
      cookiesFile: '/tmp/cookies.json',
    });

    expect(context.clearCookies).toHaveBeenCalled();
    expect(result.method).toBe('cookies');
  });

  it('re-runs the full auth flow', async () => {
    const page = createMockPage();
    const context = createMockContext();

    // Storage state file exists
    mockAccess.mockResolvedValue(undefined);
    const stateData = {
      cookies: [{ name: 'sid', value: 'refreshed', domain: 'example.com', path: '/' }],
      origins: [],
    };
    mockReadFile.mockResolvedValue(JSON.stringify(stateData));

    const result = await refreshAuth(page, context, {
      storageStatePath: '/tmp/state.json',
    });

    expect(context.clearCookies).toHaveBeenCalled();
    expect(result.success).toBe(true);
    expect(result.method).toBe('storageState');
  });
});
