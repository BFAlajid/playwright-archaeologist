/**
 * Test fixture server lifecycle helper.
 *
 * Provides start/stop semantics for integration and e2e tests.
 * Each call to startTestApp() creates an isolated server instance on a
 * random available port, ensuring parallel test suites do not collide.
 *
 * Usage in Vitest:
 *
 *   import { startTestApp } from '../fixtures/test-app/setup.js';
 *
 *   let app: Awaited<ReturnType<typeof startTestApp>>;
 *
 *   beforeAll(async () => { app = await startTestApp(); });
 *   afterAll(async () => { await app.close(); });
 *
 *   it('crawls the home page', async () => {
 *     const res = await fetch(app.url);
 *     expect(res.ok).toBe(true);
 *   });
 */

import { createTestApp, startServer, type TestServer } from './server.js';

export interface TestAppHandle {
  /** Base URL of the running server, e.g. "http://127.0.0.1:54321" */
  url: string;

  /** The resolved port number */
  port: number;

  /** Gracefully shuts down the server and all WebSocket connections. */
  close: () => Promise<void>;

  /**
   * Resets mutable server state (user database, etc.) to its initial values.
   * Call between tests that mutate API data to ensure isolation.
   */
  reset: () => Promise<void>;
}

/**
 * Starts a fresh test fixture server on a random available port.
 *
 * @param port - Optional fixed port. Defaults to 0 (OS-assigned random port).
 * @returns A handle with the base URL and a close function.
 *
 * @example
 * ```ts
 * const app = await startTestApp();
 * // app.url === "http://127.0.0.1:54321"
 * await app.close();
 * ```
 */
export async function startTestApp(port?: number): Promise<TestAppHandle> {
  const app = createTestApp();
  const server: TestServer = await startServer(app, port ?? 0);

  const reset = async (): Promise<void> => {
    const res = await fetch(`${server.url}/__reset`, { method: 'POST' });
    if (!res.ok) {
      throw new Error(`Failed to reset test app: ${res.status} ${res.statusText}`);
    }
  };

  return {
    url: server.url,
    port: server.port,
    close: server.close,
    reset,
  };
}

/**
 * Vitest-compatible shared fixture.
 *
 * Use this when multiple test files in the same pool need to share a single
 * server instance. The server starts once and is reused across all callers.
 *
 * @example
 * ```ts
 * import { getSharedTestApp } from '../fixtures/test-app/setup.js';
 *
 * let app: TestAppHandle;
 * beforeAll(async () => { app = await getSharedTestApp(); });
 * // No afterAll needed — the shared instance cleans up on process exit.
 * ```
 */
let sharedInstance: TestAppHandle | null = null;
let sharedInstancePromise: Promise<TestAppHandle> | null = null;

export async function getSharedTestApp(): Promise<TestAppHandle> {
  if (sharedInstance) return sharedInstance;
  if (sharedInstancePromise) return sharedInstancePromise;

  sharedInstancePromise = startTestApp().then((handle) => {
    sharedInstance = handle;

    // Clean up on process exit
    const cleanup = () => {
      if (sharedInstance) {
        sharedInstance.close().catch(() => {});
        sharedInstance = null;
        sharedInstancePromise = null;
      }
    };
    process.on('exit', cleanup);
    process.on('SIGINT', cleanup);
    process.on('SIGTERM', cleanup);

    return handle;
  });

  return sharedInstancePromise;
}
