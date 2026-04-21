/**
 * Filename sanitization for emitted Playwright spec files.
 *
 * The emitter writes one file per page and per flow, keyed by URL. Raw URLs
 * contain slashes, colons, query strings, and hash fragments — none of which
 * are portable filename characters. These helpers produce a stable,
 * reversible-enough, cross-platform-safe slug while avoiding collisions on
 * trimmed empty paths (e.g. `https://example.com/` → `root` rather than ``).
 */

/**
 * Characters never allowed in filenames on Windows, plus the traditional
 * POSIX separators and control characters. Matched globally.
 */
const UNSAFE_CHARS = /[\x00-\x1f<>:"/\\|?*]/g;

/**
 * Convert an absolute URL or path into a conservative filename slug.
 *
 * Strategy:
 *   - Parse as URL; if that fails, treat the input as a bare path.
 *   - Concatenate hostname + pathname. Ignore query + hash (they would
 *     explode the filename count on API-heavy sites).
 *   - Replace any unsafe character with `-`.
 *   - Collapse runs of `-`, strip leading/trailing `-`.
 *   - Return `root` when the slug is empty (so `https://example.com/` has
 *     a filename).
 *   - Cap to 100 chars so we do not hit Windows MAX_PATH in nested output.
 */
export function sanitizeUrlForFilename(url: string): string {
  let host = '';
  let path = '';

  try {
    const parsed = new URL(url);
    host = parsed.hostname.toLowerCase();
    path = parsed.pathname;
  } catch {
    // Not a valid URL — treat the whole string as a path fragment.
    path = url;
  }

  const combined = `${host}${path}`;
  const cleaned = combined
    .replace(UNSAFE_CHARS, '-')
    .replace(/[.\s]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');

  if (cleaned.length === 0) return 'root';

  return cleaned.length > 100 ? cleaned.slice(0, 100) : cleaned;
}

/**
 * Convert a URL pathname into an API-style slug (leading slash stripped,
 * segments joined by `-`). Used for `api/{slug}.spec.ts` filenames.
 */
export function sanitizeApiPatternForFilename(method: string, pattern: string): string {
  const methodPart = method.toLowerCase().replace(/[^a-z]/g, '');
  const pathPart = pattern
    .replace(/^\//, '')
    .replace(/:/g, '')
    .replace(UNSAFE_CHARS, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');

  const slug = pathPart.length > 0 ? `${methodPart}-${pathPart}` : methodPart;
  return slug.length > 100 ? slug.slice(0, 100) : slug;
}
