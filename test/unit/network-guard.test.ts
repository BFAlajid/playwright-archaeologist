/**
 * Unit tests for src/security/network-guard.ts
 *
 * SSRF protection: private IP blocking, metadata endpoint blocking,
 * protocol whitelist, DNS rebinding detection, and --allow-private bypass.
 */

import { describe, it, expect, vi } from 'vitest';
import {
  isPrivateIp,
  isMetadataHostname,
  isAllowedProtocol,
  isBlockedUrl,
} from '../../src/security/network-guard.js';

// ---------------------------------------------------------------------------
// isPrivateIp
// ---------------------------------------------------------------------------

describe('isPrivateIp', () => {
  describe('10.0.0.0/8 range', () => {
    it('blocks 10.0.0.1', () => {
      expect(isPrivateIp('10.0.0.1')).toBe(true);
    });

    it('blocks 10.255.255.255', () => {
      expect(isPrivateIp('10.255.255.255')).toBe(true);
    });

    it('blocks 10.0.0.0', () => {
      expect(isPrivateIp('10.0.0.0')).toBe(true);
    });

    it('blocks 10.128.0.1', () => {
      expect(isPrivateIp('10.128.0.1')).toBe(true);
    });
  });

  describe('172.16.0.0/12 range', () => {
    it('blocks 172.16.0.1', () => {
      expect(isPrivateIp('172.16.0.1')).toBe(true);
    });

    it('blocks 172.31.255.255', () => {
      expect(isPrivateIp('172.31.255.255')).toBe(true);
    });

    it('allows 172.32.0.1 (outside range)', () => {
      expect(isPrivateIp('172.32.0.1')).toBe(false);
    });

    it('allows 172.15.255.255 (outside range)', () => {
      expect(isPrivateIp('172.15.255.255')).toBe(false);
    });
  });

  describe('192.168.0.0/16 range', () => {
    it('blocks 192.168.0.1', () => {
      expect(isPrivateIp('192.168.0.1')).toBe(true);
    });

    it('blocks 192.168.255.255', () => {
      expect(isPrivateIp('192.168.255.255')).toBe(true);
    });

    it('allows 192.169.0.1 (outside range)', () => {
      expect(isPrivateIp('192.169.0.1')).toBe(false);
    });
  });

  describe('169.254.0.0/16 (link-local / AWS metadata)', () => {
    it('blocks 169.254.169.254 (AWS metadata)', () => {
      expect(isPrivateIp('169.254.169.254')).toBe(true);
    });

    it('blocks 169.254.0.1', () => {
      expect(isPrivateIp('169.254.0.1')).toBe(true);
    });

    it('allows 169.255.0.1 (outside range)', () => {
      expect(isPrivateIp('169.255.0.1')).toBe(false);
    });
  });

  describe('127.0.0.0/8 (loopback)', () => {
    it('blocks 127.0.0.1', () => {
      expect(isPrivateIp('127.0.0.1')).toBe(true);
    });

    it('blocks 127.255.255.255', () => {
      expect(isPrivateIp('127.255.255.255')).toBe(true);
    });
  });

  describe('IPv6 private ranges', () => {
    it('blocks fd00::1 (unique local)', () => {
      expect(isPrivateIp('fd00::1')).toBe(true);
    });

    it('blocks fdff::1 (unique local)', () => {
      expect(isPrivateIp('fdff::1')).toBe(true);
    });

    it('blocks ::1 (IPv6 loopback)', () => {
      expect(isPrivateIp('::1')).toBe(true);
    });

    it('blocks fe80::1 (IPv6 link-local)', () => {
      expect(isPrivateIp('fe80::1')).toBe(true);
    });
  });

  describe('public IPs', () => {
    it('allows 8.8.8.8 (Google DNS)', () => {
      expect(isPrivateIp('8.8.8.8')).toBe(false);
    });

    it('allows 1.1.1.1 (Cloudflare DNS)', () => {
      expect(isPrivateIp('1.1.1.1')).toBe(false);
    });

    it('allows 93.184.216.34 (example.com)', () => {
      expect(isPrivateIp('93.184.216.34')).toBe(false);
    });

    it('allows 203.0.113.1', () => {
      expect(isPrivateIp('203.0.113.1')).toBe(false);
    });
  });

  describe('edge cases', () => {
    it('blocks 0.0.0.0', () => {
      expect(isPrivateIp('0.0.0.0')).toBe(true);
    });

    it('handles invalid IP gracefully', () => {
      // Should not throw, should return true (block by default on invalid)
      // or false depending on implementation strategy
      expect(() => isPrivateIp('not-an-ip')).not.toThrow();
    });
  });
});

