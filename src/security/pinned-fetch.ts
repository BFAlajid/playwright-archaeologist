/**
 * Pinned-IP Fetch — socket-level DNS pinning
 *
 * Closes the TOCTOU window between the network guard's resolver and
 * Playwright's TCP connect. When the guard has already approved a hostname
 * (and cached its resolved public IP), we bypass the OS resolver entirely
 * by issuing the HTTP(S) request through a custom Node Agent that connects
 * directly to the pinned literal IP.
 *
 * Key properties preserved:
 *  - TLS SNI uses the original hostname via `servername`, so the server
 *    presents the correct certificate and TLS name validation still holds.
 *  - The `Host:` request header carries the original hostname so virtual
 *    hosting routes the request correctly on the server.
 *  - `rejectUnauthorized` stays on — certificate name validation is NOT
 *    disabled; this mechanism is orthogonal to trust, it just forces the
 *    socket to land at the approved IP.
 *  - Response bodies are hard-capped at 50 MiB to prevent memory blowup
 *    from hostile servers streaming without Content-Length.
 *  - Redirects are followed manually (max 5 hops), re-pinning at every new
 *    hostname so rebinding cannot smuggle in via a redirect.
 *
 * Out of scope (still fall back to the OS resolver through `route.continue()`):
 *  - WebSockets (HTTP Upgrade semantics not handled here).
 *  - HTTP/2 or HTTP/3 — Playwright speaks h2 over TLS ALPN; the Node http2
 *    module is a separate API. Callers downgrade to HTTP/1.1 by setting
 *    ALPNProtocols: ['http/1.1'] so the server negotiates h1 back with us.
 *  - Cross-origin subresources (handled by caller — see `isFirstParty`).
 */

import * as net from 'node:net';
import * as tls from 'node:tls';
import * as http from 'node:http';
import * as https from 'node:https';
import type { Duplex } from 'node:stream';
import { URL as NodeURL } from 'node:url';
import { lookup } from 'node:dns/promises';

import { isPrivateIp } from './network-guard.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Hard cap on response body size, in bytes. 50 MiB. */
export const MAX_BODY_BYTES = 50 * 1024 * 1024;

/** Default request timeout, in ms. */
export const DEFAULT_TIMEOUT_MS = 10_000;

/** Max redirects to follow before aborting. */
export const MAX_REDIRECTS = 5;

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface PinnedFetchOptions {
  timeoutMs?: number;
  /**
   * Allow the pinned IP itself to be private. Off by default — the caller
   * should already have validated via the network guard. This matters for
   * redirects where the new hostname's resolved IP has not gone through
   * the guard yet; we re-check locally.
   */
  allowPrivate?: boolean;
  /**
   * Optional DNS cache to consult for redirect hostnames. If the hostname
   * we're about to follow is already pinned there, we reuse the entry.
   */
  dnsCache?: Map<string, string>;
}

export interface PinnedFetchResponse {
  status: number;
  statusText: string;
  headers: Record<string, string | string[]>;
  body: Buffer;
}

export class PinnedFetchError extends Error {
  readonly code: string;
  constructor(code: string, message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'PinnedFetchError';
    this.code = code;
  }
}

// ---------------------------------------------------------------------------
// Custom agents: createConnection is overridden to connect to a literal IP
// ---------------------------------------------------------------------------

/**
 * Build an https.Agent whose `createConnection` ignores the hostname and
 * connects directly to `pinnedIp` on the given `port`. `servername` is set
 * to the original hostname so TLS SNI and name validation still work.
 */
function buildPinnedHttpsAgent(pinnedIp: string, hostname: string, port: number): https.Agent {
  class PinnedHttpsAgent extends https.Agent {
    override createConnection(
      _options: https.RequestOptions,
      callback?: (err: Error | null, stream: Duplex) => void,
    ): Duplex {
      const socket = tls.connect({
        host: pinnedIp,
        port,
        servername: hostname,
        // Force HTTP/1.1: Node's https module does not speak h2 at this layer,
        // and asking ALPN for h2 would leave us with a half-opened socket the
        // http.Agent cannot drive.
        ALPNProtocols: ['http/1.1'],
        // Cert trust remains the Node default. Do NOT set rejectUnauthorized:
        // false — this mechanism is about forcing the connect target, not
        // bypassing trust.
      });
      if (callback) {
        const onSecure = () => {
          socket.removeListener('error', onError);
          callback(null, socket);
        };
        const onError = (err: Error) => {
          socket.removeListener('secureConnect', onSecure);
          callback(err, socket);
        };
        socket.once('secureConnect', onSecure);
        socket.once('error', onError);
      }
      return socket;
    }
  }
  return new PinnedHttpsAgent({ keepAlive: false, maxSockets: 1 });
}

/**
 * Build an http.Agent whose `createConnection` connects directly to
 * `pinnedIp:port`. No TLS — plain HTTP.
 */
