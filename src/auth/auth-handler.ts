/**
 * Auth Handler
 *
 * Manages authentication flows for the crawler. Supports three methods
 * in priority order: storage state, cookie injection, and auth scripts.
 *
 * Storage state is the most direct method (restores full browser state).
 * Cookie injection loads cookies from a JSON file.
 * Auth scripts execute user-provided Playwright automation to log in.
 */

import { resolve } from 'node:path';
import { readFile, writeFile, access } from 'node:fs/promises';
import { constants } from 'node:fs';
import { validateAuthScript } from '../security/auth-validator.js';

import type { Page, BrowserContext, Cookie } from 'playwright';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface AuthOptions {
  /** Path to auth script (JS/TS file that exports default async function(page)) */
  authScript?: string;
  /** Path to cookies JSON file */
  cookiesFile?: string;
  /** Path to save/load storage state */
  storageStatePath?: string;
}

export interface AuthResult {
  success: boolean;
  method: 'script' | 'cookies' | 'storageState';
  /** Error message if auth failed */
  error?: string;
  /** URL after auth completed */
  finalUrl?: string;
  /** Cookies set during auth */
  cookieCount: number;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/**
 * URL path patterns that indicate the user is still on a login page.
 * Used to detect auth failures after running an auth flow.
 */
const LOGIN_PATH_PATTERNS = [
  /\/login\b/i,
  /\/signin\b/i,
  /\/sign-in\b/i,
  /\/auth\b/i,
  /\/sso\b/i,
];

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Check whether a file exists and is readable.
 */
async function fileExists(filePath: string): Promise<boolean> {
  try {
    await access(filePath, constants.R_OK);
    return true;
  } catch {
    return false;
  }
}

/**
 * Check whether the current page URL matches common login page patterns.
 */
function isLoginUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    return LOGIN_PATH_PATTERNS.some((re) => re.test(parsed.pathname));
  } catch {
    return false;
  }
}

/**
 * Get the cookie count from the browser context.
 */
async function getCookieCount(context: BrowserContext): Promise<number> {
  const cookies = await context.cookies();
  return cookies.length;
}

// ---------------------------------------------------------------------------
// Storage State
// ---------------------------------------------------------------------------

interface StorageStateData {
  cookies: Cookie[];
  origins: Array<{
    origin: string;
    localStorage: Array<{ name: string; value: string }>;
  }>;
}

/**
 * Load storage state from a JSON file.
 * Restores cookies via context.addCookies() and localStorage via context.addInitScript().
 */
async function loadStorageState(
  context: BrowserContext,
  statePath: string,
): Promise<void> {
  const raw = await readFile(statePath, 'utf-8');
  const state: StorageStateData = JSON.parse(raw);

  if (!state || typeof state !== 'object') {
    throw new Error(`Invalid storage state file: ${statePath}`);
  }

  // Restore cookies
  if (Array.isArray(state.cookies) && state.cookies.length > 0) {
    await context.addCookies(state.cookies);
  }

  // Restore localStorage via init script
  if (Array.isArray(state.origins)) {
    for (const origin of state.origins) {
      if (
        !origin.origin ||
        !Array.isArray(origin.localStorage) ||
        origin.localStorage.length === 0
      ) {
        continue;
      }
      const items = origin.localStorage;
      await context.addInitScript(
        (data: { origin: string; items: Array<{ name: string; value: string }> }) => {
          if (window.location.origin === data.origin) {
            for (const item of data.items) {
              try {
                localStorage.setItem(item.name, item.value);
              } catch {
                // localStorage may be unavailable
              }
            }
          }
        },
        { origin: origin.origin, items },
      );
    }
  }
}

/**
 * Save the current browser context state to a JSON file.
 */
async function saveStorageState(
  context: BrowserContext,
  statePath: string,
): Promise<void> {
  const state = await context.storageState();
  await writeFile(statePath, JSON.stringify(state, null, 2), 'utf-8');
}

// ---------------------------------------------------------------------------
// Cookie injection
// ---------------------------------------------------------------------------

/**
 * Load cookies from a JSON file and inject them into the browser context.
 * The file must contain a JSON array of Playwright Cookie objects.
 */
async function loadCookies(
  context: BrowserContext,
  cookiesPath: string,
): Promise<number> {
  const raw = await readFile(cookiesPath, 'utf-8');
  let cookies: unknown;
  try {
    cookies = JSON.parse(raw);
  } catch {
    throw new Error(
      `Invalid JSON in cookies file: ${cookiesPath}`,
    );
  }

  if (!Array.isArray(cookies)) {
    throw new Error(
      `Cookies file must contain a JSON array: ${cookiesPath}`,
    );
  }

  if (cookies.length === 0) {
    return 0;
  }

  await context.addCookies(cookies as Cookie[]);
  return cookies.length;
}

// ---------------------------------------------------------------------------
// Auth script execution
// ---------------------------------------------------------------------------

/**
 * Validate and execute a user-provided auth script.
 * The script must export a default async function that accepts a Playwright Page.
 */
