/// <reference lib="dom" />

/**
 * PageScanner collector — extracts structural information from a page.
 *
 * Receives a Playwright Page that has already navigated to the target URL.
 * Does NOT navigate, click, or scroll — it only reads the current DOM state.
 *
 * Extracts:
 *   - URL, canonical URL, title
 *   - Meta tags (name, property, content)
 *   - Heading hierarchy (h1-h6)
 *   - Landmark elements (nav, main, aside, footer, header, [role])
 *   - Links (<a href>) with internal/external classification
 *   - Interactive elements (buttons, inputs, selects) with CSS selectors
 *   - Navigation Timing data
 *   - Content hash for change detection
 *   - Hash-routing detection
 */

import type { Page, Response } from 'playwright';
import type {
  PageScanResult,
  HeadingEntry,
  MetaTag,
  LandmarkInfo,
  LinkInfo,
  InteractiveElement,
  PageTiming,
} from '../types/artifacts.js';
import { isSameOrigin, resolveUrl } from '../crawl/url-utils.js';

// ---------------------------------------------------------------------------
// Types for the raw data returned by page.evaluate
// ---------------------------------------------------------------------------

interface RawDomData {
  canonicalHref: string | null;
  title: string;
  metaTags: MetaTag[];
  headings: HeadingEntry[];
  landmarks: LandmarkInfo[];
  links: Array<{ href: string; text: string; rel: string | null }>;
  interactiveElements: Array<{
    tagName: string;
    type: string | null;
    text: string;
    role: string | null;
    ariaLabel: string | null;
    selector: string;
  }>;
  contentHash: string;
  hashIndicators: number;
}

