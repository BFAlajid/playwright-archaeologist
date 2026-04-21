/**
 * Network Guard — SSRF Protection
 *
 * Blocks requests to private IP ranges and dangerous protocols.
 * Default-on; can be bypassed with --allow-private.
 *
 * Blocked ranges:
 * - 10.0.0.0/8 (RFC1918)
 * - 172.16.0.0/12 (RFC1918)
 * - 192.168.0.0/16 (RFC1918)
 * - 169.254.0.0/16 (link-local, AWS/GCP metadata)
 * - 127.0.0.0/8 (loopback)
 * - 0.0.0.0/8 (unspecified)
 * - fd00::/8, fc00::/7 (IPv6 private)
 * - fe80::/10 (IPv6 link-local)
 * - ::1 (IPv6 loopback)
 * - metadata.google.internal
 * - kubernetes.default.svc
 *
 * Blocked protocols: file:, javascript:, data:, ftp:, chrome:, blob:, etc.
 * Allowed protocols: http:, https:
 */

import { lookup } from 'node:dns/promises';

export interface NetworkGuardOptions {
  allowPrivate?: boolean;
  /**
   * Per-session DNS cache shared across route handlers. The first time a
   * hostname is resolved during `isBlockedUrl`, its IP is recorded here.
   * On subsequent requests to the same hostname, `onRoute` re-resolves and
   * blocks if the answer has changed — the hallmark of a DNS rebinding
   * attack where the server initially answers with a public IP, then swaps
   * to a private IP once the crawler is already talking to the host.
   *
   * Callers should create a fresh Map per crawl session and pass the same
   * instance into `isBlockedUrl` and `createNetworkGuard`.
   */
  dnsCache?: Map<string, string>;
}

// -------------------------------------------------------------------------
// Metadata hostnames
// -------------------------------------------------------------------------
// Cloud metadata service endpoints. These return credentials (IAM role
// tokens, instance identity documents) to any HTTP client that can reach
// them. They MUST be blocked whenever the crawl is running with network
// access to the metadata network.
const METADATA_HOSTNAMES = new Set([
  // AWS / GCP / Azure legacy IMDS
  'metadata.google.internal',
  '169.254.169.254',
  'fd00:ec2::254',         // AWS IMDS over IPv6
  'fe80::a9fe:a9fe',       // AWS IMDS link-local v6
  // Azure instance metadata
  'metadata.azure.com',
  // Alibaba / Tencent instance metadata
  '100.100.100.200',
  '100.100.200.200',
  // Oracle OCI metadata
  '192.0.0.192',
  // Kubernetes service DNS
  'kubernetes.default.svc',
]);

// Absolute broadcast address — not link-local, not RFC1918, but not
// something a crawler should ever contact.
const BROADCAST_IPS = new Set<string>([
  '255.255.255.255',
]);

// -------------------------------------------------------------------------
// Allowed protocols
// -------------------------------------------------------------------------
const ALLOWED_PROTOCOLS = new Set(['http:', 'https:']);

// -------------------------------------------------------------------------
// IPv4 parsing helpers
// -------------------------------------------------------------------------

/**
 * Parse an IPv4 octet that may be decimal, octal (0-prefixed), or hex (0x-prefixed).
 * Returns NaN if invalid.
 */
function parseOctet(s: string): number {
  if (s === '') return NaN;
  if (/^0x/i.test(s)) {
    return parseInt(s, 16);
  }
  if (s.length > 1 && s.startsWith('0') && /^\d+$/.test(s)) {
    // Octal
    return parseInt(s, 8);
  }
  const n = Number(s);
  return Number.isInteger(n) ? n : NaN;
}

/**
 * Parse an IPv4 address string (supporting decimal, octal, hex notations
 * and single-integer forms) into a 32-bit number. Returns null on failure.
 */