async function runAuthScript(
  page: Page,
  scriptPath: string,
): Promise<void> {
  const resolvedPath = resolve(scriptPath);

  // Validate script safety before execution
  const validation = validateAuthScript(resolvedPath);
  if (!validation.valid) {
    throw new Error(
      `Auth script failed validation: ${validation.warnings.join('; ')}`,
    );
  }

  // Check file exists
  if (!(await fileExists(resolvedPath))) {
    throw new Error(`Auth script not found: ${resolvedPath}`);
  }

  // Dynamic import
  let mod: Record<string, unknown>;
  try {
    mod = await import(resolvedPath) as Record<string, unknown>;
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(`Failed to import auth script '${resolvedPath}': ${message}`);
  }

  const authFn = mod.default;
  if (typeof authFn !== 'function') {
    throw new Error(
      `Auth script '${resolvedPath}' must export a default async function`,
    );
  }

  await authFn(page);
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Detect whether the current page state indicates an auth failure.
 *
 * Checks:
 * - URL matches common login page patterns
 * - Page title or response status hints at auth problems
 */
export async function detectAuthFailure(
  page: Page,
): Promise<{ failed: boolean; reason?: string }> {
  const url = page.url();

  // Check if still on a login page
  if (isLoginUrl(url)) {
    return {
      failed: true,
      reason: `Still on login page: ${url}`,
    };
  }

  // Check for 401/403 response status on the main frame
  // page.mainFrame().response() is not always available,
  // so we check the page's last navigation response.
  try {
    const response = await page.evaluate(() => {
      // Access performance entries to check for HTTP status
      const entries = performance.getEntriesByType('navigation') as PerformanceNavigationTiming[];
      if (entries.length > 0) {
        return { responseStatus: (entries[0] as any).responseStatus ?? null };
      }
      return { responseStatus: null };
    });

    if (
      response.responseStatus === 401 ||
      response.responseStatus === 403
    ) {
      return {
        failed: true,
        reason: `Received HTTP ${response.responseStatus} response`,
      };
    }
  } catch {
    // evaluate may fail if page context is destroyed -- not a failure signal
  }

  return { failed: false };
}

/**
 * Execute an authentication flow.
 *
 * Priority order: storageState > cookies > authScript.
 * Uses the most direct method available. If storage state path is provided
 * but doesn't exist yet, falls through to script execution and saves state after.
 *
 * @param page - Playwright Page instance
 * @param context - Playwright BrowserContext instance
 * @param options - Auth configuration
 * @returns Result describing the auth outcome
 */
export async function executeAuth(
  page: Page,
  context: BrowserContext,
  options: AuthOptions,
): Promise<AuthResult> {
  // Validate that at least one auth method is provided
  if (!options.storageStatePath && !options.cookiesFile && !options.authScript) {
    return {
      success: false,
      method: 'script',
      error: 'No authentication method provided',
      cookieCount: 0,
    };
  }

  // ------ Storage State (highest priority) ------
  if (options.storageStatePath) {
    const stateExists = await fileExists(options.storageStatePath);

    if (stateExists) {
      try {
        await loadStorageState(context, options.storageStatePath);
        const cookieCount = await getCookieCount(context);

        return {
          success: true,
          method: 'storageState',
          finalUrl: page.url(),
          cookieCount,
        };
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        return {
          success: false,
          method: 'storageState',
          error: `Failed to load storage state: ${message}`,
          cookieCount: 0,
        };
      }
    }

    // Storage state path provided but doesn't exist -- fall through to script,
    // then save state after successful auth.
  }

  // ------ Cookie Injection ------
  if (options.cookiesFile) {
    try {
      const injectedCount = await loadCookies(context, options.cookiesFile);
      const cookieCount = await getCookieCount(context);

      return {
        success: true,
        method: 'cookies',
        finalUrl: page.url(),
        cookieCount: cookieCount > 0 ? cookieCount : injectedCount,
      };
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      return {
        success: false,
        method: 'cookies',
        error: `Failed to inject cookies: ${message}`,
        cookieCount: 0,
      };
    }
  }

  // ------ Auth Script ------
  if (options.authScript) {
    try {
      await runAuthScript(page, options.authScript);

      // Check for auth failure after script execution
      const failureCheck = await detectAuthFailure(page);
      if (failureCheck.failed) {
        return {
          success: false,
          method: 'script',
          error: failureCheck.reason,
          finalUrl: page.url(),
          cookieCount: await getCookieCount(context),
        };
      }

      // Save storage state for future reuse if path was provided
      if (options.storageStatePath) {
        try {
          await saveStorageState(context, options.storageStatePath);
        } catch {
          // Failing to save state is non-fatal -- auth itself succeeded
        }
      }

      const cookieCount = await getCookieCount(context);
      return {
        success: true,
        method: 'script',
        finalUrl: page.url(),
        cookieCount,
      };
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      return {
        success: false,
        method: 'script',
        error: `Auth script failed: ${message}`,
        finalUrl: page.url(),
        cookieCount: 0,
      };
    }
  }

  // Should not reach here given the early validation, but be defensive
  return {
    success: false,
    method: 'script',
    error: 'No authentication method could be applied',
    cookieCount: 0,
  };
}

/**
 * Re-run the authentication flow. Used when a session expires during a crawl.
 *
 * This is a thin wrapper around executeAuth that clears existing cookies
 * before re-running to avoid stale state.
 */
export async function refreshAuth(
  page: Page,
  context: BrowserContext,
  options: AuthOptions,
): Promise<AuthResult> {
  // Clear existing cookies to force a fresh auth
  await context.clearCookies();

  return executeAuth(page, context, options);
}
