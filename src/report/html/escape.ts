/**
 * HTML Escaping — XSS Prevention
 *
 * All data from the target site MUST be HTML-entity-encoded
 * before embedding in reports. This is a critical security boundary.
 */

/**
 * Escape a string for safe inclusion in HTML content.
 * Encodes: & < > " '
 * Strips null bytes.
 * Preserves Unicode characters.
 */
export function escapeHtml(input: string): string {
  // Strip null bytes first
  const stripped = input.replace(/\0/g, '');

  return stripped.replace(/[&<>"']/g, (char) => {
    switch (char) {
      case '&':
        return '&amp;';
      case '<':
        return '&lt;';
      case '>':
        return '&gt;';
      case '"':
        return '&quot;';
      case "'":
        return '&#039;';
      default:
        return char;
    }
  });
}

/**
 * Escape a string for safe inclusion in an HTML attribute value.
 * More aggressive than content escaping.
 */
export function escapeAttribute(input: string): string {
  const htmlEscaped = escapeHtml(input);

  // Additionally encode / and backtick for attribute context
  return htmlEscaped
    .replace(/\//g, '&#x2F;')
    .replace(/`/g, '&#96;');
}

/**
 * Sanitize a string for inclusion in a JSON block embedded in HTML.
 * Prevents </script> injection.
 */
export function escapeJsonInHtml(jsonString: string): string {
  return jsonString
    .replace(/<\//g, '<\\/')
    .replace(/<!--/g, '<\\!--');
}

/**
 * Sanitize a URL for use in an `href` attribute.
 *
 * Returns `'#'` if the URL cannot be parsed, or if its protocol is anything
 * other than http/https. This blocks `javascript:`, `data:`, `vbscript:`,
 * `file:`, and other schemes that can execute code or exfiltrate when the
 * user clicks a link in the generated report.
 */
export function sanitizeUrl(u: string): string {
  if (typeof u !== 'string' || u.length === 0) return '#';
  const trimmed = u.trim();
  try {
    const parsed = new URL(trimmed);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      return '#';
    }
    return trimmed;
  } catch {
    return '#';
  }
}

/**
 * Redact absolute filesystem paths from a string so the report can be
 * shared without leaking local environment details (usernames, home
 * directory layout, CI runner paths).
 *
 * Behavior:
 *   - Empty / non-string input returns `''`.
 *   - If `outputDir` is provided and `p` is under it, returns the
 *     POSIX-normalised relative path.
 *   - If `p` looks absolute (POSIX `/...` or Windows `C:\...`) and is NOT
 *     under `outputDir`, returns the opaque label `<file>`.
 *   - Otherwise returns `p` unchanged (already relative).
 */
export function redactAbsolutePath(p: string, outputDir?: string): string {
  if (typeof p !== 'string' || p.length === 0) return '';
  const normalizeSep = (s: string): string => s.replace(/\\/g, '/');

  const isAbsolute = (s: string): boolean => {
    if (s.length === 0) return false;
    if (s.charAt(0) === '/') return true;
    // Windows: C:\ or C:/
    return /^[A-Za-z]:[\\/]/.test(s);
  };

  if (!isAbsolute(p)) return p;

  if (outputDir && outputDir.length > 0) {
    const base = normalizeSep(outputDir).replace(/\/+$/, '');
    const norm = normalizeSep(p);
    // Case-insensitive prefix check for Windows drive letters.
    const baseLower = base.toLowerCase();
    const normLower = norm.toLowerCase();
    if (normLower === baseLower) return '.';
    if (normLower.startsWith(baseLower + '/')) {
      return norm.slice(base.length + 1);
    }
  }

  return '<file>';
}

/**
 * Strip dangerous content from an SVG string before inlining it into the
 * HTML report. Removes:
 *   - `<script>` blocks
 *   - `on*` event handler attributes
 *   - `href`/`xlink:href` attributes with non-http(s) schemes (e.g.
 *     `javascript:`)
 *
 * This is defense-in-depth — `svgContent` is currently always set to
 * `undefined` by the orchestrator, but the hardening closes the gap for any
 * future caller that forgets to sanitize their input.
 */
export function sanitizeSvg(svg: string): string {
  if (typeof svg !== 'string' || svg.length === 0) return '';

  let result = svg;

  // Drop entire <script>...</script> blocks. The `/g` + `/i` handles upper-case
  // variants; the lazy match ensures we don't eat across sibling tags.
  result = result.replace(/<script\b[^>]*>[\s\S]*?<\/script\s*>/gi, '');

  // Drop `on*="..."`, `on*='...'`, and `on*=bare` event handler attributes.
  result = result.replace(/\son[a-z]+\s*=\s*"[^"]*"/gi, '');
  result = result.replace(/\son[a-z]+\s*=\s*'[^']*'/gi, '');
  result = result.replace(/\son[a-z]+\s*=\s*[^\s>]+/gi, '');

  // Strip href / xlink:href values that use non-http(s) schemes.
  result = result.replace(
    /\s(?:xlink:)?href\s*=\s*"([^"]*)"/gi,
    (match, url: string) =>
      sanitizeUrl(url) === '#' && url.trim() !== '' ? '' : match,
  );
  result = result.replace(
    /\s(?:xlink:)?href\s*=\s*'([^']*)'/gi,
    (match, url: string) =>
      sanitizeUrl(url) === '#' && url.trim() !== '' ? '' : match,
  );

  return result;
}
