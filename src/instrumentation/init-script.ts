/**
 * Browser instrumentation for playwright-archaeologist.
 *
 * This module provides:
 * - getInitScript() — Returns JavaScript to inject via context.addInitScript().
 *   Runs in the BROWSER context (plain JS, no TypeScript, no Node.js APIs).
 * - setupPageInstrumentation() — Configures a Playwright Page for crawling.
 * - setupContextInstrumentation() — Configures a BrowserContext for crawling.
 * - NavigationCollector — Collects navigation events reported from the browser.
 *
 * Navigation interception strategy:
 *   PRIMARY: Navigation API (window.navigation) — Chromium 102+, catches ALL navigation types.
 *   FALLBACK: History API monkey-patching (pushState/replaceState).
 *   SUPPLEMENTARY: popstate + hashchange event listeners.
 *
 * DOM stability detection:
 *   MutationObserver tracks meaningful DOM changes. The __pa_isDomStable()
 *   function returns true when no meaningful mutations have occurred for 500ms.
 *
 * Critical ordering requirement:
 *   exposeFunction('__pa_reportNavigation') MUST be called BEFORE addInitScript,
 *   because the init script references window.__pa_reportNavigation which is
 *   created by exposeFunction. If the page loads before exposeFunction completes,
 *   the callback will be undefined.
 */

import type { Page, BrowserContext } from 'playwright';
import { logger } from '../utils/logger.js';

// ---------------------------------------------------------------------------
// Navigation event shape (passed from browser to Node.js)
// ---------------------------------------------------------------------------

export interface NavigationEvent {
  url: string;
  type: 'navigation-api' | 'pushState' | 'replaceState' | 'popstate' | 'hashchange';
  timestamp: number;
}

// ---------------------------------------------------------------------------
// NavigationCollector
// ---------------------------------------------------------------------------

/**
 * Collects navigation events reported from the browser via exposeFunction.
 * Thread-safe in the Node.js sense — all calls are on the same event loop.
 */
export class NavigationCollector {
  private urls: string[] = [];
  private seen: Set<string> = new Set();

  /**
   * Handler function to pass to exposeFunction. Receives navigation events
   * from the browser init script and stores unique URLs.
   */
  readonly handler = (event: NavigationEvent): void => {
    if (!event || typeof event.url !== 'string') return;

    // Validate the URL before storing
    let normalized: string;
    try {
      normalized = new URL(event.url).href;
    } catch {
      logger.debug(`Ignoring malformed navigation URL: ${event.url}`);
      return;
    }

    // Skip non-http protocols (javascript:, data:, blob:, etc.)
    if (!normalized.startsWith('http:') && !normalized.startsWith('https:')) {
      return;
    }

    if (!this.seen.has(normalized)) {
      this.seen.add(normalized);
      this.urls.push(normalized);
      logger.debug(`Navigation detected [${event.type}]: ${normalized}`);
    }
  };

  /**
   * Returns all URLs discovered since the last call to getDiscoveredUrls()
   * or clear(). The returned array is a snapshot — the internal buffer is
   * drained so the same URLs are not returned twice.
   */
  getDiscoveredUrls(): string[] {
    const result = this.urls.slice();
    this.urls = [];
    return result;
  }

  /**
   * Returns all unique URLs seen across the lifetime of this collector,
   * without draining the buffer.
   */
  getAllSeenUrls(): string[] {
    return Array.from(this.seen);
  }

  /** Resets the collector completely — clears both the buffer and the seen set. */
  clear(): void {
    this.urls = [];
    this.seen.clear();
  }
}

// ---------------------------------------------------------------------------
// Init script (runs in BROWSER context)
// ---------------------------------------------------------------------------

/**
 * Returns the JavaScript string to inject via context.addInitScript().
 *
 * This script runs in the BROWSER — it must be plain JavaScript with no
 * TypeScript, no imports, and no Node.js APIs. It is a self-executing
 * function wrapped in try/catch so that failures in our instrumentation
 * do not break the target site.
 *
 * The script expects window.__pa_reportNavigation to already exist
 * (set up via page.exposeFunction or context.exposeBinding before this
 * script runs).
 */
