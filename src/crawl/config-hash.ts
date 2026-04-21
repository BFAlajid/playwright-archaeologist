/**
 * Deterministic config hashing for checkpoint compatibility.
 *
 * The checkpoint file stores a hash of the config that produced it. When
 * the user later passes `--resume`, we compare the stored hash against the
 * current config to confirm they match. Mismatch => refuse to resume
 * (resuming with a different config would produce nonsensical results:
 * e.g., a new `depth` value would be ignored for already-visited URLs).
 *
 * "Canonical JSON" here means:
 *   - Object keys sorted lexicographically at every depth.
 *   - Arrays preserved in declared order (they're meaningful — include/exclude
 *     globs, additionalViewports — and resolveConfig does not sort them).
 *   - Undefined values dropped (JSON.stringify drops them too).
 *   - Function refs stripped (collectors may be user-supplied functions).
 *
 * We intentionally exclude a few fields from the hash:
 *
 *   - `outputDir`: moving the output directory does not change crawl
 *     identity. Users routinely rerun into different output paths.
 *   - `authScript` / `cookiesFile`: absolute paths vary across machines.
 *     Auth identity affects what gets crawled, but that's the user's call —
 *     and the alternative is hashing the script contents, which is
 *     brittle (whitespace changes would invalidate every checkpoint).
 *   - `warnings`: transient, populated at config resolution time.
 *   - `collectors`: function references, not serializable.
 *   - `resume`: the resume flag itself obviously differs between the
 *     original run (false, default) and the resuming run (true).
 */

import { createHash } from 'node:crypto';
import type { ResolvedConfig } from '../types/config.js';

// Fields that must NOT be part of the hash. Keep this list in sync with
// any new ResolvedConfig fields that are path-local or runtime-only.
const VOLATILE_FIELDS: ReadonlySet<string> = new Set([
  'outputDir',
  'authScript',
  'cookiesFile',
  'warnings',
  'collectors',
  'resume',
]);

/**
 * Canonical JSON stringification with sorted object keys at every depth.
 * Arrays keep their declared order. Undefined/function values are dropped.
 */
function canonicalStringify(value: unknown): string {
  if (value === null) return 'null';
  if (typeof value === 'undefined' || typeof value === 'function') return 'null';
  if (typeof value === 'number') {
    // NaN/Infinity aren't valid JSON; coerce to null (they should never
    // appear in ResolvedConfig, but be defensive).
    return Number.isFinite(value) ? String(value) : 'null';
  }
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  if (typeof value === 'string') return JSON.stringify(value);
  if (Array.isArray(value)) {
    const parts = value.map((v) => canonicalStringify(v));
    return `[${parts.join(',')}]`;
  }
  if (typeof value === 'object') {
    const obj = value as Record<string, unknown>;
    const keys = Object.keys(obj).sort();
    const parts = keys
      .filter((k) => {
        const v = obj[k];
        return typeof v !== 'undefined' && typeof v !== 'function';
      })
      .map((k) => `${JSON.stringify(k)}:${canonicalStringify(obj[k])}`);
    return `{${parts.join(',')}}`;
  }
  // bigint, symbol, etc. — shouldn't be in a ResolvedConfig, but avoid throwing.
  return 'null';
}

/**
 * Produce a stable SHA-256 hex hash of the given ResolvedConfig with
 * volatile fields stripped.
 *
 * Two configs that differ only in output directory or auth path paths
 * produce the same hash. Two configs that differ in `depth`, `maxPages`,
 * `include`, `targetUrl`, or any other crawl-shaping field produce
 * different hashes.
 */
export function hashConfig(config: ResolvedConfig): string {
  const shaped: Record<string, unknown> = {};
  for (const [key, val] of Object.entries(config)) {
    if (VOLATILE_FIELDS.has(key)) continue;
    shaped[key] = val;
  }
  const canonical = canonicalStringify(shaped);
  return createHash('sha256').update(canonical).digest('hex');
}
