import { batchDiagnosis, diagnosticCause } from './landing-observation.js';
import type { LandingWorkerStatus } from './landing-worker-status.js';
// SPDX-License-Identifier: Apache-2.0
import {
  landingAttemptId,
  projectSubmission,
  queueObservation,
  type Submission,
} from './landing-observation.js';
import { handoffSummary, latestHandoff } from './agent-handoff-types.js';
import type { OverlapPlan } from './agent-overlap-plan.js';
import type { WorkData } from './work-types.js';
import type { AutoExchangeStatus } from './auto-exchange-status.js';

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
  Partial<Pick<WorkData, 'intents' | 'landingBatches'>>;
export type PendingObservations = {
  integrationPreview?: string | undefined;
  landingWorker?: LandingWorkerStatus;
  autoExchange?: AutoExchangeStatus;
  submissions?: Submission[];
  overlap?: OverlapPlan;
  recovery?: RecoveryCaptureObservation | null;
  pendingPushes?: { operationId: string; revision: number }[];
  metadataPending?: number;
  waitingLaneIds?: string[];
  evidenceChangedAt?: string | null;
  deployment?: { head: string; observedAt: string | null; state: string | null } | null;
};
const active = (status: string) => ['queued', 'preparing', 'running'].includes(status);
const age = (at: string | null | undefined, now: string | null) => {
  if (now === null) return null;
  const delta = Date.parse(now) - Date.parse(at ?? '');
  return Number.isFinite(delta) && delta >= 0 ? delta : null;
};
const comparison = (local: string | null, observed: string | null | undefined) =>
  local && observed ? (local === observed ? 'matching' : 'different') : 'unknown';

/** Pure projection of one pinned local observation. No heartbeat implies nothing
 * about owner liveness, source publication, deployment or evidence coverage.
 * Pass null for a clock-free Work projection; only timed observations report ages. */