export function getInitScript(): string {
  // The entire script is a string literal. It must be valid browser JS.
  return `
(function() {
  'use strict';

  try {
    // -----------------------------------------------------------------------
    // Navigation event reporting
    // -----------------------------------------------------------------------

    // __pa_reportNavigation is exposed by Playwright via exposeFunction.
    // It may not exist if exposeFunction was not called (defensive).
    var report = typeof window.__pa_reportNavigation === 'function'
      ? window.__pa_reportNavigation
      : null;

    // Internal URL collection for fallback (if exposeFunction is unavailable
    // or for use via __pa_getDiscoveredUrls).
    var discoveredUrls = [];
    var seenUrls = {};

    function recordNavigation(url, type) {
      if (!url) return;

      var resolved;
      try {
        resolved = new URL(url, location.href).href;
      } catch (e) {
        return;
      }

      // Only record http/https
      if (resolved.indexOf('http:') !== 0 && resolved.indexOf('https:') !== 0) {
        return;
      }

      if (!seenUrls[resolved]) {
        seenUrls[resolved] = true;
        discoveredUrls.push(resolved);
      }

      if (report) {
        try {
          report({ url: resolved, type: type, timestamp: Date.now() });
        } catch (e) {
          // exposeFunction callback can fail if the page context is being torn down.
          // Swallow silently — the URL is still recorded in discoveredUrls.
        }
      }
    }

    // -----------------------------------------------------------------------
    // PRIMARY: Navigation API (Chromium 102+)
    // Catches ALL navigation types: link clicks, form submissions,
    // pushState, replaceState, back/forward, location.assign, etc.
    // -----------------------------------------------------------------------

    if (typeof window.navigation !== 'undefined' && window.navigation &&
        typeof window.navigation.addEventListener === 'function') {
      window.navigation.addEventListener('navigate', function(event) {
        try {
          if (event && event.destination && event.destination.url) {
            recordNavigation(event.destination.url, 'navigation-api');
          }
        } catch (e) {
          // Defensive — never break the target site's navigation
        }
      });
    }

    // -----------------------------------------------------------------------
    // FALLBACK: History API monkey-patching
    // Catches pushState and replaceState calls from SPA frameworks that may
    // have captured the original references before our patch (unlikely given
    // addInitScript timing, but defense-in-depth).
    // -----------------------------------------------------------------------

    var origPushState = history.pushState.bind(history);
    var origReplaceState = history.replaceState.bind(history);

    history.pushState = function(state, unused, url) {
      var result = origPushState(state, unused, url);
      try {
        recordNavigation(
          url ? new URL(url, location.href).href : location.href,
          'pushState'
        );
      } catch (e) {
        // Never break the calling code
      }
      return result;
    };

    history.replaceState = function(state, unused, url) {
      var result = origReplaceState(state, unused, url);
      try {
        recordNavigation(
          url ? new URL(url, location.href).href : location.href,
          'replaceState'
        );
      } catch (e) {
        // Never break the calling code
      }
      return result;
    };

    // -----------------------------------------------------------------------
    // SUPPLEMENTARY: popstate (browser back/forward)
    // -----------------------------------------------------------------------

    window.addEventListener('popstate', function() {
      try {
        recordNavigation(location.href, 'popstate');
      } catch (e) {}
    });

    // -----------------------------------------------------------------------
    // SUPPLEMENTARY: hashchange (hash-based routing)
    // -----------------------------------------------------------------------

    window.addEventListener('hashchange', function() {
      try {
        recordNavigation(location.href, 'hashchange');
      } catch (e) {}
    });

    // -----------------------------------------------------------------------
    // DOM stability detection via MutationObserver
    // -----------------------------------------------------------------------

    var lastMutationTime = Date.now(); // Treat page load as initial mutation

    var observer = new MutationObserver(function(mutations) {
      // Filter for meaningful mutations to avoid noise from animations,
      // CSS transitions, and framework housekeeping.
      var hasMeaningful = false;

      for (var i = 0; i < mutations.length; i++) {
        var m = mutations[i];
        if (m.type === 'childList') {
          // Node additions/removals are always meaningful
          hasMeaningful = true;
          break;
        }
        if (m.type === 'attributes') {
          // Only count attribute changes on semantic elements or
          // attributes that indicate structural DOM changes.
          var tag = m.target.tagName;
          if (tag === 'DIALOG' || tag === 'DETAILS' ||
              tag === 'INPUT' || tag === 'SELECT' ||
              m.attributeName === 'role' ||
              m.attributeName === 'aria-hidden' ||
              m.attributeName === 'open' ||
              m.attributeName === 'hidden') {
            hasMeaningful = true;
            break;
          }
        }
      }

      if (hasMeaningful) {
        lastMutationTime = Date.now();
      }
    });

    // Start observing once the document element exists
    if (document.documentElement) {
      observer.observe(document.documentElement, {
        childList: true,
        subtree: true,
        attributes: true,
        attributeFilter: ['role', 'aria-hidden', 'open', 'hidden', 'class', 'style']
      });
    } else {
      // Fallback: wait for DOMContentLoaded if documentElement is not yet available
      document.addEventListener('DOMContentLoaded', function() {
        if (document.documentElement) {
          observer.observe(document.documentElement, {
            childList: true,
            subtree: true,
            attributes: true,
            attributeFilter: ['role', 'aria-hidden', 'open', 'hidden', 'class', 'style']
          });
        }
      });
    }

    // -----------------------------------------------------------------------
    // Exposed functions for Playwright to call via page.evaluate()
    // -----------------------------------------------------------------------

    /**
     * Returns true when no meaningful DOM mutations have occurred for 500ms.
     * Used by the crawler to determine when the page has "settled" after
     * navigation or interaction.
     */
    window.__pa_isDomStable = function() {
      return Date.now() - lastMutationTime > 500;
    };

    /**
     * Returns URLs discovered via navigation events (pushState, replaceState,
     * Navigation API, popstate, hashchange). This is a fallback mechanism
     * for when exposeFunction is not available. The array is drained on read.
     */
    window.__pa_getDiscoveredUrls = function() {
      var result = discoveredUrls.slice();
      discoveredUrls = [];
      return result;
    };

  } catch (e) {
    // The init script must NEVER break the target site.
    // If anything fails during setup, we silently degrade —
    // the crawler will still work via link extraction and framenavigated events.
    if (typeof console !== 'undefined' && console.warn) {
      console.warn('[playwright-archaeologist] Init script error:', e);
    }
  }
})();
`;
}

