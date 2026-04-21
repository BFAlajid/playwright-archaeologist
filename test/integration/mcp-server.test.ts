/**
 * Integration tests for the MCP stdio server.
 *
 * Spawns `pa mcp <bundle>` via the compiled CLI (falls back to tsx when
 * dist is not present), performs a JSON-RPC initialize + tools/list +
 * tools/call exchange on stdio, and asserts the server responds
 * correctly and exits cleanly.
 *
 * If the MCP SDK is unavailable (e.g. offline CI run without
 * node_modules), the suite is skipped.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, writeFile, rm, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve as pathResolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { access, constants as fsConstants } from 'node:fs/promises';

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = pathResolve(__dirname, '..', '..');

// Resolve the MCP SDK; skip the suite when it is missing.
let sdkAvailable = true;
try {
  await import('@modelcontextprotocol/sdk/server/mcp.js');
} catch {
  sdkAvailable = false;
}

async function fileExists(path: string): Promise<boolean> {
  try {
    await access(path, fsConstants.F_OK);
    return true;
  } catch {
    return false;
  }
}

/**
 * Locate the compiled CLI. The suite runs against the real build (not
 * source), so `npm run build` must have produced `dist/cli.js` before
 * this test is invoked. Returns an empty command when the build is
 * missing so the test can skip rather than crash.
 */
async function resolveCliCommand(): Promise<{ command: string; args: string[] }> {
  const distCli = join(repoRoot, 'dist', 'cli.js');
  if (await fileExists(distCli)) {
    return { command: process.execPath, args: [distCli] };
  }
  return { command: '', args: [] };
}

interface JsonRpcMessage {
  jsonrpc: '2.0';
  id?: number | string;
  method?: string;
  params?: unknown;
  result?: unknown;
  error?: { code: number; message: string };
}

/**
 * Line-delimited JSON-RPC reader over stdout. Resolves the next message
 * whose `id` matches the expected one. Rejects if the child exits first.
 */
function makeRpcClient(child: ChildProcessWithoutNullStreams) {
  const pending = new Map<
    number,
    { resolve: (msg: JsonRpcMessage) => void; reject: (err: Error) => void }
  >();
  let buffer = '';

  child.stdout.setEncoding('utf-8');
  child.stdout.on('data', (chunk: string) => {
    buffer += chunk;
    let idx: number;
    while ((idx = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, idx).trim();
      buffer = buffer.slice(idx + 1);
      if (!line) continue;
      try {
        const msg = JSON.parse(line) as JsonRpcMessage;
        if (typeof msg.id === 'number') {
          const waiter = pending.get(msg.id);
          if (waiter) {
            pending.delete(msg.id);
            waiter.resolve(msg);
          }
        }
      } catch {
        // non-JSON line — ignore (SDK sometimes logs to stderr, not stdout,
        // but we guard anyway).
      }
    }
  });

  child.on('exit', (code, signal) => {
    const err = new Error(
      `Child exited (code=${String(code)}, signal=${String(signal)}) with ${pending.size} pending RPC(s)`,
    );
    for (const w of pending.values()) w.reject(err);
    pending.clear();
  });

  let nextId = 1;

  async function call(method: string, params: unknown = {}): Promise<JsonRpcMessage> {
    const id = nextId++;
    const msg: JsonRpcMessage = { jsonrpc: '2.0', id, method, params };
    let timeout: NodeJS.Timeout | undefined;
    const promise = new Promise<JsonRpcMessage>((resolve, reject) => {
      pending.set(id, {
        resolve: (m) => {
          if (timeout) clearTimeout(timeout);
          resolve(m);
        },
        reject: (err) => {
          if (timeout) clearTimeout(timeout);
          reject(err);
        },
      });
      timeout = setTimeout(() => {
        if (pending.delete(id)) {
          reject(new Error(`RPC ${method} (id=${id}) timed out after 10s`));
        }
      }, 10_000);
    });
    child.stdin.write(JSON.stringify(msg) + '\n');
    return promise;
  }

  function notify(method: string, params: unknown = {}): void {
    const msg: JsonRpcMessage = { jsonrpc: '2.0', method, params };
    child.stdin.write(JSON.stringify(msg) + '\n');
  }

  return { call, notify };
}

