/**
 * HAR Scrubber
 *
 * Playwright writes unredacted HAR to disk (cookies, bearer tokens, passwords).
 * After the crawl completes and the HAR file is flushed, we read it, walk
 * log.entries[], apply the existing credential scrubbers to every request and
 * response, and atomically write the scrubbed JSON back.
 */

import { readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import {
  scrubHeaders,
  scrubBody,
  scrubUrl,
  type HeaderMap,
  type ScrubOptions,
} from './credential-scrubber.js';

// -------------------------------------------------------------------------
// Minimal HAR types (only the fields we touch)
// -------------------------------------------------------------------------

interface HarHeader {
  name: string;
  value: string;
}

interface HarPostData {
  mimeType?: string;
  text?: string;
  params?: Array<{ name: string; value?: string }>;
}

interface HarContent {
  mimeType?: string;
  text?: string;
  encoding?: string;
  size?: number;
}

interface HarRequest {
  url: string;
  headers: HarHeader[];
  postData?: HarPostData;
  [k: string]: unknown;
}

interface HarResponse {
  headers: HarHeader[];
  content?: HarContent;
  redirectURL?: string;
  [k: string]: unknown;
}

interface HarEntry {
  request: HarRequest;
  response: HarResponse;
  [k: string]: unknown;
}

interface HarLog {
  entries: HarEntry[];
  [k: string]: unknown;
}

interface HarFile {
  log: HarLog;
  [k: string]: unknown;
}

// -------------------------------------------------------------------------
// Converters between HAR's header-array format and the scrubber's HeaderMap
// -------------------------------------------------------------------------

function headersToMap(headers: HarHeader[]): HeaderMap {
  const map: HeaderMap = {};
  for (const h of headers) {
    if (h && typeof h.name === 'string') {
      map[h.name] = typeof h.value === 'string' ? h.value : '';
    }
  }
  return map;
}

function mapToHeaders(map: HeaderMap, original: HarHeader[]): HarHeader[] {
  // Preserve original order; fall back to Object.entries for keys not present
  const seen = new Set<string>();
  const result: HarHeader[] = [];
  for (const h of original) {
    if (!h || typeof h.name !== 'string') continue;
    if (seen.has(h.name)) {
      // Duplicate header name — keep the already-rewritten value (HAR may contain dupes)
      result.push({ name: h.name, value: map[h.name] ?? h.value });
      continue;
    }
    seen.add(h.name);
    result.push({ name: h.name, value: map[h.name] ?? h.value });
  }
  return result;
}

// -------------------------------------------------------------------------
// Entry scrubbing
// -------------------------------------------------------------------------

function scrubEntry(entry: HarEntry, options?: ScrubOptions): void {
  const { request, response } = entry;

  if (request) {
    if (typeof request.url === 'string') {
      request.url = scrubUrl(request.url);
    }
    if (Array.isArray(request.headers)) {
      const map = headersToMap(request.headers);
      const scrubbed = scrubHeaders(map, options);
      request.headers = mapToHeaders(scrubbed, request.headers);
    }
    if (request.postData && typeof request.postData.text === 'string') {
      request.postData.text = scrubBody(request.postData.text);
    }
    if (request.postData && Array.isArray(request.postData.params)) {
      for (const p of request.postData.params) {
        if (p && typeof p.name === 'string' && typeof p.value === 'string') {
          // Reuse scrubBody semantics via form-encoded wrapping
          const scrubbed = scrubBody(`${p.name}=${p.value}`);
          const eq = scrubbed.indexOf('=');
          if (eq !== -1) p.value = scrubbed.slice(eq + 1);
        }
      }
    }
  }

  if (response) {
    if (Array.isArray(response.headers)) {
      const map = headersToMap(response.headers);
      const scrubbed = scrubHeaders(map, options);
      response.headers = mapToHeaders(scrubbed, response.headers);
    }
    if (
      response.content &&
      typeof response.content.text === 'string' &&
      response.content.encoding !== 'base64'
    ) {
      response.content.text = scrubBody(response.content.text);
    }
    if (typeof response.redirectURL === 'string' && response.redirectURL.length > 0) {
      response.redirectURL = scrubUrl(response.redirectURL);
    }
  }
}

// -------------------------------------------------------------------------
// Public API
// -------------------------------------------------------------------------

/**
 * Read the HAR file at `harPath`, scrub credentials from every entry, and
 * write the result back atomically (temp file + rename).
 *
 * Returns silently if the file does not exist or cannot be parsed as HAR —
 * callers treat HAR as best-effort.
 */
export async function scrubHarFile(
  harPath: string,
  options?: ScrubOptions,
): Promise<void> {
  let raw: string;
  try {
    raw = await readFile(harPath, 'utf-8');
  } catch {
    return;
  }

  let parsed: HarFile;
  try {
    parsed = JSON.parse(raw) as HarFile;
  } catch {
    return;
  }

  if (!parsed || !parsed.log || !Array.isArray(parsed.log.entries)) {
    return;
  }

  for (const entry of parsed.log.entries) {
    if (entry && typeof entry === 'object') {
      scrubEntry(entry, options);
    }
  }

  // Atomic write: temp file in same directory + rename
  const tmp = join(dirname(harPath), `.${Date.now()}.har.tmp`);
  await writeFile(tmp, JSON.stringify(parsed), 'utf-8');
  await rename(tmp, harPath);
}

// Exposed for unit tests
export const __testables = { scrubEntry };
