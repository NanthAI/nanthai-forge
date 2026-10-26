// SPDX-License-Identifier: Apache-2.0
import { isDeepStrictEqual as same } from 'node:util';
import { currentCheckReuseKey, gateCheck } from './check-reuse-key.js';
import { retainedPassedCheck, successfulCheck, validateReusedCheck } from './check-reuse-evidence.js';
import { digest } from './hash.js';
import { composeLandingSource } from './landing-compose-source.js';
import { NativeSource } from './native-source.js';
import type { WorkStore } from './work-store.js';
import type { CheckEnvironment, CheckRun, WorkData } from './work-types.js';
import type { LandingEntry } from './landing-batch-types.js';

export function soloCheckEnvironment(environment: CheckEnvironment): CheckEnvironment {
  const { fingerprint: _, ...observed } = environment;
  void _;
  const full = { ...observed, env: { ...observed.env, FORGE_CHECK_FULL: '1' } };
  return { ...full, fingerprint: digest(JSON.stringify(full)) };
}

/** Admission is separate from combined-Candidate acceptance. Evidence must be
 * a full solo gate on this main, with freshly observed Q3 execution inputs. */
export function soloCheckAdmission(
  store: WorkStore,
  data: WorkData,
  base: string,
  environment: CheckEnvironment,
) {
  const passed = store.readRecords()?.all('runs', 'passed', 'status') ?? data.runs;
  const source = new NativeSource(store.root);
  return (entry: LandingEntry): CheckRun | undefined => {
    const view = data.views.find(view => view.id === entry.viewId),
      check = data.checks.find(check => check.id === entry.checkId);
    if (!view?.head || !check || view.status !== 'clean') return;
    const eligible = passed.filter(
      run =>
        successfulCheck(run) &&
        gateCheck(run) &&
        (run.checkSelection?.scope === 'full' || !run.checkSelection) &&
        !run.optimistic &&
        !run.recovery &&
        run.interaction === undefined &&
        run.check.definition === entry.definition &&
        (run.comparisonBase ?? run.base) === base &&
        // A combined check is never proof that one of its inputs passed alone.
        (run.inputs.length === 1 || same(run.inputs, view.inputs)),
    );
    if (!eligible.length) return;
    const composed = composeLandingSource(
      store,
      source,
      view,
      base,
      'Solo admission source',
      entry.arrivedAt,
    );
    if (!composed.head) return;
    for (const run of eligible.reverse()) {
      const original = run.reusedFrom ? store.select('runs', run.reusedFrom.runId) : run;
      const retained = retainedPassedCheck(store, original);
      if (!retained || !gateCheck(retained)) continue;
      const expected = currentCheckReuseKey(store, { ...run, head: composed.head, check }, environment);
      if (!expected || run.reuseKey !== expected) continue;
      try {
        validateReusedCheck(store, run);
      } catch {
        continue;
      }
      return run;
    }
  };
}
