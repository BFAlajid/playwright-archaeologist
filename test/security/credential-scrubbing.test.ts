/**
 * Credential Scrubbing Tests
 *
 * Validates that all sensitive data (tokens, passwords, API keys, cookies,
 * credit card numbers, AWS keys) is redacted from output artifacts by default,
 * and that the --include-cookies opt-in correctly preserves cookie data.
 *
 * Threat references: T3.1 (Credentials in HAR), T5.1 (Cookie File Security),
 *                    T5.2 (Environment Variable Exposure)
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// The module under test -- src/security/credential-scrubber.ts
// Expected exports:
//   scrubHeaders(headers: Record<string, string>, opts?: { includeCookies?: boolean }): Record<string, string>
//   scrubResponseBody(body: string): string
//   scrubUrl(url: string): string
//   scrubEnvValues(text: string, envVars: string[]): string
import {
  scrubHeaders,
  scrubResponseBody,
  scrubUrl,
  scrubEnvValues,
} from '../../src/security/credential-scrubber.js';

// ===========================================================================
// 1. Authorization header scrubbing
// ===========================================================================
describe('Credential Scrubbing - Authorization Headers', () => {
  it('scrubs Authorization: Bearer <JWT>', () => {
    const headers = {
      Authorization:
        'Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIiwibmFtZSI6IkpvaG4gRG9lIiwiaWF0IjoxNTE2MjM5MDIyfQ.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c',
      'Content-Type': 'application/json',
    };

    const scrubbed = scrubHeaders(headers);
    expect(scrubbed.Authorization).toBe('[REDACTED]');
    expect(scrubbed['Content-Type']).toBe('application/json');
  });

  it('scrubs Authorization: Basic <base64>', () => {
    const headers = {
      Authorization: 'Basic dXNlcjpwYXNzd29yZA==',
    };

    const scrubbed = scrubHeaders(headers);
    expect(scrubbed.Authorization).toBe('[REDACTED]');
  });

  it('scrubs Authorization header regardless of case', () => {
    const headers = {
      authorization: 'Bearer token123',
      AUTHORIZATION: 'Basic abc123',
    };

    const scrubbed = scrubHeaders(headers);
    // Both case variants should be scrubbed
    for (const key of Object.keys(scrubbed)) {
      if (key.toLowerCase() === 'authorization') {
        expect(scrubbed[key]).toBe('[REDACTED]');
      }
    }
  });

  it('scrubs Proxy-Authorization header', () => {
    const headers = {
      'Proxy-Authorization': 'Basic cHJveHk6c2VjcmV0',
    };

    const scrubbed = scrubHeaders(headers);
    expect(scrubbed['Proxy-Authorization']).toBe('[REDACTED]');
  });
});

// ===========================================================================
// 2. Cookie header scrubbing
// ===========================================================================
describe('Credential Scrubbing - Cookie Headers', () => {
  it('scrubs Cookie header with session tokens', () => {
    const headers = {
      Cookie:
        'sessionid=abc123def456; csrftoken=xyz789; _ga=GA1.2.123456789.1234567890',
    };

    const scrubbed = scrubHeaders(headers);
    expect(scrubbed.Cookie).toBe('[REDACTED]');
  });

  it('scrubs Set-Cookie response header', () => {
    const headers = {
      'Set-Cookie':
        'session=abc123; Path=/; HttpOnly; Secure; SameSite=Strict',
    };

    const scrubbed = scrubHeaders(headers);
    expect(scrubbed['Set-Cookie']).toBe('[REDACTED]');
  });

  it('scrubs set-cookie with lowercase', () => {
    const headers = {
      'set-cookie':
        'token=eyJhbGciOiJIUzI1NiJ9.eyJ1c2VyIjoiYWRtaW4ifQ; Path=/',
    };

    const scrubbed = scrubHeaders(headers);
    expect(scrubbed['set-cookie']).toBe('[REDACTED]');
  });
});

// ===========================================================================
// 3. API key in query string
// ===========================================================================
describe('Credential Scrubbing - API Keys in URLs', () => {
  it('scrubs api_key parameter from query string', () => {
    const url = 'https://api.example.com/data?api_key=sk_live_abc123def456&page=1';
    const scrubbed = scrubUrl(url);
    expect(scrubbed).not.toContain('sk_live_abc123def456');
    expect(scrubbed).toContain('api_key=[REDACTED]');
    expect(scrubbed).toContain('page=1');
  });

  it('scrubs apiKey parameter from query string', () => {
    const url = 'https://api.example.com/data?apiKey=abc123&format=json';
    const scrubbed = scrubUrl(url);
    expect(scrubbed).not.toContain('abc123');
    expect(scrubbed).toContain('apiKey=[REDACTED]');
  });

  it('scrubs token parameter from query string', () => {
    const url = 'https://api.example.com/auth?token=eyJhbGciOiJIUzI1NiJ9&redirect=/';
    const scrubbed = scrubUrl(url);
    expect(scrubbed).not.toContain('eyJhbGciOiJIUzI1NiJ9');
    expect(scrubbed).toContain('token=[REDACTED]');
  });

  it('scrubs access_token parameter from query string', () => {
    const url = 'https://api.example.com/me?access_token=gho_abc123xyz789';
    const scrubbed = scrubUrl(url);
    expect(scrubbed).not.toContain('gho_abc123xyz789');
    expect(scrubbed).toContain('access_token=[REDACTED]');
  });

  it('scrubs key parameter from query string', () => {
    const url = 'https://maps.example.com/api?key=AIzaSyB1234567890&location=NYC';
    const scrubbed = scrubUrl(url);
    expect(scrubbed).not.toContain('AIzaSyB1234567890');
    expect(scrubbed).toContain('key=[REDACTED]');
  });

  it('scrubs secret parameter from query string', () => {
    const url = 'https://api.example.com/webhook?secret=whsec_abc123';
    const scrubbed = scrubUrl(url);
    expect(scrubbed).not.toContain('whsec_abc123');
  });
});

// ===========================================================================
// 4. API key in custom headers
// ===========================================================================
describe('Credential Scrubbing - API Key Headers', () => {
  it('scrubs X-API-Key header', () => {
    const headers = {
      'X-API-Key': 'sk_live_1234567890abcdef',
      'Content-Type': 'application/json',
    };

    const scrubbed = scrubHeaders(headers);
    expect(scrubbed['X-API-Key']).toBe('[REDACTED]');
    expect(scrubbed['Content-Type']).toBe('application/json');
  });

  it('scrubs X-Auth-Token header', () => {
    const headers = {
      'X-Auth-Token': 'some-secret-token-value',
    };

    const scrubbed = scrubHeaders(headers);
    expect(scrubbed['X-Auth-Token']).toBe('[REDACTED]');
  });

  it('scrubs X-Session-ID header', () => {
    const headers = {
      'X-Session-ID': 'sess_abc123def456',
    };

    const scrubbed = scrubHeaders(headers);
    expect(scrubbed['X-Session-ID']).toBe('[REDACTED]');
  });

  it('scrubs X-CSRF-Token header', () => {
    const headers = {
      'X-CSRF-Token': 'csrf_abc123',
    };

    const scrubbed = scrubHeaders(headers);
    expect(scrubbed['X-CSRF-Token']).toBe('[REDACTED]');
  });

  it('scrubs X-XSRF-Token header', () => {
    const headers = {
      'X-XSRF-Token': 'xsrf_abc123',
    };

    const scrubbed = scrubHeaders(headers);
    expect(scrubbed['X-XSRF-Token']).toBe('[REDACTED]');
  });
});

// ===========================================================================
// 5. OAuth token in URL fragment
// ===========================================================================
describe('Credential Scrubbing - OAuth Tokens', () => {
  it('scrubs access_token from URL fragment', () => {
    const url =
      'https://example.com/callback#access_token=ya29.abc123&token_type=bearer&expires_in=3600';
    const scrubbed = scrubUrl(url);
    expect(scrubbed).not.toContain('ya29.abc123');
  });

  it('scrubs id_token from URL fragment', () => {
    const url =
      'https://example.com/callback#id_token=eyJhbGciOiJSUzI1NiJ9.abc.def';
    const scrubbed = scrubUrl(url);
    expect(scrubbed).not.toContain('eyJhbGciOiJSUzI1NiJ9');
  });
});

// ===========================================================================
// 6. Password in POST body (form-encoded)
// ===========================================================================
describe('Credential Scrubbing - Form-Encoded Bodies', () => {
  it('scrubs password field from form-encoded body', () => {
    const body = 'username=admin&password=s3cr3t%21&remember=true';
    const scrubbed = scrubResponseBody(body);
    expect(scrubbed).not.toContain('s3cr3t%21');
    expect(scrubbed).toContain('username=admin');
  });

  it('scrubs passwd field from form-encoded body', () => {
    const body = 'user=admin&passwd=mysecretpw';
    const scrubbed = scrubResponseBody(body);
    expect(scrubbed).not.toContain('mysecretpw');
  });
});

// ===========================================================================
// 7. Password in JSON body
// ===========================================================================
describe('Credential Scrubbing - JSON Bodies', () => {
  it('scrubs password field from JSON body', () => {
    const body = '{"username":"admin","password":"s3cr3t!","remember":true}';
    const scrubbed = scrubResponseBody(body);
    expect(scrubbed).not.toContain('s3cr3t!');
    expect(scrubbed).toContain('"username":"admin"');
    expect(scrubbed).toContain('[REDACTED]');
  });

  it('scrubs secret field from JSON body', () => {
    const body = '{"client_id":"abc","secret":"my-client-secret"}';
    const scrubbed = scrubResponseBody(body);
    expect(scrubbed).not.toContain('my-client-secret');
    expect(scrubbed).toContain('[REDACTED]');
  });

  it('scrubs token field from JSON body', () => {
    const body = '{"token":"eyJhbGciOiJIUzI1NiJ9.abc.def","user_id":123}';
    const scrubbed = scrubResponseBody(body);
    expect(scrubbed).not.toContain('eyJhbGciOiJIUzI1NiJ9');
    expect(scrubbed).toContain('[REDACTED]');
  });

  it('scrubs apiKey field from JSON body', () => {
    const body = '{"apiKey":"sk_live_1234567890","data":"public"}';
    const scrubbed = scrubResponseBody(body);
    expect(scrubbed).not.toContain('sk_live_1234567890');
  });

  it('scrubs api_key field from JSON body', () => {
    const body = '{"api_key":"sk_test_abc123","status":"active"}';
    const scrubbed = scrubResponseBody(body);
    expect(scrubbed).not.toContain('sk_test_abc123');
  });

  it('scrubs access_token field from JSON body', () => {
    const body = '{"access_token":"gho_abc123","scope":"repo"}';
    const scrubbed = scrubResponseBody(body);
    expect(scrubbed).not.toContain('gho_abc123');
  });

  it('scrubs refresh_token field from JSON body', () => {
    const body = '{"refresh_token":"rt_abc123","expires_in":86400}';
    const scrubbed = scrubResponseBody(body);
    expect(scrubbed).not.toContain('rt_abc123');
  });

  it('scrubs nested password fields', () => {
    const body =
      '{"user":{"email":"test@example.com","password":"nested-secret"}}';
    const scrubbed = scrubResponseBody(body);
    expect(scrubbed).not.toContain('nested-secret');
  });
});

// ===========================================================================
// 8. Credit card pattern detection
// ===========================================================================
describe('Credential Scrubbing - Credit Card Patterns', () => {
  it('scrubs Visa card numbers', () => {
    const body = '{"card_number":"4111111111111111","expiry":"12/26"}';
    const scrubbed = scrubResponseBody(body);
    expect(scrubbed).not.toContain('4111111111111111');
  });

  it('scrubs Mastercard numbers', () => {
    const body = '{"card":"5500000000000004","cvv":"123"}';
    const scrubbed = scrubResponseBody(body);
    expect(scrubbed).not.toContain('5500000000000004');
  });

  it('scrubs card numbers with spaces', () => {
    const body = 'Card: 4111 1111 1111 1111';
    const scrubbed = scrubResponseBody(body);
    expect(scrubbed).not.toContain('4111 1111 1111 1111');
  });

  it('scrubs card numbers with dashes', () => {
    const body = 'Card: 4111-1111-1111-1111';
    const scrubbed = scrubResponseBody(body);
    expect(scrubbed).not.toContain('4111-1111-1111-1111');
  });
});

// ===========================================================================
// 9. AWS access key patterns
// ===========================================================================
describe('Credential Scrubbing - AWS Keys', () => {
  it('scrubs AWS Access Key ID (AKIA...)', () => {
    const body = '{"aws_access_key":"AKIAIOSFODNN7EXAMPLE","region":"us-east-1"}';
    const scrubbed = scrubResponseBody(body);
    expect(scrubbed).not.toContain('AKIAIOSFODNN7EXAMPLE');
  });

  it('scrubs AWS Access Key ID in plain text', () => {
    const body = 'AccessKeyId: AKIAIOSFODNN7EXAMPLE';
    const scrubbed = scrubResponseBody(body);
    expect(scrubbed).not.toContain('AKIAIOSFODNN7EXAMPLE');
  });

  it('scrubs AWS Secret Access Key pattern', () => {
    const body =
      '{"aws_secret_key":"wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY"}';
    const scrubbed = scrubResponseBody(body);
    expect(scrubbed).not.toContain('wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY');
  });

  it('scrubs AWS session token', () => {
    const body =
      '{"SessionToken":"FwoGZXIvYXdzEBYaDH4xmZ3abc123=="}';
    const scrubbed = scrubResponseBody(body);
    // SessionToken should be caught by the token field scrubber
    expect(scrubbed).not.toContain('FwoGZXIvYXdzEBYaDH4xmZ3abc123==');
  });
});

// ===========================================================================
// 10. Environment variable scrubbing
// ===========================================================================
describe('Credential Scrubbing - Environment Variables', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    process.env = { ...originalEnv };
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  it('scrubs known environment variable values from text', () => {
    process.env.APP_SECRET = 'my-super-secret-value-12345';
    const text = 'Error: connection failed with token my-super-secret-value-12345';
    const scrubbed = scrubEnvValues(text, ['APP_SECRET']);
    expect(scrubbed).not.toContain('my-super-secret-value-12345');
    expect(scrubbed).toContain('[ENV:APP_SECRET]');
  });

  it('does not scrub short environment variable values (avoids false positives)', () => {
    process.env.SHORT_VAR = '1';
    const text = 'Found 1 result in 1 second';
    const scrubbed = scrubEnvValues(text, ['SHORT_VAR']);
    // Short values (<=3 chars) should not be scrubbed to avoid mangling output
    expect(scrubbed).toBe(text);
  });

  it('scrubs multiple environment variable values', () => {
    process.env.DB_PASSWORD = 'db-pass-xyz789';
    process.env.API_KEY = 'key-abc123';
    const text = 'Connected with db-pass-xyz789, API key: key-abc123';
    const scrubbed = scrubEnvValues(text, ['DB_PASSWORD', 'API_KEY']);
    expect(scrubbed).not.toContain('db-pass-xyz789');
    expect(scrubbed).not.toContain('key-abc123');
  });

  it('handles undefined environment variables gracefully', () => {
    delete process.env.NONEXISTENT;
    const text = 'Some log output here';
    const scrubbed = scrubEnvValues(text, ['NONEXISTENT']);
    expect(scrubbed).toBe(text);
  });
});

// ===========================================================================
// 11. --include-cookies opt-in
// ===========================================================================
describe('Credential Scrubbing - --include-cookies Flag', () => {
  it('preserves Cookie header when includeCookies is true', () => {
    const headers = {
      Cookie: 'session=abc123; theme=dark',
      'Content-Type': 'text/html',
    };

    const scrubbed = scrubHeaders(headers, { includeCookies: true });
    expect(scrubbed.Cookie).toBe('session=abc123; theme=dark');
    expect(scrubbed['Content-Type']).toBe('text/html');
  });

  it('preserves Set-Cookie header when includeCookies is true', () => {
    const headers = {
      'Set-Cookie': 'session=abc123; Path=/; HttpOnly',
    };

    const scrubbed = scrubHeaders(headers, { includeCookies: true });
    expect(scrubbed['Set-Cookie']).toBe('session=abc123; Path=/; HttpOnly');
  });

  it('still scrubs Authorization even when includeCookies is true', () => {
    const headers = {
      Authorization: 'Bearer secret-token',
      Cookie: 'session=abc123',
    };

    const scrubbed = scrubHeaders(headers, { includeCookies: true });
    expect(scrubbed.Authorization).toBe('[REDACTED]');
    expect(scrubbed.Cookie).toBe('session=abc123');
  });

  it('still scrubs X-API-Key even when includeCookies is true', () => {
    const headers = {
      'X-API-Key': 'secret-api-key',
      Cookie: 'session=abc123',
    };

    const scrubbed = scrubHeaders(headers, { includeCookies: true });
    expect(scrubbed['X-API-Key']).toBe('[REDACTED]');
    expect(scrubbed.Cookie).toBe('session=abc123');
  });
});

// ===========================================================================
// 12. Non-sensitive data preservation
// ===========================================================================
describe('Credential Scrubbing - Non-Sensitive Data Preservation', () => {
  it('does not corrupt Content-Type header', () => {
    const headers = {
      'Content-Type': 'application/json; charset=utf-8',
      'Content-Length': '1234',
      Accept: 'text/html',
    };

    const scrubbed = scrubHeaders(headers);
    expect(scrubbed['Content-Type']).toBe('application/json; charset=utf-8');
    expect(scrubbed['Content-Length']).toBe('1234');
    expect(scrubbed.Accept).toBe('text/html');
  });

  it('does not corrupt Cache-Control header', () => {
    const headers = {
      'Cache-Control': 'no-cache, no-store, must-revalidate',
    };

    const scrubbed = scrubHeaders(headers);
    expect(scrubbed['Cache-Control']).toBe(
      'no-cache, no-store, must-revalidate',
    );
  });

  it('does not corrupt status-related headers', () => {
    const headers = {
      'X-Request-ID': 'req-123456',
      'X-RateLimit-Remaining': '99',
    };

    const scrubbed = scrubHeaders(headers);
    expect(scrubbed['X-Request-ID']).toBe('req-123456');
    expect(scrubbed['X-RateLimit-Remaining']).toBe('99');
  });

  it('does not alter non-sensitive JSON body content', () => {
    const body = '{"id":1,"name":"John","email":"john@example.com","role":"admin"}';
    const scrubbed = scrubResponseBody(body);
    expect(scrubbed).toContain('"id":1');
    expect(scrubbed).toContain('"name":"John"');
    expect(scrubbed).toContain('"email":"john@example.com"');
    expect(scrubbed).toContain('"role":"admin"');
  });

  it('does not alter plain text content without sensitive patterns', () => {
    const body = 'Welcome to the dashboard. You have 5 notifications.';
    const scrubbed = scrubResponseBody(body);
    expect(scrubbed).toBe(body);
  });

  it('preserves URL structure while scrubbing sensitive params', () => {
    const url =
      'https://api.example.com/v2/users?page=1&limit=20&sort=name&api_key=secret123';
    const scrubbed = scrubUrl(url);
    expect(scrubbed).toContain('https://api.example.com/v2/users');
    expect(scrubbed).toContain('page=1');
    expect(scrubbed).toContain('limit=20');
    expect(scrubbed).toContain('sort=name');
    expect(scrubbed).not.toContain('secret123');
  });
});

// ===========================================================================
// 13. Edge cases
// ===========================================================================
describe('Credential Scrubbing - Edge Cases', () => {
  it('handles empty headers object', () => {
    const scrubbed = scrubHeaders({});
    expect(scrubbed).toEqual({});
  });

  it('handles empty body string', () => {
    const scrubbed = scrubResponseBody('');
    expect(scrubbed).toBe('');
  });

  it('handles URL with no query parameters', () => {
    const url = 'https://example.com/api/users';
    const scrubbed = scrubUrl(url);
    expect(scrubbed).toBe(url);
  });

  it('handles malformed JSON gracefully', () => {
    const body = '{"password": "secret", invalid json here';
    // Should still attempt to scrub even if JSON is malformed
    const scrubbed = scrubResponseBody(body);
    expect(scrubbed).not.toContain('"secret"');
  });

  it('handles binary-like content without crashing', () => {
    const body = '\x00\x01\x02\x03\x04\x05';
    const scrubbed = scrubResponseBody(body);
    expect(typeof scrubbed).toBe('string');
  });

  it('handles headers with empty values', () => {
    const headers = {
      Authorization: '',
      Cookie: '',
      'Content-Type': 'text/html',
    };

    const scrubbed = scrubHeaders(headers);
    // Even empty auth/cookie headers should be redacted for consistency
    expect(scrubbed.Authorization).toBe('[REDACTED]');
    expect(scrubbed['Content-Type']).toBe('text/html');
  });
});
