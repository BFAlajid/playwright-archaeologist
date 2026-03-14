/**
 * URL normalization, scope checking, and utility functions.
 *
 * Responsibilities:
 * - Normalize URLs for deduplication (trailing slashes, query param ordering, hash stripping)
 * - Detect and handle hash-based routing
 * - Same-origin checking
 * - Include/exclude glob matching
 * - Protocol whitelist enforcement
 * - Relative URL resolution
 */

const ALLOWED_PROTOCOLS = new Set(['http:', 'https:']);

export interface NormalizeOptions {
  preserveHash?: boolean;
}

/**
 * Normalize a URL for deduplication.
 * - Sorts query parameters alphabetically
 * - Removes trailing slashes (except root path)
 * - Strips hash fragments (unless preserveHash is true)
 * - Lowercases scheme and host
 */
export function normalizeUrl(url: string, options: NormalizeOptions = {}): string {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return url;
  }

  // URL constructor already lowercases scheme and host.

  // Sort query parameters alphabetically
  const params = Array.from(parsed.searchParams.entries());
  params.sort((a, b) => {
    const keyCompare = a[0].localeCompare(b[0]);
    if (keyCompare !== 0) return keyCompare;
    return a[1].localeCompare(b[1]);
  });

  // Rebuild search string from sorted params
  parsed.search = '';
  if (params.length > 0) {
    const sp = new URLSearchParams();
    for (const [key, value] of params) {
      sp.append(key, value);
    }
    parsed.search = sp.toString();
  }

  // Handle hash
  if (!options.preserveHash) {
    parsed.hash = '';
  }

  // Remove trailing slashes from path (except root "/")
  let pathname = parsed.pathname;
  // Collapse multiple trailing slashes and remove them (but keep root)
  while (pathname.length > 1 && pathname.endsWith('/')) {
    pathname = pathname.slice(0, -1);
  }
  parsed.pathname = pathname;

  return parsed.toString();
}

/**
 * Check if a URL is same-origin as the base URL.
 */
export function isSameOrigin(url: string, baseUrl: string): boolean {
  try {
    const a = new URL(url);
    const b = new URL(baseUrl);
    return a.origin === b.origin;
  } catch {
    return false;
  }
}

/**
 * Convert a simple glob pattern to a RegExp.
 * Supports * (any chars except nothing special) and ** (any chars including path separators).
 */
function globToRegExp(pattern: string): RegExp {
  let regexStr = '';
  let i = 0;
  while (i < pattern.length) {
    const ch = pattern[i];
    if (ch === '*') {
      if (i + 1 < pattern.length && pattern[i + 1] === '*') {
        // ** matches anything including /
        regexStr += '.*';
        i += 2;
        // Skip a following / after ** (e.g. **/ )
        if (i < pattern.length && pattern[i] === '/') {
          // The .* already covers the slash, but we still allow it
          regexStr += '\\/?';
          i++;
        }
      } else {
        // * matches anything except /
        regexStr += '[^/]*';
        i++;
      }
    } else if (ch === '?') {
      regexStr += '[^/]';
      i++;
    } else {
      // Escape regex special chars
      regexStr += ch.replace(/[.+^${}()|[\]\\]/g, '\\$&');
      i++;
    }
  }
  return new RegExp(`^${regexStr}$`);
}

/**
 * Check if a URL matches any of the provided glob patterns.
 */
export function matchesGlob(url: string, patterns: string[]): boolean {
  if (patterns.length === 0) return false;

  for (const pattern of patterns) {
    const regex = globToRegExp(pattern);

    // Test against full URL
    if (regex.test(url)) return true;

    // If pattern starts with /, test against just the path
    if (pattern.startsWith('/')) {
      try {
        const parsed = new URL(url);
        if (regex.test(parsed.pathname)) return true;
      } catch {
        // ignore
      }
    }
  }
  return false;
}

/**
 * Check if a URL uses an allowed protocol.
 * Only http: and https: are allowed by default.
 */
export function isAllowedProtocol(url: string): boolean {
  try {
    const parsed = new URL(url);
    return ALLOWED_PROTOCOLS.has(parsed.protocol);
  } catch {
    return false;
  }
}

/**
 * Detect if a set of URLs suggest hash-based routing.
 * Returns true if 3+ URLs have hash fragments starting with #/ or #!/.
 */
export function detectHashRouting(urls: string[]): boolean {
  let count = 0;
  for (const url of urls) {
    try {
      const parsed = new URL(url);
      const hash = parsed.hash;
      if (hash.startsWith('#/') || hash.startsWith('#!/')) {
        count++;
      }
    } catch {
      // ignore malformed URLs
    }
  }
  return count >= 3;
}

/**
 * Resolve a relative URL against a base URL.
 */
export function resolveUrl(relative: string, base: string): string {
  try {
    return new URL(relative, base).toString();
  } catch {
    return relative;
  }
}

/**
 * Strip authentication info (user:pass@) from a URL.
 */
export function stripAuthInfo(url: string): string {
  try {
    const parsed = new URL(url);
    parsed.username = '';
    parsed.password = '';
    return parsed.toString();
  } catch {
    return url;
  }
}

/**
 * Check if URL should be crawled based on include/exclude patterns and protocol.
 */
export function shouldCrawl(
  url: string,
  baseUrl: string,
  options: {
    include?: string[];
    exclude?: string[];
    followExternal?: boolean;
  }
): boolean {
  // Must be an allowed protocol
  if (!isAllowedProtocol(url)) return false;

  // Same-origin check (unless followExternal)
  if (!options.followExternal && !isSameOrigin(url, baseUrl)) return false;

  // Exclude takes precedence over include
  if (options.exclude && options.exclude.length > 0 && matchesGlob(url, options.exclude)) {
    return false;
  }

  // If include patterns are specified, URL must match at least one
  if (options.include && options.include.length > 0 && !matchesGlob(url, options.include)) {
    return false;
  }

  return true;
}
