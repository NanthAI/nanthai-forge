// SPDX-License-Identifier: Apache-2.0
import { z } from 'zod';

/** Cost ledger (Issue 3e3f9fe6): per-landing quantities in src/speed-budgets.json `costs`, each with its
 * value, source and the decision Issue it protects. The landing check measures them on a scripted
 * landing fixture (tests/landing-cost-guard.test.mjs) and judges the change here: deterministic counts,
 * never live billing. Live drift uses the speed-budget path (`attempts`, `writes` in `budgets`). */
export const costGuardSchema = z
  .object({
    /** A rise past this percentage fails the check, a rise past `warnPct` warns, a drop of `ratchetPct`
     * asks the author to lower the value. A change within an entry's `floor` is neither. */
    failPct: z.number().positive(),
    warnPct: z.number().positive(),
    ratchetPct: z.number().positive(),
    /** The scripted landings the fixture runs; the values are their total divided by the landings. */
    scenario: z.string().min(1),
    /** Modeled action GB-seconds: executions times memory times a nominal duration from the captures. */
    actionModel: z
      .object({
        v8: z.object({ gb: z.number().positive(), seconds: z.number().positive() }).strict(),
        node: z.object({ gb: z.number().positive(), seconds: z.number().positive() }).strict(),
        source: z.string().min(1),
      })
      .strict(),
    /** Live dollars per 1,000 landings by family, from the latest capture: context, never judged. */
    reference: z
      .array(
        z
          .object({ family: z.string().min(1), usdPer1000: z.number().min(0).nullable(), source: z.string() })
          .strict(),
      )
      .min(1),
  })
  .strict();
export const costBudgetSchema = z
  .object({
    id: z.string().regex(/^[a-z0-9-]+$/),
    area: z.string().min(1),
    /** landing-, snapshot-, planning- and trial-merge-fixture: judged on change by the landing check. capture: a
     * live number for reading, judged nowhere (no deterministic measure exists). */
    measuredBy: z.enum([
      'landing-fixture',
      'snapshot-fixture',
      'planning-fixture',
      'trial-merge-fixture',
      'capture',
    ]),
    metric: z.string().min(1),
    unit: z.enum(['calls', 'reads', 'bytes', 'GB-s', 'ops', 'runs', 'uploads', 'min']),
    /** Per accepted landing (snapshot-fixture: per changed snapshot; planning-fixture: per planning write or search; trial-merge-fixture: per save). */
    value: z.number().min(0),
    /** Absolute change a measurement may move before any rule applies, so tiny counts never flap. */
    floor: z.number().min(0),
    source: z.string().min(20),
    issue: z.string().regex(/^[0-9a-f]{8}$/),
    reason: z.string().min(20),
  })
  .strict();
export type CostGuard = z.infer<typeof costGuardSchema>;
export type CostBudget = z.infer<typeof costBudgetSchema>;
export type CostVerdict = {
  id: string;
  metric: string;
  unit: CostBudget['unit'];
  issue: string;
  before: number;
  after: number | null;
  status: 'pass' | 'warn' | 'fail' | 'ratchet';
  message: string | null;
};

const round = (value: number) => (Math.abs(value) >= 100 ? Math.round(value) : Math.round(value * 100) / 100);
const pct = (value: number) =>
  value === Infinity ? 'new, was 0' : `${value > 0 ? '+' : ''}${Math.round(value * 1000) / 10}%`;
const OUT =
  'Two ways out: fix the change, or update this entry in src/speed-budgets.json (`costs`: value, source, reason) ' +
  'in this same Lane, so the new number is reviewed with the change.';

/** Judge one measured value against its ledger entry. */
export function judgeCost(budget: CostBudget, after: number | null, guard: CostGuard): CostVerdict {
  const base = { id: budget.id, metric: budget.metric, unit: budget.unit, issue: budget.issue };
  const before = budget.value;
  const head = (verb: string, change: string) =>
    `Cost budget ${budget.id} ${verb}: ${round(before)} -> ${round(after!)} ${budget.unit} per landing (${change}). ` +
    `Area: ${budget.area}. Decision it protects: Issue ${budget.issue}.`;
  if (after === null || !Number.isFinite(after))
    return {
      ...base,
      before,
      after: null,
      status: 'fail',
      message: `Cost budget ${budget.id} was not measured: the fixture reported no ${budget.metric}. ${OUT}`,
    };
  const delta = after - before;
  // From zero, any rise past the floor is a new cost on the landing path.
  const change = before > 0 ? delta / before : delta > 0 ? Infinity : 0;
  const verdict = (status: CostVerdict['status'], message: string | null) => ({
    ...base,
    before,
    after: round(after),
    status,
    message,
  });
  if (Math.abs(delta) <= budget.floor) return verdict('pass', null);
  if (change * 100 > guard.failPct)
    return verdict('fail', `${head('rose', `${pct(change)}, fails above +${guard.failPct}%`)} ${OUT}`);
  if (change * 100 > guard.warnPct)
    return verdict(
      'warn',
      `${head('rose', `${pct(change)}, warns above +${guard.warnPct}%`)} Within the fail line; ` +
        'say in the landing note why, or fix it.',
    );
  if (-change * 100 >= guard.ratchetPct)
    return verdict(
      'ratchet',
      `${head('fell', pct(change))} Lower its value to ${round(after)} in src/speed-budgets.json (source: ` +
        'this fixture run and the change that saved it), so the saving ratchets in and cannot quietly come back.',
    );
  return verdict('pass', null);
}

/** Every ledger entry the given measurer judges, against what it measured (by metric name). */
export function judgeCosts(
  costs: CostBudget[],
  guard: CostGuard,
  measuredBy: CostBudget['measuredBy'],
  measured: Record<string, number>,
) {
  return costs
    .filter(budget => budget.measuredBy === measuredBy)
    .map(budget => judgeCost(budget, measured[budget.metric] ?? null, guard));
}

/** Check-log lines: one per entry, then each message. */
export function formatCostVerdicts(verdicts: CostVerdict[]) {
  return [
    'Cost budgets per landing (ledger -> measured; src/speed-budgets.json, docs/operations.md#cost-budgets):',
    ...verdicts.map(
      v => `  ${v.status.padEnd(7)} ${v.id}: ${round(v.before)} -> ${v.after ?? 'unmeasured'} ${v.unit}`,
    ),
    ...verdicts.flatMap(v => (v.message ? [v.message] : [])),
  ];
}
