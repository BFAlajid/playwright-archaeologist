/**
 * Unit tests for src/security/credential-scrubber.ts
 *
 * Credential scrubbing: header removal, URL parameter masking,
 * JWT detection, body field redaction, and opt-in cookie inclusion.
 */

import { describe, it, expect } from 'vitest';
import {
  scrubHeaders,
  scrubUrl,
  maskJwt,
  scrubBody,
  scrubRequest,
  type HeaderMap,
} from '../../src/security/credential-scrubber.js';

// ---------------------------------------------------------------------------
// scrubHeaders
// ---------------------------------------------------------------------------

describe('scrubHeaders', () => {
  it('redacts Authorization header', () => {
    const headers: HeaderMap = {
      Authorization: 'Bearer abc123',
      'Content-Type': 'application/json',
    };
    const result = scrubHeaders(headers);

    expect(result.Authorization).toBe('[REDACTED]');
    expect(result['Content-Type']).toBe('application/json');
  });

  it('redacts Cookie header by default', () => {
    const headers: HeaderMap = {
      Cookie: 'session=abc123; theme=dark',
      Accept: 'text/html',
    };
    const result = scrubHeaders(headers);

    expect(result.Cookie).toBe('[REDACTED]');
    expect(result.Accept).toBe('text/html');
  });

  it('redacts Set-Cookie response header', () => {
    const headers: HeaderMap = {
      'Set-Cookie': 'session=abc123; HttpOnly',
      'Content-Type': 'text/html',
    };
    const result = scrubHeaders(headers);

    expect(result['Set-Cookie']).toBe('[REDACTED]');
  });

  it('handles case-insensitive header names', () => {
    const headers: HeaderMap = {
      authorization: 'Bearer token',
      cookie: 'session=x',
      'set-cookie': 'sid=y',
    };
    const result = scrubHeaders(headers);

    expect(result.authorization).toBe('[REDACTED]');
    expect(result.cookie).toBe('[REDACTED]');
    expect(result['set-cookie']).toBe('[REDACTED]');
  });

  it('preserves Cookie when includeCookies is true', () => {
    const headers: HeaderMap = {
      Cookie: 'session=abc',
      Authorization: 'Bearer token',
    };
    const result = scrubHeaders(headers, { includeCookies: true });

    expect(result.Cookie).toBe('session=abc');
    // Authorization should still be scrubbed
    expect(result.Authorization).toBe('[REDACTED]');
  });

  it('preserves Set-Cookie when includeCookies is true', () => {
    const headers: HeaderMap = {
      'Set-Cookie': 'session=abc; HttpOnly',
    };
    const result = scrubHeaders(headers, { includeCookies: true });

    expect(result['Set-Cookie']).toBe('session=abc; HttpOnly');
  });

  it('returns empty object for empty headers', () => {
    expect(scrubHeaders({})).toEqual({});
  });

  it('preserves non-sensitive headers', () => {
    const headers: HeaderMap = {
      'Content-Type': 'application/json',
      Accept: 'text/html',
      'User-Agent': 'playwright-archaeologist/0.1.0',
      'Cache-Control': 'no-cache',
    };
    const result = scrubHeaders(headers);

    expect(result).toEqual(headers);
  });
});

// ---------------------------------------------------------------------------
// scrubUrl
// ---------------------------------------------------------------------------

describe('scrubUrl', () => {
  it('masks Bearer token in query parameter', () => {
    const url = 'https://api.example.com/data?token=eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.sig';
    const result = scrubUrl(url);

    expect(result).toContain('token=');
    expect(result).not.toContain('eyJhbGci');
    expect(result).toMatch(/token=\[REDACTED\]/);
  });

  it('masks api_key parameter', () => {
    const url = 'https://api.example.com/data?api_key=sk_live_12345';
    const result = scrubUrl(url);

    expect(result).not.toContain('sk_live_12345');
    expect(result).toMatch(/api_key=\[REDACTED\]/);
  });

  it('masks apiKey parameter', () => {
    const url = 'https://api.example.com/data?apiKey=secret123';
    const result = scrubUrl(url);

    expect(result).not.toContain('secret123');
  });

  it('masks access_token parameter', () => {
    const url = 'https://api.example.com/data?access_token=abc123def';
    const result = scrubUrl(url);

    expect(result).not.toContain('abc123def');
  });

  it('masks key parameter', () => {
    const url = 'https://api.example.com/maps?key=AIzaSyABC123';
    const result = scrubUrl(url);

    expect(result).not.toContain('AIzaSyABC123');
  });

  it('masks secret parameter', () => {
    const url = 'https://api.example.com/webhook?secret=whsec_123';
    const result = scrubUrl(url);

    expect(result).not.toContain('whsec_123');
  });

  it('masks password parameter', () => {
    const url = 'https://api.example.com/login?password=hunter2';
    const result = scrubUrl(url);

    expect(result).not.toContain('hunter2');
  });

  it('masks auth parameter', () => {
    const url = 'https://api.example.com/data?auth=mytoken';
    const result = scrubUrl(url);

    expect(result).not.toContain('mytoken');
  });

  it('preserves non-sensitive query parameters', () => {
    const url = 'https://api.example.com/search?q=cats&page=1';
    const result = scrubUrl(url);

    expect(result).toBe(url);
  });

  it('handles URL with no query parameters', () => {
    const url = 'https://api.example.com/data';
    expect(scrubUrl(url)).toBe(url);
  });

  it('handles multiple sensitive parameters', () => {
    const url =
      'https://api.example.com/data?token=abc&api_key=def&page=1';
    const result = scrubUrl(url);

    expect(result).not.toContain('abc');
    expect(result).not.toContain('def');
    expect(result).toContain('page=1');
  });
});

