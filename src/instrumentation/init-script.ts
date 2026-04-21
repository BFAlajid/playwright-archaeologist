/**
 * Browser instrumentation init script.
 *
 * The orchestrator injects a smaller DOM-stability-only init script inline;
 * this module provides the richer `getInitScript()` builder that captures
 * Navigation API events, History API mutations, popstate/hashchange, and
 * MutationObserver-based stability. Keep this module around even while the
 * orchestrator uses the inline version — tests and future wiring depend on
 * the full script.
 *
 * Runs in the BROWSER context — plain JS, no TypeScript, no Node.js APIs.
 */

// ---------------------------------------------------------------------------
// Navigation event shape (passed from browser to Node.js when exposed)
// ---------------------------------------------------------------------------

export interface NavigationEvent {
  url: string;
  type: 'navigation-api' | 'pushState' | 'replaceState' | 'popstate' | 'hashchange';
  timestamp: number;
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
 * script runs) when the caller wants events delivered back to Node.js.
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
