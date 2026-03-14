/**
 * Unit tests for src/instrumentation/init-script.ts
 *
 * Tests the NavigationCollector class, getInitScript() output validity,
 * and the init script's JavaScript correctness (parsed but not executed
 * in a real browser — integration tests cover that).
 */

import { describe, it, expect, beforeEach } from 'vitest';
import {
  NavigationCollector,
  getInitScript,
  type NavigationEvent,
} from '../../src/instrumentation/init-script.js';

// ---------------------------------------------------------------------------
// NavigationCollector
// ---------------------------------------------------------------------------

describe('NavigationCollector', () => {
  let collector: NavigationCollector;

  beforeEach(() => {
    collector = new NavigationCollector();
  });

  describe('handler', () => {
    it('accepts a valid navigation event', () => {
      collector.handler({
        url: 'https://example.com/page',
        type: 'pushState',
        timestamp: Date.now(),
      });

      const urls = collector.getDiscoveredUrls();
      expect(urls).toEqual(['https://example.com/page']);
    });

    it('normalizes URLs via the URL constructor', () => {
      collector.handler({
        url: 'https://example.com/path/../page',
        type: 'pushState',
        timestamp: Date.now(),
      });

      const urls = collector.getDiscoveredUrls();
      expect(urls).toEqual(['https://example.com/page']);
    });

    it('deduplicates identical URLs', () => {
      const event: NavigationEvent = {
        url: 'https://example.com/page',
        type: 'pushState',
        timestamp: Date.now(),
      };

      collector.handler(event);
      collector.handler(event);
      collector.handler(event);

      const urls = collector.getDiscoveredUrls();
      expect(urls).toEqual(['https://example.com/page']);
    });

    it('deduplicates URLs that normalize to the same value', () => {
      collector.handler({
        url: 'https://example.com/page',
        type: 'pushState',
        timestamp: Date.now(),
      });
      collector.handler({
        url: 'https://example.com/./page',
        type: 'navigation-api',
        timestamp: Date.now(),
      });

      const urls = collector.getDiscoveredUrls();
      expect(urls).toEqual(['https://example.com/page']);
    });

    it('stores multiple unique URLs', () => {
      collector.handler({
        url: 'https://example.com/a',
        type: 'pushState',
        timestamp: Date.now(),
      });
      collector.handler({
        url: 'https://example.com/b',
        type: 'replaceState',
        timestamp: Date.now(),
      });
      collector.handler({
        url: 'https://example.com/c',
        type: 'navigation-api',
        timestamp: Date.now(),
      });

      const urls = collector.getDiscoveredUrls();
      expect(urls).toHaveLength(3);
      expect(urls).toContain('https://example.com/a');
      expect(urls).toContain('https://example.com/b');
      expect(urls).toContain('https://example.com/c');
    });

    it('ignores null/undefined events', () => {
      collector.handler(null as unknown as NavigationEvent);
      collector.handler(undefined as unknown as NavigationEvent);

      expect(collector.getDiscoveredUrls()).toEqual([]);
    });

    it('ignores events with non-string url', () => {
      collector.handler({
        url: 123 as unknown as string,
        type: 'pushState',
        timestamp: Date.now(),
      });

      expect(collector.getDiscoveredUrls()).toEqual([]);
    });

    it('ignores malformed URLs', () => {
      collector.handler({
        url: 'not-a-valid-url',
        type: 'pushState',
        timestamp: Date.now(),
      });

      expect(collector.getDiscoveredUrls()).toEqual([]);
    });

    it('rejects javascript: protocol URLs', () => {
      collector.handler({
        url: 'javascript:alert(1)',
        type: 'pushState',
        timestamp: Date.now(),
      });

      expect(collector.getDiscoveredUrls()).toEqual([]);
    });

    it('rejects data: protocol URLs', () => {
      collector.handler({
        url: 'data:text/html,<h1>test</h1>',
        type: 'navigation-api',
        timestamp: Date.now(),
      });

      expect(collector.getDiscoveredUrls()).toEqual([]);
    });

    it('rejects blob: protocol URLs', () => {
      collector.handler({
        url: 'blob:https://example.com/some-id',
        type: 'navigation-api',
        timestamp: Date.now(),
      });

      expect(collector.getDiscoveredUrls()).toEqual([]);
    });

    it('rejects file: protocol URLs', () => {
      collector.handler({
        url: 'file:///etc/passwd',
        type: 'pushState',
        timestamp: Date.now(),
      });

      expect(collector.getDiscoveredUrls()).toEqual([]);
    });

    it('accepts http: URLs', () => {
      collector.handler({
        url: 'http://example.com/page',
        type: 'pushState',
        timestamp: Date.now(),
      });

      expect(collector.getDiscoveredUrls()).toEqual(['http://example.com/page']);
    });

    it('accepts https: URLs', () => {
      collector.handler({
        url: 'https://example.com/page',
        type: 'pushState',
        timestamp: Date.now(),
      });

      expect(collector.getDiscoveredUrls()).toEqual(['https://example.com/page']);
    });

    it('handles all navigation event types', () => {
      const types: NavigationEvent['type'][] = [
        'navigation-api',
        'pushState',
        'replaceState',
        'popstate',
        'hashchange',
      ];

      types.forEach((type, i) => {
        collector.handler({
          url: `https://example.com/page-${i}`,
          type,
          timestamp: Date.now(),
        });
      });

      expect(collector.getDiscoveredUrls()).toHaveLength(5);
    });
  });

  describe('getDiscoveredUrls', () => {
    it('drains the buffer on each call', () => {
      collector.handler({
        url: 'https://example.com/a',
        type: 'pushState',
        timestamp: Date.now(),
      });

      const first = collector.getDiscoveredUrls();
      expect(first).toEqual(['https://example.com/a']);

      const second = collector.getDiscoveredUrls();
      expect(second).toEqual([]);
    });

    it('returns new URLs added after draining', () => {
      collector.handler({
        url: 'https://example.com/a',
        type: 'pushState',
        timestamp: Date.now(),
      });

      collector.getDiscoveredUrls(); // drain

      collector.handler({
        url: 'https://example.com/b',
        type: 'pushState',
        timestamp: Date.now(),
      });

      const urls = collector.getDiscoveredUrls();
      expect(urls).toEqual(['https://example.com/b']);
    });

    it('does not return previously-seen URLs even after draining', () => {
      collector.handler({
        url: 'https://example.com/a',
        type: 'pushState',
        timestamp: Date.now(),
      });

      collector.getDiscoveredUrls(); // drain

      // Report the same URL again
      collector.handler({
        url: 'https://example.com/a',
        type: 'pushState',
        timestamp: Date.now(),
      });

      expect(collector.getDiscoveredUrls()).toEqual([]);
    });

    it('returns a snapshot, not a live reference', () => {
      collector.handler({
        url: 'https://example.com/a',
        type: 'pushState',
        timestamp: Date.now(),
      });

      const urls = collector.getDiscoveredUrls();

      // Adding more URLs should not affect the returned array
      collector.handler({
        url: 'https://example.com/b',
        type: 'pushState',
        timestamp: Date.now(),
      });

      expect(urls).toEqual(['https://example.com/a']);
    });
  });

  describe('getAllSeenUrls', () => {
    it('returns all URLs ever seen without draining', () => {
      collector.handler({
        url: 'https://example.com/a',
        type: 'pushState',
        timestamp: Date.now(),
      });
      collector.handler({
        url: 'https://example.com/b',
        type: 'pushState',
        timestamp: Date.now(),
      });

      collector.getDiscoveredUrls(); // drain the incremental buffer

      const allSeen = collector.getAllSeenUrls();
      expect(allSeen).toHaveLength(2);
      expect(allSeen).toContain('https://example.com/a');
      expect(allSeen).toContain('https://example.com/b');
    });

    it('is not affected by getDiscoveredUrls draining', () => {
      collector.handler({
        url: 'https://example.com/a',
        type: 'pushState',
        timestamp: Date.now(),
      });

      collector.getDiscoveredUrls(); // drain

      expect(collector.getAllSeenUrls()).toEqual(['https://example.com/a']);
    });
  });

  describe('clear', () => {
    it('resets both the buffer and the seen set', () => {
      collector.handler({
        url: 'https://example.com/a',
        type: 'pushState',
        timestamp: Date.now(),
      });

      collector.clear();

      expect(collector.getDiscoveredUrls()).toEqual([]);
      expect(collector.getAllSeenUrls()).toEqual([]);
    });

    it('allows previously-seen URLs to be re-added after clear', () => {
      collector.handler({
        url: 'https://example.com/a',
        type: 'pushState',
        timestamp: Date.now(),
      });

      collector.clear();

      collector.handler({
        url: 'https://example.com/a',
        type: 'pushState',
        timestamp: Date.now(),
      });

      expect(collector.getDiscoveredUrls()).toEqual(['https://example.com/a']);
    });
  });
});

