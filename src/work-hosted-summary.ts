// SPDX-License-Identifier: Apache-2.0
import type { Lane, WorkView, CheckRun } from './work-types.js';

export type HostedChanges = { files: number; add?: number; del?: number };

/** Disposable hosted projection format; retained source and Work formats are unchanged. */
export const HOSTED_WORK_INDEX_FORMAT = 10;

export function laneSummary(lane: Lane, main: HostedMainSummary = { head: null, included: null }) {
  const last = lane.checkpoints.at(-1);
  return {
    id: lane.id,
    // Unlike Views/runs, Lane membership asks whether main contains this Lane head.
    main,
    intentId: lane.intentId,
    ...(lane.after ? { after: lane.after } : {}),
    name: lane.name,
    ...(lane.startedBy ? { startedBy: lane.startedBy } : {}),
    ...(lane.startedAt ? { startedAt: lane.startedAt } : {}),
    state: lane.state,
    head: lane.head,
    base: lane.base,
    assignment: lane.assignment,
    target: lane.target,
    ...(lane.setup ? { setup: lane.setup } : {}),
    checkpoints: [],
    checkpointCount: lane.checkpoints.length,
    ...(last
      ? {
          lastCheckpointAt: last.at,
          lastCheckpointMessage: (last.automatic?.summary ?? last.message).slice(0, 200),
        }
      : {}),
  };
}
export type HostedMainSummary = { head: string | null; included: boolean | null };
export function viewSummary(view: WorkView, main: HostedMainSummary = { head: null, included: null }) {
  return {
    id: view.id,
    main,
    intentId: view.intentId,
    base: view.base,
    ...(view.composedMain ? { composedMain: view.composedMain } : {}),
    head: view.head,
    status: view.status,
    at: view.at,
    inputs: view.inputs.map(({ laneId, head }) => ({ laneId, head })),
    dependencies: view.dependencies ?? [],
    dependencyCount: view.dependencies?.length ?? 0,
  };
}
export function runSummary(run: CheckRun, main: HostedMainSummary = { head: null, included: null }) {
  const scope = run.checkSelection ? ` · ${run.checkSelection.scope}` : '';
  return {
    id: run.id,
    main,
    viewId: run.viewId,
    head: run.head,
    status: run.status,
    checkId: run.check.id,
    checkName: `${run.check.name.slice(0, 200 - scope.length)}${scope}`,
    startedAt: run.startedAt,
    ...(run.endedAt !== undefined ? { endedAt: run.endedAt } : {}),
    ...(run.exitCode !== undefined ? { exitCode: run.exitCode } : {}),
    // The durable summary is already bounded to 4096 characters by the Work schema.
    ...(run.mainCheck ? { mainCheck: run.mainCheck } : {}),
    ...(run.failureSummary !== undefined ? { failureSummary: run.failureSummary } : {}),
    ...(run.backend?.quarantine ? { checkQuarantine: run.backend.quarantine } : {}),
    ...(run.backend?.verdict ? { checkVerdict: run.backend.verdict } : {}),
  };
}
export type HostedLaneSummary = ReturnType<typeof laneSummary> & { changes?: HostedChanges };
export type HostedViewSummary = ReturnType<typeof viewSummary> & { changes?: HostedChanges };
export type HostedRunSummary = ReturnType<typeof runSummary>;