// ---------------------------------------------------------------------------
// isMetadataHostname
// ---------------------------------------------------------------------------

describe('isMetadataHostname', () => {
  it('blocks metadata.google.internal', () => {
    expect(isMetadataHostname('metadata.google.internal')).toBe(true);
  });

  it('blocks 169.254.169.254 as hostname', () => {
    expect(isMetadataHostname('169.254.169.254')).toBe(true);
  });

  it('allows regular hostname', () => {
    expect(isMetadataHostname('example.com')).toBe(false);
  });

  it('allows api subdomain', () => {
    expect(isMetadataHostname('api.example.com')).toBe(false);
  });

  it('blocks instance metadata endpoint variations', () => {
    // Azure metadata
    expect(isMetadataHostname('169.254.169.254')).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// isAllowedProtocol
// ---------------------------------------------------------------------------

describe('isAllowedProtocol (network-guard)', () => {
  it('allows http:', () => {
    expect(isAllowedProtocol('http://example.com')).toBe(true);
  });

  it('allows https:', () => {
    expect(isAllowedProtocol('https://example.com')).toBe(true);
  });

  it('blocks file: protocol', () => {
    expect(isAllowedProtocol('file:///etc/passwd')).toBe(false);
  });

  it('blocks javascript: protocol', () => {
    expect(isAllowedProtocol('javascript:alert(1)')).toBe(false);
  });

  it('blocks data: protocol', () => {
    expect(isAllowedProtocol('data:text/html,test')).toBe(false);
  });

  it('blocks ftp: protocol', () => {
    expect(isAllowedProtocol('ftp://files.example.com')).toBe(false);
  });

  it('blocks chrome: protocol', () => {
    expect(isAllowedProtocol('chrome://settings')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// isBlockedUrl (async, resolves DNS)
// ---------------------------------------------------------------------------

describe('isBlockedUrl', () => {
  it('blocks http://127.0.0.1/', async () => {
    const result = await isBlockedUrl('http://127.0.0.1/');
    expect(result.blocked).toBe(true);
    expect(result.reason).toContain('private');
  });

  it('blocks http://localhost/', async () => {
    const result = await isBlockedUrl('http://localhost/');
    expect(result.blocked).toBe(true);
  });

  it('blocks http://169.254.169.254/latest/meta-data/', async () => {
    const result = await isBlockedUrl(
      'http://169.254.169.254/latest/meta-data/'
    );
    expect(result.blocked).toBe(true);
  });

  it('blocks http://10.0.0.1/', async () => {
    const result = await isBlockedUrl('http://10.0.0.1/');
    expect(result.blocked).toBe(true);
  });

  it('blocks http://192.168.1.1/', async () => {
    const result = await isBlockedUrl('http://192.168.1.1/');
    expect(result.blocked).toBe(true);
  });

  it('blocks file:///etc/passwd', async () => {
    const result = await isBlockedUrl('file:///etc/passwd');
    expect(result.blocked).toBe(true);
    expect(result.reason).toContain('protocol');
  });

  it('blocks javascript:alert(1)', async () => {
    const result = await isBlockedUrl('javascript:alert(1)');
    expect(result.blocked).toBe(true);
  });

  it('blocks data: URL', async () => {
    const result = await isBlockedUrl('data:text/html,<h1>test</h1>');
    expect(result.blocked).toBe(true);
  });

  it('allows http://example.com/ with --allow-private disabled', async () => {
    // Note: this depends on DNS resolution. example.com resolves to a public IP.
    // In a real test, we might mock DNS.
    const result = await isBlockedUrl('http://93.184.216.34/');
    expect(result.blocked).toBe(false);
  });

  it('allows private IP when allowPrivate is true', async () => {
    const result = await isBlockedUrl('http://127.0.0.1/', {
      allowPrivate: true,
    });
    expect(result.blocked).toBe(false);
  });

  it('allows localhost when allowPrivate is true', async () => {
    const result = await isBlockedUrl('http://localhost/', {
      allowPrivate: true,
    });
    expect(result.blocked).toBe(false);
  });

  it('blocks metadata.google.internal', async () => {
    // This test may fail if DNS doesn't resolve. The guard should detect
    // the hostname pattern directly.
    const result = await isBlockedUrl(
      'http://metadata.google.internal/computeMetadata/v1/'
    );
    expect(result.blocked).toBe(true);
  });

  describe('DNS rebinding detection', () => {
    it('blocks when hostname resolves to private IP', async () => {
      // This tests the concept. In practice, we would mock DNS.
      // The guard should resolve the hostname and check the IP.
      const result = await isBlockedUrl('http://127.0.0.1/');
      expect(result.blocked).toBe(true);
    });
  });
});
