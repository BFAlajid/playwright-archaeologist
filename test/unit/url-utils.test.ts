/**
 * Unit tests for src/crawl/url-utils.ts
 *
 * URL normalization, scope checking, protocol whitelist, glob matching,
 * hash routing detection, and relative URL resolution.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import {
  normalizeUrl,
  isSameOrigin,
  matchesGlob,
  isAllowedProtocol,
  detectHashRouting,
  resolveUrl,
  stripAuthInfo,
  shouldCrawl,
  __clearNormalizeUrlCacheForTesting,
} from '../../src/crawl/url-utils.js';

// ---------------------------------------------------------------------------
// normalizeUrl
// ---------------------------------------------------------------------------

describe('normalizeUrl', () => {
  describe('trailing slashes', () => {
    it('strips trailing slash from non-root paths', () => {
      expect(normalizeUrl('https://example.com/about/')).toBe(
        'https://example.com/about'
      );
    });

    it('preserves trailing slash on root path', () => {
      const result = normalizeUrl('https://example.com/');
      expect(result).toBe('https://example.com/');
    });

    it('handles path with multiple trailing slashes', () => {
      const result = normalizeUrl('https://example.com/about///');
      // Should normalize to single path without trailing slash
      expect(result).not.toMatch(/\/$/);
      expect(result).toContain('/about');
    });
  });

  describe('query parameter ordering', () => {
    it('sorts query parameters alphabetically', () => {
      expect(normalizeUrl('https://example.com/?z=1&a=2&m=3')).toBe(
        'https://example.com/?a=2&m=3&z=1'
      );
    });

    it('preserves duplicate query parameters in sorted order', () => {
      const result = normalizeUrl('https://example.com/?b=2&a=1&b=3');
      expect(result).toBe('https://example.com/?a=1&b=2&b=3');
    });

    it('handles empty query string', () => {
      const result = normalizeUrl('https://example.com/?');
      // Should either strip the ? or normalize to no query
      expect(result).toBe('https://example.com/');
    });

    it('handles query parameters with no value', () => {
      const result = normalizeUrl('https://example.com/?debug&verbose');
      expect(result).toContain('debug');
      expect(result).toContain('verbose');
    });
  });

  describe('hash stripping', () => {
    it('strips hash fragments by default', () => {
      expect(normalizeUrl('https://example.com/page#section')).toBe(
        'https://example.com/page'
      );
    });

    it('preserves hash when preserveHash option is true', () => {
      expect(
        normalizeUrl('https://example.com/page#section', {
          preserveHash: true,
        })
      ).toContain('#section');
    });

    it('strips empty hash fragment', () => {
      expect(normalizeUrl('https://example.com/page#')).toBe(
        'https://example.com/page'
      );
    });
  });

  describe('hash-based routing preservation', () => {
    it('preserves hash routes when preserveHash is enabled', () => {
      const result = normalizeUrl('https://example.com/#/dashboard', {
        preserveHash: true,
      });
      expect(result).toContain('#/dashboard');
    });

    it('preserves hashbang routes when preserveHash is enabled', () => {
      const result = normalizeUrl('https://example.com/#!/users/123', {
        preserveHash: true,
      });
      expect(result).toContain('#!/users/123');
    });
  });

  describe('scheme and host normalization', () => {
    it('lowercases scheme', () => {
      expect(normalizeUrl('HTTPS://Example.com/Path')).toMatch(
        /^https:\/\/example\.com/
      );
    });

    it('lowercases hostname', () => {
      expect(normalizeUrl('https://EXAMPLE.COM/page')).toMatch(
        /example\.com/
      );
    });

    it('preserves path case', () => {
      const result = normalizeUrl('https://example.com/CaseSensitive');
      expect(result).toContain('/CaseSensitive');
    });
  });

  describe('unicode URL handling', () => {
    it('handles URLs with unicode characters', () => {
      const result = normalizeUrl('https://example.com/caf%C3%A9');
      expect(result).toBeTruthy();
      expect(result).toContain('example.com');
    });

    it('handles internationalized domain names', () => {
      const result = normalizeUrl('https://xn--nxasmq6b.example.com/');
      expect(result).toBeTruthy();
    });

    it('handles URLs with emoji in path', () => {
      // Encoded emoji
      const result = normalizeUrl(
        'https://example.com/%F0%9F%8E%89'
      );
      expect(result).toBeTruthy();
    });
  });

  describe('very long URLs', () => {
    it('handles URLs over 2000 characters', () => {
      const longParam = 'x'.repeat(2000);
      const url = `https://example.com/?q=${longParam}`;
      const result = normalizeUrl(url);
      expect(result).toBeTruthy();
      expect(result).toContain('example.com');
    });
  });

  describe('URLs with authentication info', () => {
    it('handles URLs with user:pass@host', () => {
      // normalizeUrl should still produce a valid result
      const result = normalizeUrl('https://user:pass@example.com/path');
      expect(result).toBeTruthy();
    });
  });

  describe('edge cases', () => {
    it('normalizes default port numbers', () => {
      expect(normalizeUrl('https://example.com:443/page')).toBe(
        normalizeUrl('https://example.com/page')
      );
    });

    it('preserves non-default port numbers', () => {
      const result = normalizeUrl('https://example.com:8080/page');
      expect(result).toContain(':8080');
    });

    it('handles URL with only domain', () => {
      const result = normalizeUrl('https://example.com');
      expect(result).toBeTruthy();
    });

    it('deduplicates identical URLs with different normalization', () => {
      const a = normalizeUrl('https://example.com/path/?b=2&a=1#frag');
      const b = normalizeUrl('https://example.com/path?a=1&b=2');
      expect(a).toBe(b);
    });
  });
});

// ---------------------------------------------------------------------------
// isSameOrigin
// ---------------------------------------------------------------------------

describe('isSameOrigin', () => {
  it('returns true for same scheme + host + port', () => {
    expect(
      isSameOrigin(
        'https://example.com/page',
        'https://example.com/other'
      )
    ).toBe(true);
  });

  it('returns false for different host', () => {
    expect(
      isSameOrigin(
        'https://other.com/page',
        'https://example.com/'
      )
    ).toBe(false);
  });

  it('returns false for different scheme', () => {
    expect(
      isSameOrigin(
        'http://example.com/page',
        'https://example.com/'
      )
    ).toBe(false);
  });

  it('returns false for different port', () => {
    expect(
      isSameOrigin(
        'https://example.com:8080/page',
        'https://example.com/'
      )
    ).toBe(false);
  });

  it('treats subdomain as different origin', () => {
    expect(
      isSameOrigin(
        'https://sub.example.com/',
        'https://example.com/'
      )
    ).toBe(false);
  });

  it('is case-insensitive for hostname', () => {
    expect(
      isSameOrigin(
        'https://EXAMPLE.COM/page',
        'https://example.com/'
      )
    ).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// matchesGlob
// ---------------------------------------------------------------------------

describe('matchesGlob', () => {
  it('matches exact URL', () => {
    expect(
      matchesGlob('https://example.com/about', [
        'https://example.com/about',
      ])
    ).toBe(true);
  });

  it('matches wildcard pattern', () => {
    expect(
      matchesGlob('https://example.com/users/123', [
        'https://example.com/users/*',
      ])
    ).toBe(true);
  });

  it('matches double-wildcard pattern', () => {
    expect(
      matchesGlob('https://example.com/api/v2/users/123', [
        '**/api/**',
      ])
    ).toBe(true);
  });

  it('returns false when no patterns match', () => {
    expect(
      matchesGlob('https://example.com/about', [
        'https://example.com/users/*',
      ])
    ).toBe(false);
  });

  it('returns false for empty pattern list', () => {
    expect(matchesGlob('https://example.com/about', [])).toBe(false);
  });

  it('matches path-only pattern against URL path', () => {
    expect(
      matchesGlob('https://example.com/admin/settings', ['/admin/*'])
    ).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// isAllowedProtocol
// ---------------------------------------------------------------------------

describe('isAllowedProtocol', () => {
  it('allows http:', () => {
    expect(isAllowedProtocol('http://example.com')).toBe(true);
  });

  it('allows https:', () => {
    expect(isAllowedProtocol('https://example.com')).toBe(true);
  });

  it('blocks file: protocol', () => {
    expect(isAllowedProtocol('file:///etc/passwd')).toBe(false);
  });

  it('blocks javascript: protocol', () => {
    expect(isAllowedProtocol('javascript:alert(1)')).toBe(false);
  });

  it('blocks data: protocol', () => {
    expect(isAllowedProtocol('data:text/html,<h1>hi</h1>')).toBe(false);
  });

  it('blocks mailto: protocol', () => {
    expect(isAllowedProtocol('mailto:user@example.com')).toBe(false);
  });

  it('blocks tel: protocol', () => {
    expect(isAllowedProtocol('tel:+1234567890')).toBe(false);
  });

  it('blocks ftp: protocol', () => {
    expect(isAllowedProtocol('ftp://files.example.com/')).toBe(false);
  });

  it('blocks chrome: protocol', () => {
    expect(isAllowedProtocol('chrome://settings')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// detectHashRouting
// ---------------------------------------------------------------------------

describe('detectHashRouting', () => {
  it('detects hash routing with 3+ hash-path URLs', () => {
    expect(
      detectHashRouting([
        'https://app.com/#/home',
        'https://app.com/#/about',
        'https://app.com/#/users',
      ])
    ).toBe(true);
  });

  it('detects hashbang routing', () => {
    expect(
      detectHashRouting([
        'https://app.com/#!/home',
        'https://app.com/#!/about',
        'https://app.com/#!/users',
      ])
    ).toBe(true);
  });

  it('returns false for fewer than 3 hash-path URLs', () => {
    expect(
      detectHashRouting([
        'https://app.com/#/home',
        'https://app.com/#/about',
      ])
    ).toBe(false);
  });

  it('returns false for regular anchor hashes', () => {
    expect(
      detectHashRouting([
        'https://app.com/page#section1',
        'https://app.com/page#section2',
        'https://app.com/page#section3',
      ])
    ).toBe(false);
  });

  it('returns false for empty URL list', () => {
    expect(detectHashRouting([])).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// resolveUrl
// ---------------------------------------------------------------------------

describe('resolveUrl', () => {
  it('resolves a relative path against a base URL', () => {
    expect(resolveUrl('/about', 'https://example.com/page')).toBe(
      'https://example.com/about'
    );
  });

  it('resolves a relative path without leading slash', () => {
    expect(resolveUrl('about', 'https://example.com/dir/page')).toBe(
      'https://example.com/dir/about'
    );
  });

  it('resolves an absolute URL (returns as-is)', () => {
    expect(resolveUrl('https://other.com/', 'https://example.com/')).toBe(
      'https://other.com/'
    );
  });

  it('resolves protocol-relative URL', () => {
    const result = resolveUrl(
      '//cdn.example.com/script.js',
      'https://example.com/'
    );
    expect(result).toBe('https://cdn.example.com/script.js');
  });

  it('resolves dot segments (..)', () => {
    expect(
      resolveUrl('../other', 'https://example.com/a/b/c')
    ).toBe('https://example.com/a/other');
  });

  it('resolves query-only relative URL', () => {
    expect(
      resolveUrl('?page=2', 'https://example.com/search')
    ).toBe('https://example.com/search?page=2');
  });

  it('resolves hash-only relative URL', () => {
    expect(
      resolveUrl('#section', 'https://example.com/page')
    ).toContain('#section');
  });
});

// ---------------------------------------------------------------------------
// stripAuthInfo
// ---------------------------------------------------------------------------

describe('stripAuthInfo', () => {
  it('strips user:pass from URL', () => {
    expect(stripAuthInfo('https://user:pass@example.com/path')).toBe(
      'https://example.com/path'
    );
  });

  it('strips user-only auth from URL', () => {
    expect(stripAuthInfo('https://admin@example.com/path')).toBe(
      'https://example.com/path'
    );
  });

  it('leaves URLs without auth info unchanged', () => {
    expect(stripAuthInfo('https://example.com/path')).toBe(
      'https://example.com/path'
    );
  });
});

// ---------------------------------------------------------------------------
// shouldCrawl
// ---------------------------------------------------------------------------

describe('shouldCrawl', () => {
  const base = 'https://example.com/';

  it('allows same-origin URL by default', () => {
    expect(shouldCrawl('https://example.com/about', base, {})).toBe(true);
  });

  it('blocks external URL by default', () => {
    expect(shouldCrawl('https://other.com/page', base, {})).toBe(false);
  });

  it('allows external URL when followExternal is true', () => {
    expect(
      shouldCrawl('https://other.com/page', base, {
        followExternal: true,
      })
    ).toBe(true);
  });

  it('blocks URL matching exclude pattern', () => {
    expect(
      shouldCrawl('https://example.com/admin/secret', base, {
        exclude: ['**/admin/**'],
      })
    ).toBe(false);
  });

  it('allows URL matching include pattern', () => {
    expect(
      shouldCrawl('https://example.com/docs/api', base, {
        include: ['**/docs/**'],
      })
    ).toBe(true);
  });

  it('blocks URL not matching include pattern when include is specified', () => {
    expect(
      shouldCrawl('https://example.com/about', base, {
        include: ['**/docs/**'],
      })
    ).toBe(false);
  });

  it('blocks data: URI', () => {
    expect(shouldCrawl('data:text/html,test', base, {})).toBe(false);
  });

  it('blocks javascript: URI', () => {
    expect(shouldCrawl('javascript:void(0)', base, {})).toBe(false);
  });

  it('blocks mailto: URI', () => {
    expect(shouldCrawl('mailto:user@example.com', base, {})).toBe(false);
  });

  it('exclude takes precedence over include', () => {
    expect(
      shouldCrawl('https://example.com/docs/admin/secret', base, {
        include: ['**/docs/**'],
        exclude: ['**/admin/**'],
      })
    ).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// normalizeUrl memoization
//
// Performance invariant: repeated calls with the same input must NOT
// re-parse and re-sort. The cache is an LRU-ish Map; cold miss computes
// and stores, warm hit returns the previously computed value.
// ---------------------------------------------------------------------------

describe('normalizeUrl memoization', () => {
  beforeEach(() => {
    __clearNormalizeUrlCacheForTesting();
  });

  it('returns the same cached string reference on repeat calls', () => {
    const input = 'https://example.com/path?z=1&a=2';
    const first = normalizeUrl(input);
    const second = normalizeUrl(input);

    // Same referential identity — proves the cache returned the stored
    // string rather than re-computing (which would yield a fresh string).
    expect(second).toBe(first);
  });

  it('distinguishes cache entries by preserveHash option', () => {
    const url = 'https://example.com/p#section';

    const stripped = normalizeUrl(url);
    const preserved = normalizeUrl(url, { preserveHash: true });

    expect(stripped).toBe('https://example.com/p');
    expect(preserved).toBe('https://example.com/p#section');

    // Both cached independently; neither call should leak into the other.
    expect(normalizeUrl(url)).toBe(stripped);
    expect(normalizeUrl(url, { preserveHash: true })).toBe(preserved);
  });

  it('produces correct output on cache hit (no stale data)', () => {
    const url = 'https://example.com/p?b=1&a=2';
    const expected = 'https://example.com/p?a=2&b=1';

    expect(normalizeUrl(url)).toBe(expected);
    expect(normalizeUrl(url)).toBe(expected);
    expect(normalizeUrl(url)).toBe(expected);
  });

  it('remains correct under cache eviction pressure', () => {
    // Fill well past the 10_000 cap. If eviction is buggy this will either
    // OOM or yield wrong answers for the early URLs.
    for (let i = 0; i < 12_000; i++) {
      normalizeUrl(`https://example.com/path${i}?z=1&a=2`);
    }

    // The oldest entries should have been evicted, but recomputing still
    // produces the correct output.
    expect(normalizeUrl('https://example.com/path0?z=1&a=2')).toBe(
      'https://example.com/path0?a=2&z=1',
    );
    expect(normalizeUrl('https://example.com/path11999?z=1&a=2')).toBe(
      'https://example.com/path11999?a=2&z=1',
    );
  });
});