// ---------------------------------------------------------------------------
// getInitScript
// ---------------------------------------------------------------------------

describe('getInitScript', () => {
  it('returns a non-empty string', () => {
    const script = getInitScript();
    expect(typeof script).toBe('string');
    expect(script.length).toBeGreaterThan(100);
  });

  it('is syntactically valid JavaScript', () => {
    const script = getInitScript();
    // This will throw if the script has syntax errors
    expect(() => new Function(script)).not.toThrow();
  });

  it('is a self-executing function (IIFE)', () => {
    const script = getInitScript().trim();
    expect(script.startsWith('(function()')).toBe(true);
    expect(script.endsWith('();')).toBe(true);
  });

  it('contains Navigation API interception', () => {
    const script = getInitScript();
    expect(script).toContain('window.navigation');
    expect(script).toContain('navigate');
    expect(script).toContain('event.destination.url');
  });

  it('contains History API monkey-patching', () => {
    const script = getInitScript();
    expect(script).toContain('history.pushState');
    expect(script).toContain('history.replaceState');
    expect(script).toContain('origPushState');
    expect(script).toContain('origReplaceState');
  });

  it('contains popstate listener', () => {
    const script = getInitScript();
    expect(script).toContain("'popstate'");
  });

  it('contains hashchange listener', () => {
    const script = getInitScript();
    expect(script).toContain("'hashchange'");
  });

  it('contains MutationObserver setup', () => {
    const script = getInitScript();
    expect(script).toContain('MutationObserver');
    expect(script).toContain('childList');
    expect(script).toContain('subtree');
  });

  it('exposes __pa_isDomStable function', () => {
    const script = getInitScript();
    expect(script).toContain('window.__pa_isDomStable');
    // The 500ms threshold
    expect(script).toContain('500');
  });

  it('exposes __pa_getDiscoveredUrls function', () => {
    const script = getInitScript();
    expect(script).toContain('window.__pa_getDiscoveredUrls');
  });

  it('references __pa_reportNavigation from exposeFunction', () => {
    const script = getInitScript();
    expect(script).toContain('__pa_reportNavigation');
  });

  it('wraps everything in try/catch for safety', () => {
    const script = getInitScript();
    // Outer try/catch
    expect(script).toContain('try {');
    expect(script).toContain('} catch (e) {');
  });

  it('filters meaningful mutations (not just any attribute change)', () => {
    const script = getInitScript();
    expect(script).toContain('attributeFilter');
    expect(script).toContain('DIALOG');
    expect(script).toContain('aria-hidden');
  });

  it('validates URLs with protocol check (http/https only)', () => {
    const script = getInitScript();
    expect(script).toContain("'http:'");
    expect(script).toContain("'https:'");
  });

  it('does not contain TypeScript syntax', () => {
    const script = getInitScript();
    // No type annotations
    expect(script).not.toMatch(/:\s*(string|number|boolean|void|any)\b/);
    // No interface/type keywords
    expect(script).not.toMatch(/\binterface\b/);
    // No import/export
    expect(script).not.toMatch(/\bimport\b/);
    expect(script).not.toMatch(/\bexport\b/);
  });

  it('does not contain Node.js APIs', () => {
    const script = getInitScript();
    expect(script).not.toContain('require(');
    expect(script).not.toContain('process.');
    expect(script).not.toContain('Buffer.');
    expect(script).not.toContain('__dirname');
    expect(script).not.toContain('__filename');
  });

  it('returns the same script on repeated calls (idempotent)', () => {
    const first = getInitScript();
    const second = getInitScript();
    expect(first).toBe(second);
  });
});
