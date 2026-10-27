// SPDX-License-Identifier: Apache-2.0
import { testExecutionVerdicts } from './check-test-verdicts.js';
import {
  quarantineHistory,
  quarantineOverLimit,
  observeQuarantine,
  quarantineList,
  type QuarantineState,
} from './check-quarantine-history.js';
import { appendFriction, frictionId } from './friction.js';
import { existsSync } from 'node:fs';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import { durableReplace } from './native-durability.js';
import { digest } from './hash.js';
import { invariant } from './errors.js';
import type { WorkStore } from './work-store.js';
import type { CheckRun } from './work-types.js';
import type { ModalEvent } from './modal-client.js';
import { testFlakeEvidence, type TestVerdict, type TestObservation } from './check-flake-evidence.js';

type Verdict = TestVerdict;
type Observation = TestObservation;
const fixesSchema = z.array(z.object({ id: z.uuid(), at: z.string(), test: z.string() }));
export function quarantineLedger(observations: readonly Observation[]) {
  const states = new Map<string, QuarantineState>();
  const seen = new Set<string>();
  for (const observation of [...observations].sort(
    (a, b) => a.at.localeCompare(b.at) || a.id.localeCompare(b.id),
  )) {
    if (seen.has(observation.id)) continue;
    seen.add(observation.id);
    observeQuarantine(states, observation);
  }
  return quarantineList(states);
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
export function checkQuarantine(store: WorkStore) {
  return { needsYou: quarantineList(quarantineHistory(store, fixes(store)).states) };
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
      needsYou: quarantineList(quarantineHistory(store, fixes(store)).states),
      details: 'Explicit fix recorded. The test continues to run; later flake verdicts count anew.',
    };
  });
}

