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
  recordHar?: { path: string; content?: 'embed' | 'attach'; mode?: 'full' | 'minimal' };
  userAgent?: string;
  acceptDownloads?: boolean;
}

export const TOOL_VERSION = '0.1.0';

/**
 * Maximum number of HTTP redirects to follow before aborting.
 */
export const MAX_REDIRECTS = 10;

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
