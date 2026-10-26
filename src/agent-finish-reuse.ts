// SPDX-License-Identifier: Apache-2.0
import { hostname } from 'node:os';
import { processAlive } from './local-process.js';
import { checkEnvironment } from './work-run.js';
import { currentCheckReuseKey, gateCheck } from './check-reuse-key.js';
import { retainedPassedCheck, successfulCheck, validateReusedCheck } from './check-reuse-evidence.js';
import type { WorkStore } from './work-store.js';
import type { FinishAction } from './agent-workflow-schema.js';
function passedForCurrentInputs(store: WorkStore, run: import('./work-types.js').CheckRun) {
  if (
    !successfulCheck(run) ||
    !gateCheck(run) ||
    !run.reuseKey ||
    currentCheckReuseKey(store, run, checkEnvironment()) !== run.reuseKey
  )
    return false;
  try {
    if (run.reusedFrom) validateReusedCheck(store, run);
    else if (!retainedPassedCheck(store, run)) return false;
    return true;
  } catch {
    return false;
  }
}

/** Select only an exact prior candidate; the acceptance owner proves reuse. */
export function reusableFinish(store: WorkStore, command: FinishAction, head: string) {
  const data = store.load(),
    environment = checkEnvironment();
  const inputs = [{ laneId: command.laneId, head }, ...(command.withInputs ?? [])];
  const candidate = [...data.views]
    .reverse()
    .find(
      view =>
        view.status === 'clean' &&
        view.head &&
        view.composedMain &&
        JSON.stringify(view.inputs) === JSON.stringify(inputs) &&
        JSON.stringify(view.dependencies ?? []) === JSON.stringify(command.dependencies ?? []),
    );
  const run =
    candidate &&
    [...data.runs]
      .reverse()
      .find(
        run =>
          run.viewId === candidate.id &&
          run.head === candidate.head &&
          run.status === 'passed' &&
          run.checkSelection?.scope !== 'partial' &&
          run.check.id === command.checkId &&
          run.check.definition === command.expectedDefinition &&
          (!command.expectedEnvironment || environment.fingerprint === command.expectedEnvironment) &&
          passedForCurrentInputs(store, run),
      );
  return candidate && run ? { candidate, run } : undefined;
}

/** Adopt only the same source inputs, composed head, definition and environment.
 * View identity may differ across finish operation ids; source identity may not. */
export function adoptFinishRun(store: WorkStore, command: FinishAction, viewId: string) {
  const data = store.load(),
    view = data.views.find(item => item.id === viewId);
  if (!view) return;
  return [...data.runs].reverse().find(
    run =>
      gateCheck(run) &&
      run.head === view.head &&
      run.base === view.base &&
      JSON.stringify(run.inputs) === JSON.stringify(view.inputs) &&
      JSON.stringify(run.dependencies ?? []) === JSON.stringify(view.dependencies ?? []) &&
      run.check.id === command.checkId &&
      run.check.definition === command.expectedDefinition &&
      // An exact environment match adopts as before; a passed run may also be
      // adopted across restarts and Node patches through its content key.
      (run.environment.fingerprint === (command.expectedEnvironment ?? checkEnvironment().fingerprint) ||
        (run.status === 'passed' &&
          passedForCurrentInputs(store, run) &&
          (!command.expectedEnvironment ||
            command.expectedEnvironment === checkEnvironment().fingerprint))) &&
      (['passed', 'failed'].includes(run.status) ||
        (run.runner.host === hostname() && processAlive(run.runner))) &&
      run.interaction === undefined &&
      !run.cancelRequested &&
      ['queued', 'preparing', 'running', 'passed', 'failed'].includes(run.status),
  );
}

export function adoptLaneFinish(
  store: WorkStore,
  command: FinishAction,
  head: string,
  previous: string | null,
) {
  const data = store.load();
  const inputs = [{ laneId: command.laneId, head }, ...(command.withInputs ?? [])];
  const candidate = [...data.views]
    .reverse()
    .find(
      view =>
        view.status === 'clean' &&
        JSON.stringify(view.inputs) === JSON.stringify(inputs) &&
        JSON.stringify(view.dependencies ?? []) === JSON.stringify(command.dependencies ?? []) &&
        (!previous || view.composedMain === previous),
    );
  const run = candidate && adoptFinishRun(store, command, candidate.id);
  const original = run && data.views.find(view => view.id === run.viewId);
  return original && run ? { candidate: original, run } : undefined;
}
