// SPDX-License-Identifier: Apache-2.0
import { z } from 'zod';
import type { semanticVerdict } from './intent-semantic-conflict.js';

export const batchMemberDetailSchema = z
  .object({
    submissionId: z.uuid(),
    intentId: z.uuid(),
    outcome: z.string(),
    paths: z.array(z.string()),
    tests: z.array(z.string()),
  })
  .strict();
const budgetPair = z.object({ measuredMs: z.number().nonnegative(), intents: z.array(z.uuid()) }).strict();
export const batchFailureSchema = z
  .object({
    runId: z.uuid(),
    failedTests: z.array(z.string()),
    suspects: z.array(z.uuid()),
    pairs: z.array(
      z
        .object({ members: z.tuple([z.uuid(), z.uuid()]), tests: z.array(z.number().safe().nonnegative()) })
        .strict(),
    ),
    overBudgetPairs: z.array(budgetPair),
  })
  .strict();
export const batchDiagnosticSchema = z
  .object({
    sharedRunId: z.uuid().optional(),
    likelyCulprit: z.boolean(),
    failedTests: z.array(z.string()),
    waitingFor: z.uuid().nullable(),
    failsTogetherWith: z.array(
      batchMemberDetailSchema
        .pick({ submissionId: true, intentId: true, outcome: true })
        .extend({ tests: z.array(z.string()) })
        .strict(),
    ),
    individualPassed: z.boolean(),
    coverage: z.enum(['declared-contract', 'no-declared-contract', 'unavailable']),
    overBudgetPairs: z.array(budgetPair),
    message: z.string(),
  })
  .strict();
export type BatchMemberDetail = z.infer<typeof batchMemberDetailSchema>;
export type BatchFailure = z.infer<typeof batchFailureSchema>;

/** Advisory attribution from retained reports, never another check or a gate. */
export function diagnoseBatchFailure(
  members: BatchMemberDetail[],
  run: {
    id: string;
    contractReports?: Record<string, { failed: boolean; firstError?: string | undefined }> | undefined;
    testFiles?: { failed: { file: string }[] } | undefined;
  },
  semantic: ReturnType<typeof semanticVerdict>,
): BatchFailure {
  const reports = run.contractReports ?? {};
  const failedTests = [
    ...new Set([
      ...Object.keys(reports).filter(path => reports[path]!.failed),
      ...(run.testFiles?.failed.map(file => file.file) ?? []),
    ]),
  ].sort();
  const byIntent = new Map(members.map(member => [member.intentId, member.submissionId]));
  const indexes = new Map(failedTests.map((path, index) => [path, index]));
  return {
    runId: run.id,
    failedTests,
    suspects: members
      .filter(member =>
        failedTests.some(
          file =>
            member.tests.includes(file) ||
            member.paths.includes(file) ||
            member.paths.some(path => reports[file]?.firstError?.includes(path)),
        ),
      )
      .map(member => member.submissionId),
    pairs: semantic.conflicts.flatMap(conflict => {
      const a = byIntent.get(conflict.intents[0].intentId),
        b = byIntent.get(conflict.intents[1].intentId);
      return a && b
        ? [
            {
              members: [a, b] as [string, string],
              tests: conflict.failedTests.map(path => indexes.get(path)!),
            },
          ]
        : [];
    }),
    overBudgetPairs: semantic.overBudgetPairs,
  };
}
export function batchMemberDiagnostic(
  members: BatchMemberDetail[],
  failure: BatchFailure | undefined,
  state: { id: string; phase: string; batchSolo?: true | undefined },
  next: string | null,
  /** `split`: the cohort rechecks in parallel groups instead of individual fallback. */
  mode: 'fallback' | 'split' = 'fallback',
) {
  const split = mode === 'split';
  const own = members.find(member => member.submissionId === state.id);
  const likelyCulprit = failure?.suspects.includes(state.id) ?? false;
  const terminal = state.phase === 'landed' || state.phase === 'terminal-failed';
  const individualPassed = Boolean(state.batchSolo && state.phase === 'landed');
  const waitingFor = split || terminal || next === state.id ? null : next;
  const failsTogetherWith = (failure?.pairs ?? []).flatMap(pair => {
    if (!pair.members.includes(state.id)) return [];
    const peer = members.find(member => member.submissionId === pair.members.find(id => id !== state.id));
    return peer
      ? [
          {
            submissionId: peer.submissionId,
            intentId: peer.intentId,
            outcome: peer.outcome,
            tests: pair.tests.map(index => failure!.failedTests[index]!),
          },
        ]
      : [];
  });
  const coverage = !own
    ? ('unavailable' as const)
    : own.tests.length
      ? ('declared-contract' as const)
      : ('no-declared-contract' as const);
  const nextMember = members.find(member => member.submissionId === next);
  const message = [
    split
      ? failure
        ? `Shared batch run ${failure.runId} failed; the cohort split to recheck in parallel.`
        : 'The cohort could not compose; it split to recheck in parallel.'
      : failure
        ? `Shared batch run ${failure.runId} required individual fallback.`
        : 'Shared batch evidence cannot be published.',
    likelyCulprit
      ? 'Likely member: failing files match this member changed paths or declared contract tests.'
      : split
        ? 'No matching failure evidence; this member rechecks with the other unnamed members.'
        : 'No matching failure evidence; individual fallback runs before likely members.',
    coverage === 'declared-contract'
      ? ''
      : coverage === 'unavailable'
        ? 'Member attribution coverage is unavailable.'
        : 'No declared contract tests; attribution uses changed-path evidence only.',
    ...failsTogetherWith.map(
      peer =>
        `Likely fails together with ${peer.outcome} (${peer.intentId}; submission ${peer.submissionId}) on ${peer.tests.length} failing contract test files; shared-batch evidence does not isolate the pair.`,
    ),
    split
      ? likelyCulprit
        ? 'Rechecking alone on accepted main.'
        : 'Rechecking after the split.'
      : individualPassed
        ? 'Individual fallback passed on accepted main.'
        : terminal
          ? 'Individual fallback settled.'
          : waitingFor
            ? `Waiting for individual fallback of ${nextMember?.outcome ?? next} (${next}).`
            : 'Running individual fallback on accepted main.',
    ...(failure?.overBudgetPairs ?? []).map(
      pair =>
        `Pair ${pair.intents.join(' + ')} measured ${pair.measuredMs} ms, over the existing under-90000 ms budget; pair attribution is unavailable.`,
    ),
  ]
    .filter(Boolean)
    .join(' ');
  return {
    ...(failure ? { sharedRunId: failure.runId } : {}),
    likelyCulprit,
    failedTests: failure?.failedTests ?? [],
    waitingFor,
    failsTogetherWith,
    individualPassed,
    coverage,
    overBudgetPairs: failure?.overBudgetPairs ?? [],
    message,
  };
}
