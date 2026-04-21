/**
 * Shared design tokens for HTML reports.
 *
 * Imported by both `template.ts` (crawl report) and `diff-report.ts`
 * (diff report) so color, radius, shadow, and typography scales stay in
 * sync across the two artifacts. Theming is layered:
 *
 *   1. `:root` defines light-mode values.
 *   2. `@media (prefers-color-scheme: dark)` applies dark when the user has
 *      no explicit preference.
 *   3. `:root[data-theme="dark"]` / `:root[data-theme="light"]` override the
 *      media query when the in-report theme toggle has persisted a choice.
 */
export const CSS_TOKENS = `
  :root {
    --bg: #ffffff;
    --bg-surface: #f8f9fa;
    --bg-surface-hover: #f0f1f3;
    --bg-nav: #1a1a2e;
    --text: #1a1a2e;
    --text-muted: #6c757d;
    --text-nav: #ffffff;
    --border: #dee2e6;
    --border-light: #e9ecef;
    --accent: #4361ee;
    --accent-hover: #3a56d4;
    --status-2xx: #198754;
    --status-3xx: #0d6efd;
    --status-4xx: #e67700;
    --status-5xx: #dc3545;
    --method-get: #198754;
    --method-post: #0d6efd;
    --method-put: #e67700;
    --method-delete: #dc3545;
    --method-patch: #cc8800;
    --badge-bg: #e9ecef;
    --badge-added-bg: #d4edda;
    --badge-added-fg: #155724;
    --badge-removed-bg: #f8d7da;
    --badge-removed-fg: #721c24;
    --badge-changed-bg: #fff3cd;
    --badge-changed-fg: #856404;
    --badge-unchanged-bg: #e2e3e5;
    --badge-unchanged-fg: #383d41;
    --no-changes-bg: #d4edda;
    --no-changes-fg: #155724;
    --shadow: 0 1px 3px rgba(0,0,0,0.08);
    --radius: 6px;
    --nav-h: 48px;
  }

  @media (prefers-color-scheme: dark) {
    :root {
      --bg: #0d1117;
      --bg-surface: #161b22;
      --bg-surface-hover: #1c2129;
      --bg-nav: #010409;
      --text: #e6edf3;
      --text-muted: #8b949e;
      --text-nav: #e6edf3;
      --border: #30363d;
      --border-light: #21262d;
      --accent: #58a6ff;
      --accent-hover: #79b8ff;
      --status-2xx: #3fb950;
      --status-3xx: #58a6ff;
      --status-4xx: #d29922;
      --status-5xx: #f85149;
      --method-get: #3fb950;
      --method-post: #58a6ff;
      --method-put: #d29922;
      --method-delete: #f85149;
      --method-patch: #e3b341;
      --badge-bg: #21262d;
      --badge-added-bg: #1b3a2d;
      --badge-added-fg: #7ee787;
      --badge-removed-bg: #3d1f28;
      --badge-removed-fg: #f85149;
      --badge-changed-bg: #3d2e00;
      --badge-changed-fg: #d29922;
      --badge-unchanged-bg: #21262d;
      --badge-unchanged-fg: #8b949e;
      --no-changes-bg: #1b3a2d;
      --no-changes-fg: #7ee787;
      --shadow: 0 1px 3px rgba(0,0,0,0.3);
    }
  }

  /*
   * Explicit theme override — beats the media query when the user has
   * clicked the in-report theme toggle.
   */
  :root[data-theme="light"] {
    --bg: #ffffff;
    --bg-surface: #f8f9fa;
    --bg-surface-hover: #f0f1f3;
    --bg-nav: #1a1a2e;
    --text: #1a1a2e;
    --text-muted: #6c757d;
    --text-nav: #ffffff;
    --border: #dee2e6;
    --border-light: #e9ecef;
    --accent: #4361ee;
    --accent-hover: #3a56d4;
    --status-2xx: #198754;
    --status-3xx: #0d6efd;
    --status-4xx: #e67700;
    --status-5xx: #dc3545;
    --method-get: #198754;
    --method-post: #0d6efd;
    --method-put: #e67700;
    --method-delete: #dc3545;
    --method-patch: #cc8800;
    --badge-bg: #e9ecef;
    --badge-added-bg: #d4edda;
    --badge-added-fg: #155724;
    --badge-removed-bg: #f8d7da;
    --badge-removed-fg: #721c24;
    --badge-changed-bg: #fff3cd;
    --badge-changed-fg: #856404;
    --badge-unchanged-bg: #e2e3e5;
    --badge-unchanged-fg: #383d41;
    --no-changes-bg: #d4edda;
    --no-changes-fg: #155724;
    --shadow: 0 1px 3px rgba(0,0,0,0.08);
  }

  :root[data-theme="dark"] {
    --bg: #0d1117;
    --bg-surface: #161b22;
    --bg-surface-hover: #1c2129;
    --bg-nav: #010409;
    --text: #e6edf3;
    --text-muted: #8b949e;
    --text-nav: #e6edf3;
    --border: #30363d;
    --border-light: #21262d;
    --accent: #58a6ff;
    --accent-hover: #79b8ff;
    --status-2xx: #3fb950;
    --status-3xx: #58a6ff;
    --status-4xx: #d29922;
    --status-5xx: #f85149;
    --method-get: #3fb950;
    --method-post: #58a6ff;
    --method-put: #d29922;
    --method-delete: #f85149;
    --method-patch: #e3b341;
    --badge-bg: #21262d;
    --badge-added-bg: #1b3a2d;
    --badge-added-fg: #7ee787;
    --badge-removed-bg: #3d1f28;
    --badge-removed-fg: #f85149;
    --badge-changed-bg: #3d2e00;
    --badge-changed-fg: #d29922;
    --badge-unchanged-bg: #21262d;
    --badge-unchanged-fg: #8b949e;
    --no-changes-bg: #1b3a2d;
    --no-changes-fg: #7ee787;
    --shadow: 0 1px 3px rgba(0,0,0,0.3);
  }
`;

/**
 * Inline SVG favicon (data URI). ~420 bytes — a stylised compass/shovel glyph
 * in neutral gray that reads against both light and dark browser chrome.
 */
export const FAVICON_DATA_URI =
  'data:image/svg+xml,%3Csvg%20xmlns%3D%22http%3A%2F%2Fwww.w3.org%2F2000%2Fsvg%22%20viewBox%3D%220%200%2016%2016%22%3E%3Ccircle%20cx%3D%228%22%20cy%3D%228%22%20r%3D%227%22%20fill%3D%22%234361ee%22%2F%3E%3Cpath%20d%3D%22M8%202L9%208L8%2014L7%208Z%22%20fill%3D%22%23fff%22%2F%3E%3Cpath%20d%3D%22M2%208L8%207L14%208L8%209Z%22%20fill%3D%22%23fff%22%2F%3E%3C%2Fsvg%3E';

/**
 * Small non-cryptographic hash (DJB2) producing a short base-36 slug.
 * Used for stable row IDs in reports. Not suitable for security use.
 */
export function hashSlug(s: string): string {
  let h = 5381;
  for (let i = 0; i < s.length; i++) {
    h = ((h << 5) + h) + s.charCodeAt(i);
  }
  return (h >>> 0).toString(36);
}

/**
 * Produce a URL-safe slug (lowercase, non-alphanumerics collapsed to `-`).
 * Used alongside `hashSlug` to build readable deep-link IDs.
 */
export function patternSlug(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40);
}
