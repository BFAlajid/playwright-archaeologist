/**
 * Unit tests for src/instrumentation/init-script.ts
 *
 * Tests the getInitScript() output validity (parsed but not executed
 * in a real browser — integration tests cover that).
 */

import { describe, it, expect } from 'vitest';
import { getInitScript } from '../../src/instrumentation/init-script.js';

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
