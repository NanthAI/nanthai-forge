// SPDX-License-Identifier: Apache-2.0
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import { durableReplace } from './native-durability.js';
import { invariant } from './errors.js';
import type { WorkStore } from './work-store.js';
import type { CheckRun } from './work-types.js';
import type { ModalEvent } from './modal-client.js';
import { testFlakeEvidence, type TestVerdict, type TestObservation } from './check-flake-evidence.js';

type Verdict = TestVerdict;
type Observation = TestObservation;
const fixesSchema = z.array(z.object({ id: z.uuid(), at: z.string(), test: z.string() }));
export function quarantineLedger(observations: readonly Observation[]) {
  const tests = new Map<string, { flakes: number[]; quarantined: boolean; consecutivePasses: number }>();
  const seen = new Set<string>();
  for (const observation of [...observations].sort(
    (a, b) => a.at.localeCompare(b.at) || a.id.localeCompare(b.id),
  )) {
    if (seen.has(observation.id)) continue;
    seen.add(observation.id);
    const now = Date.parse(observation.at);
    for (const result of observation.tests) {
      const state = tests.get(result.test) ?? { flakes: [], quarantined: false, consecutivePasses: 0 };
      if (result.verdict === 'fixed') {
        state.flakes = [];
        state.quarantined = false;
        state.consecutivePasses = 0;
      } else if (result.verdict === 'passed') {
        state.consecutivePasses++;
        if (state.consecutivePasses >= 20) {
          state.quarantined = false;
          state.flakes = [];
        }
      } else {
        state.consecutivePasses = 0;
        if (
          result.verdict === 'flake' &&
          result.evidenceRunId &&
          ['unrelated-change', 'unchanged-source'].includes(result.recovery ?? '')
        ) {
          state.flakes = state.flakes.filter(at => now - at <= 7 * 86400000);
          state.flakes.push(now);
          if (state.flakes.length >= 2) state.quarantined = true;
        }
      }
      tests.set(result.test, state);
    }
  }
  return [...tests]
    .filter(([, state]) => state.quarantined)
    .map(([test, state]) => ({ test, consecutivePasses: state.consecutivePasses }));
}
function fixes(store: WorkStore): Observation[] {
  let bytes: string;
  try {
    bytes = readFileSync(join(store.directory, 'check-quarantine-fixes.json'), 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }
  return fixesSchema
    .parse(JSON.parse(bytes))
    .map(({ id, at, test }) => ({ id, at, tests: [{ test, verdict: 'fixed' }] }));
}
function observations(store: WorkStore): Observation[] {
  const tx = store.readRecords();
  const runs = tx
    ? Array.from({ length: tx.manifest.collections.runs!.count }, (_, i) => tx.at('runs', i))
    : store.load().runs;
  return [
    ...runs
      .filter(run => run.backend?.testVerdicts && run.endedAt && ['passed', 'failed'].includes(run.status))
      .map(run => ({
        id: run.id,
        at: run.endedAt!,
        tests: run.backend!.testVerdicts!,
        source: {
          head: run.head,
          definition: run.check.definition,
          ...(run.backend?.runtime ? { runtime: run.backend.runtime } : {}),
        },
      })),
    ...fixes(store),
  ];
}
export function checkQuarantine(store: WorkStore) {
  return store.locked(() => ({ needsYou: quarantineLedger(observations(store)) }));
}
/** Explicit fix is retry-safe and only releases the named test; later flakes count anew. */
export function fixQuarantinedTest(store: WorkStore, operationId: string, test: string) {
  z.uuid().parse(operationId);
  invariant(test.length > 0, 'BAD_ARGUMENT', 'Supply the exact test identity from the quarantine ledger.');
  return store.locked(() => {
    const path = join(store.directory, 'check-quarantine-fixes.json');
    const previous = fixes(store);
    const existing = previous.find(item => item.id === operationId);
    invariant(
      !existing || existing.tests[0]?.test === test,
      'EVIDENCE_CHANGED',
      'Fix operation already names another test.',
    );
    if (!existing) {
      const records = previous.map(item => ({ id: item.id, at: item.at, test: item.tests[0]!.test }));
      records.push({ id: operationId, at: new Date().toISOString(), test });
      durableReplace(path, JSON.stringify(records));
    }
    return {
      operationId,
      test,
      needsYou: quarantineLedger(observations(store)),
      details: 'Explicit fix recorded. The test continues to run; later flake verdicts count anew.',
    };
  });
}

/** Only complete, attributed reports may remove a failure from the landing gate. */
export function modalTestVerdicts(result: Extract<ModalEvent, { kind: 'result' }>, groups: string[][]) {
  const latest = new Map<number, NonNullable<typeof result.executions>[number]>();
  for (const execution of result.executions ?? [])
    if ((latest.get(execution.index)?.attempt ?? -1) < execution.attempt)
      latest.set(execution.index, execution);
  const verdicts = new Map<string, Verdict>();
  const failures: string[] = [];
  let unknownFailure =
    result.executions !== undefined &&
    Array.from({ length: groups.length + 1 }, (_, index) => index).some(index => !latest.has(index));
  const priorAttempts = (execution: NonNullable<typeof result.executions>[number]) =>
    (result.executions ?? []).filter(
      item => item.index === execution.index && item.attempt < execution.attempt,
    );
  const infrastructureOnly = (execution: NonNullable<typeof result.executions>[number]) =>
    (execution.exitCode === 137 || execution.infrastructure === 'sandbox-stopped') &&
    !Object.values(execution.tests ?? {}).some(report => report.results.some(test => !test.passed));
  const recoveredFailure = [...latest.values()].some(
    execution =>
      groups[execution.index] &&
      execution.exitCode === 0 &&
      priorAttempts(execution).some(
        previous =>
          previous.tests &&
          Object.values(previous.tests).some(report => report.results.some(test => !test.passed)),
      ),
  );
  for (const execution of latest.values()) {
    const files = groups[execution.index];
    if (!files) {
      if (execution.exitCode !== 0) unknownFailure = true;
      continue;
    }
    const previous = priorAttempts(execution);
    const recoveredInfrastructure = previous.length > 0 && previous.every(infrastructureOnly);
    let namedFailure = false;
    for (const file of files) {
      const report = execution.tests?.[file];
      if (!report?.complete || report.file !== file) {
        if (execution.exitCode !== 0 || previous.length > 0) unknownFailure = true;
        continue;
      }
      for (const test of report.results) {
        const identity = `${file} :: ${test.name}`;
        const failedBefore = previous.some(
          item =>
            item.exitCode !== 0 &&
            item.tests?.[file]?.complete &&
            item.tests[file]!.file === file &&
            item.tests[file]!.results.some(old => old.name === test.name && !old.passed),
        );
        const verdict = !test.passed ? 'failed' : failedBefore ? 'recovered' : 'passed';
        const old = verdicts.get(identity);
        // Infrastructure recovery does not advance quarantine clean-pass streaks.
        // Duplicate names are conservative: a failure wins over a pass.
        if (
          !(recoveredInfrastructure && execution.exitCode === 0 && test.passed) &&
          (!old || verdict === 'failed' || (old.verdict === 'passed' && verdict === 'recovered'))
        )
          verdicts.set(identity, { test: identity, verdict });
        if (verdict !== 'passed') failures.push(identity);
        if (!test.passed) namedFailure = true;
      }
    }
    if (execution.exitCode !== 0 && !namedFailure) unknownFailure = true;
    if (
      execution.exitCode === 0 &&
      previous.some(item => !infrastructureOnly(item) && item.exitCode !== 0) &&
      ![...verdicts.values()].some(
        item => item.verdict === 'recovered' && files.some(file => item.test.startsWith(`${file} :: `)),
      )
    )
      unknownFailure = true;
  }
  return {
    verdicts: [...verdicts.values()],
    failures: [...new Set(failures)],
    unknownFailure,
    recoveredFailure,
  };
}
export function modalQuarantine(
  store: WorkStore,
  run: CheckRun,
  result: Extract<ModalEvent, { kind: 'result' }>,
  groups: string[][],
  at: string,
) {
  const observed = modalTestVerdicts(result, groups);
  const { failures, unknownFailure, recoveredFailure } = observed;
  return store.locked(() => {
    const history = observations(store).filter(item => item.id !== run.id && item.at <= at);
    const evidence = testFlakeEvidence(store, run, history);
    const verdicts = observed.verdicts.map(item =>
      item.verdict === 'recovered' ? evidence.recovery(item.test) : item,
    );
    const quarantine = quarantineLedger([...history, { id: run.id, at, tests: verdicts }]);
    const quarantined = new Set(quarantine.map(item => item.test));
    const nonblocking = (test: string) =>
      quarantined.has(test) &&
      evidence.canQuarantine(test) &&
      !verdicts.some(item => item.test === test && item.verdict === 'recovered');
    const blocked = unknownFailure || failures.some(test => !nonblocking(test));
    return {
      testVerdicts: verdicts,
      quarantine,
      blocked,
      verdict:
        verdicts.some(item => item.verdict === 'recovered') ||
        (recoveredFailure && !verdicts.some(item => item.verdict === 'flake'))
          ? ('recovered' as const)
          : verdicts.some(item => item.verdict === 'flake')
            ? ('flake' as const)
            : failures.some(test => !nonblocking(test))
              ? ('failed' as const)
              : failures.length
                ? ('quarantined' as const)
                : ('clean' as const),
    };
  });
}