function parseIpv4ToNumber(ip: string): number | null {
  // Single integer form (e.g., 2130706433 for 127.0.0.1)
  if (/^(0x[\da-fA-F]+|\d+)$/.test(ip)) {
    const n = ip.startsWith('0x') || ip.startsWith('0X')
      ? parseInt(ip, 16)
      : Number(ip);
    if (Number.isFinite(n) && n >= 0 && n <= 0xFFFFFFFF) {
      return n;
    }
    return null;
  }

  const parts = ip.split('.');
  if (parts.length !== 4) return null;

  let result = 0;
  for (let i = 0; i < 4; i++) {
    const octet = parseOctet(parts[i]);
    if (isNaN(octet) || octet < 0 || octet > 255) return null;
    result = (result << 8) | octet;
  }
  // Ensure unsigned
  return result >>> 0;
}

/**
 * Check if a 32-bit IPv4 number falls in a private/reserved range.
 */
function isPrivateIpv4Number(num: number): boolean {
  // 0.0.0.0/8
  if ((num >>> 24) === 0) return true;
  // 10.0.0.0/8
  if ((num >>> 24) === 10) return true;
  // 127.0.0.0/8
  if ((num >>> 24) === 127) return true;
  // 172.16.0.0/12
  if ((num >>> 24) === 172) {
    const second = (num >>> 16) & 0xFF;
    if (second >= 16 && second <= 31) return true;
  }
  // 192.168.0.0/16
  if ((num >>> 16) === ((192 << 8) | 168)) return true;
  // 169.254.0.0/16
  if ((num >>> 16) === ((169 << 8) | 254)) return true;

  return false;
}

/**
 * Check if an IP address is in a private/reserved range.
 * Handles IPv4, IPv6, IPv4-mapped IPv6 (::ffff:x.x.x.x).
 * Returns true for private, false for public.
 * Invalid IPs return false (for isPrivateIp/isPrivateIP direct callers),
 * but isBlockedUrl treats DNS failures as blocked (fail-closed).
 */
export function isPrivateIp(ip: string): boolean {
  if (!ip || typeof ip !== 'string') return false;

  const trimmed = ip.trim();

  // --- IPv6 handling ---
  if (trimmed.includes(':')) {
    return isPrivateIpv6(trimmed);
  }

  // --- IPv4 handling ---
  const num = parseIpv4ToNumber(trimmed);
  if (num === null) return false;
  return isPrivateIpv4Number(num);
}

/**
 * Check if an IPv6 address is private/reserved.
 */
function isPrivateIpv6(ip: string): boolean {
  // Remove zone ID (e.g., %eth0 or %25eth0)
  let cleaned = ip.replace(/%.*$/, '');

  // IPv4-mapped IPv6: ::ffff:x.x.x.x or 0:0:0:0:0:ffff:x.x.x.x
  const v4MappedMatch = cleaned.match(
    /^(?:::ffff:|0{1,4}:0{1,4}:0{1,4}:0{1,4}:0{1,4}:ffff:)(\d+\.\d+\.\d+\.\d+)$/i
  );
  if (v4MappedMatch) {
    return isPrivateIp(v4MappedMatch[1]);
  }

  // Expand :: to full form for comparison
  const expanded = expandIpv6(cleaned);
  if (!expanded) return false;

  // ::1 (loopback)
  if (expanded === '0000:0000:0000:0000:0000:0000:0000:0001') return true;

  // :: (unspecified)
  if (expanded === '0000:0000:0000:0000:0000:0000:0000:0000') return true;

  const firstGroup = parseInt(expanded.substring(0, 4), 16);

  // fc00::/7 (includes fd00::/8)
  if ((firstGroup & 0xFE00) === 0xFC00) return true;

  // fe80::/10 (link-local)
  if ((firstGroup & 0xFFC0) === 0xFE80) return true;

  return false;
}

/**
 * Expand an IPv6 address to its full 8-group form.
 */