// ---------------------------------------------------------------------------
// Page instrumentation
// ---------------------------------------------------------------------------

/**
 * Sets up a Playwright Page for crawling with navigation interception,
 * dialog handling, and JS error logging.
 *
 * MUST be called BEFORE the page navigates to any URL, because
 * exposeFunction must be registered before the init script runs.
 *
 * @param page - The Playwright Page to instrument.
 * @param collector - NavigationCollector to receive navigation events.
 * @returns The same collector, for chaining convenience.
 */
export async function setupPageInstrumentation(
  page: Page,
  collector: NavigationCollector
): Promise<NavigationCollector> {
  // 1. Expose the navigation reporting function BEFORE any page loads.
  //    This creates window.__pa_reportNavigation in the browser context.
  //    exposeFunction persists across navigations within the same page.
  await page.exposeFunction('__pa_reportNavigation', collector.handler);

  // 2. Auto-dismiss dialogs (alert, confirm, prompt, beforeunload).
  //    Without this, the crawler will hang on any dialog.
  page.on('dialog', async (dialog) => {
    try {
      await dialog.dismiss();
    } catch {
      // Dialog may already be closed if the page navigated away
    }
  });

  // 3. Log JavaScript errors on the target page.
  //    Our init script uses try/catch internally, so target site errors
  //    should not corrupt our instrumentation. Log for debugging.
  page.on('pageerror', (error) => {
    logger.debug(`JS error on ${page.url()}: ${error.message}`);
  });

  return collector;
}

// ---------------------------------------------------------------------------
// Context instrumentation
// ---------------------------------------------------------------------------

/**
 * Sets up a BrowserContext for crawling. This is the preferred entry point
 * because it applies instrumentation to ALL pages opened within the context,
 * including popups.
 *
 * The init script is registered via context.addInitScript() so it runs
 * on every new document (including soft navigations that create new documents).
 *
 * @param context - The Playwright BrowserContext to instrument.
 * @returns A NavigationCollector that accumulates discovered URLs.
 */
export async function setupContextInstrumentation(
  context: BrowserContext
): Promise<NavigationCollector> {
  const collector = new NavigationCollector();

  // 1. Register the init script on the context.
  //    This runs on every new document BEFORE any page scripts execute.
  //    Note: addInitScript does NOT depend on exposeFunction ordering at the
  //    context level — it just registers the script text. The script itself
  //    checks for window.__pa_reportNavigation existence defensively.
  await context.addInitScript(getInitScript());

  // 2. Handle popup pages (window.open, target="_blank", etc.).
  //    Record the popup URL into the collector before closing it.
  //    This ensures we discover URLs from popups without letting them
  //    consume browser resources.
  context.on('page', async (popup) => {
    try {
      const url = popup.url();

      // Popups often start at 'about:blank' and then navigate.
      // Wait briefly for the actual URL to resolve.
      if (!url || url === 'about:blank') {
        try {
          await popup.waitForURL(/^https?:\/\//, { timeout: 3000 });
        } catch {
          // Popup never navigated to a real URL — skip it
        }
      }

      const finalUrl = popup.url();
      if (finalUrl && finalUrl !== 'about:blank') {
        collector.handler({
          url: finalUrl,
          type: 'navigation-api', // Treat popup URLs as navigation events
          timestamp: Date.now(),
        });
        logger.debug(`Captured popup URL: ${finalUrl}`);
      }

      await popup.close();
    } catch {
      // Popup may have already closed itself
      try {
        await popup.close();
      } catch {
        // Already closed
      }
    }
  });

  return collector;
}

// ---------------------------------------------------------------------------
// Page-level context instrumentation helper
// ---------------------------------------------------------------------------

/**
 * Instruments an individual page within an already-instrumented context.
 * Use this when the context was set up via setupContextInstrumentation()
 * and you need to add page-level handlers (dialog, pageerror) plus
 * the exposeFunction binding.
 *
 * The init script is already registered on the context, so we only need
 * to expose the navigation function and add event handlers.
 *
 * @param page - The page to instrument.
 * @param collector - The NavigationCollector from setupContextInstrumentation().
 */
export async function instrumentPage(
  page: Page,
  collector: NavigationCollector
): Promise<void> {
  // Expose the bridge function so the init script can report navigation events.
  // This must happen before the page navigates.
  await page.exposeFunction('__pa_reportNavigation', collector.handler);

  // Dialog dismissal
  page.on('dialog', async (dialog) => {
    try {
      await dialog.dismiss();
    } catch {
      // Dialog may already be closed
    }
  });

  // JS error logging
  page.on('pageerror', (error) => {
    logger.debug(`JS error on ${page.url()}: ${error.message}`);
  });
}
