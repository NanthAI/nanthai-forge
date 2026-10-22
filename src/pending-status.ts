// SPDX-License-Identifier: Apache-2.0
import { handoffSummary, latestHandoff } from './agent-handoff-types.js';
import type { WorkData } from './work-types.js';

/** R1 integration contract: only successfully published captures belong here.
 * Missing observations stay null; metadata publication is never a source receipt. */
export type RecoveryCaptureObservation = {
  captureId: string;
  capturedAt: string | null;
  publishedAt: string | null;
  mainHead: string | null;
  workRevision: number | null;
  completeHistory: boolean | null;
  unavailable: string[] | null;
  evidenceComplete: boolean | null;
};
export type PendingData = Pick<
  WorkData,
  | 'revision'
  | 'lanes'
  | 'views'
  | 'runs'
  | 'channelMoves'
  | 'landingEntries'
  | 'githubSync'
  | 'githubAutoPush'
> &
  Partial<Pick<WorkData, 'intents'>>;
export type PendingObservations = {
  recovery?: RecoveryCaptureObservation | null;
  pendingPushes?: { operationId: string; revision: number }[];
  metadataPending?: number;
  waitingLaneIds?: string[];
  evidenceChangedAt?: string | null;
  deployment?: { head: string; observedAt: string | null; state: string | null } | null;
};
const active = (status: string) => ['queued', 'preparing', 'running'].includes(status);
const age = (at: string | null | undefined, now: string) => {
  const delta = Date.parse(now) - Date.parse(at ?? '');
  return Number.isFinite(delta) && delta >= 0 ? delta : null;
};
const comparison = (local: string | null, observed: string | null | undefined) =>
  local && observed ? (local === observed ? 'matching' : 'different') : 'unknown';

/** Pure projection of one pinned local observation. No heartbeat implies nothing
 * about owner liveness, source publication, deployment or evidence coverage. */
