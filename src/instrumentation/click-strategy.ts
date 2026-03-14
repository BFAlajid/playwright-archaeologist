/**
 * Click Strategy — Tiered element clicking with destructive action detection.
 *
 * Tier 1 (always): <a href> — extract href, no clicking
 * Tier 2 (default): <nav> items, [role="tab"], pagination — click + monitor URL
 * Tier 3 (opt-in: --deep-click): Other interactive elements — snapshot/click/compare/restore
 * Tier 4 (never): Destructive patterns — skip always
 */

export type ClickTier = 1 | 2 | 3 | 4;

export interface ElementInfo {
  tagName: string;
  text: string;
  href?: string;
  role?: string;
  ariaLabel?: string;
  dataAttributes?: Record<string, string>;
  parentTagName?: string;
}

/**
 * Destructive action patterns — text content matching.
 */
export const DESTRUCTIVE_TEXT_PATTERNS: RegExp[] = [
  /\blog\s*out\b/i,
  /\bsign\s*out\b/i,
  /\bdelete\b/i,
  /\bremove\b/i,
  /\bdestroy\b/i,
  /\bdeactivate\b/i,
  /\bcancel\s*account\b/i,
  /\bunsubscribe\b/i,
  /\breset\b/i,
];

/**
 * Safe patterns that should NOT be treated as destructive
 * even though they contain destructive keywords.
 */
export const SAFE_OVERRIDE_PATTERNS: RegExp[] = [
  /\bdelete\s+filter\b/i,
  /\bremove\s+filter\b/i,
  /\bsign\s*up\b/i,
  /\breset\s+filter\b/i,
  /\breset\s+search\b/i,
];

/**
 * Destructive attribute selectors.
 */
export const DESTRUCTIVE_ATTR_SELECTORS = [
  '[data-method="delete"]',
  '[data-confirm]',
  '[data-turbo-method="delete"]',
];

/**
 * Determine if an element's text content suggests a destructive action.
 */
export function isDestructiveText(text: string): boolean {
  if (!text) return false;

  // Check safe overrides first — if it matches a safe pattern, it is not destructive
  for (const safe of SAFE_OVERRIDE_PATTERNS) {
    if (safe.test(text)) return false;
  }

  // Check destructive patterns
  for (const pattern of DESTRUCTIVE_TEXT_PATTERNS) {
    if (pattern.test(text)) return true;
  }

  return false;
}

/**
 * Determine if an element has destructive data attributes.
 */
export function hasDestructiveAttributes(
  dataAttributes: Record<string, string>
): boolean {
  // data-method="delete"
  if (dataAttributes['data-method'] === 'delete') return true;

  // data-confirm (any value — its mere presence signals a destructive action)
  if ('data-confirm' in dataAttributes) return true;

  // data-turbo-method="delete"
  if (dataAttributes['data-turbo-method'] === 'delete') return true;

  return false;
}

/**
 * Classify an element into a click tier.
 */
export function classifyElement(element: ElementInfo): ClickTier {
  const { tagName, text, href, role, parentTagName, dataAttributes } = element;

  // Tier 4: destructive actions take highest priority
  if (isDestructiveText(text)) return 4;
  if (dataAttributes && hasDestructiveAttributes(dataAttributes)) return 4;

  // Tier 1: anchor tags with href (for link extraction, not clicking)
  const tag = tagName.toUpperCase();
  if (tag === 'A' && href != null) return 1;

  // Tier 2: navigation elements
  if (parentTagName && parentTagName.toUpperCase() === 'NAV') return 2;

  const normalizedRole = role?.toLowerCase();
  if (
    normalizedRole === 'tab' ||
    normalizedRole === 'menuitem' ||
    normalizedRole === 'link'
  ) {
    return 2;
  }

  // Tier 3: everything else (buttons, divs with click handlers, etc.)
  return 3;
}

/**
 * Determine if an element should be clicked based on its tier and the crawl options.
 */
export function shouldClick(
  element: ElementInfo,
  options: { deepClick?: boolean }
): boolean {
  const tier = classifyElement(element);

  switch (tier) {
    case 1:
      // Tier 1: extract href, never click
      return false;
    case 2:
      // Tier 2: always click
      return true;
    case 3:
      // Tier 3: only click if deepClick is enabled
      return options.deepClick === true;
    case 4:
      // Tier 4: never click
      return false;
  }
}
