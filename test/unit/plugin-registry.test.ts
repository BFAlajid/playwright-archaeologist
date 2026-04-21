/**
 * Unit tests for src/plugins/registry.ts
 *
 * Exercises the core guarantees callers depend on:
 *   - Registered collectors run in order.
 *   - A failing collector does not abort the rest.
 *   - A collector that exceeds the timeout is reported as an error.
 *   - Results include `data` on success and `error` on failure / timeout.
 */

import { describe, it, expect } from 'vitest';
import { CollectorRegistry } from '../../src/plugins/registry.js';
import type { Collector, CollectorContext } from '../../src/plugins/types.js';

function fakeCtx(): CollectorContext {
  return {
    // The registry does not touch `page` or `response`, so casting
    // `undefined` through is fine for the unit boundary.
    page: undefined as unknown as CollectorContext['page'],
    response: null,
    url: 'https://example.com/',
    startTime: Date.now(),
  };
}

describe('CollectorRegistry', () => {
  it('runs registered collectors in order and returns their data', async () => {
    const registry = new CollectorRegistry();
    const calls: string[] = [];

    const makeCollector = (name: string, value: number): Collector<number> => ({
      name,
      async collect() {
        calls.push(name);
        return value;
      },
    });

    registry.register(makeCollector('first', 1));
    registry.register(makeCollector('second', 2));
    registry.register(makeCollector('third', 3));

    const results = await registry.runAll(fakeCtx());

    expect(calls).toEqual(['first', 'second', 'third']);
    expect(results).toHaveLength(3);
    expect(results.map((r) => r.name)).toEqual(['first', 'second', 'third']);
    expect(results.map((r) => r.data)).toEqual([1, 2, 3]);
    expect(results.every((r) => r.error === undefined)).toBe(true);
  });

  it('captures errors per-collector without aborting the rest', async () => {
    const registry = new CollectorRegistry();
    registry.register({ name: 'ok-before', async collect() { return 'ok'; } });
    registry.register({
      name: 'boom',
      async collect() {
        throw new Error('plugin exploded');
      },
    });
    registry.register({ name: 'ok-after', async collect() { return 'still-ok'; } });

    const results = await registry.runAll(fakeCtx());

    expect(results).toHaveLength(3);
    expect(results[0]).toMatchObject({ name: 'ok-before', data: 'ok' });
    expect(results[1].name).toBe('boom');
    expect(results[1].data).toBeUndefined();
    expect(results[1].error).toContain('plugin exploded');
    expect(results[2]).toMatchObject({ name: 'ok-after', data: 'still-ok' });
  });

  it('reports a timeout as an error and moves on', async () => {
    const registry = new CollectorRegistry();
    registry.register({
      name: 'slow',
      async collect() {
        await new Promise((r) => setTimeout(r, 200));
        return 'never-returned';
      },
    });
    registry.register({ name: 'fast', async collect() { return 'quick'; } });

    const results = await registry.runAll(fakeCtx(), { timeoutMs: 25 });

    expect(results).toHaveLength(2);
    expect(results[0].name).toBe('slow');
    expect(results[0].data).toBeUndefined();
    expect(results[0].error).toMatch(/timed out after 25ms/);
    expect(results[1]).toMatchObject({ name: 'fast', data: 'quick' });
  });

  it('records elapsed time on each result', async () => {
    const registry = new CollectorRegistry();
    registry.register({
      name: 'delayed',
      async collect() {
        await new Promise((r) => setTimeout(r, 20));
        return true;
      },
    });

    const [result] = await registry.runAll(fakeCtx());
    expect(result.durationMs).toBeGreaterThanOrEqual(15);
    expect(result.durationMs).toBeLessThan(200);
  });

  it('returns an empty array when no collectors are registered', async () => {
    const registry = new CollectorRegistry();
    expect(registry.size).toBe(0);
    expect(await registry.runAll(fakeCtx())).toEqual([]);
  });

  it('rejects invalid collector registrations', () => {
    const registry = new CollectorRegistry();
    expect(() =>
      registry.register({ name: '', collect: async () => null } as unknown as Collector),
    ).toThrow(TypeError);
    expect(() =>
      registry.register({ name: 'no-fn' } as unknown as Collector),
    ).toThrow(TypeError);
  });
});
