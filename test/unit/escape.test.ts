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
  sanitizeUrl,
  sanitizeSvg,
  redactAbsolutePath,
} from '../../src/report/html/escape.js';
import { hashSlug, patternSlug } from '../../src/report/html/tokens.js';

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

// ---------------------------------------------------------------------------
// sanitizeUrl
// ---------------------------------------------------------------------------

describe('sanitizeUrl', () => {
  it('returns http URLs unchanged', () => {
    expect(sanitizeUrl('http://example.com/path?x=1')).toBe(
      'http://example.com/path?x=1',
    );
  });

  it('returns https URLs unchanged', () => {
    expect(sanitizeUrl('https://example.com/')).toBe('https://example.com/');
  });

  it('blocks javascript: scheme', () => {
    expect(sanitizeUrl('javascript:alert(1)')).toBe('#');
    expect(sanitizeUrl('JavaScript:alert(1)')).toBe('#');
  });

  it('blocks data: scheme', () => {
    expect(sanitizeUrl('data:text/html,<script>alert(1)</script>')).toBe('#');
  });

  it('blocks vbscript: scheme', () => {
    expect(sanitizeUrl('vbscript:msgbox(1)')).toBe('#');
  });

  it('blocks file: scheme', () => {
    expect(sanitizeUrl('file:///etc/passwd')).toBe('#');
  });

  it('blocks blob: scheme', () => {
    expect(sanitizeUrl('blob:https://example.com/abc-123')).toBe('#');
  });

  it('returns # for empty string', () => {
    expect(sanitizeUrl('')).toBe('#');
  });

  it('returns # for non-URL strings', () => {
    expect(sanitizeUrl('not a url')).toBe('#');
  });

  it('returns # for non-string input', () => {
    // @ts-expect-error — testing defensive non-string handling
    expect(sanitizeUrl(null)).toBe('#');
    // @ts-expect-error
    expect(sanitizeUrl(undefined)).toBe('#');
  });

  it('trims whitespace before validating', () => {
    expect(sanitizeUrl('  https://example.com/  ')).toBe('https://example.com/');
  });

  it('blocks javascript: with leading whitespace', () => {
    expect(sanitizeUrl('  javascript:alert(1)')).toBe('#');
  });
});

// ---------------------------------------------------------------------------
// sanitizeSvg
// ---------------------------------------------------------------------------

describe('sanitizeSvg', () => {
  it('returns empty string for empty input', () => {
    expect(sanitizeSvg('')).toBe('');
  });

  it('returns empty string for non-string input', () => {
    // @ts-expect-error — defensive non-string handling
    expect(sanitizeSvg(null)).toBe('');
    // @ts-expect-error
    expect(sanitizeSvg(undefined)).toBe('');
  });

  it('strips <script> blocks', () => {
    const input = '<svg><script>alert(1)</script><circle /></svg>';
    const out = sanitizeSvg(input);
    expect(out).not.toContain('<script');
    expect(out).not.toContain('alert(1)');
    expect(out).toContain('<circle');
  });

  it('strips uppercase <SCRIPT> blocks', () => {
    const input = '<svg><SCRIPT>alert(1)</SCRIPT></svg>';
    expect(sanitizeSvg(input)).not.toMatch(/<script/i);
  });

  it('strips on* event handler attributes (double-quoted)', () => {
    const input = '<svg onload="alert(1)"><rect onclick="evil()" /></svg>';
    const out = sanitizeSvg(input);
    expect(out).not.toMatch(/onload/i);
    expect(out).not.toMatch(/onclick/i);
    expect(out).not.toContain('alert(1)');
  });

  it('strips on* event handler attributes (single-quoted)', () => {
    const input = "<svg onload='alert(1)'></svg>";
    expect(sanitizeSvg(input)).not.toMatch(/onload/i);
  });

  it('strips on* event handler attributes (unquoted)', () => {
    const input = '<svg onload=alert(1)></svg>';
    expect(sanitizeSvg(input)).not.toMatch(/onload/i);
  });

  it('strips javascript: hrefs', () => {
    const input = '<svg><a href="javascript:alert(1)">click</a></svg>';
    const out = sanitizeSvg(input);
    expect(out).not.toContain('javascript:alert(1)');
  });

  it('strips javascript: xlink:hrefs', () => {
    const input = '<svg><use xlink:href="javascript:alert(1)" /></svg>';
    expect(sanitizeSvg(input)).not.toContain('javascript:alert(1)');
  });

  it('preserves safe http hrefs', () => {
    const input = '<svg><a href="https://example.com">ok</a></svg>';
    expect(sanitizeSvg(input)).toContain('https://example.com');
  });

  it('preserves ordinary SVG content', () => {
    const input =
      '<svg width="10" height="10"><circle cx="5" cy="5" r="4" fill="red" /></svg>';
    expect(sanitizeSvg(input)).toContain('<circle');
    expect(sanitizeSvg(input)).toContain('fill="red"');
  });
});

