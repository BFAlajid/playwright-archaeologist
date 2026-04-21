/**
 * Auth Validator
 *
 * Static analysis of authentication scripts to detect dangerous imports
 * and patterns. Does not block execution -- produces warnings for the user.
 *
 * Also provides executeAuthScript for safe dynamic import and execution
 * of user-provided auth scripts.
 */

import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

import { SecurityError } from '../types/errors.js';

export interface AuthValidationResult {
  valid: boolean;
  warnings: string[];
}

/**
 * Dangerous Node.js module patterns that should raise warnings in auth scripts.
 * Auth scripts should only interact with the browser via Playwright API,
 * not access the filesystem, spawn processes, or open network connections.
 */
const DANGEROUS_MODULES = [
  'child_process',
  'fs',
  'fs/promises',
  'net',
  'dgram',
  'cluster',
  'worker_threads',
  'vm',
  'v8',
  'perf_hooks',
  'dns',
  'tls',
  'http',
  'https',
] as const;

/**
 * Patterns that indicate dangerous code in auth scripts.
 */
const DANGEROUS_PATTERNS: Array<{ pattern: RegExp; description: string }> = [
  {
    pattern: /\beval\s*\(/g,
    description: 'eval() usage detected -- potential code injection',
  },
  {
    pattern: /\bnew\s+Function\s*\(/g,
    description: 'Function constructor detected -- potential code injection',
  },
  {
    pattern: /\bprocess\.exit\b/g,
    description: 'process.exit() detected -- could terminate the tool unexpectedly',
  },
];

/**
 * Build regex patterns for import/require of dangerous modules.
 * Handles both bare module names and node: prefixed names.
 */
function buildModulePatterns(): Array<{ pattern: RegExp; moduleName: string }> {
  const results: Array<{ pattern: RegExp; moduleName: string }> = [];

  for (const mod of DANGEROUS_MODULES) {
    const escaped = mod.replace(/\//g, '\\/');

    // import ... from 'module' or 'node:module'
    results.push({
      pattern: new RegExp(`\\bimport\\b[^;]*['"](?:node:)?${escaped}['"]`, 'g'),
      moduleName: mod,
    });

    // import('module') or import('node:module')
    results.push({
      pattern: new RegExp(`\\bimport\\s*\\(\\s*['"](?:node:)?${escaped}['"]\\s*\\)`, 'g'),
      moduleName: mod,
    });

    // require('module') or require('node:module')
    results.push({
      pattern: new RegExp(`\\brequire\\s*\\(\\s*['"](?:node:)?${escaped}['"]\\s*\\)`, 'g'),
      moduleName: mod,
    });
  }

  return results;
}

const MODULE_PATTERNS = buildModulePatterns();

/**
 * Validate an authentication script by reading it and performing
 * static analysis for dangerous imports and patterns.
 *
 * This is synchronous -- it reads the file and scans the source text.
 * It does NOT execute the script.
 *
 * @param scriptPath - Absolute or relative path to the auth script file.
 * @returns Validation result with valid flag and warnings array.
 * @throws If the file cannot be read.
 */
export function validateAuthScript(scriptPath: string): AuthValidationResult {
  const warnings: string[] = [];

  let content: string;
  try {
    content = readFileSync(scriptPath, 'utf-8');
  } catch (err: any) {
    const code = err?.code;
    if (code === 'ENOENT') {
      throw new Error(`Auth script not found: ${scriptPath}`);
    }
    throw new Error(`Failed to read auth script '${scriptPath}': ${err?.message ?? String(err)}`);
  }

  // Check for dangerous module imports
  for (const { pattern, moduleName } of MODULE_PATTERNS) {
    // Reset lastIndex for global regex
    pattern.lastIndex = 0;
    if (pattern.test(content)) {
      warnings.push(`Dangerous import of '${moduleName}' detected`);
    }
  }

  // Check for dangerous code patterns
  for (const { pattern, description } of DANGEROUS_PATTERNS) {
    pattern.lastIndex = 0;
    if (pattern.test(content)) {
      warnings.push(description);
    }
  }

  return {
    valid: warnings.length === 0,
    warnings,
  };
}

/**
 * Execute an authentication script by dynamically importing it and
 * calling its default export with the provided Playwright Page.
 *
 * Before importing, the script is validated with `validateAuthScript()`.
 * If static analysis produces any warnings (dangerous imports, eval, etc.),
 * the script is rejected with a SecurityError unless `allowAuthScript`
 * has been explicitly set. `yes` is *not* an override — unsafe auth
 * scripts are a security gate, not a UX prompt.
 *
 * @param scriptPath - Path to the auth script (.js, .mjs, or .ts via loader).
 * @param page - Playwright Page instance to pass to the auth function.
 * @param opts - Options. `allowAuthScript: true` bypasses the static-analysis gate.
 * @throws SecurityError if static analysis finds dangerous patterns and
 *         `allowAuthScript` is not set.
 * @throws If the script has no default export, the default export is not a function,
 *         or the auth function throws.
 */
export async function executeAuthScript(
  scriptPath: string,
  page: any,
  opts?: { yes?: boolean; allowAuthScript?: boolean }
): Promise<void> {
  // Static analysis MUST run before the module is imported. If the import
  // happens first, top-level side effects in a malicious script run before
  // we can reject it.
  const validation = validateAuthScript(scriptPath);
  if (!validation.valid && !opts?.allowAuthScript) {
    throw new SecurityError(
      'auth_script_dangerous',
      `Auth script '${scriptPath}' failed static analysis:\n  - ` +
        validation.warnings.join('\n  - ') +
        `\nRe-run with --allow-auth-script if you trust this script.`,
    );
  }

  // Convert to file URL for dynamic import
  const fileUrl = pathToFileURL(scriptPath).href;

  let mod: any;
  try {
    mod = await import(fileUrl);
  } catch (err: any) {
    throw new Error(
      `Failed to import auth script '${scriptPath}': ${err?.message ?? String(err)}`
    );
  }

  const authFn = mod.default;

  if (authFn === undefined || authFn === null) {
    throw new Error(
      `Auth script '${scriptPath}' has no default export. ` +
      `The script must export a default async function.`
    );
  }

  if (typeof authFn !== 'function') {
    throw new Error(
      `Auth script '${scriptPath}' default export is not a function ` +
      `(got ${typeof authFn}). The script must export a default async function.`
    );
  }

  // Execute the auth function
  await authFn(page);
}
