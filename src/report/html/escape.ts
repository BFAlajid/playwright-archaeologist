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