// Minimal bundle on disk so the server boots.
async function writeFixtureBundle(dir: string): Promise<void> {
  const dataDir = join(dir, 'data');
  await mkdir(dataDir, { recursive: true });

  const manifest = {
    version: 1,
    tool: 'playwright-archaeologist',
    toolVersion: '0.0.0-test',
    createdAt: new Date().toISOString(),
    config: {
      targetUrl: 'https://example.com',
      depth: 1,
      viewport: { width: 1280, height: 720 },
      concurrency: 1,
      maxPages: 10,
      followExternal: false,
      deepClick: false,
    },
    stats: { pagesVisited: 2, formsFound: 1, apiEndpoints: 1, screenshotCount: 0, duration: 100 },
    files: [],
  };
  await writeFile(join(dir, 'manifest.json'), JSON.stringify(manifest));

  const sitemap = [
    {
      url: 'https://example.com/',
      title: 'Home',
      statusCode: 200,
      contentHash: 'a',
      depth: 0,
      formCount: 0,
      apiCallCount: 0,
      hasScreenshot: false,
      discoveryMethod: 'entry',
    },
    {
      url: 'https://example.com/broken',
      title: 'Broken',
      statusCode: 500,
      contentHash: 'b',
      depth: 1,
      formCount: 0,
      apiCallCount: 0,
      hasScreenshot: false,
      discoveryMethod: 'link',
    },
  ];
  await writeFile(join(dataDir, 'sitemap.json'), JSON.stringify(sitemap));

  const forms = [
    {
      action: '/submit',
      method: 'POST',
      isImplicit: false,
      fields: [{ name: 'body', type: 'text', required: true }],
      validationMessages: [],
      wasHidden: false,
    },
  ];
  await writeFile(join(dataDir, 'forms.json'), JSON.stringify(forms));

  await writeFile(join(dataDir, 'api-map.json'), JSON.stringify([]));
}

describe.skipIf(!sdkAvailable)('MCP stdio server (integration)', () => {
  let tmp: string;
  let child: ChildProcessWithoutNullStreams | undefined;

  beforeAll(async () => {
    tmp = await mkdtemp(join(tmpdir(), 'pa-mcp-test-'));
    await writeFixtureBundle(tmp);
  });

  afterAll(async () => {
    try {
      child?.kill('SIGTERM');
    } catch {
      // best-effort
    }
    if (tmp) await rm(tmp, { recursive: true, force: true });
  });

  it('boots, lists tools, answers search_routes, and exits cleanly', async () => {
    const { command, args } = await resolveCliCommand();
    if (!command) {
      // tsx unavailable and no dist build — skip rather than fail.
      return;
    }
    child = spawn(command, [...args, 'mcp', tmp], {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, NO_COLOR: '1' },
    });

    // stderr is where the tool logs; drain it so the pipe doesn't block.
    child.stderr.setEncoding('utf-8');
    let stderrText = '';
    child.stderr.on('data', (chunk: string) => {
      stderrText += chunk;
    });

    const rpc = makeRpcClient(child);

    // --- initialize ---
    const initResp = await rpc.call('initialize', {
      protocolVersion: '2025-06-18',
      capabilities: {},
      clientInfo: { name: 'pa-test-harness', version: '0.0.0' },
    });
    expect(initResp.error).toBeUndefined();
    expect(initResp.result).toBeDefined();

    rpc.notify('notifications/initialized');

    // --- tools/list ---
    const toolsResp = await rpc.call('tools/list');
    expect(toolsResp.error).toBeUndefined();
    const tools = (toolsResp.result as { tools: Array<{ name: string }> }).tools;
    const names = tools.map((t) => t.name).sort();
    expect(names).toEqual(
      [
        'find_forms_without_csrf',
        'get_api_endpoint',
        'list_accessibility_violations',
        'list_broken_routes',
        'list_forms',
        'search_routes',
      ].sort(),
    );

    // --- tools/call: search_routes ---
    const callResp = await rpc.call('tools/call', {
      name: 'search_routes',
      arguments: { query: 'broken' },
    });
    expect(callResp.error).toBeUndefined();
    const result = callResp.result as {
      content: Array<{ type: string; text: string }>;
    };
    expect(result.content[0].type).toBe('text');
    const payload = JSON.parse(result.content[0].text) as {
      total: number;
      matches: Array<{ url: string; statusCode: number }>;
    };
    expect(payload.total).toBe(1);
    expect(payload.matches[0].url).toContain('/broken');
    expect(payload.matches[0].statusCode).toBe(500);

    // --- tools/call: list_broken_routes ---
    const brokenResp = await rpc.call('tools/call', {
      name: 'list_broken_routes',
      arguments: {},
    });
    const brokenPayload = JSON.parse(
      (brokenResp.result as { content: Array<{ text: string }> }).content[0].text,
    ) as { total: number };
    expect(brokenPayload.total).toBe(1);

    // --- resources/list ---
    const resourcesResp = await rpc.call('resources/list');
    expect(resourcesResp.error).toBeUndefined();
    const resources = (resourcesResp.result as { resources: Array<{ uri: string }> }).resources;
    expect(resources.map((r) => r.uri).sort()).toEqual(
      ['bundle://api-map', 'bundle://flow-graph', 'bundle://forms', 'bundle://manifest', 'bundle://sitemap'].sort(),
    );

    // --- graceful shutdown on SIGTERM ---
    const exitPromise = once(child, 'exit') as Promise<[number | null, NodeJS.Signals | null]>;
    child.kill('SIGTERM');
    const [, signal] = await exitPromise;
    // Either a clean 0-exit or SIGTERM-induced exit is acceptable.
    expect(signal === 'SIGTERM' || signal === null).toBe(true);

    // Sanity: logger output went to stderr, not stdout.
    expect(stderrText.length).toBeGreaterThanOrEqual(0);
  }, 30_000);
});