// ---------------------------------------------------------------------------
// maskJwt
// ---------------------------------------------------------------------------

describe('maskJwt', () => {
  it('masks a JWT token in a string', () => {
    const jwt =
      'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U';
    const result = maskJwt(`Bearer ${jwt}`);

    expect(result).not.toContain(jwt);
    expect(result).toContain('[JWT REDACTED]');
  });

  it('masks multiple JWTs in a string', () => {
    const jwt1 = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.sig1';
    const jwt2 = 'eyJhbGciOiJSUzI1NiJ9.eyJzdWIiOiIyIn0.sig2';
    const input = `token1=${jwt1}&token2=${jwt2}`;
    const result = maskJwt(input);

    expect(result).not.toContain(jwt1);
    expect(result).not.toContain(jwt2);
  });

  it('leaves non-JWT strings unchanged', () => {
    const input = 'Hello world, no tokens here';
    expect(maskJwt(input)).toBe(input);
  });

  it('detects JWT-like strings (starts with eyJ)', () => {
    const input = 'auth=eyJhbGciOiJIUzI1NiJ9.eyJ0ZXN0IjoxfQ.HMAC';
    const result = maskJwt(input);

    expect(result).not.toContain('eyJhbGci');
  });
});

// ---------------------------------------------------------------------------
// scrubBody
// ---------------------------------------------------------------------------

describe('scrubBody', () => {
  it('scrubs password fields in JSON body', () => {
    const body = JSON.stringify({
      username: 'admin',
      password: 'hunter2',
    });
    const result = scrubBody(body);
    const parsed = JSON.parse(result);

    expect(parsed.username).toBe('admin');
    expect(parsed.password).not.toBe('hunter2');
    expect(parsed.password).toMatch(/\[REDACTED\]/);
  });

  it('scrubs secret fields in JSON body', () => {
    const body = JSON.stringify({
      name: 'my-app',
      client_secret: 'very-secret-value',
    });
    const result = scrubBody(body);
    const parsed = JSON.parse(result);

    expect(parsed.name).toBe('my-app');
    expect(parsed.client_secret).toMatch(/\[REDACTED\]/);
  });

  it('scrubs token fields in JSON body', () => {
    const body = JSON.stringify({
      access_token: 'eyJhbGci...',
      refresh_token: 'rt_abc123',
    });
    const result = scrubBody(body);
    const parsed = JSON.parse(result);

    expect(parsed.access_token).toMatch(/\[REDACTED\]/);
    expect(parsed.refresh_token).toMatch(/\[REDACTED\]/);
  });

  it('scrubs apiKey fields in JSON body', () => {
    const body = JSON.stringify({
      apiKey: 'sk_live_abc',
      data: 'safe',
    });
    const result = scrubBody(body);
    const parsed = JSON.parse(result);

    expect(parsed.apiKey).toMatch(/\[REDACTED\]/);
    expect(parsed.data).toBe('safe');
  });

  it('handles URL-encoded form data with password', () => {
    const body = 'username=admin&password=hunter2&remember=true';
    const result = scrubBody(body);

    expect(result).not.toContain('hunter2');
    expect(result).toContain('username=admin');
  });

  it('handles non-JSON, non-form body (returns unchanged)', () => {
    const body = 'plain text body without secrets';
    expect(scrubBody(body)).toBe(body);
  });

  it('handles empty body', () => {
    expect(scrubBody('')).toBe('');
  });

  it('scrubs nested JSON fields', () => {
    const body = JSON.stringify({
      user: {
        email: 'user@example.com',
        credentials: {
          password: 'secret123',
          api_key: 'key_abc',
        },
      },
    });
    const result = scrubBody(body);
    const parsed = JSON.parse(result);

    expect(parsed.user.email).toBe('user@example.com');
    expect(parsed.user.credentials.password).toMatch(/\[REDACTED\]/);
    expect(parsed.user.credentials.api_key).toMatch(/\[REDACTED\]/);
  });
});

// ---------------------------------------------------------------------------
// scrubRequest (integration of all scrubbing)
// ---------------------------------------------------------------------------

describe('scrubRequest', () => {
  it('scrubs headers, URL, and body in a single pass', () => {
    const request = {
      url: 'https://api.example.com/users?token=secret123',
      headers: {
        Authorization: 'Bearer eyJhbGci.payload.sig',
        Cookie: 'session=abc',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ password: 'hunter2', name: 'test' }),
    };

    const result = scrubRequest(request);

    // URL scrubbed
    expect(result.url).not.toContain('secret123');
    // Headers scrubbed
    expect(result.headers.Authorization).toBe('[REDACTED]');
    expect(result.headers.Cookie).toBe('[REDACTED]');
    expect(result.headers['Content-Type']).toBe('application/json');
    // Body scrubbed
    const body = JSON.parse(result.body!);
    expect(body.password).toMatch(/\[REDACTED\]/);
    expect(body.name).toBe('test');
  });

  it('preserves cookies when includeCookies is true', () => {
    const request = {
      url: 'https://api.example.com/data',
      headers: {
        Cookie: 'session=abc',
        Authorization: 'Bearer token',
      },
    };

    const result = scrubRequest(request, { includeCookies: true });

    expect(result.headers.Cookie).toBe('session=abc');
    expect(result.headers.Authorization).toBe('[REDACTED]');
  });

  it('handles request without body', () => {
    const request = {
      url: 'https://api.example.com/data',
      headers: { Accept: 'application/json' },
    };

    const result = scrubRequest(request);
    expect(result.body).toBeUndefined();
  });
});
