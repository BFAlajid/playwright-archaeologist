/**
 * Unit tests for src/security/har-scrubber.ts
 *
 * Verifies that HAR files written by Playwright are scrubbed in place:
 * sensitive request/response headers, postData bodies, response bodies,
 * and URLs have credentials redacted. The rewrite is atomic (temp + rename).
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { scrubHarFile } from '../../src/security/har-scrubber.js';

let testDir: string;

beforeEach(async () => {
  testDir = await mkdtemp(join(tmpdir(), 'pa-harscrub-'));
});

afterEach(async () => {
  await rm(testDir, { recursive: true, force: true });
});

function writeHar(content: unknown): Promise<string> {
  const path = join(testDir, 'crawl.har');
  return writeFile(path, JSON.stringify(content), 'utf-8').then(() => path);
}

describe('scrubHarFile', () => {
  it('redacts Authorization header in request', async () => {
    const harPath = await writeHar({
      log: {
        entries: [
          {
            request: {
              url: 'https://api.example.com/me',
              headers: [
                { name: 'Authorization', value: 'Bearer eyJabc.def.ghi' },
                { name: 'User-Agent', value: 'pa/1.0' },
              ],
            },
            response: {
              headers: [],
            },
          },
        ],
      },
    });

    await scrubHarFile(harPath);

    const raw = await readFile(harPath, 'utf-8');
    const parsed = JSON.parse(raw);
    const reqHeaders = parsed.log.entries[0].request.headers;
    const auth = reqHeaders.find((h: any) => h.name === 'Authorization');
    const ua = reqHeaders.find((h: any) => h.name === 'User-Agent');
    expect(auth.value).toBe('[REDACTED]');
    expect(ua.value).toBe('pa/1.0');
  });

  it('redacts Cookie and Set-Cookie by default', async () => {
    const harPath = await writeHar({
      log: {
        entries: [
          {
            request: {
              url: 'https://example.com/',
              headers: [{ name: 'Cookie', value: 'session=abc123' }],
            },
            response: {
              headers: [{ name: 'Set-Cookie', value: 'session=abc123; HttpOnly' }],
            },
          },
        ],
      },
    });

    await scrubHarFile(harPath);

    const parsed = JSON.parse(await readFile(harPath, 'utf-8'));
    const reqCookie = parsed.log.entries[0].request.headers[0];
    const setCookie = parsed.log.entries[0].response.headers[0];
    expect(reqCookie.value).toBe('[REDACTED]');
    expect(setCookie.value).toBe('[REDACTED]');
  });

  it('preserves Cookie when includeCookies is true', async () => {
    const harPath = await writeHar({
      log: {
        entries: [
          {
            request: {
              url: 'https://example.com/',
              headers: [{ name: 'Cookie', value: 'session=abc123' }],
            },
            response: { headers: [] },
          },
        ],
      },
    });

    await scrubHarFile(harPath, { includeCookies: true });

    const parsed = JSON.parse(await readFile(harPath, 'utf-8'));
    expect(parsed.log.entries[0].request.headers[0].value).toBe('session=abc123');
  });

  it('scrubs password field from postData.text JSON body', async () => {
    const harPath = await writeHar({
      log: {
        entries: [
          {
            request: {
              url: 'https://example.com/login',
              headers: [],
              postData: {
                mimeType: 'application/json',
                text: '{"user":"alice","password":"hunter2"}',
              },
            },
            response: { headers: [] },
          },
        ],
      },
    });

    await scrubHarFile(harPath);

    const parsed = JSON.parse(await readFile(harPath, 'utf-8'));
    const text: string = parsed.log.entries[0].request.postData.text;
    expect(text).not.toContain('hunter2');
    expect(text).toContain('[REDACTED]');
  });

  it('scrubs sensitive query params in request URL', async () => {
    const harPath = await writeHar({
      log: {
        entries: [
          {
            request: {
              url: 'https://example.com/?access_token=secret123&x=1',
              headers: [],
            },
            response: { headers: [] },
          },
        ],
      },
    });

    await scrubHarFile(harPath);

    const parsed = JSON.parse(await readFile(harPath, 'utf-8'));
    const url: string = parsed.log.entries[0].request.url;
    expect(url).not.toContain('secret123');
    expect(url).toContain('[REDACTED]');
    expect(url).toContain('x=1');
  });

  it('scrubs response body text when present', async () => {
    const harPath = await writeHar({
      log: {
        entries: [
          {
            request: {
              url: 'https://example.com/token',
              headers: [],
            },
            response: {
              headers: [],
              content: {
                mimeType: 'application/json',
                text: '{"access_token":"topsecret","ttl":3600}',
              },
            },
          },
        ],
      },
    });

    await scrubHarFile(harPath);

    const parsed = JSON.parse(await readFile(harPath, 'utf-8'));
    const body: string = parsed.log.entries[0].response.content.text;
    expect(body).not.toContain('topsecret');
    expect(body).toContain('[REDACTED]');
    expect(body).toContain('3600');
  });

  it('leaves base64-encoded response content untouched', async () => {
    // Base64 bodies can contain apparent JWT/card strings that would trigger
    // the scrubber's text regex. We skip them entirely.
    const harPath = await writeHar({
      log: {
        entries: [
          {
            request: { url: 'https://example.com/img', headers: [] },
            response: {
              headers: [],
              content: {
                mimeType: 'image/png',
                encoding: 'base64',
                text: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=',
              },
            },
          },
        ],
      },
    });

    await scrubHarFile(harPath);

    const parsed = JSON.parse(await readFile(harPath, 'utf-8'));
    expect(parsed.log.entries[0].response.content.text).toBe(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=',
    );
  });

  it('returns silently when the HAR file does not exist', async () => {
    // Must not throw — HAR is best-effort.
    await expect(
      scrubHarFile(join(testDir, 'nonexistent.har')),
    ).resolves.toBeUndefined();
  });

  it('returns silently when the file is not valid JSON', async () => {
    const harPath = join(testDir, 'crawl.har');
    await writeFile(harPath, 'not json', 'utf-8');
    await expect(scrubHarFile(harPath)).resolves.toBeUndefined();
    // The corrupt file should be left as-is (no overwrite).
    expect(await readFile(harPath, 'utf-8')).toBe('not json');
  });

  it('scrubs redirectURL', async () => {
    const harPath = await writeHar({
      log: {
        entries: [
          {
            request: { url: 'https://example.com/a', headers: [] },
            response: {
              headers: [],
              redirectURL: 'https://example.com/b?token=xyz',
            },
          },
        ],
      },
    });

    await scrubHarFile(harPath);

    const parsed = JSON.parse(await readFile(harPath, 'utf-8'));
    const redirect: string = parsed.log.entries[0].response.redirectURL;
    expect(redirect).not.toContain('xyz');
    expect(redirect).toContain('[REDACTED]');
  });
});