function expandIpv6(ip: string): string | null {
  // Remove brackets if present
  let addr = ip.replace(/^\[|\]$/g, '');

  // Handle IPv4-mapped suffix
  const lastColon = addr.lastIndexOf(':');
  const possibleV4 = addr.substring(lastColon + 1);
  if (possibleV4.includes('.')) {
    const num = parseIpv4ToNumber(possibleV4);
    if (num === null) return null;
    const hi = (num >>> 16) & 0xFFFF;
    const lo = num & 0xFFFF;
    addr = addr.substring(0, lastColon + 1) +
      hi.toString(16).padStart(4, '0') + ':' +
      lo.toString(16).padStart(4, '0');
  }

  const parts = addr.split('::');
  if (parts.length > 2) return null;

  if (parts.length === 2) {
    const left = parts[0] ? parts[0].split(':') : [];
    const right = parts[1] ? parts[1].split(':') : [];
    const missing = 8 - left.length - right.length;
    if (missing < 0) return null;
    const mid = Array(missing).fill('0000');
    const all = [...left, ...mid, ...right];
    return all.map(g => g.padStart(4, '0')).join(':');
  }

  const groups = addr.split(':');
  if (groups.length !== 8) return null;
  return groups.map(g => g.padStart(4, '0')).join(':');
}

// Export alias for tests that import isPrivateIP (capital IP)
export { isPrivateIp as isPrivateIP };

/**
 * Check if a hostname is a known metadata endpoint.
 */
export function isMetadataHostname(hostname: string): boolean {
  if (!hostname) return false;
  const lower = hostname.toLowerCase().trim();
  return METADATA_HOSTNAMES.has(lower);
}

/**
 * Check if a URL uses an allowed protocol.
 */
export function isAllowedProtocol(url: string): boolean {
  try {
    const parsed = new URL(url);
    return ALLOWED_PROTOCOLS.has(parsed.protocol);
  } catch {
    // If we can't parse, check for known dangerous prefixes
    const lower = url.toLowerCase().trim();
    if (lower.startsWith('http:') || lower.startsWith('https:')) return true;
    return false;
  }
}

/**
 * Extract the hostname from a URL, handling percent-encoding.
 */
function extractHostname(urlStr: string): string {
  try {
    const parsed = new URL(urlStr);
    // URL constructor decodes percent-encoded hostnames
    return parsed.hostname;
  } catch {
    return '';
  }
}

/**
 * Check if a URL should be blocked.
 * Resolves DNS to detect private IPs behind public hostnames (DNS rebinding).
 * Fail-closed: blocks if DNS fails or URL is unparseable.
 */