export function pendingStatus(
  data: PendingData,
  observed: PendingObservations = {},
  now: string | null = new Date().toISOString(),
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
    .filter(
      lane =>
        !['completed', 'abandoned'].includes(lane.state) ||
        (data.landingEntries ?? []).some(entry =>
          views.get(entry.viewId)?.inputs.some(pin => pin.laneId === lane.id),
        ),
    )
    .map(lane => {
      const candidates = data.views.filter(view =>
        view.inputs.some(pin => pin.laneId === lane.id && pin.head === lane.head),
      );
      const candidateIds = new Set(candidates.map(view => view.id));
      const entries = (data.landingEntries ?? []).filter(entry => candidateIds.has(entry.viewId));
      const entry = entries.at(-1);
      const submissions = new Map(
        (observed.submissions ?? [])
          .filter(item => item.laneId === lane.id)
          .map(item => [item.submissionId, item]),
      );
      for (const queued of data.landingEntries ?? []) {
        const pin = views.get(queued.viewId)?.inputs.find(pin => pin.laneId === lane.id);
        if (!pin) continue;
        const previous = [...submissions.values()].find(
          item => item.entryOperationId === queued.id && item.laneId === lane.id,
        );
        const queuedRun = data.runs.find(run => run.id === queued.runId);
        const batch = data.landingBatches?.find(batch => batch.id === queued.batchId);
        const observedDiagnosis = previous?.diagnosis;
        const diagnosis = batch
          ? batchDiagnosis(batch)
          : observedDiagnosis && observedDiagnosis.batchId === queued.batchId
            ? { diagnosis: observedDiagnosis }
            : {};
        const submission = projectSubmission(
          previous?.operationId ?? queued.id,
          previous ? { ...pin, head: previous.head } : pin,
          lane,
          {
            ...queueObservation(queued, queuedRun, diagnosis),
            status:
              queued.status === 'awaiting-review' &&
              data.channelMoves.some(
                move =>
                  move.channel === queued.channel &&
                  move.status === 'accepted' &&
                  move.viewId === (data.runs.find(run => run.id === queued.runId)?.viewId ?? queued.viewId),
              )
                ? 'accepted'
                : queued.status,
          },
          landingAttemptId(queued),
          pin.head,
        );
        submissions.set(submission.submissionId, {
          ...submission,
          entryOperationId: queued.id,
          ...(previous?.phases ? { phases: previous.phases } : {}),
        });
      }
      const submissionList = [...submissions.values()];
      const submission =
        [...submissionList].reverse().find(item => item.state !== 'superseded') ??
        submissionList.at(-1) ??
        null;
      const after = lane.after;
      const parent = lane.stack ? data.lanes.find(item => item.id === lane.stack!.laneId) : undefined;
      const parentLanded =
        !!lane.stack &&
        [lane.stack.head, parent?.head].some(head => acceptedInputs.has(`${lane.stack!.laneId}:${head}`));
      const chain = [lane.id];
      let ancestor = lane;
      while (ancestor.stack && !ancestor.stack.detached && !chain.includes(ancestor.stack.laneId)) {
        chain.unshift(ancestor.stack.laneId);
        const next = data.lanes.find(item => item.id === ancestor.stack!.laneId);
        if (!next) break;
        ancestor = next;
      }
      const stackState = lane.stack?.detached
        ? 'main'
        : parentLanded
          ? 'parent-landed'
          : parent?.state === 'abandoned'
            ? 'parent-abandoned'
            : parent?.head !== lane.stack?.head
              ? 'parent-moved'
              : 'up-to-date';
      const dependencyWaiting =
        (lane.stack && !lane.stack.detached && !parentLanded) ||
        (after &&
          !(parentLanded && 'intentId' in after && after.intentId === parent?.intentId) &&
          ('viewId' in after
            ? !accepted.has(after.viewId)
            : data.lanes.filter(item => item.intentId === after.intentId).length === 0 ||
              data.lanes.some(
                item => item.intentId === after.intentId && !acceptedInputs.has(`${item.id}:${item.head}`),
              )));
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
        submission:
          submission?.state === 'pending' && dependencyWaiting && submission.pendingReason === 'queued'
            ? { ...submission, pendingReason: 'waiting-for-dependency' as const }
            : submission,
        intentId: lane.intentId,
        checkpoints: lane.checkpoints ?? [],
        savesSinceSubmission: (
          lane as typeof lane & { savesSinceSubmission?: { head: string; saves: number }[] }
        ).savesSinceSubmission,
        checkpointCount:
          (lane as typeof lane & { checkpointCount?: number }).checkpointCount ??
          lane.checkpoints?.length ??
          0,
        lastCheckpointAt:
          (lane as typeof lane & { lastCheckpointAt?: string }).lastCheckpointAt ??
          lane.checkpoints?.at(-1)?.at,
        stackParent: parent ? { laneId: parent.id, name: parent.name } : null,
        entries: (data.landingEntries ?? [])
          .filter(item => views.get(item.viewId)?.inputs.some(pin => pin.laneId === lane.id))
          .map(item => {
            const run = data.runs.find(run => run.id === item.runId);
            const move = item.acceptanceId
              ? moves.find(move => move.id === item.acceptanceId)
              : moves.filter(move => move.viewId === (run?.viewId ?? item.viewId)).at(-1);
            return {
              id: item.id,
              status: item.status,
              arrivedAt: item.arrivedAt,
              viewId: item.viewId,
              run: run
                ? {
                    id: run.id,
                    intentId: views.get(run.viewId)?.intentId ?? lane.intentId,
                    viewId: run.viewId,
                    status: run.status,
                    startedAt: run.startedAt,
                    endedAt: run.endedAt,
                    exitCode: run.exitCode,
                    check: { name: run.check?.name ?? 'Check' },
                    cause: diagnosticCause(run),
                  }
                : null,
              move: move ? { id: move.id, at: move.at, head: move.head, automatic: move.automatic } : null,
            };
          }),
        submissions: submissionList,
        after: after ?? null,
        ...(lane.stack
          ? {
              stack: {
                status: stackState,
                depth: chain.length,
                summary: `${chain.map(id => id.slice(0, 8)).join(' → ')} · ${stackState}`,
              },
            }
          : {}),
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
    overlap: observed.overlap ?? { groups: [], coverage: 'unknown' },
    schema: 1,
    integrationPreview: observed.integrationPreview,
    snapshot: { observedAt: now, workRevision: data.revision, scope: 'local-saved-records' },
    main: { head: mainHead, acceptanceId: main?.id ?? null, acceptedAt: main?.at ?? null },
    lanes,
    counts: {
      ready: lanes.filter(lane => lane.status === 'ready').length,
      waiting: lanes.filter(lane => lane.status === 'waiting').length,
      checking: lanes.filter(lane => lane.status === 'checking').length,
    },
    hosted: {
      autoExchange: observed.autoExchange ?? null,
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
    landingWorker: {
      ...(observed.landingWorker ?? { status: 'unknown', workers: 0, observedAt: null, code: null }),
      pendingRecovery: (data.landingEntries ?? []).filter(entry =>
        ['queued', 'checking'].includes(entry.status),
      ).length,
      dependencyWaits: observed.waitingLaneIds?.length ?? 0,
    },
  };
}
export type PendingStatus = ReturnType<typeof pendingStatus>;
