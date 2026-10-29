// SPDX-License-Identifier: Apache-2.0
import { z } from 'zod';
import { invariant } from './errors.js';
import { safeRelative } from './safe-relative.js';
export const contractTestPath = z
  .string()
  .refine(path => safeRelative(path) && /^tests\/.+\.test\.[cm]?[jt]s$/.test(path));
export const contractTestsInput = z.object({
  laneId: z.uuid().optional(),
  candidateId: z.uuid().optional(),
  runId: z.uuid().optional(),
  timingBasis: z.literal('history').optional(),
  tests: z.array(contractTestPath).optional(),
  expectedHead: z
    .string()
    .regex(/^[0-9a-f]{40,64}$/)
    .optional(),
  expectedVersion: z.number().safe().nonnegative().optional(),
  operationId: z.uuid().optional(),
});
export const intentTestContractSchema = z
  .object({
    timingBasis: z.literal('history').optional(),
    version: z.number().safe().positive(),
    operationId: z.uuid(),
    request: z.string().regex(/^[0-9a-f]{64}$/),
    candidateId: z.uuid(),
    measuredOn: z.string().regex(/^[0-9a-f]{40,64}$/),
    runId: z.uuid(),
    at: z.string(),
    proposedTests: z.array(contractTestPath),
    tests: z.array(z.object({ path: contractTestPath, durationMs: z.number().finite().positive() })),
    totalMs: z.number().finite().nonnegative().lt(90_000),
  })
  .refine(
    contract =>
      new Set(contract.tests.map(test => test.path)).size === contract.tests.length &&
      contract.tests.reduce((sum, test) => sum + test.durationMs, 0) === contract.totalMs,
    'Contract total must match unique measured test files.',
  );
export type IntentTestContract = z.infer<typeof intentTestContractSchema>;
export type ContractTestsInput = z.infer<typeof contractTestsInput>;
export const latestTestContract = (intent?: { testContracts?: IntentTestContract[] | undefined } | null) =>
  intent?.testContracts?.at(-1) ?? null;

/** Exact measurements stay source-bound; history declarations apply across the Intent. */
export const candidateTestContract = (
  intent: { testContracts?: IntentTestContract[] | undefined } | null | undefined,
  candidateId: string,
  head: string | undefined,
) =>
  intent?.testContracts
    ?.slice()
    .reverse()
    .find(
      contract =>
        contract.timingBasis === 'history' ||
        (contract.candidateId === candidateId && contract.measuredOn === head),
    ) ?? null;

export function contractProposal(tests: string[], timings: Record<string, number>, required = tests) {
  const entries = [...new Set(tests)].sort().map(path => ({ path, durationMs: timings[path] ?? null }));
  const missingTimings = entries.filter(test => test.durationMs === null).map(test => test.path);
  return {
    tests: entries,
    required: [...new Set(required)].sort(),
    missingTimings,
    totalMs: missingTimings.length ? null : entries.reduce((sum, test) => sum + test.durationMs!, 0),
    budgetMs: 90_000,
    slowest: entries
      .filter(test => test.durationMs !== null)
      .sort((a, b) => b.durationMs! - a.durationMs!)
      .slice(0, 10),
  };
}
export function confirmTestContract(input: {
  command: ContractTestsInput;
  candidateId: string;
  head: string;
  required: string[];
  available: string[];
  timings: Record<string, number>;
  version: number;
  request: string;
  at: string;
  history?: { runId: string; measuredOn: string };
}): IntentTestContract {
  const { command } = input;
  invariant(
    command.operationId && (command.runId || input.history),
    'BAD_ARGUMENT',
    'Confirmation needs operationId and an exact-Candidate timing runId.',
  );
  invariant(command.expectedHead === input.head, 'VIEW_STALE', 'Confirm the exact proposed Candidate head.');
  invariant(
    command.expectedVersion === input.version,
    'WORK_STALE',
    'The Intent contract changed. Read its proposal and confirm the current version.',
  );
  const tests = [...new Set(command.tests ?? input.required)].sort();
  invariant(
    tests.every(test => input.available.includes(test)),
    'BAD_ARGUMENT',
    'Select test files present in the Candidate.',
  );
  const proposal = contractProposal(tests, input.timings, input.required);
  invariant(
    !proposal.missingTimings.length,
    'CONTRACT_TIMING_MISSING',
    `No complete measurement on Candidate ${input.head} for: ${proposal.missingTimings.join(', ')}. Run those tests on this Candidate and confirm with that runId.`,
  );
  invariant(
    proposal.totalMs! < 90_000,
    'CONTRACT_OVER_BUDGET',
    `Contract measured ${proposal.totalMs} ms; budget is under 90000 ms. Slowest tests: ${proposal.slowest.map(test => `${test.path}: ${test.durationMs} ms`).join(', ')}.`,
  );
  return intentTestContractSchema.parse({
    version: input.version + 1,
    operationId: command.operationId,
    request: input.request,
    candidateId: input.candidateId,
    ...(input.history ? { timingBasis: 'history' } : {}),
    measuredOn: input.history?.measuredOn ?? input.head,
    runId: input.history?.runId ?? command.runId,
    at: input.at,
    proposedTests: input.required,
    tests: proposal.tests,
    totalMs: proposal.totalMs,
  });
}
