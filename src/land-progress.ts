import { readLandingAttempts } from './land-attempts.js';
// SPDX-License-Identifier: Apache-2.0
import { landingPositions, landingMatch } from './landing-records-index.js';
import { finishChild } from './agent-finish-journal.js';
import { orderLandingEntries } from './landing-batch-order.js';
import { deriveLandingPhases, landingEta, type PhaseRecords } from './land-phases.js';
import { readLandingWorkerStatus } from './landing-worker-status.js';
import { readLandCheckController, readLandCheckProgress } from './land-check-progress.js';
import type { LandEntry } from './land-journal.js';
import type { LandingEntry } from './landing-batch-types.js';
import type { ChannelMove, CheckRun, WorkData } from './work-types.js';
import type { WorkStore } from './work-store.js';

const HISTORY_LIMIT = 20;
function records(store: WorkStore, channel: string, arrivedAt?: string) {
  const tx = store.readRecords();
  if (!tx) {
    const data = store.load();
    return { entries: data.landingEntries ?? [], moves: data.channelMoves };
  }
  const entries = landingPositions(store, tx, 'landingEntries', ['queued', 'checking'], channel).map(
    position => tx.at('landingEntries', position),
  );
  const moves: ChannelMove[] = [];
  for (const position of tx.positions('channelMoves', channel, 'channel').reverse()) {
    const move = tx.at('channelMoves', position);
    if (move.status === 'accepted' && (!arrivedAt || move.at < arrivedAt)) moves.push(move);
    if (moves.length > HISTORY_LIMIT) break;
  }
  return { entries, moves: moves.reverse() };
}
function runRecords(
  store: WorkStore,
  entry: LandingEntry | undefined,
  run: CheckRun | undefined,
  move: ChannelMove | undefined,
  includeFiles = true,
): PhaseRecords {
  const batch = entry?.batchId ? store.select('landingBatches', entry.batchId) : undefined;
  const full = batch?.prefixes.at(-1);
  const fullRun = full ? store.select('runs', full.runId) : undefined;
  run = fullRun ?? run;
  const check = run ? readLandCheckProgress(store.directory, run.id, includeFiles) : undefined;
  const remote = run?.backend?.actual === 'github-actions' || run?.backend?.actual === 'modal';
  const ciAt =
    check?.ciAt ??
    (!remote && run?.status !== 'queued' && run?.status !== 'preparing' ? run?.startedAt : undefined);
  const checkedAt = check?.checkedAt ?? run?.endedAt;
  const requeued = entry?.status === 'queued' && batch && ['completed', 'superseded'].includes(batch.status);
  const current = requeued
    ? 'queued'
    : move
      ? 'accepted'
      : checkedAt
        ? batch?.diagnosis?.nodes.some(node => node.parentId) && !batch.timing?.settlementStartedAt
          ? 'diagnosing'
          : 'recording-accepting'
        : ciAt ||
            check?.dispatched ||
            run?.backend?.executionIds?.length ||
            (!remote && run?.status === 'running')
          ? 'ci-running'
          : run || (batch?.status === 'checking' && batch.prefixes.length)
            ? 'dispatching'
            : batch?.status === 'composing' || entry?.firstSelectedAt
              ? 'composing'
              : 'queued';
  const readmittedAt = [...(entry?.infrastructureRetries ?? []), ...(entry?.runtimeRepins ?? [])]
    .map(item => item.at)
    .sort()
    .at(-1);
  return {
    current,
    queuedAt: readmittedAt ?? entry?.arrivedAt,
    // firstSelectedAt belongs to the original attempt. Re-admissions do not retain
    // a fresh composition start; counting the intervening CI as composition is false.
    selectedAt:
      readmittedAt && (!entry?.firstSelectedAt || entry.firstSelectedAt < readmittedAt)
        ? undefined
        : (batch?.timing?.selectedAt ?? entry?.firstSelectedAt),
    // A run reservation is the recorded end of composition/start of dispatch preparation.
    composedAt: batch?.timing?.composedAt,
    diagnosisAt: batch?.diagnosis?.nodes.some(node => node.parentId) ? checkedAt : undefined,
    settlementAt: batch?.timing?.settlementStartedAt,
    dispatchAt: run?.queuedAt ?? run?.startedAt ?? check?.dispatchAt,
    ciAt,
    checkedAt,
    acceptedAt: move?.at,
    progress: check?.progress,
    ...(entry && !['queued', 'checking', 'awaiting-review'].includes(entry.status)
      ? { outcome: entry.status }
      : {}),
  };
}
/** Finite local-only projection. It never wakes a worker, fetches provider data or changes records. */
function landingProgressSnapshot(
  store: WorkStore,
  operationId: string,
  journal?: LandEntry,
  now = Date.now(),
  includeFollowUp = true,
) {
  const entry = store.select('landingEntries', operationId);
  const channel = entry?.channel ?? journal?.command.accept?.channel ?? 'main';
  const data = records(store, channel, entry?.arrivedAt);
  const batch = entry?.batchId ? store.select('landingBatches', entry.batchId) : undefined;
  const runId =
    entry?.runId ??
    batch?.prefixes.at(-1)?.runId ??
    (journal?.single
      ? finishChild(operationId, `single:${journal.single.attempt}:run`)
      : typeof journal?.result?.runId === 'string'
        ? journal.result.runId
        : undefined);
  const run = runId ? store.select('runs', runId) : undefined;
  const viewId = run?.viewId ?? journal?.single?.viewId ?? journal?.viewId ?? entry?.viewId;
  const acceptanceId = entry?.acceptanceId ?? journal?.result?.acceptanceId;
  const tx = store.readRecords();
  const moves = acceptanceId
    ? [store.select('channelMoves', String(acceptanceId))].filter((move): move is ChannelMove => !!move)
    : viewId && tx
      ? tx.all('channelMoves', viewId, 'viewId')
      : data.moves;
  const move = moves.find(
    item =>
      item.status === 'accepted' &&
      item.channel === channel &&
      (acceptanceId ? item.id === acceptanceId : item.viewId === viewId),
  );
  const result = runRecords(store, entry, run, move);
  if (!entry && journal?.single?.timing) {
    result.selectedAt = journal.single.timing.selectedAt;
    result.composedAt = journal.single.timing.composedAt;
    result.settlementAt = journal.single.timing.settlementStartedAt;
  }
  if (!entry && !run && journal?.viewId)
    result.current = journal.single?.viewId ? 'dispatching' : 'composing';
  if (journal?.result?.status && journal.result.status !== 'waiting')
    result.outcome = String(journal.result.status);
  const queued = orderLandingEntries(
    data.entries.filter(
      item =>
        item.channel === (entry?.channel ?? journal?.command.accept?.channel ?? 'main') &&
        item.status === 'queued',
    ),
  );
  const position = entry ? queued.findIndex(item => item.id === entry.id) + 1 : 0;
  if (result.current === 'queued')
    result.queue = {
      position: position || 'unknown',
      total: position ? queued.length : 'unknown',
      waitingOn: journal?.result?.dependencies
        ? 'dependency'
        : journal?.result?.overlapAfter ||
            position > 1 ||
            data.entries.some(item => item.channel === entry?.channel && item.status === 'checking')
          ? 'batch ahead'
          : run?.status === 'queued'
            ? 'runner'
            : 'composition',
    };
  if (run?.status === 'queued') result.waitingOn = 'runner';
  const summary = (store.readRecords()?.data() ?? store.load()) as Pick<
    WorkData,
    'githubSync' | 'githubAutoPush' | 'autonomyPolicy'
  >;
  if (includeFollowUp && move?.postAccept) {
    const audit = move.postAcceptRunId ? store.select('runs', move.postAcceptRunId) : undefined;
    result.audit = {
      startedAt: audit?.startedAt,
      endedAt: audit?.endedAt,
      waitingOn: audit ? (audit.status === 'queued' ? 'runner' : audit.status) : 'audit queue',
    };
    if (audit?.status !== 'passed') result.current = 'main-audit';
  }
  const mirror = summary.githubAutoPush;
  const binding = summary.githubSync;
  const commitIndex = binding?.commits.findIndex(item => item.acceptanceId === move?.id) ?? -1;
  const pushed = commitIndex >= 0 && binding!.pushed > commitIndex;
  if (
    includeFollowUp &&
    move &&
    (mirror?.acceptanceId === move.id || commitIndex >= 0 || summary.autonomyPolicy?.githubMirror?.autoPush)
  ) {
    result.mirror = {
      // `at` is an observation/update, not the beginning of a push. No start is retained.
      completed: pushed || (mirror?.acceptanceId === move.id && mirror.status === 'pushed'),
      endedAt:
        pushed && commitIndex === binding!.pushed - 1
          ? binding?.pushedAt
          : mirror?.acceptanceId === move.id && mirror.status === 'pushed'
            ? mirror.at
            : undefined,
      waitingOn:
        result.current === 'main-audit'
          ? 'main audit'
          : mirror?.acceptanceId === move.id
            ? mirror.status
            : 'github mirror push',
    };
    if (result.current === 'accepted' && !result.mirror?.completed) result.current = 'github-mirror-push';
  }
  const phases = deriveLandingPhases(result);
  const history = data.moves
    .filter(
      item =>
        item.status === 'accepted' &&
        item.channel === (entry?.channel ?? 'main') &&
        item.id !== move?.id &&
        (!entry?.arrivedAt || item.at < entry.arrivedAt),
    )
    .slice(-HISTORY_LIMIT)
    .map(item => {
      const prior = tx
        ? landingMatch(store, tx, 'landingEntries', 'acceptanceId', item.id ?? '').map(position =>
            tx.at('landingEntries', position),
          )[0]
        : data.entries.find(entry => entry.acceptanceId === item.id);
      const priorRun = prior?.runId
        ? store.select('runs', prior.runId)
        : (
            store.readRecords()?.all('runs', item.viewId, 'viewId') ??
            store.load().runs.filter(run => run.viewId === item.viewId)
          ).at(-1);
      const historical = runRecords(store, prior, priorRun, item, false);
      if (item.postAcceptRunId) {
        const audit = store.select('runs', item.postAcceptRunId);
        historical.audit = { startedAt: audit?.startedAt, endedAt: audit?.endedAt };
      }
      return deriveLandingPhases(historical);
    });
  const eta = landingEta(phases, history, now, HISTORY_LIMIT);
  // Execution ownership and worker errors are live observations, never replayed receipt facts.
  const check = includeFollowUp && run ? readLandCheckController(store, run) : undefined;
  const worker = includeFollowUp ? readLandingWorkerStatus(store) : undefined;
  const affected = worker?.affected;
  const workerError =
    worker?.code &&
    affected &&
    (affected.operationId === operationId ||
      (batch && affected.operationId === batch.id) ||
      (affected.runId && affected.runId === runId))
      ? { code: worker.code, ...affected }
      : undefined;
  return {
    ...phases,
    attempts: readLandingAttempts(store, operationId, journal),
    ...(eta ? { eta } : {}),
    ...(check ? { check } : {}),
    ...(workerError ? { workerError } : {}),
  };
}

export function readLandingProgress(...args: Parameters<typeof landingProgressSnapshot>) {
  return args[0].observing(() => landingProgressSnapshot(...args));
}