function buildPinnedHttpAgent(pinnedIp: string, port: number): http.Agent {
  class PinnedHttpAgent extends http.Agent {
    override createConnection(
      _options: http.ClientRequestArgs,
      callback?: (err: Error | null, stream: Duplex) => void,
    ): Duplex {
      const socket = net.createConnection({ host: pinnedIp, port });
      if (callback) {
        const onConnect = () => {
          socket.removeListener('error', onError);
          callback(null, socket);
        };
        const onError = (err: Error) => {
          socket.removeListener('connect', onConnect);
          callback(err, socket);
        };
        socket.once('connect', onConnect);
        socket.once('error', onError);
      }
      return socket;
    }
  }
  return new PinnedHttpAgent({ keepAlive: false, maxSockets: 1 });
}

// ---------------------------------------------------------------------------
// Core issuer — single request, no redirect handling
// ---------------------------------------------------------------------------

interface IssueResult {
  status: number;
  statusText: string;
  headers: Record<string, string | string[]>;
  body: Buffer;
  /** Raw Location header, if any. */
  location?: string;
}

function issueRequest(
  method: string,
  urlStr: string,
  pinnedIp: string,
  headers: Record<string, string>,
  body: Buffer | string | null,
  timeoutMs: number,
): Promise<IssueResult> {
  return new Promise((resolve, reject) => {
    let parsed: NodeURL;
    try {
      parsed = new NodeURL(urlStr);
    } catch {
      reject(new PinnedFetchError('INVALID_URL', `Invalid URL: ${urlStr}`));
      return;
    }

    const isHttps = parsed.protocol === 'https:';
    if (!isHttps && parsed.protocol !== 'http:') {
      reject(
        new PinnedFetchError(
          'BAD_PROTOCOL',
          `pinned-fetch only supports http: and https: (got ${parsed.protocol})`,
        ),
      );
      return;
    }

    const port = parsed.port
      ? parseInt(parsed.port, 10)
      : isHttps
        ? 443
        : 80;

    const hostname = parsed.hostname;
    const agent = isHttps
      ? buildPinnedHttpsAgent(pinnedIp, hostname, port)
      : buildPinnedHttpAgent(pinnedIp, port);

    // Preserve Host header. Normalize header keys to lowercase so we don't
    // double-set Host/host.
    const outHeaders: Record<string, string> = {};
    for (const [k, v] of Object.entries(headers)) {
      const lower = k.toLowerCase();
      // Drop hop-by-hop / transport-managed headers — Node sets these itself
      // and duplicating them breaks the request.
      if (lower === 'host' || lower === 'content-length' || lower === 'connection') {
        continue;
      }
      outHeaders[lower] = v;
    }
    outHeaders['host'] = port === (isHttps ? 443 : 80) ? hostname : `${hostname}:${port}`;
    outHeaders['connection'] = 'close';

    const reqOptions: http.RequestOptions = {
      method,
      agent,
      hostname: pinnedIp,
      port,
      path: parsed.pathname + parsed.search,
      headers: outHeaders,
      // `setHost: false` — we set Host ourselves above.
      setHost: false,
    };

    const lib: typeof http | typeof https = isHttps ? https : http;

    const req = lib.request(reqOptions, (res) => {
      const chunks: Buffer[] = [];
      let total = 0;
      let aborted = false;

      res.on('data', (chunk: Buffer) => {
        if (aborted) return;
        total += chunk.length;
        if (total > MAX_BODY_BYTES) {
          aborted = true;
          res.destroy();
          req.destroy();
          reject(
            new PinnedFetchError(
              'BODY_TOO_LARGE',
              `Response body exceeds ${MAX_BODY_BYTES} bytes`,
            ),
          );
          return;
        }
        chunks.push(chunk);
      });
      res.on('end', () => {
        if (aborted) return;
        resolve({
          status: res.statusCode ?? 0,
          statusText: res.statusMessage ?? '',
          headers: res.headers as Record<string, string | string[]>,
          body: Buffer.concat(chunks),
          location: typeof res.headers.location === 'string' ? res.headers.location : undefined,
        });
      });
      res.on('error', (err) => {
        if (aborted) return;
        reject(new PinnedFetchError('RESPONSE_ERROR', err.message, { cause: err }));
      });
    });

    req.on('error', (err) => {
      reject(new PinnedFetchError('REQUEST_ERROR', err.message, { cause: err }));
    });

    req.setTimeout(timeoutMs, () => {
      req.destroy(new PinnedFetchError('TIMEOUT', `Request timed out after ${timeoutMs}ms`));
    });

    if (body != null) {
      req.write(body);
    }
    req.end();
  });
}

// ---------------------------------------------------------------------------
// Public entry point — handles redirects with per-hop re-pinning
// ---------------------------------------------------------------------------

