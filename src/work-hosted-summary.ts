// SPDX-License-Identifier: Apache-2.0
import { diagnosticCause } from './landing-observation.js';
import type { Lane, WorkView, CheckRun } from './work-types.js';

export type HostedChanges = { files: number; add?: number; del?: number };

/** Disposable hosted projection format; retained source and Work formats are unchanged. */
export const HOSTED_WORK_INDEX_FORMAT = 11;

export function laneSummary(
  lane: Lane,
  main: HostedMainSummary = { head: null, included: null },
  submittedHeads: readonly string[] = [],
) {
  const last = lane.checkpoints.at(-1);
  return {
    id: lane.id,
    // Unlike Views/runs, Lane membership asks whether main contains this Lane head.
    main,
    intentId: lane.intentId,
    ...(lane.after ? { after: lane.after } : {}),
    ...(lane.stack ? { stack: lane.stack } : {}),
    name: lane.name,
    ...(lane.overlapInbox?.length ? { overlaps: lane.overlapInbox.slice(0, 20) } : {}),
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
    savesSinceSubmission: submittedHeads.flatMap(head => {
      const index = lane.checkpoints.findIndex(save => save.head === head);
      return index < 0 ? [] : [{ head, saves: lane.checkpoints.length - index - 1 }];
    }),
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
    cause: diagnosticCause(run),
    ...(run.error ? { error: { code: run.error.code } } : {}),
    ...(run.signal ? { signal: run.signal } : {}),
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
