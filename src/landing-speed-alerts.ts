// SPDX-License-Identifier: Apache-2.0
import { z } from 'zod';
import type { HostedLandingState } from './hosted-landing.js';
import { digest } from './portable-hash.js';
import { percentile } from './self-metrics-joins.js';
import { costGuardSchema, costBudgetSchema } from './cost-budgets.js';

/** Speed budgets (b7851c44). The numbers, their sources and reasons live in
 * src/speed-budgets.json; this module only judges landings against them. A budget is
 * judged on the last `window.landings` landings, never on one outlier. */
export const speedBudgetSchema = z
  .object({
    id: z.string().regex(/^[a-z0-9-]+$/),
    area: z.string().min(1),
    /** landing-record: judged on every landing from stamps it already carries. perf-harness: measured
     * by scripts/perf-harness.mjs. build-guard: enforced by a check that fails the build. unrecorded:
     * nothing records the value yet; the report says so and names the gap. */
    measuredBy: z.enum(['landing-record', 'perf-harness', 'build-guard', 'unrecorded']),
    metric: z.string().min(1),
    /** mean: cost budgets, where every landing's share adds up; p50/p90: speed budgets. */
    stat: z.enum(['p50', 'p90', 'mean']).optional(),
    unit: z.enum(['min', 's', 'ms', 'calls', 'bytes', 'attempts', 'writes']),
    max: z.number().min(0).nullable(),
    source: z.string().min(1),
    reason: z.string().min(1),
    /** The decision Issue (first 8 characters) this budget protects. */
    issue: z
      .string()
      .regex(/^[0-9a-f]{8}$/)
      .optional(),
  })
  .strict();
export const speedBudgetsSchema = z
  .object({
    schema: z.literal(1),
    window: z.object({ landings: z.number().int().min(5).max(30) }).strict(),
    budgets: z.array(speedBudgetSchema).min(1),
    /** Per-landing cost ledger judged on change by the landing check (src/cost-budgets.ts). */
    costGuard: costGuardSchema,
    costs: z.array(costBudgetSchema).min(1),
  })
  .strict();
export type SpeedBudget = z.infer<typeof speedBudgetSchema>;
export type SpeedBudgets = z.infer<typeof speedBudgetsSchema>;
/** attempts and writes are cost counts (Issue 3e3f9fe6): the landing's attempts (each a compose and a
 * check or a reuse) and its landing-state writes (the mutations of its own landing path). */
export type LandingMetric = 'toMain' | 'check' | 'settle' | 'attempts' | 'writes';
type Stat = 'p50' | 'p90' | 'mean';
const METRICS: LandingMetric[] = ['toMain', 'check', 'settle', 'attempts', 'writes'];
const INDEX: Record<LandingMetric, number> = { toMain: 1, check: 2, settle: 4, attempts: 5, writes: 6 };
const isLanding = (b: SpeedBudget): b is SpeedBudget & { metric: LandingMetric; stat: Stat; max: number } =>
  b.measuredBy === 'landing-record' && !!b.stat && b.max !== null && (METRICS as string[]).includes(b.metric);
/** The budgets a landing's own stamps can judge. */
export const landingBudgets = (budgets: SpeedBudgets) => budgets.budgets.filter(isLanding);

const minute = 60_000;
/** Retained samples per project (about 2 KB): the window plus gaps where a stamp was missing. */
const MAX_SAMPLES = 60;
const sampleSchema = z.tuple([
  z.number().int(),
  z.number().nullable(),
  z.number().nullable(),
  z.string(),
  // Seconds from the check result to the commit; absent on rows written before this budget.
  z.number().nullable().optional(),
  // Attempts and landing-state writes (cost counts); absent on rows written before them.
  z.number().nullable().optional(),
  z.number().nullable().optional(),
]);
const brokenSchema = z
  .object({
    since: z.iso.datetime(),
    landing: z.string(),
    value: z.number(),
    stage: z.string().optional(),
  })
  .strict();
export const landingSpeedStateSchema = z
  .object({
    schema: z.literal(2),
    /** [settled at ms, time-to-main minutes, check minutes, landing id, settle seconds, attempts,
     * landing-state writes], oldest first. */
    samples: z.array(sampleSchema),
    /** Budgets over their limit now, by budget id: one entry means one alert and one Issue. */
    broken: z.record(z.string(), brokenSchema),
  })
  .strict();
export type LandingSpeedState = z.infer<typeof landingSpeedStateSchema>;
export type LandingSpeedSample = {
  at: number;
  /** The landed state's acceptance receipt: names the landing that crossed a budget. */
  id: string;
  toMain: number | null;
  check: number | null;
  /** Seconds from the check result (ciEndedAt) to the commit: the gap the landing supervisor must keep short. */
  settle: number | null;
  /** Attempts this landing took (1 when nothing recomposed or re-ran), and its landing-state writes. */
  attempts?: number | null;
  writes?: number | null;
  /** Minutes in each stage of this landing: waiting and composing, check, settling. */
  stages: { queue: number | null; check: number | null; settle: number | null };
};
export type SpeedBudgetEvent = {
  kind: 'broken' | 'recovered';
  budget: SpeedBudget;
  /** The statistic over the window now. */
  value: number;
  landing: string;
  since: string;
  /** The longest stage of the landing that crossed (broken only). */
  stage?: string;
};