interface RawTimingData {
  loadTime: number;
  domContentLoaded: number;
  firstContentfulPaint: number | null;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Scan a page and extract its structural information.
 *
 * @param page       Playwright Page already navigated to the target URL.
 * @param baseUrl    The crawl's starting URL, used for same-origin checks.
 * @param response   The navigation response (for HTTP status code).
 *                   Pass null/undefined if not available; statusCode defaults to 200.
 */
export async function scanPage(
  page: Page,
  baseUrl: string,
  response?: Response | null,
): Promise<PageScanResult> {
  const url = page.url();
  const statusCode = response?.status() ?? 200;

  // Run DOM extraction and timing extraction in parallel.
  const [domData, timingData] = await Promise.all([
    extractDomData(page),
    extractTiming(page),
  ]);

  // Post-process links: resolve relative URLs and classify internal/external.
  const links = processLinks(domData.links, url, baseUrl);

  // Post-process interactive elements: strip nulls into undefined.
  const interactiveElements = processInteractiveElements(domData.interactiveElements);

  // Determine hash-routing presence from link hrefs.
  const hashRoutingDetected = domData.hashIndicators >= 3;

  return {
    url,
    canonicalUrl: domData.canonicalHref ?? undefined,
    statusCode,
    title: domData.title,
    metaTags: domData.metaTags,
    headings: domData.headings,
    landmarks: domData.landmarks,
    links,
    interactiveElements,
    timing: timingData,
    contentHash: domData.contentHash,
    hashRoutingDetected,
  };
}

// ---------------------------------------------------------------------------
// DOM extraction (single page.evaluate call)
// ---------------------------------------------------------------------------

async function extractDomData(page: Page): Promise<RawDomData> {
  try {
    return await page.evaluate((): RawDomData => {
      // ------ Canonical ------
      const canonicalEl = document.querySelector<HTMLLinkElement>('link[rel="canonical"]');
      const canonicalHref = canonicalEl?.href ?? null;

      // ------ Title ------
      const title = document.title ?? '';

      // ------ Meta tags ------
      const metaEls = document.querySelectorAll<HTMLMetaElement>('meta[name], meta[property], meta[content]');
      const metaTags: MetaTag[] = [];
      metaEls.forEach((el) => {
        const content = el.getAttribute('content');
        if (!content) return;
        const entry: MetaTag = { content };
        const name = el.getAttribute('name');
        const property = el.getAttribute('property');
        if (name) entry.name = name;
        if (property) entry.property = property;
        // Only include if at least one of name/property is present
        if (name || property) {
          metaTags.push(entry);
        }
      });

      // ------ Headings ------
      const headingEls = document.querySelectorAll<HTMLHeadingElement>('h1, h2, h3, h4, h5, h6');
      const headings: HeadingEntry[] = [];
      headingEls.forEach((el) => {
        const text = (el.textContent ?? '').trim();
        if (!text) return;
        const level = parseInt(el.tagName[1], 10) as 1 | 2 | 3 | 4 | 5 | 6;
        headings.push({ level, text });
      });

      // ------ Landmarks ------
      const landmarkSelectors = 'nav, main, aside, footer, header, [role]';
      const landmarkEls = document.querySelectorAll(landmarkSelectors);
      const landmarks: LandmarkInfo[] = [];
      const seenLandmarks = new Set<string>();

      landmarkEls.forEach((el) => {
        const tagName = el.tagName.toLowerCase();
        const explicitRole = el.getAttribute('role');

        // Determine the effective role
        let role: string;
        if (explicitRole) {
          role = explicitRole;
        } else {
          // Map tag names to implicit ARIA roles
          const implicitRoles: Record<string, string> = {
            nav: 'navigation',
            main: 'main',
            aside: 'complementary',
            footer: 'contentinfo',
            header: 'banner',
          };
          role = implicitRoles[tagName] ?? tagName;
        }

        const label =
          el.getAttribute('aria-label') ??
          el.getAttribute('aria-labelledby') ??
          undefined;

        // Dedup by role+tagName+label
        const key = `${role}|${tagName}|${label ?? ''}`;
        if (seenLandmarks.has(key)) return;
        seenLandmarks.add(key);

        const entry: LandmarkInfo = { role, tagName };
        if (label) entry.label = label;
        landmarks.push(entry);
      });

      // ------ Links ------
      const linkEls = document.querySelectorAll<HTMLAnchorElement>('a[href]');
      const links: Array<{ href: string; text: string; rel: string | null }> = [];
      const seenHrefs = new Set<string>();

      linkEls.forEach((el) => {
        const href = el.getAttribute('href');
        if (!href || href === '#' || href.startsWith('javascript:')) return;

        // Use the resolved href from the anchor element
        const resolvedHref = el.href;
        if (seenHrefs.has(resolvedHref)) return;
        seenHrefs.add(resolvedHref);

        const text = (el.textContent ?? '').trim();
        const rel = el.getAttribute('rel');
        links.push({ href: resolvedHref, text, rel });
      });

      // ------ Interactive elements (not links) ------
      const interactiveSelectors =
        'button, input, select, textarea, [role="button"], [role="tab"], [role="combobox"], [role="listbox"], [role="slider"], [role="spinbutton"], [role="switch"]';
      const interactiveEls = document.querySelectorAll(interactiveSelectors);
      const interactiveElements: RawDomData['interactiveElements'] = [];

      interactiveEls.forEach((el, index) => {
        const tagName = el.tagName.toLowerCase();
        const type = el.getAttribute('type');
        const role = el.getAttribute('role');
        const ariaLabel = el.getAttribute('aria-label');

        // Skip hidden inputs — they are not user-interactive
        if (tagName === 'input' && type === 'hidden') return;

        // Extract visible text
        let text = '';
        if (tagName === 'input' || tagName === 'textarea') {
          text =
            (el as HTMLInputElement).placeholder ??
            (el as HTMLInputElement).value ??
            '';
        } else {
          text = (el.textContent ?? '').trim();
        }

        // Generate a CSS selector
        let selector: string;
        const id = el.getAttribute('id');
        if (id) {
          selector = `${tagName}#${CSS.escape(id)}`;
        } else {
          const name = el.getAttribute('name');
          if (name) {
            selector = `${tagName}[name="${CSS.escape(name)}"]`;
          } else {
            // Fall back to nth-of-type within parent
            const parent = el.parentElement;
            if (parent) {
              const siblings = Array.from(parent.querySelectorAll(`:scope > ${tagName}`));
              const nth = siblings.indexOf(el) + 1;
              // Try to produce a more specific selector using parent's id
              const parentId = parent.getAttribute('id');
              if (parentId) {
                selector = `#${CSS.escape(parentId)} > ${tagName}:nth-of-type(${nth})`;
              } else {
                selector = `${tagName}:nth-of-type(${nth})`;
              }
            } else {
              selector = `${tagName}[data-arch-index="${index}"]`;
            }
          }
        }

        interactiveElements.push({
          tagName,
          type,
          text: text.slice(0, 200), // cap text length
          role,
          ariaLabel,
          selector,
        });
      });

      // ------ Content hash (SHA-256 via SubtleCrypto) ------
      // SubtleCrypto is async, so we compute a simple djb2 hash synchronously
      // for deterministic, fast change detection.
      const bodyText = (document.body?.innerText ?? '').trim();
      let hash = 5381;
      for (let i = 0; i < bodyText.length; i++) {
        hash = ((hash << 5) + hash + bodyText.charCodeAt(i)) | 0;
      }
      const contentHash = (hash >>> 0).toString(16).padStart(8, '0');

      // ------ Hash routing indicators ------
      let hashIndicators = 0;
      linkEls.forEach((el) => {
        const h = el.getAttribute('href');
        if (h && (h.startsWith('#/') || h.startsWith('#!/'))) {
          hashIndicators++;
        }
      });

      return {
        canonicalHref,
        title,
        metaTags,
        headings,
        landmarks,
        links,
        interactiveElements,
        contentHash,
        hashIndicators,
      };
    });
  } catch {
    // If DOM extraction fails entirely, return safe defaults
    return {
      canonicalHref: null,
      title: '',
      metaTags: [],
      headings: [],
      landmarks: [],
      links: [],
      interactiveElements: [],
      contentHash: '00000000',
      hashIndicators: 0,
    };
  }
}

// ---------------------------------------------------------------------------
// Timing extraction
// ---------------------------------------------------------------------------

async function extractTiming(page: Page): Promise<PageTiming> {
  try {
    const raw = await page.evaluate((): RawTimingData => {
      const entries = performance.getEntriesByType('navigation') as PerformanceNavigationTiming[];
      if (entries.length === 0) {
        return { loadTime: 0, domContentLoaded: 0, firstContentfulPaint: null };
      }

      const nav = entries[0];
      const loadTime = nav.loadEventEnd > 0
        ? Math.round(nav.loadEventEnd - nav.startTime)
        : 0;
      const domContentLoaded = nav.domContentLoadedEventEnd > 0
        ? Math.round(nav.domContentLoadedEventEnd - nav.startTime)
        : 0;

      // First Contentful Paint from paint entries
      let firstContentfulPaint: number | null = null;
      const paintEntries = performance.getEntriesByType('paint');
      for (const entry of paintEntries) {
        if (entry.name === 'first-contentful-paint') {
          firstContentfulPaint = Math.round(entry.startTime);
          break;
        }
      }

      return { loadTime, domContentLoaded, firstContentfulPaint };
    });

    const timing: PageTiming = {
      loadTime: raw.loadTime,
      domContentLoaded: raw.domContentLoaded,
    };
    if (raw.firstContentfulPaint != null) {
      timing.firstContentfulPaint = raw.firstContentfulPaint;
    }
    return timing;
  } catch {
    return { loadTime: 0, domContentLoaded: 0 };
  }
}

// ---------------------------------------------------------------------------
// Post-processing helpers
// ---------------------------------------------------------------------------

/**
 * Resolve relative hrefs against the page URL and classify as internal/external.
 */
function processLinks(
  rawLinks: Array<{ href: string; text: string; rel: string | null }>,
  pageUrl: string,
  baseUrl: string,
): LinkInfo[] {
  const results: LinkInfo[] = [];

  for (const raw of rawLinks) {
    const resolved = resolveUrl(raw.href, pageUrl);
    const isExternal = !isSameOrigin(resolved, baseUrl);

    const link: LinkInfo = {
      href: resolved,
      text: raw.text,
      isExternal,
    };
    if (raw.rel) {
      link.rel = raw.rel;
    }
    results.push(link);
  }

  return results;
}

/**
 * Convert nullable fields to undefined for the InteractiveElement interface.
 */
function processInteractiveElements(
  rawElements: RawDomData['interactiveElements'],
): InteractiveElement[] {
  return rawElements.map((raw) => {
    const el: InteractiveElement = {
      tagName: raw.tagName,
      text: raw.text,
      selector: raw.selector,
    };
    if (raw.type) el.type = raw.type;
    if (raw.role) el.role = raw.role;
    if (raw.ariaLabel) el.ariaLabel = raw.ariaLabel;
    return el;
  });
}