/**
 * Fetch a URL forcing the underlying TCP/TLS connection to use `pinnedIp`
 * for the first hop. Redirects are followed manually; each redirect
 * hostname is freshly resolved and re-checked against the private-IP
 * blocklist (unless `options.allowPrivate` is true).
 */
export async function fetchWithPinnedHost(
  method: string,
  url: string,
  pinnedIp: string,
  headers: Record<string, string>,
  body: Buffer | string | null,
  options: PinnedFetchOptions = {},
): Promise<PinnedFetchResponse> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const allowPrivate = options.allowPrivate ?? false;
  let currentUrl = url;
  let currentIp = pinnedIp;
  let currentMethod = method;
  let currentBody = body;

  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    const result = await issueRequest(
      currentMethod,
      currentUrl,
      currentIp,
      headers,
      currentBody,
      timeoutMs,
    );

    const status = result.status;
    const isRedirect = status >= 300 && status < 400 && !!result.location;

    if (!isRedirect) {
      return {
        status: result.status,
        statusText: result.statusText,
        headers: result.headers,
        body: result.body,
      };
    }

    if (hop === MAX_REDIRECTS) {
      throw new PinnedFetchError(
        'TOO_MANY_REDIRECTS',
        `Exceeded ${MAX_REDIRECTS} redirects`,
      );
    }

    // Resolve the next URL relative to the current one.
    let nextUrl: string;
    try {
      nextUrl = new NodeURL(result.location!, currentUrl).toString();
    } catch {
      throw new PinnedFetchError('BAD_REDIRECT', `Invalid Location header: ${result.location}`);
    }

    // Only follow http(s) redirects. A redirect to javascript:, file:, etc.
    // is an attack.
    let parsed: NodeURL;
    try {
      parsed = new NodeURL(nextUrl);
    } catch {
      throw new PinnedFetchError('BAD_REDIRECT', `Unparseable redirect target: ${nextUrl}`);
    }
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      throw new PinnedFetchError(
        'BAD_REDIRECT',
        `Refusing non-http(s) redirect to ${parsed.protocol}`,
      );
    }

    // Re-pin at the new hostname. Prefer the dnsCache entry if present.
    const nextHost = parsed.hostname;
    let nextIp = options.dnsCache?.get(nextHost);
    if (!nextIp) {
      try {
        const dns = await lookup(nextHost);
        nextIp = typeof dns === 'string' ? dns : dns.address;
      } catch {
        throw new PinnedFetchError(
          'REDIRECT_DNS_FAILED',
          `Could not resolve redirect target ${nextHost}`,
        );
      }
    }

    if (!allowPrivate && isPrivateIp(nextIp)) {
      throw new PinnedFetchError(
        'REDIRECT_TO_PRIVATE',
        `Refusing redirect to private IP ${nextIp} (${nextHost})`,
      );
    }

    // Update the cache so future requests to this hostname see the same IP.
    if (options.dnsCache && !options.dnsCache.has(nextHost)) {
      options.dnsCache.set(nextHost, nextIp);
    }

    // Per RFC 7231: 303 always becomes GET; 301/302 commonly do in practice.
    // 307/308 preserve method. To minimize surprise, match fetch()'s behavior:
    // 301/302/303 -> GET with no body; 307/308 -> preserve.
    if (status === 301 || status === 302 || status === 303) {
      currentMethod = 'GET';
      currentBody = null;
    }

    currentUrl = nextUrl;
    currentIp = nextIp;
  }

  // Unreachable — the loop either returns or throws.
  throw new PinnedFetchError('INTERNAL', 'Redirect loop fell through');
}

// ---------------------------------------------------------------------------
// Same-site heuristic
// ---------------------------------------------------------------------------

/**
 * Return true if the request hostname is the same registrable domain as the
 * crawl's entry hostname. Used to decide whether to apply socket pinning or
 * fall through to the OS resolver.
 *
 * This is an eTLD+1 approximation — we don't ship the Public Suffix List to
 * keep zero runtime deps, so we use a conservative "last two labels match"
 * check. For hosts under known multi-label suffixes (co.uk, github.io) this
 * under-approximates (marks cross-site as same-site). That is safe: it only
 * means we pin more aggressively, not less.
 */
export function isFirstParty(requestHostname: string, entryHostname: string): boolean {
  if (!requestHostname || !entryHostname) return false;
  const r = requestHostname.toLowerCase().replace(/^\[|\]$/g, '');
  const e = entryHostname.toLowerCase().replace(/^\[|\]$/g, '');
  if (r === e) return true;

  // Bare IPs: equality already handled above; different IPs are different origins.
  if (net.isIP(r) || net.isIP(e)) return false;

  // Compare last two labels as eTLD+1 approximation.
  const rParts = r.split('.').filter(Boolean);
  const eParts = e.split('.').filter(Boolean);
  if (rParts.length < 2 || eParts.length < 2) return false;
  const rTail = rParts.slice(-2).join('.');
  const eTail = eParts.slice(-2).join('.');
  return rTail === eTail;
}