const span = (from?: string, to?: string, unit = minute) => {
  if (!from || !to) return null;
  const value = (Date.parse(to) - Date.parse(from)) / unit;
  return Number.isFinite(value) && value >= 0 ? Math.round(value * 10) / 10 : null;
};
/** Data already on the landed state: no extra read. Missing stamps leave that metric unknown.
 * `attempts` comes from the accepted attempt the accept mutation already holds. */
export function landingSpeedSample(
  state: HostedLandingState,
  attempts: number | null = null,
): LandingSpeedSample | null {
  const timing = state.timing;
  const at = Date.parse(timing?.committedAt ?? timing?.settledAt ?? '');
  if (!timing || !Number.isFinite(at)) return null;
  return {
    at,
    id: state.acceptance?.receiptId ?? state.id,
    toMain: span(timing.submittedAt, timing.committedAt),
    check: span(timing.checkReservedAt, timing.ciEndedAt),
    settle: span(timing.ciEndedAt, timing.committedAt, 1000),
    attempts,
    // The landing state starts at version 0 and every write adds one (projectHostedLandingStore).
    writes: Number.isSafeInteger(state.version) ? state.version + 1 : null,
    stages: {
      queue: span(timing.submittedAt, timing.checkReservedAt),
      check: span(timing.checkReservedAt, timing.ciEndedAt),
      settle: span(timing.ciEndedAt, timing.committedAt),
    },
  };
}

const round = (value: number) => Math.round(value * 10) / 10;
const STAGE_LABEL = { queue: 'queue and compose', check: 'check', settle: 'settle after the check' } as const;
/** The area to look at first: the longest stage of the landing that crossed. */
export function longestStage(stages: LandingSpeedSample['stages']) {
  const known = (Object.entries(stages) as [keyof typeof STAGE_LABEL, number | null][]).filter(
    (entry): entry is [keyof typeof STAGE_LABEL, number] => entry[1] !== null,
  );
  const top = known.sort((a, b) => b[1] - a[1])[0];
  return top ? `${STAGE_LABEL[top[0]]} (${top[1]} min)` : undefined;
}

/** The statistic over the last `window` landings that know the metric; null until a full window exists. */
export function windowValue(
  samples: LandingSpeedState['samples'],
  metric: LandingMetric,
  stat: Stat,
  window: number,
) {
  const index = INDEX[metric];
  const values = samples.flatMap(row => (row[index] == null ? [] : [row[index] as number])).slice(-window);
  if (values.length < window) return null;
  if (stat === 'mean') return round(values.reduce((sum, value) => sum + value, 0) / values.length);
  return round(percentile(values, stat === 'p50' ? 0.5 : 0.9)!);
}

/** Pure: append one landing and report each budget it breaks or recovers. A budget alerts once when
 * it breaks and once when it recovers; while it stays broken nothing repeats. */
export function observeLandingSpeed(
  previous: LandingSpeedState | null,
  sample: LandingSpeedSample,
  budgets: SpeedBudgets,
): { state: LandingSpeedState; events: SpeedBudgetEvent[] } {
  const samples = [
    ...(previous?.samples ?? []),
    [
      sample.at,
      sample.toMain,
      sample.check,
      sample.id,
      sample.settle,
      sample.attempts ?? null,
      sample.writes ?? null,
    ] as const,
  ]
    .sort((a, b) => a[0] - b[0])
    .slice(-MAX_SAMPLES)
    .map(
      ([at, toMain, check, id, settle, attempts, writes]) =>
        [at, toMain, check, id, settle ?? null, attempts ?? null, writes ?? null] as Row,
    );
  const broken = { ...previous?.broken };
  const events: SpeedBudgetEvent[] = [];
  for (const budget of landingBudgets(budgets)) {
    const value = windowValue(samples, budget.metric, budget.stat, budgets.window.landings);
    if (value === null) continue;
    const open = broken[budget.id];
    if (value > budget.max && !open) {
      const stage = longestStage(sample.stages);
      const since = new Date(sample.at).toISOString();
      broken[budget.id] = { since, landing: sample.id, value, ...(stage ? { stage } : {}) };
      events.push({ kind: 'broken', budget, value, landing: sample.id, since, ...(stage ? { stage } : {}) });
    } else if (value <= budget.max && open) {
      delete broken[budget.id];
      events.push({ kind: 'recovered', budget, value, landing: open.landing, since: open.since });
    }
  }
  return { state: { schema: 2, samples, broken }, events };
}
type Row = [number, number | null, number | null, string, number | null, number | null, number | null];

