// SPDX-License-Identifier: Apache-2.0
import { z } from 'zod';
import { contractTestPath } from './intent-test-contract.js';

const member = z.object({
  acceptedSequence: z.number().safe().nonnegative().optional(),
  intentId: z.uuid(),
  outcome: z.string(),
  version: z.number().int().positive(),
  tests: z.array(z.object({ path: contractTestPath, durationMs: z.number().positive() })),
});
const expandedSemanticPlanSchema = z.object({
  primaryIntentId: z.uuid(),
  afterSequence: z.number().safe().nonnegative().optional(),
  members: z.array(member),
});
const indexedSemanticPlanSchema = expandedSemanticPlanSchema
  .extend({
    format: z.literal('indexed-tests-v1'),
    paths: z.array(contractTestPath),
    members: z.array(
      member.omit({ tests: true }).extend({
        tests: z.array(z.tuple([z.number().safe().nonnegative(), z.number().finite().positive()])),
      }),
    ),
  })
  .superRefine((plan, ctx) => {
    if (plan.members.some(member => member.tests.some(([index]) => index >= plan.paths.length)))
      ctx.addIssue({ code: 'custom', message: 'Semantic test reference is outside the path dictionary.' });
  })
  .transform(plan => ({
    primaryIntentId: plan.primaryIntentId,
    ...(plan.afterSequence !== undefined ? { afterSequence: plan.afterSequence } : {}),
    members: plan.members.map(member => ({
      ...member,
      tests: member.tests.map(([index, durationMs]) => ({ path: plan.paths[index]!, durationMs })),
    })),
  }));
export const semanticPlanSchema = z.unknown().transform((value, ctx) => {
  const indexed = value !== null && typeof value === 'object' && 'format' in value;
  const result = (indexed ? indexedSemanticPlanSchema : expandedSemanticPlanSchema.strict()).safeParse(value);
  if (result.success) return result.data;
  ctx.addIssue({ code: 'custom', message: 'Invalid semantic contract plan.' });
  return z.NEVER;
});
/** Shared paths are encoded once; measurements and contract membership stay exact. */
export function indexedSemanticPlan(value: z.infer<typeof expandedSemanticPlanSchema>) {
  const paths: string[] = [],
    indexes = new Map<string, number>();
  return {
    ...value,
    format: 'indexed-tests-v1' as const,
    paths,
    members: value.members.map(member => ({
      ...member,
      tests: member.tests.map(test => {
        let index = indexes.get(test.path);
        if (index === undefined) {
          index = paths.length;
          paths.push(test.path);
          indexes.set(test.path, index);
        }
        return [index, test.durationMs];
      }),
    })),
  };
}
export const semanticConflictSchema = z.object({
  kind: z.literal('intent-semantic'),
  candidateId: z.uuid(),
  head: z.string().regex(/^[0-9a-f]{40}(?:[0-9a-f]{24})?$/),
  runId: z.uuid(),
  intents: z.tuple([member.omit({ tests: true }), member.omit({ tests: true })]),
  tests: z.array(contractTestPath),
  failedTests: z.array(contractTestPath),
  measuredMs: z.number().finite().nonnegative(),
});
export const semanticReportsSchema = z.record(
  contractTestPath,
  z.object({ durationMs: z.number().finite().positive(), failed: z.boolean() }).strict(),
);
export type SemanticPlan = z.infer<typeof semanticPlanSchema>;
export type SemanticConflict = z.infer<typeof semanticConflictSchema>;

const index = z.number().safe().nonnegative();
const indexedConflicts = z
  .object({
    format: z.literal('indexed-conflicts-v1'),
    paths: z.array(contractTestPath),
    intents: z.array(member.omit({ tests: true })),
    pins: z.array(semanticConflictSchema.pick({ candidateId: true, head: true, runId: true })),
    records: z.array(
      z.object({
        p: index,
        i: z.tuple([index, index]),
        t: z.array(index),
        f: z.array(index),
        m: z.number().finite().nonnegative(),
      }),
    ),
  })
  .superRefine((value, ctx) => {
    if (
      value.records.some(
        record =>
          record.p >= value.pins.length ||
          record.i.some(index => index >= value.intents.length) ||
          [...record.t, ...record.f].some(index => index >= value.paths.length),
      )
    )
      ctx.addIssue({ code: 'custom', message: 'Semantic conflict reference is out of bounds.' });
  })
  .transform(value =>
    value.records.map(record => ({
      kind: 'intent-semantic' as const,
      ...value.pins[record.p]!,
      intents: [value.intents[record.i[0]]!, value.intents[record.i[1]]!] as SemanticConflict['intents'],
      tests: record.t.map(index => value.paths[index]!),
      failedTests: record.f.map(index => value.paths[index]!),
      measuredMs: record.m,
    })),
  );