export function assessTestQuarantine(
  store: WorkStore,
  run: CheckRun,
  observed: ReturnType<typeof testExecutionVerdicts>,
  at: string,
) {
  const retained = join(store.directory, `check-${run.id}`, 'quarantine-assessment.json');
  const input = digest(JSON.stringify({ head: run.head, definition: run.check?.definition, observed }));
  const replay = () => {
    const saved = JSON.parse(readFileSync(retained, 'utf8')) as { input: string; assessment: Assessment };
    invariant(
      saved.input === input,
      'EVIDENCE_CHANGED',
      'Retained test assessment names different Candidate or test evidence.',
    );
    return saved.assessment;
  };
  if (existsSync(retained)) return replay();
  // Passing observations are retained in the existing receipt, with no ledger I/O.
  if (!observed.unknownFailure && observed.verdicts.every(item => item.verdict === 'passed')) {
    if (quarantineOverLimit(store)) {
      const quarantine = quarantineList(
        quarantineHistory(store, fixes(store), { id: run.id, at, tests: observed.verdicts }).states,
      );
      const blocked = quarantine.length > 10;
      // Even excess-quarantine clean checks write only the existing run receipt.
      return {
        testVerdicts: observed.verdicts,
        quarantine,
        ignoredTests: [],
        blocked,
        verdict: blocked ? ('failed' as const) : ('clean' as const),
        details: blocked ? 'Too many flaky tests: more than 10 quarantined tests; check failed.' : '',
      };
    }
    return {
      testVerdicts: observed.verdicts,
      quarantine: undefined,
      ignoredTests: [],
      blocked: false,
      verdict: 'clean' as const,
      details: '',
    };
  }
  return store.locked(() => {
    if (existsSync(retained)) return replay();
    const evidence = testFlakeEvidence(store, run, []);
    const verdicts = observed.verdicts.map(item => ({
      ...(item.attempts && ['recovered', 'flake'].includes(item.verdict)
        ? evidence.canQuarantine(item.test)
          ? { ...item, verdict: 'flake' as const, recovery: 'unchanged-source' as const }
          : { ...item, verdict: 'recovered' as const, recovery: evidence.recovery(item.test).recovery }
        : item.verdict === 'recovered'
          ? evidence.recovery(item.test)
          : item.verdict === 'flake' && !evidence.canQuarantine(item.test)
            ? { ...item, verdict: 'recovered' as const, recovery: 'related-change' as const }
            : item),
      ...(item.attempts ? { head: run.head } : {}),
    }));
    const updated = quarantineHistory(store, fixes(store), { id: run.id, at, tests: verdicts });
    const previous = new Set(updated.previousQuarantine.map(item => item.test));
    const quarantine = quarantineList(updated.states);
    const quarantined = new Set(quarantine.map(item => item.test));
    const tooMany = quarantine.length > 10;
    const ignored = verdicts.filter(
      item => item.verdict === 'failed' && quarantined.has(item.test) && evidence.canQuarantine(item.test),
    );
    const ignoredNames = new Set(ignored.map(item => item.test));
    const blocked =
      tooMany ||
      observed.unknownFailure ||
      verdicts.some(
        item => item.verdict === 'recovered' || (item.verdict === 'failed' && !ignoredNames.has(item.test)),
      );
    const assessment = {
      testVerdicts: verdicts,
      quarantine,
      ignoredTests: tooMany || observed.unknownFailure ? [] : [...ignoredNames],
      blocked,
      verdict: tooMany
        ? ('failed' as const)
        : verdicts.some(item => item.verdict === 'recovered')
          ? ('recovered' as const)
          : ignored.length && !blocked
            ? ('quarantined' as const)
            : verdicts.some(item => item.verdict === 'flake')
              ? ('flake' as const)
              : verdicts.some(item => item.verdict === 'failed')
                ? ('failed' as const)
                : ('clean' as const),
      details: tooMany
        ? 'Too many flaky tests: more than 10 quarantined tests; check failed.'
        : ignored
            .map(item => `Ignored quarantined test: ${item.test}; run ${run.id}; Candidate ${run.head}.`)
            .join(' '),
    };
    const added = quarantine.filter(item => !previous.has(item.test));
    if (added.length) {
      const tx = store.records();
      for (const item of added) {
        const id = frictionId(`quarantine:${run.id}:${item.test}`);
        appendFriction(tx, {
          id,
          operationId: id,
          kind: 'capture',
          automatic: true,
          count: 1,
          at,
          request: digest(JSON.stringify({ runId: run.id, test: item.test })),
          title: `Fix quarantined test: ${item.test}`,
          area: 'checks',
          detail: `Two evidenced flakes within seven days. Test continues to run. Run ${run.id}; Candidate ${run.head}.`,
          evidence: [run.id, run.head, item.test],
        });
      }
      store.commitRecords(tx);
    }
    if (existsSync(join(store.directory, `check-${run.id}`)))
      durableReplace(retained, JSON.stringify({ input, assessment }));
    updated.save();
    return assessment;
  });
}
type Assessment = {
  testVerdicts: Verdict[];
  ignoredTests: string[];
  quarantine?: { test: string; consecutivePasses: number }[];
  blocked: boolean;
  verdict: 'clean' | 'recovered' | 'flake' | 'quarantined' | 'failed';
  details: string;
};
export function checkQuarantineResult(
  store: WorkStore,
  run: CheckRun,
  result: Extract<ModalEvent, { kind: 'result' }>,
  groups: string[][],
  at: string,
) {
  const observed = testExecutionVerdicts(result, groups);
  // Retained provider retries also ran the same pinned Candidate. No new job is launched.
  for (const item of observed.verdicts)
    if (item.verdict === 'recovered') {
      const file = item.test.split(' :: ')[0]!;
      const executions = (result.executions ?? []).filter(execution => execution.tests?.[file]);
      const last = executions.sort((a, b) => a.attempt - b.attempt).at(-1);
      const first = executions.find(
        execution =>
          execution !== last &&
          execution.tests?.[file]?.complete &&
          execution.tests[file]!.results.some(
            test => `${file} :: ${test.name}` === item.test && !test.passed,
          ),
      );
      if (first && last) {
        item.evidenceRunId = first.executionId;
        item.attempts = [
          { runId: first.executionId, attempt: first.attempt, passed: false },
          { runId: last.executionId, attempt: last.attempt, passed: true },
        ];
      }
    }
  return assessTestQuarantine(store, run, observed, at);
}

export {
  testExecutionVerdicts,
  testExecutionVerdicts as modalTestVerdicts,
  checkQuarantineResult as modalQuarantine,
};