export async function isBlockedUrl(
  url: string,
  options?: NetworkGuardOptions
): Promise<{ blocked: boolean; reason?: string }> {
  const allowPrivate = options?.allowPrivate ?? false;

  // Check protocol first (even allowPrivate doesn't bypass protocol checks)
  if (!isAllowedProtocol(url)) {
    return { blocked: true, reason: 'Blocked protocol — only http: and https: are allowed' };
  }

  let hostname: string;
  try {
    hostname = extractHostname(url);
  } catch {
    return { blocked: true, reason: 'Failed to parse URL (fail-closed)' };
  }

  if (!hostname) {
    return { blocked: true, reason: 'Empty hostname (fail-closed)' };
  }

  // Decode percent-encoded hostname
  let decodedHostname: string;
  try {
    decodedHostname = decodeURIComponent(hostname);
  } catch {
    // Double-encoded or invalid — fail closed
    return { blocked: true, reason: 'Invalid hostname encoding (fail-closed)' };
  }

  // Check metadata hostnames
  if (isMetadataHostname(decodedHostname)) {
    if (allowPrivate) return { blocked: false };
    return { blocked: true, reason: 'Blocked metadata hostname' };
  }

  // Remove brackets from IPv6
  const cleanedHost = decodedHostname.replace(/^\[|\]$/g, '');

  // Broadcast addresses are never a legitimate crawl target.
  if (BROADCAST_IPS.has(cleanedHost)) {
    return { blocked: true, reason: `Blocked broadcast address: ${cleanedHost}` };
  }

  // Check if hostname is directly a private IP (including encoded forms)
  if (isPrivateIp(cleanedHost)) {
    if (allowPrivate) return { blocked: false };
    return { blocked: true, reason: `Blocked private IP: ${cleanedHost}` };
  }

  // Check if it's a decimal/hex/octal-encoded IP
  const ipNum = parseIpv4ToNumber(cleanedHost);
  if (ipNum !== null) {
    if (isPrivateIpv4Number(ipNum)) {
      if (allowPrivate) return { blocked: false };
      return { blocked: true, reason: `Blocked private IP (encoded): ${cleanedHost}` };
    }
    // It's a valid public IP in non-standard form, allow it
    return { blocked: false };
  }

  // DNS resolution
  try {
    const result = await lookup(decodedHostname, { all: true });
    const addresses = Array.isArray(result) ? result : [result];

    // Pick the first public address (or the first address if allowPrivate).
    // This becomes the pinned answer for this hostname for the rest of
    // the session.
    let pinned: string | undefined;
    for (const entry of addresses) {
      const addr = typeof entry === 'string' ? entry : entry.address;
      if (isPrivateIp(addr)) {
        if (allowPrivate) {
          pinned = pinned ?? addr;
          continue;
        }
        return { blocked: true, reason: `DNS resolved to private IP: ${addr}` };
      }
      pinned = pinned ?? addr;
    }

    // Record the pinned IP for later rebinding detection. Only set on the
    // first resolution — later requests compare against this entry.
    if (pinned && options?.dnsCache && !options.dnsCache.has(decodedHostname)) {
      options.dnsCache.set(decodedHostname, pinned);
    }

    return { blocked: false };
  } catch {
    // DNS failure — fail closed
    return { blocked: true, reason: 'DNS resolution failed (fail-closed)' };
  }
}

/**
 * Create a Playwright route handler that blocks requests to private IPs.
 *
 * Also performs best-effort DNS rebinding detection when `options.dnsCache`
 * is provided. Each request re-resolves the hostname and compares against
 * the pinned address set on first resolution. If none of the fresh
 * addresses match the pinned one AND at least one fresh address is private,
 * the request is blocked (classic rebinding to a private target). If all
 * fresh addresses are public but different, this is more likely ordinary
 * DNS rotation (round-robin, A/AAAA load balancing) — the request is
 * allowed but we record the observation.
 *
 * CAVEAT: this check does not cover the time-of-check-to-time-of-use window
 * between our resolver and Playwright's own TCP connect; for a hard
 * guarantee you would need to pin at the socket level (e.g. a custom HTTP
 * agent that forces connection to the pinned address with the original
 * hostname in the Host header). That is out of scope here.
 */
export function createNetworkGuard(options?: NetworkGuardOptions) {
  return async (route: any) => {
    const url = route.request().url();
    const result = await isBlockedUrl(url, options);

    if (result.blocked) {
      await route.abort('blockedbyclient');
      return;
    }

    if (options?.dnsCache) {
      try {
        const hostname = new URL(url).hostname.replace(/^\[|\]$/g, '');
        const pinned = options.dnsCache.get(hostname);
        if (pinned) {
          const fresh = await lookup(hostname, { all: true });
          const addresses = Array.isArray(fresh) ? fresh : [fresh];
          const freshAddrs = addresses.map((a) =>
            typeof a === 'string' ? a : a.address,
          );
          const matches = freshAddrs.includes(pinned);
          if (!matches) {
            const anyPrivate = freshAddrs.some((a) => isPrivateIp(a));
            if (anyPrivate && !(options.allowPrivate ?? false)) {
              // Classic rebinding attempt: resolver now returns a private IP.
              await route.abort('blockedbyclient');
              return;
            }
            // Public IP rotation (CDN round-robin / geo-LB). Allow.
          }
        }
      } catch {
        // DNS errored on re-lookup — fail closed.
        await route.abort('blockedbyclient');
        return;
      }
    }

    await route.continue();
  };
}
