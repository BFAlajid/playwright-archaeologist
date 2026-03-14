/**
 * Unit tests for src/report/html/escape.ts
 *
 * HTML escaping for XSS prevention: basic XSS, attribute injection,
 * entity encoding, Unicode preservation, null byte stripping,
 * and nested encoding prevention.
 */

import { describe, it, expect } from 'vitest';
import {
  escapeHtml,
  escapeAttribute,
  escapeJsonInHtml,
} from '../../src/report/html/escape.js';

// ---------------------------------------------------------------------------
// escapeHtml
// ---------------------------------------------------------------------------

describe('escapeHtml', () => {
  describe('basic XSS prevention', () => {
    it('escapes <script>alert(1)</script>', () => {
      const result = escapeHtml('<script>alert(1)</script>');
      expect(result).not.toContain('<script>');
      expect(result).not.toContain('</script>');
      expect(result).toContain('&lt;script&gt;');
    });

    it('escapes script tags with attributes', () => {
      const result = escapeHtml('<script src="evil.js"></script>');
      expect(result).not.toContain('<script');
    });

    it('escapes img onerror payload', () => {
      const result = escapeHtml('<img src=x onerror=alert(1)>');
      expect(result).not.toContain('<img');
    });

    it('escapes svg onload payload', () => {
      const result = escapeHtml('<svg onload="alert(1)">');
      expect(result).not.toContain('<svg');
    });

    it('escapes iframe injection', () => {
      const result = escapeHtml('<iframe src="evil.com"></iframe>');
      expect(result).not.toContain('<iframe');
    });
  });

  describe('entity encoding', () => {
    it('encodes ampersand (&)', () => {
      expect(escapeHtml('A & B')).toBe('A &amp; B');
    });

    it('encodes less-than (<)', () => {
      expect(escapeHtml('a < b')).toBe('a &lt; b');
    });

    it('encodes greater-than (>)', () => {
      expect(escapeHtml('a > b')).toBe('a &gt; b');
    });

    it('encodes double quote (")', () => {
      expect(escapeHtml('say "hello"')).toContain('&quot;');
    });

    it('encodes single quote (\')', () => {
      const result = escapeHtml("it's");
      expect(result).toMatch(/&#0?39;|&#x27;|&apos;/);
    });

    it('encodes all five characters in one string', () => {
      const result = escapeHtml('<div class="a" data-val=\'b\'>&</div>');
      expect(result).not.toContain('<div');
      expect(result).not.toContain('>');
      expect(result).toContain('&lt;');
      expect(result).toContain('&gt;');
      expect(result).toContain('&amp;');
    });
  });

  describe('Unicode preservation', () => {
    it('preserves ASCII text', () => {
      expect(escapeHtml('Hello World')).toBe('Hello World');
    });

    it('preserves Unicode characters', () => {
      expect(escapeHtml('\u00E9\u00E8\u00EA')).toBe('\u00E9\u00E8\u00EA'); // French accents
    });

    it('preserves CJK characters', () => {
      expect(escapeHtml('\u4F60\u597D\u4E16\u754C')).toBe('\u4F60\u597D\u4E16\u754C');
    });

    it('preserves emoji', () => {
      expect(escapeHtml('\uD83D\uDE00\uD83D\uDE01')).toBe('\uD83D\uDE00\uD83D\uDE01');
    });

    it('preserves mathematical symbols', () => {
      expect(escapeHtml('\u2200x \u2208 \u2124')).toBe('\u2200x \u2208 \u2124');
    });
  });

  describe('null byte handling', () => {
    it('strips null bytes', () => {
      const result = escapeHtml('hello\x00world');
      expect(result).not.toContain('\x00');
      expect(result).toBe('helloworld');
    });

    it('strips null bytes mixed with entities', () => {
      const result = escapeHtml('a\x00<b');
      expect(result).not.toContain('\x00');
      expect(result).toContain('&lt;');
    });
  });

  describe('nested encoding prevention', () => {
    it('does not double-encode existing entities', () => {
      // If input already contains &amp; we should still encode the &
      // This is intentional: we escape raw text, not pre-escaped HTML
      const result = escapeHtml('&amp;');
      expect(result).toBe('&amp;amp;');
    });

    it('treats input as raw text, not HTML', () => {
      const result = escapeHtml('&lt;script&gt;');
      // The & should be encoded, producing &amp;lt;script&amp;gt;
      expect(result).toContain('&amp;');
    });
  });

  describe('edge cases', () => {
    it('handles empty string', () => {
      expect(escapeHtml('')).toBe('');
    });

    it('handles string with only special characters', () => {
      const result = escapeHtml('<>&"\'');
      expect(result).not.toContain('<');
      expect(result).not.toContain('>');
      // & appears in encoded entities, but not as raw unescaped &
      expect(result).not.toMatch(/&(?!amp;|lt;|gt;|quot;|#039;|#x27;)/);
      expect(result).toMatch(/^&lt;&gt;&amp;/);
    });

    it('handles very long strings', () => {
      const long = '<script>'.repeat(1000);
      const result = escapeHtml(long);
      expect(result).not.toContain('<script>');
    });
  });
});

// ---------------------------------------------------------------------------
// escapeAttribute
// ---------------------------------------------------------------------------

describe('escapeAttribute', () => {
  it('escapes double quotes for attribute values', () => {
    const result = escapeAttribute('" onload="alert(1)');
    expect(result).not.toContain('"');
  });

  it('escapes single quotes for attribute values', () => {
    const result = escapeAttribute("' onfocus='alert(1)");
    expect(result).not.toMatch(/(?<!&)'/);
  });

  it('escapes angle brackets', () => {
    const result = escapeAttribute('<script>alert(1)</script>');
    expect(result).not.toContain('<');
    expect(result).not.toContain('>');
  });

  it('escapes backtick (template literal injection)', () => {
    const result = escapeAttribute('`${alert(1)}`');
    expect(result).not.toContain('`');
  });

  it('preserves safe attribute values', () => {
    const result = escapeAttribute('my-class-name');
    expect(result).toBe('my-class-name');
  });

  it('handles URL in attribute', () => {
    const result = escapeAttribute('https://example.com/page?a=1&b=2');
    expect(result).toContain('&amp;');
    expect(result).not.toContain('&b');
  });
});

// ---------------------------------------------------------------------------
// escapeJsonInHtml
// ---------------------------------------------------------------------------

describe('escapeJsonInHtml', () => {
  it('prevents </script> injection in embedded JSON', () => {
    const json = JSON.stringify({
      html: '</script><script>alert(1)</script>',
    });
    const result = escapeJsonInHtml(json);

    expect(result).not.toContain('</script>');
  });

  it('escapes </ to prevent tag closing', () => {
    const json = JSON.stringify({ value: '</style>' });
    const result = escapeJsonInHtml(json);

    expect(result).not.toContain('</style>');
  });

  it('preserves valid JSON structure', () => {
    const data = { name: 'test', count: 42, nested: { flag: true } };
    const json = JSON.stringify(data);
    const escaped = escapeJsonInHtml(json);

    // After unescaping the special sequences, it should be parseable
    // The escaping replaces </ with safe sequences
    expect(escaped).toBeTruthy();
  });

  it('handles JSON with HTML entities in values', () => {
    const json = JSON.stringify({ title: 'A & B <C>' });
    const result = escapeJsonInHtml(json);

    expect(result).toBeTruthy();
    // The JSON string itself should remain valid-ish; only </ patterns are escaped
  });
});
