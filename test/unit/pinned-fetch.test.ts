/**
 * Unit tests for src/security/pinned-fetch.ts
 *
 * Verifies the custom agents actually route traffic to the pinned IP,
 * preserve Host/SNI, enforce timeouts, honor the body-size cap, and
 * re-pin on redirects. We spin up a local HTTP server on 127.0.0.1 so
 * the fact that the connection works despite a non-resolving hostname
 * is proof the IP pin is active.
 *
 * HTTPS end-to-end coverage is delegated to the integration suite
 * (test/integration/crawl.test.ts), which runs against real HTTPS
 * fixtures without forcing us to generate a self-signed cert inline.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as http from 'node:http';
import { AddressInfo } from 'node:net';

import {
  fetchWithPinnedHost,
  PinnedFetchError,
  isFirstParty,
} from '../../src/security/pinned-fetch.js';

// ---------------------------------------------------------------------------
// HTTP fixture
// ---------------------------------------------------------------------------

describe('fetchWithPinnedHost — HTTP', () => {
  let server: http.Server;
  let port: number;
  let receivedHost: string | undefined;
  let receivedPath: string | undefined;

  beforeAll(async () => {
    server = http.createServer((req, res) => {
      receivedHost = req.headers.host;
      receivedPath = req.url;

      if (req.url === '/redirect-once') {
        res.writeHead(302, { Location: '/final' });
        res.end();
        return;
      }
      if (req.url === '/redirect-loop') {
        res.writeHead(302, { Location: '/redirect-loop' });
        res.end();
        return;
      }
      if (req.url === '/evil-redirect') {
        res.writeHead(302, { Location: 'javascript:alert(1)' });
        res.end();
        return;
      }
      if (req.url === '/final') {
        res.writeHead(200, { 'Content-Type': 'text/plain' });
        res.end('landed');
        return;
      }
      if (req.url === '/huge') {
        res.writeHead(200, { 'Content-Type': 'application/octet-stream' });
        // Stream way more than MAX_BODY_BYTES
        const chunk = Buffer.alloc(1 << 20, 0); // 1 MiB per write
        let n = 0;
        const tick = () => {
          if (n > 60) {
            res.end();
            return;
          }
          n++;
          if (res.write(chunk)) tick();
          else res.once('drain', tick);
        };
        tick();
        return;
      }
      if (req.url === '/slow') {
        // Hang forever — the client should time out.
        return;
      }

      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, host: req.headers.host, path: req.url }));
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    port = (server.address() as AddressInfo).port;
  });

  afterAll(async () => {
    await new Promise<void>((resolve, reject) =>
      server.close((err) => (err ? reject(err) : resolve())),
    );
  });

  it('connects to pinnedIp even when the URL hostname is non-resolvable', async () => {
    // "test.local" isn't in DNS, but the pinned IP is 127.0.0.1 — if the
    // agent weren't overriding the resolver, this call would ENOTFOUND.
    const res = await fetchWithPinnedHost(
      'GET',
      `http://test.local:${port}/hello`,
      '127.0.0.1',
      {},
      null,
    );
    expect(res.status).toBe(200);
    expect(receivedHost).toBe(`test.local:${port}`);
    expect(receivedPath).toBe('/hello');
    const body = JSON.parse(res.body.toString('utf-8'));
    expect(body.ok).toBe(true);
  });

  it('forwards the Host header as the original hostname, not the pinned IP', async () => {
    await fetchWithPinnedHost(
      'GET',
      `http://virtual-host.example:${port}/`,
      '127.0.0.1',
      {},
      null,
    );
    expect(receivedHost).toBe(`virtual-host.example:${port}`);
  });

  it('follows redirects and re-pins at each hop', async () => {
    const res = await fetchWithPinnedHost(
      'GET',
      `http://test.local:${port}/redirect-once`,
      '127.0.0.1',
      {},
      null,
      {
        dnsCache: new Map([['test.local', '127.0.0.1']]),
        // Our test fixture uses 127.0.0.1; normally the redirect check
        // would reject the private IP — opt in for the test.
        allowPrivate: true,
      },
    );
    expect(res.status).toBe(200);
    expect(res.body.toString('utf-8')).toBe('landed');
    expect(receivedPath).toBe('/final');
  });

  it('aborts a redirect loop after MAX_REDIRECTS hops', async () => {
    await expect(
      fetchWithPinnedHost(
        'GET',
        `http://test.local:${port}/redirect-loop`,
        '127.0.0.1',
        {},
        null,
        {
          dnsCache: new Map([['test.local', '127.0.0.1']]),
          allowPrivate: true,
        },
      ),
    ).rejects.toMatchObject({ code: 'TOO_MANY_REDIRECTS' });
  });

  it('rejects a body larger than MAX_BODY_BYTES', async () => {
    await expect(
      fetchWithPinnedHost(
        'GET',
        `http://test.local:${port}/huge`,
        '127.0.0.1',
        {},
        null,
        { timeoutMs: 30_000 },
      ),
    ).rejects.toMatchObject({ code: 'BODY_TOO_LARGE' });
  });

  it('enforces the timeout', async () => {
    // /slow never sends headers. We set a 150ms timeout and expect a
    // timeout-class failure. The outer code surfaces this as
    // REQUEST_ERROR (wrapping the socket timeout) or as TIMEOUT directly
    // depending on the race between the destroy() call and the socket
    // error. Accept either.
    const err = await fetchWithPinnedHost(
      'GET',
      `http://test.local:${port}/slow`,
      '127.0.0.1',
      {},
      null,
      { timeoutMs: 150 },
    ).then(
      () => {
        throw new Error('should have rejected');
      },
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(PinnedFetchError);
    const code = (err as PinnedFetchError).code;
    expect(['TIMEOUT', 'REQUEST_ERROR']).toContain(code);
  });

  it('refuses non-http(s) redirect targets', async () => {
    await expect(
      fetchWithPinnedHost(
        'GET',
        `http://test.local:${port}/evil-redirect`,
        '127.0.0.1',
        {},
        null,
        { allowPrivate: true },
      ),
    ).rejects.toMatchObject({ code: 'BAD_REDIRECT' });
  });

  it('refuses a redirect whose target resolves to a private IP', async () => {
    // Without allowPrivate, following `Location: /final` against our
    // test server's pinned IP (127.0.0.1) must be rejected by the
    // per-hop private-IP check.
    await expect(
      fetchWithPinnedHost(
        'GET',
        `http://test.local:${port}/redirect-once`,
        '127.0.0.1',
        {},
        null,
        { dnsCache: new Map([['test.local', '127.0.0.1']]) },
      ),
    ).rejects.toMatchObject({ code: 'REDIRECT_TO_PRIVATE' });
  });

  it('rejects invalid URLs synchronously via INVALID_URL', async () => {
    await expect(
      fetchWithPinnedHost('GET', 'not-a-url', '127.0.0.1', {}, null),
    ).rejects.toMatchObject({ code: 'INVALID_URL' });
  });

  it('rejects unsupported schemes with BAD_PROTOCOL', async () => {
    await expect(
      fetchWithPinnedHost('GET', 'ftp://host/', '127.0.0.1', {}, null),
    ).rejects.toMatchObject({ code: 'BAD_PROTOCOL' });
  });
});

// ---------------------------------------------------------------------------
// isFirstParty — same-registrable-domain heuristic
// ---------------------------------------------------------------------------

describe('isFirstParty', () => {
  it('treats identical hostnames as same-site', () => {
    expect(isFirstParty('example.com', 'example.com')).toBe(true);
  });

  it('treats subdomains of the same eTLD+1 approximation as same-site', () => {
    expect(isFirstParty('api.example.com', 'example.com')).toBe(true);
    expect(isFirstParty('cdn.example.com', 'api.example.com')).toBe(true);
  });

  it('treats different registrable domains as cross-site', () => {
    expect(isFirstParty('example.com', 'attacker.com')).toBe(false);
    expect(isFirstParty('example.com', 'example.org')).toBe(false);
  });

  it('treats raw IP addresses conservatively (only exact matches)', () => {
    expect(isFirstParty('127.0.0.1', '127.0.0.1')).toBe(true);
    expect(isFirstParty('127.0.0.1', '127.0.0.2')).toBe(false);
    expect(isFirstParty('127.0.0.1', 'localhost')).toBe(false);
  });

  it('returns false for empty inputs', () => {
    expect(isFirstParty('', 'example.com')).toBe(false);
    expect(isFirstParty('example.com', '')).toBe(false);
  });

  it('returns false for single-label hostnames that do not match exactly', () => {
    expect(isFirstParty('localhost', 'example.com')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// PinnedFetchError
// ---------------------------------------------------------------------------

describe('PinnedFetchError', () => {
  it('carries a code and message', () => {
    const err = new PinnedFetchError('BAD_X', 'bad x happened');
    expect(err.code).toBe('BAD_X');
    expect(err.message).toBe('bad x happened');
    expect(err.name).toBe('PinnedFetchError');
  });

  it('preserves a cause when provided', () => {
    const root = new Error('root');
    const err = new PinnedFetchError('WRAP', 'wrapped', { cause: root });
    expect((err as unknown as { cause: unknown }).cause).toBe(root);
  });
});
