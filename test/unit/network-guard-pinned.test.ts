/**
 * Unit tests for src/security/network-guard.ts — pinned-fetch code path.
 *
 * Exercises `createNetworkGuard({ pinned: true })` against a mocked
 * Playwright route. We stub `node:dns/promises` so the guard sees a
 * "public" IP for our test hostname (127.0.0.1 is actually private,
 * which would normally trigger the SSRF block — we want the guard to
 * proceed so we can observe pinning behavior).
 *
 * Coverage:
 *  - a first-party request with a pinned IP is served via route.fulfill()
 *  - the fulfilled response carries the pinned-fetch body + status
 *  - cross-origin requests fall through to route.continue()
 *  - allowPrivate disables pinning (user opted in to SSRF)
 *  - missing pinned IP falls through to route.continue()
 *  - pinned:false disables the pinned path entirely
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import * as http from 'node:http';
import { AddressInfo } from 'node:net';

// Mock node:dns/promises BEFORE importing the guard, so the module under
// test captures our mocked lookup.
vi.mock('node:dns/promises', () => {
  // Default mock: claim that every hostname resolves to a fixed public IP.
  // Individual tests can override with `mockResolvedValue` below.
  return {
    lookup: vi.fn(async (_host: string, _opts?: { all?: boolean }) => {
      if (_opts && _opts.all) {
        return [{ address: '203.0.113.1', family: 4 }];
      }
      return { address: '203.0.113.1', family: 4 };
    }),
  };
});

import { lookup as mockedLookup } from 'node:dns/promises';
import { createNetworkGuard } from '../../src/security/network-guard.js';

// ---------------------------------------------------------------------------
// Minimal Playwright route mock
// ---------------------------------------------------------------------------

interface FulfillArgs {
  status: number;
  headers: Record<string, string>;
  body: Buffer | string;
}

function makeRouteMock(method: string, url: string, requestHeaders: Record<string, string> = {}) {
  const continueMock = vi.fn().mockResolvedValue(undefined);
  const abortMock = vi.fn().mockResolvedValue(undefined);
  const fulfillMock = vi.fn<(args: FulfillArgs) => Promise<void>>().mockResolvedValue(undefined);

  return {
    continue: continueMock,
    abort: abortMock,
    fulfill: fulfillMock,
    request: () => ({
      url: () => url,
      method: () => method,
      headers: () => requestHeaders,
    }),
  };
}

// ---------------------------------------------------------------------------
// HTTP test server — the "pinned IP" points here
// ---------------------------------------------------------------------------

describe('createNetworkGuard — pinned path', () => {
  let server: http.Server;
  let port: number;

  beforeAll(async () => {
    server = http.createServer((req, res) => {
      if (req.url === '/ok') {
        res.writeHead(200, { 'Content-Type': 'text/plain', 'X-From-Fixture': '1' });
        res.end('from-pinned-fetch');
        return;
      }
      res.writeHead(404);
      res.end('not found');
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    port = (server.address() as AddressInfo).port;
  });

  afterAll(async () => {
    await new Promise<void>((resolve, reject) =>
      server.close((err) => (err ? reject(err) : resolve())),
    );
  });

  beforeEach(() => {
    // Reset the DNS mock between tests so per-test overrides don't leak.
    vi.mocked(mockedLookup).mockImplementation(
      async (_host: string, opts?: { all?: boolean }) => {
        if (opts && opts.all) {
          return [{ address: '203.0.113.1', family: 4 }] as unknown as ReturnType<typeof mockedLookup>;
        }
        return { address: '203.0.113.1', family: 4 } as unknown as ReturnType<typeof mockedLookup>;
      },
    );
  });

  it('fulfills a first-party request via the pinned IP (pinning path fires)', async () => {
    const hostname = 'entry.test';
    const url = `http://${hostname}:${port}/ok`;
    // The dnsCache pins this hostname to 127.0.0.1 (our test server).
    // The DNS mock above returns 203.0.113.1 (public) on fresh lookups,
    // so isBlockedUrl passes (public IP) and the re-lookup in the guard
    // sees a public IP too (no rebinding detected).
    const dnsCache = new Map<string, string>([[hostname, '127.0.0.1']]);

    const guard = createNetworkGuard({
      allowPrivate: false,
      dnsCache,
      pinned: true,
      entryHostname: hostname,
    });

    const route = makeRouteMock('GET', url);
    await guard(route);

    // fulfill() must have been called, proving the pinned path served the
    // request from our test fixture instead of letting Playwright connect.
    expect(route.fulfill).toHaveBeenCalledTimes(1);
    expect(route.continue).not.toHaveBeenCalled();
    expect(route.abort).not.toHaveBeenCalled();

    const args = route.fulfill.mock.calls[0][0];
    expect(args.status).toBe(200);
    expect(args.body).toBeInstanceOf(Buffer);
    expect((args.body as Buffer).toString('utf-8')).toBe('from-pinned-fetch');
    // Headers are normalized to a flat Record<string, string>.
    expect(Object.keys(args.headers).map((k) => k.toLowerCase())).toContain('x-from-fixture');
  });

  it('aborts the request when DNS fails (fail-closed)', async () => {
    // When isBlockedUrl cannot resolve the hostname, the guard must fail
    // closed regardless of pinning. Proof: mocked lookup throws ENOTFOUND
    // -> route.abort() is the correct response; no fulfill, no continue.
    vi.mocked(mockedLookup).mockImplementationOnce(() => {
      return Promise.reject(Object.assign(new Error('ENOTFOUND'), { code: 'ENOTFOUND' }));
    });

    const hostname = 'truly-unknown.example';
    const url = `http://${hostname}:${port}/ok`;

    const guard = createNetworkGuard({
      allowPrivate: false,
      dnsCache: new Map<string, string>(),
      pinned: true,
      entryHostname: hostname,
    });

    const route = makeRouteMock('GET', url);
    await guard(route);

    expect(route.abort).toHaveBeenCalledTimes(1);
    expect(route.fulfill).not.toHaveBeenCalled();
    expect(route.continue).not.toHaveBeenCalled();
  });

  it('falls through to continue() for cross-origin requests (first-party heuristic)', async () => {
    const dnsCache = new Map<string, string>([
      ['entry.test', '127.0.0.1'],
      ['third-party.net', '127.0.0.1'],
    ]);

    const guard = createNetworkGuard({
      allowPrivate: false,
      dnsCache,
      pinned: true,
      entryHostname: 'entry.test',
    });

    const route = makeRouteMock('GET', `http://third-party.net:${port}/ok`);
    await guard(route);

    // Even though third-party.net has a pinned IP, the same-site heuristic
    // rejects cross-origin pinning unless pinCrossOrigin is set.
    expect(route.continue).toHaveBeenCalledTimes(1);
    expect(route.fulfill).not.toHaveBeenCalled();
  });

  it('pins cross-origin when pinCrossOrigin is set', async () => {
    const dnsCache = new Map<string, string>([
      ['entry.test', '203.0.113.1'],
      ['third-party.net', '127.0.0.1'], // pinned to our test server
    ]);

    const guard = createNetworkGuard({
      allowPrivate: false,
      dnsCache,
      pinned: true,
      pinCrossOrigin: true,
      entryHostname: 'entry.test',
    });

    const route = makeRouteMock('GET', `http://third-party.net:${port}/ok`);
    await guard(route);

    expect(route.fulfill).toHaveBeenCalledTimes(1);
  });

  it('does not pin when allowPrivate is true (user opted in to SSRF)', async () => {
    const hostname = 'entry.test';
    const dnsCache = new Map<string, string>([[hostname, '127.0.0.1']]);

    const guard = createNetworkGuard({
      allowPrivate: true,
      dnsCache,
      pinned: true,
      entryHostname: hostname,
    });

    const route = makeRouteMock('GET', `http://${hostname}:${port}/ok`);
    await guard(route);

    // allowPrivate short-circuits the pinned branch — user has explicitly
    // accepted SSRF risk, so we don't rewrite requests.
    expect(route.continue).toHaveBeenCalledTimes(1);
    expect(route.fulfill).not.toHaveBeenCalled();
  });

  it('does not pin when pinned: false', async () => {
    const hostname = 'entry.test';
    const dnsCache = new Map<string, string>([[hostname, '127.0.0.1']]);

    const guard = createNetworkGuard({
      allowPrivate: false,
      dnsCache,
      pinned: false,
      entryHostname: hostname,
    });

    const route = makeRouteMock('GET', `http://${hostname}:${port}/ok`);
    await guard(route);

    expect(route.continue).toHaveBeenCalledTimes(1);
    expect(route.fulfill).not.toHaveBeenCalled();
  });

  it('falls through to continue() for non-GET/HEAD methods (pinning not yet wired for uploads)', async () => {
    const hostname = 'entry.test';
    const dnsCache = new Map<string, string>([[hostname, '127.0.0.1']]);

    const guard = createNetworkGuard({
      allowPrivate: false,
      dnsCache,
      pinned: true,
      entryHostname: hostname,
    });

    const route = makeRouteMock('POST', `http://${hostname}:${port}/ok`);
    await guard(route);

    expect(route.continue).toHaveBeenCalledTimes(1);
    expect(route.fulfill).not.toHaveBeenCalled();
  });

  it('blocks the request when pinned-fetch throws (no silent fallback to OS resolver)', async () => {
    // Pinned IP points to a port that's closed — the fetch will fail.
    // The guard MUST abort rather than silently fall through, or we
    // defeat the TOCTOU-closing guarantee the user opted in to.
    const hostname = 'entry.test';
    const dnsCache = new Map<string, string>([[hostname, '127.0.0.1']]);

    const guard = createNetworkGuard({
      allowPrivate: false,
      dnsCache,
      pinned: true,
      entryHostname: hostname,
    });

    // Port 1 is effectively always closed / privileged.
    const route = makeRouteMock('GET', `http://${hostname}:1/ok`);
    await guard(route);

    expect(route.abort).toHaveBeenCalledTimes(1);
    expect(route.continue).not.toHaveBeenCalled();
    expect(route.fulfill).not.toHaveBeenCalled();
  });
});