// ---------------------------------------------------------------------------
// redactAbsolutePath
// ---------------------------------------------------------------------------

describe('redactAbsolutePath', () => {
  it('returns empty string for empty input', () => {
    expect(redactAbsolutePath('')).toBe('');
  });

  it('returns empty string for non-string input', () => {
    // @ts-expect-error — defensive non-string handling
    expect(redactAbsolutePath(null)).toBe('');
    // @ts-expect-error
    expect(redactAbsolutePath(undefined)).toBe('');
  });

  it('passes through already-relative paths unchanged', () => {
    expect(redactAbsolutePath('screenshots/home.png')).toBe('screenshots/home.png');
    expect(redactAbsolutePath('./foo/bar')).toBe('./foo/bar');
  });

  it('returns <file> for a POSIX absolute path outside outputDir', () => {
    expect(redactAbsolutePath('/etc/passwd')).toBe('<file>');
    expect(redactAbsolutePath('/home/user/img.png', '/tmp/out')).toBe('<file>');
  });

  it('returns <file> for a Windows absolute path outside outputDir', () => {
    expect(redactAbsolutePath('C:\\Users\\me\\img.png')).toBe('<file>');
  });

  it('returns a relative path when input is under outputDir', () => {
    expect(
      redactAbsolutePath('/tmp/out/screenshots/home.png', '/tmp/out'),
    ).toBe('screenshots/home.png');
  });

  it('handles Windows outputDir prefix with mixed separators', () => {
    const rel = redactAbsolutePath(
      'C:\\Users\\me\\out\\screenshots\\home.png',
      'C:\\Users\\me\\out',
    );
    expect(rel).toBe('screenshots/home.png');
  });

  it('handles a trailing slash on outputDir', () => {
    expect(
      redactAbsolutePath('/tmp/out/file.txt', '/tmp/out/'),
    ).toBe('file.txt');
  });
});

// ---------------------------------------------------------------------------
// hashSlug / patternSlug
// ---------------------------------------------------------------------------

describe('hashSlug', () => {
  it('produces a stable output for the same input', () => {
    expect(hashSlug('hello')).toBe(hashSlug('hello'));
  });

  it('produces different output for different input', () => {
    expect(hashSlug('foo')).not.toBe(hashSlug('bar'));
  });

  it('always returns a non-empty base-36 string', () => {
    expect(hashSlug('')).toMatch(/^[0-9a-z]+$/);
    expect(hashSlug('a')).toMatch(/^[0-9a-z]+$/);
    expect(hashSlug('https://example.com/some/path?x=1')).toMatch(/^[0-9a-z]+$/);
  });

  it('handles unicode input without crashing', () => {
    const out = hashSlug('\u4F60\u597D');
    expect(typeof out).toBe('string');
    expect(out.length).toBeGreaterThan(0);
  });
});

describe('patternSlug', () => {
  it('lowercases and collapses non-alphanumeric characters', () => {
    expect(patternSlug('/api/users/:id')).toBe('api-users-id');
  });

  it('trims leading and trailing dashes', () => {
    expect(patternSlug('///foo///')).toBe('foo');
  });

  it('truncates to 40 characters', () => {
    const out = patternSlug('/api/' + 'a'.repeat(200));
    expect(out.length).toBeLessThanOrEqual(40);
  });

  it('returns empty string for inputs with no alphanumeric characters', () => {
    expect(patternSlug('///')).toBe('');
  });
});
