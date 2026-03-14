/**
 * Unit tests for src/security/output-sanitizer.ts
 *
 * Output path sanitization: path traversal prevention, null bytes,
 * Windows reserved names, long filenames, Unicode filenames, and
 * URL-to-filename conversion.
 */

import { describe, it, expect } from 'vitest';
import { join, resolve, sep } from 'node:path';
import {
  sanitizeFilename,
  validateOutputPath,
  urlToFilename,
} from '../../src/security/output-sanitizer.js';

// ---------------------------------------------------------------------------
// sanitizeFilename
// ---------------------------------------------------------------------------

describe('sanitizeFilename', () => {
  describe('path traversal', () => {
    it('strips ../ sequences', () => {
      const result = sanitizeFilename('../../etc/passwd');
      expect(result).not.toContain('..');
      expect(result).not.toContain('/');
    });

    it('strips ..\\ sequences (Windows)', () => {
      const result = sanitizeFilename('..\\..\\windows\\system32');
      expect(result).not.toContain('..');
      expect(result).not.toContain('\\');
    });

    it('strips multiple path traversal variations', () => {
      const result = sanitizeFilename('./../.../../etc/passwd');
      expect(result).not.toContain('..');
    });

    it('strips encoded path traversal (%2e%2e%2f)', () => {
      const result = sanitizeFilename('%2e%2e%2fetc%2fpasswd');
      // After decoding, should still be safe
      expect(result).not.toContain('..');
    });
  });

  describe('null bytes', () => {
    it('strips null bytes from filename', () => {
      const result = sanitizeFilename('file\x00name.txt');
      expect(result).not.toContain('\x00');
      expect(result).toContain('file');
      expect(result).toContain('name');
    });

    it('strips null bytes at the end', () => {
      const result = sanitizeFilename('file.txt\x00.exe');
      expect(result).not.toContain('\x00');
    });
  });

  describe('Windows reserved names', () => {
    const reservedNames = [
      'CON', 'PRN', 'AUX', 'NUL',
      'COM1', 'COM2', 'COM3', 'COM4', 'COM5', 'COM6', 'COM7', 'COM8', 'COM9',
      'LPT1', 'LPT2', 'LPT3', 'LPT4', 'LPT5', 'LPT6', 'LPT7', 'LPT8', 'LPT9',
    ];

    for (const name of reservedNames) {
      it(`sanitizes Windows reserved name: ${name}`, () => {
        const result = sanitizeFilename(name);
        // Should either prefix, suffix, or replace the reserved name
        expect(result.toUpperCase()).not.toBe(name);
      });

      it(`sanitizes ${name} with extension`, () => {
        const result = sanitizeFilename(`${name}.txt`);
        // "CON.txt" is still reserved on Windows
        expect(result.toUpperCase().split('.')[0]).not.toBe(name);
      });
    }

    it('handles lowercase reserved names', () => {
      const result = sanitizeFilename('con');
      expect(result.toUpperCase()).not.toBe('CON');
    });
  });

  describe('very long filenames', () => {
    it('truncates filenames exceeding 255 characters', () => {
      const longName = 'a'.repeat(300);
      const result = sanitizeFilename(longName);
      expect(result.length).toBeLessThanOrEqual(255);
    });

    it('preserves file extension on truncation', () => {
      const longName = 'a'.repeat(300) + '.png';
      const result = sanitizeFilename(longName);
      expect(result).toMatch(/\.png$/);
      expect(result.length).toBeLessThanOrEqual(255);
    });
  });

  describe('Unicode filenames', () => {
    it('preserves safe Unicode characters', () => {
      const result = sanitizeFilename('cafe\u0301-menu');
      expect(result).toBeTruthy();
      expect(result.length).toBeGreaterThan(0);
    });

    it('handles CJK characters', () => {
      const result = sanitizeFilename('\u4F60\u597D-page');
      expect(result).toBeTruthy();
    });

    it('handles emoji in filenames', () => {
      const result = sanitizeFilename('\uD83D\uDE00-screenshot');
      expect(result).toBeTruthy();
    });
  });

  describe('special characters', () => {
    it('replaces forward slashes', () => {
      const result = sanitizeFilename('path/to/file');
      expect(result).not.toContain('/');
    });

    it('replaces backslashes', () => {
      const result = sanitizeFilename('path\\to\\file');
      expect(result).not.toContain('\\');
    });

    it('replaces colons', () => {
      const result = sanitizeFilename('https://example.com');
      expect(result).not.toContain(':');
    });

    it('handles empty string', () => {
      const result = sanitizeFilename('');
      expect(result).toBeTruthy(); // Should return a fallback name
    });

    it('handles string of only special characters', () => {
      const result = sanitizeFilename('///\\\\:::');
      expect(result).toBeTruthy(); // Should return a fallback name
    });
  });
});

// ---------------------------------------------------------------------------
// validateOutputPath
// ---------------------------------------------------------------------------

describe('validateOutputPath', () => {
  const outputDir = resolve('/tmp/archaeologist-output');

  it('accepts a path within the output directory', () => {
    const result = validateOutputPath('screenshots/home.png', outputDir);
    const resolved = resolve(outputDir, 'screenshots/home.png');
    expect(result).toBe(resolved);
  });

  it('rejects path traversal outside output directory', () => {
    expect(() =>
      validateOutputPath('../../etc/passwd', outputDir)
    ).toThrow();
  });

  it('rejects absolute path outside output directory', () => {
    expect(() =>
      validateOutputPath('/etc/passwd', outputDir)
    ).toThrow();
  });

  it('accepts nested path within output directory', () => {
    const result = validateOutputPath(
      'reports/2024/march/report.html',
      outputDir
    );
    expect(result).toContain(outputDir);
  });

  it('rejects path with null bytes', () => {
    expect(() =>
      validateOutputPath('file\x00.txt', outputDir)
    ).toThrow();
  });

  it('handles empty filename', () => {
    expect(() => validateOutputPath('', outputDir)).toThrow();
  });
});

// ---------------------------------------------------------------------------
// urlToFilename
// ---------------------------------------------------------------------------

describe('urlToFilename', () => {
  it('converts simple URL to filename', () => {
    const result = urlToFilename('https://example.com/about');
    expect(result).toBeTruthy();
    expect(result).not.toContain(':');
    expect(result).not.toContain('//');
  });

  it('handles root URL', () => {
    const result = urlToFilename('https://example.com/');
    expect(result).toBeTruthy();
  });

  it('handles URL with query parameters', () => {
    const result = urlToFilename('https://example.com/search?q=test&page=1');
    expect(result).toBeTruthy();
    expect(result).not.toContain('?');
  });

  it('handles URL with special characters', () => {
    const result = urlToFilename(
      'https://example.com/path/with spaces/and%20encoding'
    );
    expect(result).toBeTruthy();
    expect(result.length).toBeLessThanOrEqual(255);
  });

  it('produces unique filenames for different URLs', () => {
    const a = urlToFilename('https://example.com/page-a');
    const b = urlToFilename('https://example.com/page-b');
    expect(a).not.toBe(b);
  });

  it('handles very long URL', () => {
    const longPath = '/segment'.repeat(100);
    const result = urlToFilename(`https://example.com${longPath}`);
    expect(result.length).toBeLessThanOrEqual(255);
  });
});
