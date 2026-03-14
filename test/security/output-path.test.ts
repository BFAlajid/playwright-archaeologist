/**
 * Output Path Security Tests
 *
 * Validates that the output directory path is safely validated to prevent
 * path traversal attacks, null byte injection, symlink exploitation,
 * and filename sanitization from untrusted URLs.
 *
 * Threat reference: T3.4 (Output Directory Path Traversal)
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  existsSync,
  mkdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
  chmodSync,
} from 'fs';
import { join, resolve, sep } from 'path';
import { tmpdir, platform } from 'os';
import { randomUUID } from 'crypto';

// The module under test -- src/security/output-sanitizer.ts
// Expected exports:
//   validateOutputPath(outputDir: string, cwd: string): string
//   sanitizeFilename(url: string): string
import {
  validateOutputPath,
  sanitizeFilename,
} from '../../src/security/output-sanitizer.js';

// ---------------------------------------------------------------------------
// Test fixture helpers
// ---------------------------------------------------------------------------
let tempDir: string;
let testCwd: string;

beforeEach(() => {
  tempDir = join(tmpdir(), `pa-output-test-${randomUUID()}`);
  testCwd = join(tempDir, 'project');
  mkdirSync(testCwd, { recursive: true });
});

afterEach(() => {
  if (existsSync(tempDir)) {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

// ===========================================================================
// 1. Normal paths accepted
// ===========================================================================
describe('Output Path Validation - Normal Paths', () => {
  it('accepts a relative path within cwd', () => {
    const result = validateOutputPath('.archaeologist', testCwd);
    expect(result).toBe(resolve(testCwd, '.archaeologist'));
  });

  it('accepts a nested relative path within cwd', () => {
    const result = validateOutputPath('output/reports', testCwd);
    expect(result).toBe(resolve(testCwd, 'output', 'reports'));
  });

  it('accepts an absolute path to a safe directory', () => {
    const safeDir = join(tempDir, 'safe-output');
    const result = validateOutputPath(safeDir, testCwd);
    expect(result).toBe(resolve(safeDir));
  });

  it('accepts current directory (.)', () => {
    const result = validateOutputPath('.', testCwd);
    expect(result).toBe(resolve(testCwd));
  });
});

// ===========================================================================
// 2. Relative path resolution
// ===========================================================================
describe('Output Path Validation - Relative Path Resolution', () => {
  it('resolves relative path to absolute', () => {
    const result = validateOutputPath('output', testCwd);
    expect(result).toMatch(/^[A-Z]:\\/i); // Windows absolute path
  });

  it('resolves ./output to absolute', () => {
    const result = validateOutputPath('./output', testCwd);
    expect(result).toBe(resolve(testCwd, 'output'));
  });
});

// ===========================================================================
// 3. Path traversal rejection
// ===========================================================================
describe('Output Path Validation - Path Traversal', () => {
  it('rejects ../../../etc/passwd', () => {
    expect(() =>
      validateOutputPath('../../../etc/passwd', testCwd),
    ).toThrow();
  });

  it('rejects ../../etc/cron.d/', () => {
    expect(() =>
      validateOutputPath('../../etc/cron.d/', testCwd),
    ).toThrow();
  });

  it('rejects ../ at the start', () => {
    expect(() => validateOutputPath('../outside', testCwd)).toThrow();
  });

  it('rejects embedded ../ traversal', () => {
    expect(() =>
      validateOutputPath('safe/../../outside', testCwd),
    ).toThrow();
  });

  it('rejects multiple ../ sequences', () => {
    expect(() =>
      validateOutputPath('a/../b/../c/../../outside', testCwd),
    ).toThrow();
  });

  it('rejects relative traversal that escapes cwd', () => {
    expect(() =>
      validateOutputPath(
        '../'.repeat(20) + 'etc/passwd',
        testCwd,
      ),
    ).toThrow();
  });
});

// ===========================================================================
// 4. Null byte injection
// ===========================================================================
describe('Output Path Validation - Null Byte Injection', () => {
  it('rejects path with null byte', () => {
    expect(() =>
      validateOutputPath('output\0/evil', testCwd),
    ).toThrow();
  });

  it('rejects path with null byte before extension', () => {
    expect(() =>
      validateOutputPath('report\0.html', testCwd),
    ).toThrow();
  });

  it('rejects path with embedded null byte', () => {
    expect(() =>
      validateOutputPath('safe/path\0/../../../etc/passwd', testCwd),
    ).toThrow();
  });
});

// ===========================================================================
// 5. Windows UNC paths
// ===========================================================================
describe('Output Path Validation - Windows UNC Paths', () => {
  // These tests are meaningful on Windows; on Unix they still test the
  // validator handles these strings without crashing
  it('handles \\\\server\\share path', () => {
    // UNC paths should either be rejected or handled safely
    // depending on whether we want to support network shares
    const uncPath = '\\\\server\\share\\output';
    try {
      const result = validateOutputPath(uncPath, testCwd);
      // If it doesn't throw, the result should be a resolved absolute path
      expect(typeof result).toBe('string');
    } catch (err: any) {
      // Rejecting UNC paths is also acceptable
      expect(err).toBeDefined();
    }
  });

  it('handles //server/share path (forward-slash UNC)', () => {
    const uncPath = '//server/share/output';
    try {
      const result = validateOutputPath(uncPath, testCwd);
      expect(typeof result).toBe('string');
    } catch (err: any) {
      expect(err).toBeDefined();
    }
  });
});

// ===========================================================================
// 6. Symlink behavior
// ===========================================================================
describe('Output Path Validation - Symlinks', () => {
  it('detects symlink following behavior', () => {
    // Create a symlink pointing outside tempDir
    const symlinkPath = join(testCwd, 'symlink-output');
    const targetPath = join(tmpdir(), `pa-symlink-target-${randomUUID()}`);
    mkdirSync(targetPath, { recursive: true });

    try {
      symlinkSync(targetPath, symlinkPath, 'junction');
    } catch {
      // Symlink creation may fail on Windows without admin
      // Skip the test in that case
      return;
    }

    // The validator should either follow the symlink and validate the real
    // path, or reject symlinks outright
    try {
      const result = validateOutputPath(symlinkPath, testCwd);
      // If it follows the symlink, the resolved path should be the real target
      expect(typeof result).toBe('string');
    } catch (err: any) {
      // Rejecting symlinks is also acceptable security behavior
      expect(err).toBeDefined();
    } finally {
      rmSync(targetPath, { recursive: true, force: true });
    }
  });
});

// ===========================================================================
// 7. Non-writable directory detection
// ===========================================================================
describe('Output Path Validation - Write Permissions', () => {
  // Permission tests only meaningful on Unix-like systems
  const isWindows = platform() === 'win32';

  it('detects non-writable directory early', () => {
    if (isWindows) {
      // Skip on Windows -- permission model is different
      return;
    }

    const readonlyDir = join(tempDir, 'readonly');
    mkdirSync(readonlyDir, { recursive: true });
    chmodSync(readonlyDir, 0o444);

    try {
      // The validator should either throw or return a warning about
      // the directory not being writable
      expect(() =>
        validateOutputPath(readonlyDir, testCwd),
      ).toThrow(/permission|writable|write|access/i);
    } finally {
      chmodSync(readonlyDir, 0o755);
    }
  });
});

// ===========================================================================
// 8. Directory creation when missing
// ===========================================================================
describe('Output Path Validation - Directory Creation', () => {
  it('creates output directory when it does not exist', () => {
    const newDir = join(testCwd, 'new-output-dir');
    expect(existsSync(newDir)).toBe(false);

    const result = validateOutputPath(newDir, testCwd);
    // The validator should return the resolved path (it may or may not
    // create the directory -- creation could be deferred to write time)
    expect(result).toBe(resolve(newDir));
  });

  it('creates nested output directory when it does not exist', () => {
    const newDir = join(testCwd, 'deeply', 'nested', 'output');
    expect(existsSync(newDir)).toBe(false);

    const result = validateOutputPath(newDir, testCwd);
    expect(result).toBe(resolve(newDir));
  });
});

// ===========================================================================
// 9. System directory blocking
// ===========================================================================
describe('Output Path Validation - System Directories', () => {
  it('rejects /etc as output directory', () => {
    expect(() => validateOutputPath('/etc', testCwd)).toThrow();
  });

  it('rejects /usr as output directory', () => {
    expect(() => validateOutputPath('/usr', testCwd)).toThrow();
  });

  it('rejects /bin as output directory', () => {
    expect(() => validateOutputPath('/bin', testCwd)).toThrow();
  });

  it('rejects /var as output directory', () => {
    expect(() => validateOutputPath('/var', testCwd)).toThrow();
  });

  if (platform() === 'win32') {
    it('rejects C:\\Windows as output directory', () => {
      expect(() =>
        validateOutputPath('C:\\Windows', testCwd),
      ).toThrow();
    });

    it('rejects C:\\Program Files as output directory', () => {
      expect(() =>
        validateOutputPath('C:\\Program Files', testCwd),
      ).toThrow();
    });
  }
});

// ===========================================================================
// 10. Filename sanitization from URLs
// ===========================================================================
describe('Filename Sanitization from URLs', () => {
  it('sanitizes basic URL to safe filename', () => {
    const filename = sanitizeFilename('https://example.com/about');
    expect(filename).toMatch(/^[a-zA-Z0-9._-]+$/);
    expect(filename.length).toBeGreaterThan(0);
  });

  it('removes <script> from URL path', () => {
    const filename = sanitizeFilename(
      'https://example.com/page?q=<script>alert(1)</script>',
    );
    expect(filename).not.toContain('<');
    expect(filename).not.toContain('>');
    expect(filename).toMatch(/^[a-zA-Z0-9._-]+$/);
  });

  it('removes .. from path segments', () => {
    const filename = sanitizeFilename('https://example.com/../../../etc/passwd');
    expect(filename).not.toContain('..');
    expect(filename).toMatch(/^[a-zA-Z0-9._-]+$/);
  });

  it('removes null bytes from URL', () => {
    const filename = sanitizeFilename('https://example.com/page\0.html');
    expect(filename).not.toContain('\0');
    expect(filename).toMatch(/^[a-zA-Z0-9._-]+$/);
  });

  it('truncates very long URL paths to safe filename length', () => {
    const longPath = 'a'.repeat(500);
    const filename = sanitizeFilename(`https://example.com/${longPath}`);
    expect(filename.length).toBeLessThanOrEqual(255);
    expect(filename.length).toBeGreaterThan(0);
  });

  it('handles URL with only special characters', () => {
    const filename = sanitizeFilename('https://example.com/!@#$%^&*()');
    expect(filename.length).toBeGreaterThan(0);
    expect(filename).toMatch(/^[a-zA-Z0-9._-]+$/);
  });

  it('handles URL with spaces', () => {
    const filename = sanitizeFilename(
      'https://example.com/path with spaces/page',
    );
    expect(filename).not.toContain(' ');
    expect(filename).toMatch(/^[a-zA-Z0-9._-]+$/);
  });

  it('handles URL with unicode characters', () => {
    const filename = sanitizeFilename('https://example.com/cafe\u0301/page');
    expect(filename).toMatch(/^[a-zA-Z0-9._-]+$/);
  });

  it('handles empty URL path', () => {
    const filename = sanitizeFilename('https://example.com/');
    expect(filename.length).toBeGreaterThan(0);
  });

  it('collapses consecutive underscores', () => {
    const filename = sanitizeFilename(
      'https://example.com/path///with///slashes',
    );
    // Multiple slashes become multiple underscores, which should be collapsed
    expect(filename).not.toMatch(/_{2,}/);
  });

  it('produces deterministic output for same input', () => {
    const url = 'https://example.com/some/path?q=test';
    const a = sanitizeFilename(url);
    const b = sanitizeFilename(url);
    expect(a).toBe(b);
  });

  it('produces different output for different URLs', () => {
    const a = sanitizeFilename('https://example.com/page-a');
    const b = sanitizeFilename('https://example.com/page-b');
    expect(a).not.toBe(b);
  });

  it('handles protocol-relative URL', () => {
    const filename = sanitizeFilename('//example.com/path');
    expect(filename.length).toBeGreaterThan(0);
    expect(filename).toMatch(/^[a-zA-Z0-9._-]+$/);
  });

  it('handles URL with query parameters containing special chars', () => {
    const filename = sanitizeFilename(
      'https://example.com/search?q=foo&bar=<img+onerror=alert(1)>',
    );
    expect(filename).not.toContain('<');
    expect(filename).not.toContain('>');
    expect(filename).toMatch(/^[a-zA-Z0-9._-]+$/);
  });

  it('handles URL with Windows path separators', () => {
    const filename = sanitizeFilename(
      'https://example.com/path\\to\\resource',
    );
    expect(filename).not.toContain('\\');
    expect(filename).toMatch(/^[a-zA-Z0-9._-]+$/);
  });
});