const NAME: Record<LandingMetric, string> = {
  toMain: 'landing to main',
  check: 'check',
  settle: 'check result to commit',
  attempts: 'attempts per landing',
  writes: 'landing-state writes per landing',
};
const describe = (b: SpeedBudget) => `${NAME[b.metric as LandingMetric]} ${b.stat}`;
const NEXT: Record<LandingMetric, string> = {
  toMain:
    'Next: run `nforge metrics ROOT --text` for waste by cause and main-race re-checks; ' +
    'if queue or compose gaps grew, run the landing-loop dry micro-bench (regression ladder rung 2) on the latest landing-loop change.',
  settle:
    'Next: read the landing supervisor path (settle step, finish wake, order waits) on the crossing landing with ' +
    '`nforge agent ROOT landings` (heldAfterCheck) and compare with the latest change to convex/projectHostedLanding* ' +
    'or the acceptance publish; the gap was 300 s before fix caa934a7 and about 8.5 s after.',
  attempts:
    'Next: run `nforge agent ROOT landings` for the window and look at recomposeCount and checkRunIds; ' +
    'more attempts per landing means recompose or re-check loops (incident 10d253c6), each a compose and a check.',
  writes:
    'Next: compare the landing-state writes of the crossing landing with its attempts; writes rising with flat ' +
    'attempts means the landing path writes its state more often per step: read the latest change to ' +
    'convex/projectHostedLanding* (the landing check cost guard counts the same path on a fixture).',
  check:
    'Next: run `nforge metrics ROOT --text` for check minutes and flaky files; ' +
    'compare the slowest test files with the previous week and the latest change to the verify script or check runner.',
};
const lastLandings = (budgets: SpeedBudgets) => `the last ${budgets.window.landings} landings`;

/** The owner-facing message: which budget, which landing crossed it, where to look, the next step. */
export function speedBudgetMessage(event: SpeedBudgetEvent, project: string, budgets: SpeedBudgets) {
  const b = event.budget;
  const head = `${describe(b)} over ${lastLandings(budgets)} is ${event.value} ${b.unit}; budget ${b.max} ${b.unit}.`;
  return event.kind === 'broken'
    ? {
        subject: `[Forge] Speed budget broken: ${describe(b)}: ${project}`,
        text: [
          `Speed budget ${b.id} broke on ${project}: ${head}`,
          `Crossed by landing ${event.landing.slice(0, 8)} (${b.area})${event.stage ? `; its longest stage was ${event.stage}` : ''}.`,
          `Budget source: ${b.source}`,
          NEXT[b.metric as LandingMetric],
          'One P0 Issue tracks this budget; this alert does not repeat while it stays broken, and a recovery message follows.',
        ].join('\n'),
      }
    : {
        subject: `[Forge] Speed budget recovered: ${describe(b)}: ${project}`,
        text: `Speed budget ${b.id} is back within budget on ${project}: ${head} It had been broken since ${event.since} (landing ${event.landing.slice(0, 8)}).`,
      };
}

const uuid = (seed: string) => {
  const hex = digest(seed).slice(0, 32).split('');
  hex[12] = '4';
  hex[16] = '8';
  return `${hex.slice(0, 8).join('')}-${hex.slice(8, 12).join('')}-${hex.slice(12, 16).join('')}-${hex.slice(16, 20).join('')}-${hex.slice(20, 32).join('')}`;
};
export const speedBudgetIssueSchema = z
  .object({
    itemId: z.uuid(),
    putOperationId: z.uuid(),
    commentOperationId: z.uuid(),
    title: z.string(),
    body: z.string(),
    comment: z.string(),
    reopen: z.boolean(),
  })
  .strict();
/** One P0 Issue per budget, found again by its fixed id: a repeat break reopens it, never duplicates it.
 * Operation ids name the transition, so a retried write reconciles. */
export function speedBudgetIssue(event: SpeedBudgetEvent, projectId: string, budgets: SpeedBudgets) {
  const b = event.budget;
  const operation = (what: string) =>
    uuid(`speed-budget:${projectId}:${b.id}:${event.kind}:${event.landing}:${what}`);
  return speedBudgetIssueSchema.parse({
    itemId: uuid(`speed-budget:${projectId}:${b.id}`),
    putOperationId: operation('put'),
    commentOperationId: operation('comment'),
    title: `P0 speed budget broken: ${describe(b)} (${b.area})`,
    body: [
      `Opened by Forge. Budget \`${b.id}\`: ${describe(b)} over ${lastLandings(budgets)} must stay at or under ${b.max} ${b.unit}.`,
      '',
      `Crossed by landing \`${event.landing}\` at ${event.since}. Area: ${b.area}.`,
      `Budget source: ${b.source}`,
      `Reason: ${b.reason}`,
      ...(b.issue ? [`Decision it protects: Issue ${b.issue}.`] : []),
      '',
      'Fix the cause, not the budget. Forge comments here when the budget recovers; close the Issue once the fix is verified.',
    ].join('\n'),
    comment: speedBudgetMessage(event, 'this project', budgets).text,
    reopen: event.kind === 'broken',
  });
}
