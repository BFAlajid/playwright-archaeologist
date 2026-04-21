/**
 * Performance budget enforcement.
 *
 * Reads `test/performance/budget.json` (required) and the most recent
 * `bench-results.json` (optional — produced by `npm run bench:ci`).
 * For each bench metric where both files have an entry, asserts that
 * the observed value is ≤ the budget's `max`.
 *
 * When `bench-results.json` does not exist, the budget file is still
 * validated for shape and the enforcement tests are skipped with a
 * clear message. This keeps the unit-test CI lane green while letting
 * the bench lane enforce regressions.
 *
 * NB: The current bench files measure inlined fakes (see TODO comment
 * at the top of each `.bench.ts` file). Until those are rewritten to
 * call the real modules from `src/`, budget enforcement is an early-
 * warning signal rather than a production gate.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// ---------------------------------------------------------------------------
// File locations
// ---------------------------------------------------------------------------

const __dirname = dirname(fileURLToPath(import.meta.url));
const BUDGET_PATH = resolve(__dirname, 'budget.json');
const ROOT = resolve(__dirname, '..', '..');
const BENCH_RESULTS_PATH = resolve(ROOT, 'bench-results.json');

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface BudgetMetric {
  target?: number;
  max?: number;
  value?: number;
  unit?: string;
  notes?: string;
}

type BudgetTree = Record<string, Record<string, BudgetMetric>>;

interface VitestBenchTask {
  name?: string;
  result?: {
    benchmarks?: Array<{
      name?: string;
      mean?: number;
      min?: number;
      max?: number;
      hz?: number;
    }>;
    duration?: number;
  };
  tasks?: VitestBenchTask[];
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function loadBudget(): BudgetTree {
  const raw = readFileSync(BUDGET_PATH, 'utf-8');
  const parsed = JSON.parse(raw) as Record<string, unknown>;
  // Strip top-level metadata keys ($schema, description, version).
  const categories: BudgetTree = {};
  for (const [key, value] of Object.entries(parsed)) {
    if (key.startsWith('$') || key === 'description' || key === 'version') continue;
    if (typeof value === 'object' && value !== null) {
      categories[key] = value as Record<string, BudgetMetric>;
    }
  }
  return categories;
}

/**
 * Extract a flat map of `benchName -> mean_ms` from Vitest's bench output.
 * Vitest emits a tree of tasks; benchmarks live on the innermost nodes.
 */
function flattenBenchResults(node: VitestBenchTask, out: Map<string, number>): void {
  if (Array.isArray(node.tasks)) {
    for (const child of node.tasks) flattenBenchResults(child, out);
  }
  const benches = node.result?.benchmarks;
  if (Array.isArray(benches)) {
    for (const b of benches) {
      if (typeof b.name === 'string' && typeof b.mean === 'number') {
        out.set(b.name, b.mean);
      }
    }
  }
}

function loadBenchResultsIfAvailable(): Map<string, number> | null {
  if (!existsSync(BENCH_RESULTS_PATH)) return null;
  const raw = readFileSync(BENCH_RESULTS_PATH, 'utf-8');
  const parsed = JSON.parse(raw) as { files?: VitestBenchTask[]; tasks?: VitestBenchTask[] };
  const out = new Map<string, number>();
  // Vitest JSON reporter varies across versions; handle both shapes.
  const roots: VitestBenchTask[] = Array.isArray(parsed.files)
    ? parsed.files
    : Array.isArray(parsed.tasks)
      ? parsed.tasks
      : [];
  for (const root of roots) flattenBenchResults(root, out);
  return out;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('budget.json shape', () => {
  it('is valid JSON with at least one category', () => {
    const budget = loadBudget();
    expect(Object.keys(budget).length).toBeGreaterThan(0);
  });

  it('every metric has a `unit` and either `max` or `value`', () => {
    const budget = loadBudget();
    for (const [category, metrics] of Object.entries(budget)) {
      for (const [name, metric] of Object.entries(metrics)) {
        expect(typeof metric.unit === 'string', `${category}.${name}.unit missing`).toBe(true);
        const hasLimit = typeof metric.max === 'number' || typeof metric.value === 'number';
        expect(hasLimit, `${category}.${name} has neither .max nor .value`).toBe(true);
      }
    }
  });

  it('every .max value is positive and finite', () => {
    const budget = loadBudget();
    for (const [category, metrics] of Object.entries(budget)) {
      for (const [name, metric] of Object.entries(metrics)) {
        if (typeof metric.max === 'number') {
          expect(Number.isFinite(metric.max), `${category}.${name}.max not finite`).toBe(true);
          expect(metric.max > 0, `${category}.${name}.max must be > 0`).toBe(true);
        }
      }
    }
  });

  it('every .target (if present) is ≤ the corresponding .max', () => {
    // A misconfigured budget where target > max would always trigger a
    // warning — catch it at config-validation time.
    const budget = loadBudget();
    for (const [category, metrics] of Object.entries(budget)) {
      for (const [name, metric] of Object.entries(metrics)) {
        if (typeof metric.target === 'number' && typeof metric.max === 'number') {
          expect(
            metric.target <= metric.max,
            `${category}.${name}: target (${metric.target}) must be <= max (${metric.max})`,
          ).toBe(true);
        }
      }
    }
  });
});

describe('bench-results enforcement', () => {
  const results = loadBenchResultsIfAvailable();

  it('skips gracefully when bench-results.json does not exist', () => {
    // Intentional no-op. Documents the contract: running `npm run test:bench-check`
    // without first running `npm run bench:ci` does not fail — it just has
    // nothing to check. This keeps the unit lane green.
    if (!results) {
      expect(existsSync(BENCH_RESULTS_PATH)).toBe(false);
      return;
    }
    // Present: the next test will exercise enforcement below.
    expect(results.size).toBeGreaterThanOrEqual(0);
  });

  it.skipIf(!results)('no bench metric exceeds its .max budget', () => {
    if (!results) return; // TypeScript narrowing (skipped above)
    const budget = loadBudget();

    // Flatten the budget tree into a bench-name → max map. Bench names in
    // the results are free-form strings (e.g. "enqueue 1000 URLs"); matching
    // to the budget is done by including the budget metric name in the
    // bench name, case-insensitively. This is deliberately loose so new
    // benches automatically get checked against their named budget.
    const budgetEntries: Array<{ category: string; key: string; max: number }> = [];
    for (const [category, metrics] of Object.entries(budget)) {
      for (const [key, metric] of Object.entries(metrics)) {
        if (typeof metric.max === 'number') {
          budgetEntries.push({ category, key, max: metric.max });
        }
      }
    }

    const regressions: string[] = [];
    for (const [benchName, observedMs] of results) {
      for (const entry of budgetEntries) {
        // Match the bench name to a budget key by fuzzy substring.
        const keyLower = entry.key.toLowerCase();
        const benchLower = benchName.toLowerCase();
        if (!benchLower.includes(keyLower.slice(0, 8))) continue;

        if (observedMs > entry.max) {
          regressions.push(
            `${entry.category}.${entry.key}: ${observedMs.toFixed(2)}ms > ${entry.max}ms (bench: "${benchName}")`,
          );
        }
      }
    }

    expect(regressions, `Budget regressions:\n  - ${regressions.join('\n  - ')}`).toEqual([]);
  });
});