export function pendingStatus(
  data: PendingData,
  observed: PendingObservations = {},
  now = new Date().toISOString(),
) {
  const moves = data.channelMoves.filter(move => move.channel === 'main' && move.status === 'accepted');
  const main = moves.at(-1);
  const views = new Map(data.views.map(view => [view.id, view]));
  const accepted = new Set(moves.map(move => move.viewId));
  const acceptedInputs = new Set<string>();
  const collect = (id: string) => {
    const view = views.get(id);
    if (!view) return;
    for (const pin of view.inputs) acceptedInputs.add(`${pin.laneId}:${pin.head}`);
    for (const dep of view.dependencies ?? [])
      if (dep.kind === 'view' && !accepted.has(dep.viewId)) {
        accepted.add(dep.viewId);
        collect(dep.viewId);
      }
  };
  for (const move of moves) collect(move.viewId);
  const checks = data.runs
    .filter(run => active(run.status))
    .map(run => ({
      runId: run.id,
      viewId: run.viewId,
      head: run.head,
      status: run.status,
      startedAt: run.startedAt,
      processState: 'unknown' as const,
      kind: run.mainCheck ? 'audit' : 'candidate',
    }));
  const lanes = data.lanes
    .filter(lane => !['completed', 'abandoned'].includes(lane.state))
    .map(lane => {
      const candidates = data.views.filter(view =>
        view.inputs.some(pin => pin.laneId === lane.id && pin.head === lane.head),
      );
      const candidateIds = new Set(candidates.map(view => view.id));
      const entries = (data.landingEntries ?? []).filter(entry => candidateIds.has(entry.viewId));
      const entry = entries.at(-1);
      const after = lane.after;
      const dependencyWaiting =
        after &&
        ('viewId' in after
          ? !accepted.has(after.viewId)
          : data.lanes.filter(item => item.intentId === after.intentId).length === 0 ||
            data.lanes.some(
              item => item.intentId === after.intentId && !acceptedInputs.has(`${item.id}:${item.head}`),
            ));
      const status = acceptedInputs.has(`${lane.id}:${lane.head}`)
        ? 'landed'
        : checks.some(run => candidateIds.has(run.viewId)) || entry?.status === 'checking'
          ? 'checking'
          : dependencyWaiting ||
              observed.waitingLaneIds?.includes(lane.id) ||
              lane.state === 'paused' ||
              entry?.status === 'awaiting-review'
            ? 'waiting'
            : entry && ['failed', 'conflict', 'interrupted', 'cancelled'].includes(entry.status)
              ? entry.status
              : lane.state === 'ready' || entry?.status === 'queued'
                ? 'ready'
                : 'working';
      return {
        laneId: lane.id,
        name: lane.name,
        head: lane.head,
        status,
        after: after ?? null,
        landingId: entry?.id ?? null,
        handoff: handoffSummary(
          latestHandoff(data.intents?.find(intent => intent.id === lane.intentId)?.notes ?? [], lane.id),
        ),
      };
    });
  const recovery = observed.recovery ?? null;
  const mainHead = main?.head ?? null;
  const evidenceNewer = recovery?.capturedAt
    ? [observed.evidenceChangedAt, ...data.runs.map(run => run.endedAt ?? run.startedAt)].some(
        at => at && Date.parse(at) > Date.parse(recovery.capturedAt!),
      )
    : false;
  const source = comparison(mainHead, recovery?.mainHead);
  const work =
    recovery?.workRevision == null
      ? 'unknown'
      : data.revision > recovery.workRevision
        ? 'pending'
        : data.revision === recovery.workRevision
          ? 'matching'
          : 'unknown';
  const evidence = evidenceNewer
    ? 'pending'
    : checks.length || recovery?.evidenceComplete == null
      ? 'unknown'
      : recovery.evidenceComplete
        ? 'complete'
        : 'incomplete';
  const github = data.githubSync;
  const pushed = github?.commits[(github?.pushed ?? 0) - 1];
  const audits = moves
    .filter(move => move.postAccept)
    .map(move => {
      const run = data.runs.find(item => item.id === move.postAcceptRunId);
      return {
        acceptanceId: move.id,
        head: move.head,
        runId: run?.id ?? null,
        status: run?.status ?? 'pending',
      };
    });
  return {
    schema: 1,
    snapshot: { observedAt: now, workRevision: data.revision, scope: 'local-saved-records' },
    main: { head: mainHead, acceptanceId: main?.id ?? null, acceptedAt: main?.at ?? null },
    lanes,
    counts: {
      ready: lanes.filter(lane => lane.status === 'ready').length,
      waiting: lanes.filter(lane => lane.status === 'waiting').length,
      checking: lanes.filter(lane => lane.status === 'checking').length,
    },
    hosted: {
      mainHead: recovery?.mainHead ?? null,
      source,
      work,
      evidence,
      captureAgeMs: age(recovery?.capturedAt, now),
      recovery,
      pendingPushes: observed.pendingPushes ?? [],
      metadataPending: observed.metadataPending ?? 0,
      pendingSince: null,
      pendingAgeMs: null,
      // There is no timestamp of the oldest unsent Work/evidence mutation yet.
      pendingAgeReason: 'Oldest unsent mutation time is not recorded.',
    },
    github: {
      mainHead: pushed?.state ?? null,
      commit: pushed?.commit ?? null,
      pushedAt: github?.pushedAt ?? null,
      ageMs: age(github?.pushedAt, now),
      source: comparison(mainHead, pushed?.state),
      status: data.githubAutoPush?.status ?? 'unknown',
    },
    checks,
    audits,
    deployment: observed.deployment
      ? {
          ...observed.deployment,
          source: comparison(mainHead, observed.deployment.head),
          ageMs: age(observed.deployment.observedAt, now),
          scope: 'last-recorded-observation',
        }
      : null,
    installedSource: null,
    ownerHeartbeat: null,
  };
}
export type PendingStatus = ReturnType<typeof pendingStatus>;
