/**
 * Unit tests for src/plugins/axe-collector.ts
 *
 * The real AxeBuilder hits a Playwright Page and runs axe-core in-page.
 * Here we mock @axe-core/playwright at the module boundary so we can feed
 * canned axe results and assert the collector's shape and summarisation.
 */

import { describe, it, expect, vi } from 'vitest';

// Canned axe result the mock returns from analyze().
const FIXTURE = {
  violations: [
    {
      id: 'color-contrast',
      impact: 'serious',
      help: 'Elements must have sufficient color contrast',
      helpUrl: 'https://dequeuniversity.com/rules/axe/4.8/color-contrast',
      nodes: [{}, {}, {}],
    },
    {
      id: 'image-alt',
      impact: null,
      help: 'Images must have alternate text',
      helpUrl: 'https://dequeuniversity.com/rules/axe/4.8/image-alt',
      nodes: [{}],
    },
  ],
  passes: [{ id: 'region' }, { id: 'landmark-one-main' }],
  incomplete: [{ id: 'color-contrast-enhanced' }],
  inapplicable: [{ id: 'a' }, { id: 'b' }, { id: 'c' }],
};

vi.mock('@axe-core/playwright', () => ({
  AxeBuilder: class {
    constructor(_args: unknown) {
      /* noop — we only need analyze() to resolve. */
    }
    async analyze() {
      return FIXTURE;
    }
  },
}));

// Import AFTER vi.mock so the collector picks up the mocked module.
import { AxeCollector } from '../../src/plugins/axe-collector.js';
import type { CollectorContext } from '../../src/plugins/types.js';

function fakeCtx(): CollectorContext {
  // The collector only forwards `page` to AxeBuilder, and the mock ignores
  // its argument, so we can cast an empty object through here.
  return {
    page: {} as unknown as CollectorContext['page'],
    response: null,
    url: 'https://example.com/',
    startTime: Date.now(),
  };
}

describe('AxeCollector', () => {
  it('exposes the stable collector name "axe"', () => {
    expect(new AxeCollector().name).toBe('axe');
  });

  it('summarises axe results into violations + counts', async () => {
    const collector = new AxeCollector();
    const result = await collector.collect(fakeCtx());

    expect(result.passes).toBe(2);
    expect(result.incomplete).toBe(1);
    expect(result.inapplicable).toBe(3);
    expect(result.violations).toHaveLength(2);

    expect(result.violations[0]).toEqual({
      id: 'color-contrast',
      impact: 'serious',
      nodes: 3,
      help: 'Elements must have sufficient color contrast',
      helpUrl: 'https://dequeuniversity.com/rules/axe/4.8/color-contrast',
    });
  });

  it('coerces a missing/null impact to "unknown"', async () => {
    const collector = new AxeCollector();
    const result = await collector.collect(fakeCtx());

    expect(result.violations[1].impact).toBe('unknown');
    expect(result.violations[1].nodes).toBe(1);
  });
});