export const semanticConflictsSchema = z.unknown().transform((value, ctx) => {
  const result = (Array.isArray(value) ? z.array(semanticConflictSchema) : indexedConflicts).safeParse(value);
  if (result.success) return result.data;
  ctx.addIssue({ code: 'custom', message: 'Invalid semantic conflict records.' });
  return z.NEVER;
});
export function indexedSemanticConflicts(conflicts: SemanticConflict[]) {
  const paths: string[] = [],
    intents: SemanticConflict['intents'][number][] = [],
    pins: Pick<SemanticConflict, 'candidateId' | 'head' | 'runId'>[] = [];
  const pathIndex = new Map<string, number>(),
    intentIndex = new Map<string, number>(),
    pinIndex = new Map<string, number>();
  function intern<T>(items: T[], indexes: Map<string, number>, key: string, value: T) {
    let index = indexes.get(key);
    if (index === undefined) {
      index = items.length;
      items.push(value);
      indexes.set(key, index);
    }
    return index;
  }
  return {
    format: 'indexed-conflicts-v1' as const,
    paths,
    intents,
    pins,
    records: conflicts.map(conflict => ({
      p: intern(pins, pinIndex, JSON.stringify([conflict.candidateId, conflict.head, conflict.runId]), {
        candidateId: conflict.candidateId,
        head: conflict.head,
        runId: conflict.runId,
      }),
      i: conflict.intents.map(intent => intern(intents, intentIndex, JSON.stringify(intent), intent)),
      t: conflict.tests.map(path => intern(paths, pathIndex, path, path)),
      f: conflict.failedTests.map(path => intern(paths, pathIndex, path, path)),
      m: conflict.measuredMs,
    })),
  };
}

export const activeSemanticMembers = (plan?: SemanticPlan) =>
  plan?.members.filter(
    member =>
      member.intentId === plan.primaryIntentId ||
      plan.afterSequence === undefined ||
      member.acceptedSequence === undefined ||
      member.acceptedSequence > plan.afterSequence,
  ) ?? [];
export const semanticTests = (plan?: SemanticPlan) => {
  const members = activeSemanticMembers(plan);
  return members.length > 1 && members.some(member => member.intentId === plan?.primaryIntentId)
    ? [...new Set(members.flatMap(member => member.tests.map(test => test.path)))].sort()
    : [];
};
export function semanticVerdict(
  plan: SemanticPlan | undefined,
  reports: Record<string, { durationMs: number; failed: boolean }>,
  pins: { candidateId: string; head: string; runId: string },
) {
  const conflicts: SemanticConflict[] = [];
  let overBudget: { measuredMs: number; intents: string[] } | undefined;
  const left = plan?.members.find(member => member.intentId === plan.primaryIntentId);
  for (const right of activeSemanticMembers(plan)) {
    if (!left || left.intentId === right.intentId) continue;
    const tests = [...new Set([...left.tests, ...right.tests].map(test => test.path))].sort();
    if (!tests.length || tests.some(test => !reports[test])) continue;
    const measuredMs = tests.reduce((total, test) => total + reports[test]!.durationMs, 0);
    if (measuredMs >= 90_000) {
      overBudget = { measuredMs, intents: [left.intentId, right.intentId] };
      continue;
    }
    const failedTests = tests.filter(test => reports[test]!.failed);
    if (failedTests.length) {
      const { tests: _left, ...a } = left,
        { tests: _right, ...b } = right;
      void _left;
      void _right;
      conflicts.push({ kind: 'intent-semantic', ...pins, intents: [a, b], tests, failedTests, measuredMs });
    }
  }
  return { conflicts, overBudget };
}
export function semanticConflictMessage(conflicts: SemanticConflict[]) {
  const first = conflicts[0];
  if (!first) return '';
  return `Intent semantic conflict: ${first.intents.map(intent => `${intent.outcome} (${intent.intentId})`).join(' + ')}; contract tests failed together on ${first.head}: ${first.failedTests.join(', ')}; run ${first.runId}.${conflicts.length > 1 ? ` ${conflicts.length - 1} additional named conflicts are retained in semanticConflicts.` : ''}`;
}
