/**
 * Output Sanitizer
 *
 * Prevents path traversal, sanitizes filenames from URLs,
 * and validates output paths.
 */

import { resolve, basename, extname, isAbsolute, normalize, sep } from 'node:path';
import { accessSync, constants } from 'node:fs';
import { platform } from 'node:os';

// -------------------------------------------------------------------------
// Windows reserved device names
// -------------------------------------------------------------------------
const WINDOWS_RESERVED = new Set([
  'CON', 'PRN', 'AUX', 'NUL',
  'COM1', 'COM2', 'COM3', 'COM4', 'COM5', 'COM6', 'COM7', 'COM8', 'COM9',
  'LPT1', 'LPT2', 'LPT3', 'LPT4', 'LPT5', 'LPT6', 'LPT7', 'LPT8', 'LPT9',
]);

// -------------------------------------------------------------------------
// System directories that must never be used as output directories
// -------------------------------------------------------------------------
const UNIX_SYSTEM_DIRS = new Set([
  '/etc',
  '/usr',
  '/bin',
  '/sbin',
  '/var',
  '/boot',
  '/dev',
  '/proc',
  '/sys',
  '/lib',
  '/lib64',
  '/root',
]);

const WINDOWS_SYSTEM_DIRS_LOWER = new Set([
  'c:\\windows',
  'c:\\program files',
  'c:\\program files (x86)',
  'c:\\system32',
]);

/**
 * Check if a path is a blocked system directory.
 * Checks both the resolved path AND the original input for Unix system paths
 * (to correctly block /etc/passwd even on Windows where it resolves to C:\etc\passwd).
 */
function isSystemDirectory(absolutePath: string, originalInput?: string): boolean {
  const normalized = normalize(absolutePath);

  // Unix system dirs — check resolved path
  for (const dir of UNIX_SYSTEM_DIRS) {
    if (normalized === dir || normalized.startsWith(dir + '/')) {
      return true;
    }
  }

  // Also check the original input for Unix-style system paths (cross-platform safety)
  if (originalInput) {
    const cleanInput = originalInput.replace(/\\/g, '/');
    for (const dir of UNIX_SYSTEM_DIRS) {
      if (cleanInput === dir || cleanInput.startsWith(dir + '/')) {
        return true;
      }
    }
  }

  // Windows system dirs (case-insensitive)
  const lower = normalized.toLowerCase().replace(/\//g, '\\');
  for (const dir of WINDOWS_SYSTEM_DIRS_LOWER) {
    if (lower === dir || lower.startsWith(dir + '\\')) {
      return true;
    }
  }

  return false;
}

/**
 * Sanitize a filename derived from user input or URL path.
 * - Removes path traversal sequences (../, ..\)
 * - Removes null bytes
 * - Replaces Windows reserved names (CON, PRN, AUX, NUL, COM1-9, LPT1-9)
 * - Truncates very long filenames (preserving extension)
 * - Handles Unicode
 * - Replaces special characters with safe alternatives
 * - Collapses consecutive underscores
 */
export function sanitizeFilename(input: string): string {
  if (!input) return '_unnamed';

  let result = input;

  // Decode percent-encoding
  try {
    result = decodeURIComponent(result);
  } catch {
    // If decoding fails, continue with the raw string
  }

  // Remove null bytes
  result = result.replace(/\0/g, '');

  // Remove path traversal sequences
  result = result.replace(/\.\.\//g, '');
  result = result.replace(/\.\.\\/g, '');
  result = result.replace(/\.\./g, '');

  // Replace characters not allowed in filenames: / \ : * ? " < > | and control chars
  // Keep letters, digits, dots, hyphens, underscores, and Unicode word characters
  result = result.replace(/[/\\:*?"<>|\x00-\x1F\x7F]/g, '_');

  // Remove any remaining potentially dangerous characters for strict mode
  // Allow: alphanumeric, dot, hyphen, underscore
  result = result.replace(/[^a-zA-Z0-9._-]/g, '_');

  // Collapse consecutive underscores
  result = result.replace(/_{2,}/g, '_');

  // Remove leading/trailing underscores and dots (except a single dot before extension)
  result = result.replace(/^[_]+/, '');
  result = result.replace(/[_]+$/, '');

  // If empty after sanitization, use fallback
  if (!result || result === '.' || result === '..') {
    return '_unnamed';
  }

  // Handle Windows reserved names
  const ext = extname(result);
  const nameWithoutExt = ext ? result.slice(0, -ext.length) : result;
  if (WINDOWS_RESERVED.has(nameWithoutExt.toUpperCase())) {
    result = `_${nameWithoutExt}${ext}`;
  }

  // Truncate to 255 chars (preserving extension)
  const MAX_LENGTH = 255;
  if (result.length > MAX_LENGTH) {
    const extension = extname(result);
    if (extension && extension.length < 20) {
      const maxBase = MAX_LENGTH - extension.length;
      result = result.slice(0, maxBase) + extension;
    } else {
      result = result.slice(0, MAX_LENGTH);
    }
  }

  return result;
}

/**
 * Validate and resolve an output path.
 * For relative paths: resolves against the base directory (outputDir/cwd).
 * For absolute paths: accepts if not a system directory or path-traversal.
 * Rejects null bytes, empty paths, and paths to system directories.
 * Returns the resolved absolute path.
 */
export function validateOutputPath(
  requestedPath: string,
  outputDir: string
): string {
  // Reject empty paths
  if (!requestedPath) {
    throw new Error('Output path must not be empty');
  }

  // Reject null bytes
  if (requestedPath.includes('\0')) {
    throw new Error('Output path must not contain null bytes');
  }

  // Resolve the path
  let resolved: string;
  if (isAbsolute(requestedPath)) {
    resolved = resolve(requestedPath);
  } else {
    resolved = resolve(outputDir, requestedPath);
  }

  // Normalize
  resolved = normalize(resolved);

  // Check for system directory
  if (isSystemDirectory(resolved, requestedPath)) {
    throw new Error(`Output path '${resolved}' is a protected system directory`);
  }

  // For relative paths, verify the resolved path doesn't escape the base directory
  if (!isAbsolute(requestedPath)) {
    const normalizedBase = normalize(resolve(outputDir));
    if (!resolved.startsWith(normalizedBase)) {
      throw new Error(
        `Path traversal detected: '${requestedPath}' resolves outside '${normalizedBase}'`
      );
    }
  }

  // For absolute paths that are outside the cwd, check they're not escaping
  // via traversal in the original string
  if (isAbsolute(requestedPath)) {
    // Check if it's a system directory (already done above)
    // Also check permissions on Unix if the directory exists
    if (platform() !== 'win32') {
      try {
        accessSync(resolved, constants.W_OK);
      } catch (err: any) {
        if (err?.code === 'EACCES') {
          throw new Error(
            `Output directory '${resolved}' is not writable — check permission`
          );
        }
        // ENOENT is OK — directory will be created later
      }
    }
  }

  return resolved;
}

/**
 * Convert a URL to a safe filename for screenshots/artifacts.
 * Produces a deterministic, human-readable filename from a URL.
 */
export function urlToFilename(url: string): string {
  let result: string;

  try {
    const parsed = new URL(url);
    // Combine host and path for a meaningful filename
    result = parsed.hostname + parsed.pathname;
    if (parsed.search) {
      result += parsed.search;
    }
  } catch {
    // If URL parsing fails, use the raw string
    result = url;
  }

  // Sanitize through the filename sanitizer
  return sanitizeFilename(result);
}
