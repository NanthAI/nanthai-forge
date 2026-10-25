// SPDX-License-Identifier: Apache-2.0
import { isDeepStrictEqual as same } from 'node:util';
import { digest } from './hash.js';
import { readSource } from './files.js';
import { invariant } from './errors.js';
import { validateModalPlan, type ModalPlan } from './modal-plan.js';
import { receiptSchema } from './work-run-receipt.js';
import { checkRunSchema, type CheckRun } from './work-types.js';
import type { WorkStore } from './work-store.js';

export const successfulCheck = (run: CheckRun) =>
  run.status === 'passed' &&
  run.checkSelection?.scope !== 'partial' &&
  !!run.endedAt &&
  Number.isFinite(Date.parse(run.endedAt)) &&
  run.exitCode === 0 &&
  !run.signal &&
  !run.cancelRequested &&
  !run.cancellation &&
  !run.error;
export const readCheckJson = (store: WorkStore, id: string, name: string) => {
  const bytes = readSource(store.directory, `check-${id}/${name}`, 4 * 1024 * 1024);
  return bytes ? JSON.parse(bytes.toString('utf8')) : undefined;
};
export const executionSelection = (selection: { scope: string; tests: string[] } | undefined) =>
  selection && { scope: selection.scope, tests: selection.tests };
export const checkEvidenceFingerprint = (run: CheckRun) => digest(JSON.stringify(run));

/** Work's verdict alone is insufficient: the retained completion and recipe must agree. */
export function retainedPassedCheck(store: WorkStore, value: unknown): CheckRun | undefined {
  try {
    const run = checkRunSchema.parse(value);
    if (!successfulCheck(run) || run.reusedFrom || run.runner.pid === 0) return;
    const receipt = receiptSchema.parse(readCheckJson(store, run.id, 'result.json'));
    if (!Object.entries(receipt).every(([key, value]) => same(value, Reflect.get(run, key)))) return;
    if (
      receipt.exitCode !== 0 ||
      !same(receipt.checkSelection, run.checkSelection) ||
      !same(receipt.backend, run.backend)
    )
      return;
    if (run.backend?.actual !== 'local') {
      const plan = readCheckJson(store, run.id, 'modal-plan.json') as ModalPlan;
      validateModalPlan(plan, run);
      if (
        plan.runtime !== run.backend?.runtime ||
        plan.lockfile !== run.backend?.lockfile ||
        (plan.standard && !same(executionSelection(plan.selection), executionSelection(run.checkSelection)))
      )
        return;
    }
    return run;
  } catch {
    return; // Missing/corrupt evidence falls through to ordinary execution.
  }
}

/** A reused run is a new exact-Candidate receipt, never a second execution. */
export function validateReusedCheck(store: WorkStore, run: CheckRun) {
  invariant(
    run.checkSelection?.scope !== 'partial',
    'CHECK_REQUIRED',
    'Explicit test-file runs are partial evidence, not a landing gate.',
  );
  invariant(
    run.runner.pid !== 0 || !!run.reusedFrom,
    'EVIDENCE_CHANGED',
    'A virtual check needs its retained source result.',
  );
  if (!run.reusedFrom) return;
  const original = retainedPassedCheck(store, store.select('runs', run.reusedFrom.runId));
  invariant(
    original &&
      checkEvidenceFingerprint(original) === run.reusedFrom.evidence &&
      original.endedAt === run.reusedFrom.endedAt,
    'EVIDENCE_CHANGED',
    'The reused check no longer has its retained successful result. Original evidence is preserved.',
  );
}
