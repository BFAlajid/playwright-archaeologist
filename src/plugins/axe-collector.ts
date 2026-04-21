/**
 * Axe-core accessibility collector.
 *
 * Runs axe-core against the page and returns a compact, JSON-serializable
 * summary of violations + counts. Uses `@axe-core/playwright`, which injects
 * axe into the page context and collects results via `page.evaluate`.
 *
 * Output is intentionally shallow: violation id, impact, node count, help
 * text, and help URL. We do not emit full `node` arrays because those can
 * be large and contain serialized selectors that we would need to scrub.
 */

import { AxeBuilder } from '@axe-core/playwright';
import type { Collector, CollectorContext } from './types.js';

export interface AxeViolation {
  id: string;
  /** WCAG impact level reported by axe. */
  impact: string;
  /** Number of DOM nodes that violated this rule. */
  nodes: number;
  /** Short, human-readable description. */
  help: string;
  /** URL to the axe rule documentation. */
  helpUrl: string;
}

export interface AxeResult {
  violations: AxeViolation[];
  /** Number of rules that passed. */
  passes: number;
  /** Number of rules axe could not complete for this page. */
  incomplete: number;
  /** Number of rules that were inapplicable to the page. */
  inapplicable: number;
}

/**
 * In-tree axe-core collector. Registered via the CLI `--with-a11y` flag
 * or programmatically by pushing `new AxeCollector()` into the collector
 * registry.
 */
export class AxeCollector implements Collector<AxeResult> {
  readonly name = 'axe';

  async collect(ctx: CollectorContext): Promise<AxeResult> {
    const results = await new AxeBuilder({ page: ctx.page }).analyze();
    return {
      violations: results.violations.map((v) => ({
        id: v.id,
        impact: v.impact ?? 'unknown',
        nodes: v.nodes.length,
        help: v.help,
        helpUrl: v.helpUrl,
      })),
      passes: results.passes.length,
      incomplete: results.incomplete.length,
      inapplicable: results.inapplicable.length,
    };
  }
}
