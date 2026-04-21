/**
 * Browser Hardening
 *
 * Provides secure default options for Playwright browser contexts and launches.
 * Ensures CSP bypass for inspection, blocks downloads, blocks service workers,
 * disables WebRTC leaks, auto-dismisses dialogs, closes popups, and limits
 * resource types.
 */

import type { BrowserContextOptions, LaunchOptions, Page } from 'playwright';

export interface SecureContextOptions {
  viewport?: { width: number; height: number };
  storageState?: BrowserContextOptions['storageState'];
  recordHar?: { path: string; content?: 'embed' | 'attach' | 'omit'; mode?: 'full' | 'minimal' };
  userAgent?: string;
  acceptDownloads?: boolean;
}

import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { existsSync } from 'node:fs';
const _require = createRequire(import.meta.url);

/**
 * Locate package.json robustly whether this module is loaded from its
 * source location (`src/security/browser-hardening.ts` — two levels
 * deep from the package root) or its bundled location
 * (`dist/cli.js` or `dist/index.js` — one level deep).
 *
 * tsup collapses all source into `dist/*.js`, so `../../package.json`
 * relative to the bundled file does not exist. Fall back to
 * `../package.json` when the two-up lookup fails.
 */
function locatePackageJson(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  const candidates = [
    join(here, '..', '..', 'package.json'),
    join(here, '..', 'package.json'),
  ];
  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate;
  }
  // Let the caller see a clear error — a missing package.json is a packaging bug.
  return candidates[0];
}

const _pkg = _require(locatePackageJson()) as { version: string };
export const TOOL_VERSION = _pkg.version;

/**
 * Resource types that are blocked to reduce attack surface and noise.
 * Documents, stylesheets, images, scripts, xhr, and fetch are allowed
 * because they are needed for crawling and screenshot capture.
 */
export const BLOCKED_RESOURCE_TYPES: string[] = [
  'media',
  'font',
  'websocket',
];

/**
 * Secure browser launch options.
 * - Preserves Chromium sandbox
 * - Disables WebRTC to prevent IP leaks
 * - Disables signal handling so the tool controls shutdown
 */
export const LAUNCH_OPTIONS: LaunchOptions = {
  handleSIGINT: false,
  handleSIGTERM: false,
  handleSIGHUP: false,
  args: [
    '--disable-webrtc',
    '--enforce-webrtc-ip-permission-check',
    '--force-webrtc-ip-handling-policy=disable_non_proxied_udp',
  ],
};

/**
 * Build BrowserContextOptions with secure defaults.
 *
 * - bypassCSP: true -- allows the tool to inspect pages behind CSP
 * - acceptDownloads: false -- prevents file downloads
 * - javaScriptEnabled: true -- required for SPA inspection
 * - ignoreHTTPSErrors: false -- enforces certificate validation
 * - serviceWorkers: 'block' -- prevents SW interference with network capture
 * - permissions: [] -- deny all permission prompts
 * - viewport: 1280x720 default
 * - userAgent: identifies this tool
 */
export function getSecureContextOptions(opts?: SecureContextOptions): BrowserContextOptions {
  return {
    bypassCSP: true,
    acceptDownloads: false,
    javaScriptEnabled: true,
    ignoreHTTPSErrors: false,
    serviceWorkers: 'block',
    permissions: [],
    viewport: opts?.viewport ?? { width: 1280, height: 720 },
    ...(opts?.userAgent && { userAgent: opts.userAgent }),
    ...(opts?.storageState && { storageState: opts.storageState }),
    ...(opts?.recordHar && { recordHar: opts.recordHar }),
  };
}

/**
 * Build secure launch options for Playwright browser.
 * Alias for LAUNCH_OPTIONS for backward compatibility.
 */
export function getSecureLaunchOptions(): LaunchOptions {
  return { ...LAUNCH_OPTIONS };
}

/**
 * Register safety event handlers on a Playwright Page.
 * - Auto-dismisses all dialog types (alert, confirm, prompt, beforeunload)
 * - Auto-closes popup windows
 */
export function registerPageSafetyHandlers(page: Page): void {
  // Auto-dismiss all dialogs
  page.on('dialog', async (dialog) => {
    await dialog.dismiss();
  });

  // Auto-close popup windows
  page.on('popup', async (popup) => {
    await popup.close();
  });
}
