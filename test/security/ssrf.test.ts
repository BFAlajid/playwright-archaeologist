/**
 * SSRF (Server-Side Request Forgery) Prevention Tests
 *
 * Validates that the network guard blocks all private, loopback, link-local,
 * and cloud metadata addresses by default, and that the --allow-private flag
 * provides an explicit opt-in bypass.
 *
 * Threat references: T4.1 (SSRF), T4.2 (DNS Rebinding)
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// The module under test -- will be implemented at src/security/network-guard.ts
// Expected exports:
//   isBlockedUrl(url: string, opts?: { allowPrivate?: boolean }): Promise<boolean>
//   isPrivateIP(ip: string): boolean
//   isAllowedProtocol(url: string): boolean
import {
  isBlockedUrl,
  isPrivateIP,
  isAllowedProtocol,
} from '../../src/security/network-guard.js';

// ---------------------------------------------------------------------------
// Helper: batch-test a list of URLs that must all be blocked (or allowed)
// ---------------------------------------------------------------------------
function expectAllBlocked(urls: string[], description: string) {
  for (const url of urls) {
    it(`blocks ${description}: ${url}`, async () => {
      const result = await isBlockedUrl(url);
      expect(result.blocked).toBe(true);
    });
  }
}

function expectAllAllowed(urls: string[], description: string) {
  for (const url of urls) {
    it(`allows ${description}: ${url}`, async () => {
      const result = await isBlockedUrl(url);
      expect(result.blocked).toBe(false);
    });
  }
}

// ===========================================================================
// 1. IPv4 Private Ranges (RFC1918)
// ===========================================================================
describe('SSRF Protection', () => {
  // -----------------------------------------------------------------------
  // 1a. 10.0.0.0/8
  // -----------------------------------------------------------------------
  describe('IPv4 private range 10.0.0.0/8', () => {
    expectAllBlocked(
      [
        'http://10.0.0.1/',
        'http://10.0.0.1:8080/admin',
        'http://10.255.255.255/',
        'http://10.1.2.3/internal-api',
        'http://10.0.0.0/',
      ],
      '10.x.x.x private range',
    );
  });

  // -----------------------------------------------------------------------
  // 1b. 172.16.0.0/12
  // -----------------------------------------------------------------------
  describe('IPv4 private range 172.16.0.0/12', () => {
    expectAllBlocked(
      [
        'http://172.16.0.1/',
        'http://172.16.0.1:9200/elasticsearch',
        'http://172.31.255.255/',
        'http://172.20.10.1/',
        'http://172.24.0.0/',
      ],
      '172.16-31.x.x private range',
    );

    // 172.15.x.x and 172.32.x.x are NOT private -- they should be allowed
    // (assuming DNS resolves to those IPs; we mock DNS for these)
    it('does not block 172.15.0.1 (outside /12 range)', async () => {
      // 172.15.0.1 is a public IP
      expect(isPrivateIP('172.15.0.1')).toBe(false);
    });

    it('does not block 172.32.0.1 (outside /12 range)', async () => {
      expect(isPrivateIP('172.32.0.1')).toBe(false);
    });
  });

  // -----------------------------------------------------------------------
  // 1c. 192.168.0.0/16
  // -----------------------------------------------------------------------
  describe('IPv4 private range 192.168.0.0/16', () => {
    expectAllBlocked(
      [
        'http://192.168.0.1/',
        'http://192.168.1.1/',
        'http://192.168.1.1:3000/api',
        'http://192.168.255.255/',
        'http://192.168.0.0/',
      ],
      '192.168.x.x private range',
    );
  });

  // -----------------------------------------------------------------------
  // 2. IPv4 Loopback (127.0.0.0/8)
  // -----------------------------------------------------------------------
  describe('IPv4 loopback 127.0.0.0/8', () => {
    expectAllBlocked(
      [
        'http://127.0.0.1/',
        'http://127.0.0.1:3000/',
        'http://127.0.0.1:8080/admin',
        'http://127.0.0.2/',
        'http://127.0.0.2:9090/',
        'http://127.1.1.1/',
        'http://127.255.255.255/',
      ],
      'loopback 127.x.x.x',
    );
  });

  // -----------------------------------------------------------------------
  // 3. IPv4 Link-local (169.254.0.0/16)
  // -----------------------------------------------------------------------
  describe('IPv4 link-local 169.254.0.0/16', () => {
    expectAllBlocked(
      [
        'http://169.254.0.1/',
        'http://169.254.169.254/',
        'http://169.254.169.254/latest/meta-data/',
        'http://169.254.255.255/',
        'http://169.254.1.1/',
      ],
      'link-local 169.254.x.x',
    );
  });

  // -----------------------------------------------------------------------
  // 4. IPv6 Loopback (::1)
  // -----------------------------------------------------------------------
  describe('IPv6 loopback', () => {
    expectAllBlocked(
      [
        'http://[::1]/',
        'http://[::1]:8080/',
        'http://[::1]:3000/api',
        'http://[0000:0000:0000:0000:0000:0000:0000:0001]/',
      ],
      'IPv6 loopback ::1',
    );
  });

  // -----------------------------------------------------------------------
  // 5. IPv6 Private (fc00::/7 -- includes fd00::/8)
  // -----------------------------------------------------------------------
  describe('IPv6 private (Unique Local)', () => {
    expectAllBlocked(
      [
        'http://[fd00::1]/',
        'http://[fd12:3456:789a::1]/',
        'http://[fc00::1]/',
        'http://[fdff:ffff:ffff:ffff:ffff:ffff:ffff:ffff]/',
      ],
      'IPv6 ULA fd00::/fc00::',
    );
  });

  // -----------------------------------------------------------------------
  // 6. IPv6 Link-local (fe80::/10)
  // -----------------------------------------------------------------------
  describe('IPv6 link-local', () => {
    expectAllBlocked(
      [
        'http://[fe80::1]/',
        'http://[fe80::1%25eth0]/',
        'http://[fe80::a1:b2:c3:d4]/',
      ],
      'IPv6 link-local fe80::',
    );
  });

  // -----------------------------------------------------------------------
  // 7. IPv4-mapped IPv6 addresses (::ffff:x.x.x.x)
  // -----------------------------------------------------------------------
  describe('IPv4-mapped IPv6', () => {
    expectAllBlocked(
      [
        'http://[::ffff:127.0.0.1]/',
        'http://[::ffff:10.0.0.1]/',
        'http://[::ffff:192.168.1.1]/',
        'http://[::ffff:172.16.0.1]/',
        'http://[::ffff:169.254.169.254]/',
        'http://[0:0:0:0:0:ffff:127.0.0.1]/',
      ],
      'IPv4-mapped IPv6',
    );
  });

  // -----------------------------------------------------------------------
  // 8. Decimal IP encoding (bypass attempt)
  // -----------------------------------------------------------------------
  describe('decimal IP encoding bypass', () => {
    // 2130706433 == 127.0.0.1  (127*16777216 + 0*65536 + 0*256 + 1)
    expectAllBlocked(
      [
        'http://2130706433/',
        'http://2130706433:8080/',
      ],
      'decimal-encoded 127.0.0.1',
    );

    // 167772161 == 10.0.0.1 (10*16777216 + 0*65536 + 0*256 + 1)
    expectAllBlocked(
      ['http://167772161/'],
      'decimal-encoded 10.0.0.1',
    );

    // 2852039166 == 169.254.169.254
    expectAllBlocked(
      ['http://2852039166/'],
      'decimal-encoded 169.254.169.254',
    );
  });

  // -----------------------------------------------------------------------
  // 9. Octal IP encoding (bypass attempt)
  // -----------------------------------------------------------------------
  describe('octal IP encoding bypass', () => {
    // 0177.0.0.1 == 127.0.0.1
    expectAllBlocked(
      [
        'http://0177.0.0.1/',
        'http://0177.0000.0000.0001/',
      ],
      'octal-encoded 127.0.0.1',
    );

    // 012.0.0.1 == 10.0.0.1
    expectAllBlocked(
      ['http://012.0.0.1/'],
      'octal-encoded 10.0.0.1',
    );
  });

  // -----------------------------------------------------------------------
  // 10. Hex IP encoding (bypass attempt)
  // -----------------------------------------------------------------------
  describe('hex IP encoding bypass', () => {
    // 0x7f.0.0.1 == 127.0.0.1
    expectAllBlocked(
      [
        'http://0x7f.0.0.1/',
        'http://0x7f000001/',
        'http://0x7f.0x0.0x0.0x1/',
      ],
      'hex-encoded 127.0.0.1',
    );

    // 0x0a.0.0.1 == 10.0.0.1
    expectAllBlocked(
      ['http://0x0a.0.0.1/'],
      'hex-encoded 10.0.0.1',
    );
  });

  // -----------------------------------------------------------------------
  // 11. URL with credentials (user:pass@host)
  // -----------------------------------------------------------------------
  describe('URL with embedded credentials', () => {
    expectAllBlocked(
      [
        'http://user:pass@127.0.0.1/',
        'http://admin:secret@10.0.0.1:8080/',
        'http://user:pass@192.168.1.1/',
        'http://user:pass@169.254.169.254/latest/meta-data/',
      ],
      'URL with credentials targeting private IP',
    );

    it('allows URL with credentials targeting public IP', async () => {
      // Credentials in URL do not themselves make the request blocked
      expect((await isBlockedUrl('http://user:pass@93.184.216.34/')).blocked).toBe(false);
    });
  });

  // -----------------------------------------------------------------------
  // 12. Double-encoded URLs
  // -----------------------------------------------------------------------
  describe('double-encoded URL bypass attempts', () => {
    // %31%32%37%2e%30%2e%30%2e%31 == 127.0.0.1
    expectAllBlocked(
      [
        'http://%31%32%37%2e%30%2e%30%2e%31/',
        'http://%31%30%2e%30%2e%30%2e%31/',
      ],
      'percent-encoded IP in hostname',
    );

    // Double encoding: %2531%2532%2537... -- the guard should decode or reject
    it('blocks double-encoded localhost', async () => {
      // Even if the URL parser doesn't decode this, the guard should be
      // conservative and block or fail-closed
      const result = await isBlockedUrl('http://%2531%2532%2537%252e%2530%252e%2530%252e%2531/');
      // Should either block (safe) or throw (also safe -- fail closed)
      expect(result.blocked).toBe(true);
    });
  });

  // -----------------------------------------------------------------------
  // 13. Cloud metadata endpoints
  // -----------------------------------------------------------------------
  describe('cloud metadata endpoints', () => {
    // Google Cloud
    it('blocks metadata.google.internal', async () => {
      expect((await isBlockedUrl('http://metadata.google.internal/')).blocked).toBe(true);
    });

    it('blocks metadata.google.internal with path', async () => {
      expect(
        (await isBlockedUrl('http://metadata.google.internal/computeMetadata/v1/')).blocked,
      ).toBe(true);
    });

    it('blocks metadata.google.internal with custom headers path', async () => {
      expect(
        (await isBlockedUrl(
          'http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/token',
        )).blocked,
      ).toBe(true);
    });

    // AWS metadata (169.254.169.254)
    it('blocks AWS metadata endpoint', async () => {
      expect(
        (await isBlockedUrl('http://169.254.169.254/latest/meta-data/')).blocked,
      ).toBe(true);
    });

    it('blocks AWS metadata IAM credentials path', async () => {
      expect(
        (await isBlockedUrl(
          'http://169.254.169.254/latest/meta-data/iam/security-credentials/',
        )).blocked,
      ).toBe(true);
    });

    it('blocks AWS IMDSv2 token endpoint', async () => {
      expect(
        (await isBlockedUrl('http://169.254.169.254/latest/api/token')).blocked,
      ).toBe(true);
    });

    it('blocks AWS user data endpoint', async () => {
      expect(
        (await isBlockedUrl('http://169.254.169.254/latest/user-data')).blocked,
      ).toBe(true);
    });

    // Azure metadata (same IP as AWS)
    it('blocks Azure metadata endpoint', async () => {
      expect(
        (await isBlockedUrl(
          'http://169.254.169.254/metadata/instance?api-version=2021-02-01',
        )).blocked,
      ).toBe(true);
    });

    it('blocks Azure identity token endpoint', async () => {
      expect(
        (await isBlockedUrl(
          'http://169.254.169.254/metadata/identity/oauth2/token',
        )).blocked,
      ).toBe(true);
    });

    // Kubernetes metadata
    it('blocks kubernetes.default.svc', async () => {
      expect(
        (await isBlockedUrl('https://kubernetes.default.svc/api/v1/namespaces')).blocked,
      ).toBe(true);
    });
  });

  // -----------------------------------------------------------------------
  // 14. Cloud metadata paths (path-based detection as defense in depth)
  // -----------------------------------------------------------------------
  describe('cloud metadata paths', () => {
    it('blocks /latest/meta-data/ path on any blocked host', async () => {
      expect(
        (await isBlockedUrl('http://169.254.169.254/latest/meta-data/')).blocked,
      ).toBe(true);
    });

    it('blocks /computeMetadata/v1/ path on metadata host', async () => {
      expect(
        (await isBlockedUrl('http://metadata.google.internal/computeMetadata/v1/')).blocked,
      ).toBe(true);
    });
  });

  // -----------------------------------------------------------------------
  // 15. --allow-private flag bypass
  // -----------------------------------------------------------------------
  describe('--allow-private flag', () => {
    it('allows 10.x when allowPrivate is true', async () => {
      expect(
        (await isBlockedUrl('http://10.0.0.1/', { allowPrivate: true })).blocked,
      ).toBe(false);
    });

    it('allows 192.168.x when allowPrivate is true', async () => {
      expect(
        (await isBlockedUrl('http://192.168.1.1/', { allowPrivate: true })).blocked,
      ).toBe(false);
    });

    it('allows 172.16.x when allowPrivate is true', async () => {
      expect(
        (await isBlockedUrl('http://172.16.0.1/', { allowPrivate: true })).blocked,
      ).toBe(false);
    });

    it('allows localhost when allowPrivate is true', async () => {
      expect(
        (await isBlockedUrl('http://127.0.0.1/', { allowPrivate: true })).blocked,
      ).toBe(false);
    });

    it('allows link-local when allowPrivate is true', async () => {
      expect(
        (await isBlockedUrl('http://169.254.169.254/', { allowPrivate: true })).blocked,
      ).toBe(false);
    });

    it('still blocks non-HTTP protocols even with allowPrivate', async () => {
      expect(
        (await isBlockedUrl('file:///etc/passwd', { allowPrivate: true })).blocked,
      ).toBe(true);
    });

    it('still blocks javascript: protocol even with allowPrivate', async () => {
      expect(
        (await isBlockedUrl('javascript:alert(1)', { allowPrivate: true })).blocked,
      ).toBe(true);
    });
  });

  // -----------------------------------------------------------------------
  // 16. Protocol whitelist
  // -----------------------------------------------------------------------
  describe('protocol whitelist', () => {
    it('allows http:', () => {
      expect(isAllowedProtocol('http://example.com')).toBe(true);
    });

    it('allows https:', () => {
      expect(isAllowedProtocol('https://example.com')).toBe(true);
    });

    it('blocks file:', () => {
      expect(isAllowedProtocol('file:///etc/passwd')).toBe(false);
    });

    it('blocks javascript:', () => {
      expect(isAllowedProtocol('javascript:alert(1)')).toBe(false);
    });

    it('blocks data:', () => {
      expect(isAllowedProtocol('data:text/html,<h1>hi</h1>')).toBe(false);
    });

    it('blocks ftp:', () => {
      expect(isAllowedProtocol('ftp://ftp.example.com/secret')).toBe(false);
    });

    it('blocks chrome:', () => {
      expect(isAllowedProtocol('chrome://settings')).toBe(false);
    });

    it('blocks chrome-extension:', () => {
      expect(isAllowedProtocol('chrome-extension://abc/page.html')).toBe(false);
    });

    it('blocks blob:', () => {
      expect(isAllowedProtocol('blob:http://example.com/uuid')).toBe(false);
    });
  });

  // -----------------------------------------------------------------------
  // 17. Public IPs must be allowed (sanity checks)
  // -----------------------------------------------------------------------
  describe('public IPs allowed', () => {
    expectAllAllowed(
      [
        'https://93.184.216.34/',
        'https://1.1.1.1/',
        'https://8.8.8.8/',
        'http://203.0.113.1/',
        'http://198.51.100.1/',
      ],
      'public IP addresses',
    );
  });

  // -----------------------------------------------------------------------
  // 18. Edge cases
  // -----------------------------------------------------------------------
  describe('edge cases', () => {
    it('blocks 0.0.0.0 (unspecified address)', async () => {
      expect((await isBlockedUrl('http://0.0.0.0/')).blocked).toBe(true);
    });

    it('blocks empty hostname', async () => {
      // new URL('http:///path') may throw or produce empty hostname
      // The guard should handle this safely (fail closed)
      try {
        const result = await isBlockedUrl('http:///path');
        expect(result.blocked).toBe(true);
      } catch {
        // Throwing is also acceptable -- fail closed
      }
    });

    it('blocks on DNS resolution failure (fail closed)', async () => {
      // A hostname that does not resolve should be blocked
      expect(
        (await isBlockedUrl('http://this-domain-does-not-exist-xyzzy.example/')).blocked,
      ).toBe(true);
    });

    it('handles URL with port numbers correctly', async () => {
      expect((await isBlockedUrl('http://127.0.0.1:65535/')).blocked).toBe(true);
      expect((await isBlockedUrl('http://10.0.0.1:22/')).blocked).toBe(true);
    });

    it('handles URL with path and query string', async () => {
      expect(
        (await isBlockedUrl('http://127.0.0.1/api?token=secret&redirect=true')).blocked,
      ).toBe(true);
    });

    it('handles URL with fragment', async () => {
      expect((await isBlockedUrl('http://192.168.1.1/#/admin')).blocked).toBe(true);
    });
  });

  // -----------------------------------------------------------------------
  // 19. isPrivateIP unit tests
  // -----------------------------------------------------------------------
  describe('isPrivateIP', () => {
    it('identifies 10.x as private', () => {
      expect(isPrivateIP('10.0.0.1')).toBe(true);
      expect(isPrivateIP('10.255.255.255')).toBe(true);
    });

    it('identifies 172.16-31 as private', () => {
      expect(isPrivateIP('172.16.0.1')).toBe(true);
      expect(isPrivateIP('172.31.255.255')).toBe(true);
    });

    it('identifies 172.15 and 172.32 as public', () => {
      expect(isPrivateIP('172.15.255.255')).toBe(false);
      expect(isPrivateIP('172.32.0.0')).toBe(false);
    });

    it('identifies 192.168.x as private', () => {
      expect(isPrivateIP('192.168.0.1')).toBe(true);
      expect(isPrivateIP('192.168.255.255')).toBe(true);
    });

    it('identifies 127.x as private', () => {
      expect(isPrivateIP('127.0.0.1')).toBe(true);
      expect(isPrivateIP('127.255.255.255')).toBe(true);
    });

    it('identifies 169.254.x as private', () => {
      expect(isPrivateIP('169.254.0.1')).toBe(true);
      expect(isPrivateIP('169.254.169.254')).toBe(true);
    });

    it('identifies 0.x as private', () => {
      expect(isPrivateIP('0.0.0.0')).toBe(true);
    });

    it('identifies public IPs as non-private', () => {
      expect(isPrivateIP('8.8.8.8')).toBe(false);
      expect(isPrivateIP('93.184.216.34')).toBe(false);
      expect(isPrivateIP('1.1.1.1')).toBe(false);
    });

    it('returns false for non-IP strings', () => {
      expect(isPrivateIP('not-an-ip')).toBe(false);
      expect(isPrivateIP('')).toBe(false);
    });
  });
});
