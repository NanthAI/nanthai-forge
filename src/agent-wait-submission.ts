// SPDX-License-Identifier: Apache-2.0
import { readLaneSubmissions } from './landing-submission-read.js';
import { submissionOutcome, type Submission } from './landing-submission.js';
import { finishChild } from './agent-finish-journal.js';
import { activeCheck, waitJson, type WaitEvent } from './agent-wait-run.js';
import type { CheckRun } from './work-types.js';
import type { WorkStore } from './work-store.js';

type Journal = {
  attempts?: { operations: { run: string }; error?: { message: string } }[];
  result?: { reason?: string; message?: string };
  entries?: {
    command: { operationId: string };
    single?: { attempt: number };
    result?: { runId?: string; message?: string; reason?: string };
  }[];
};
/** S01 owns submission identity/state; wait adds read-only live run/log observations. */
export function waitSubmissions(
  store: WorkStore,
  kind: 'lane' | 'operation',
  id: string,
  check: (run: CheckRun) => WaitEvent,
  runIds: Set<string>,
) {
  const parent =
    kind === 'operation' ? (waitJson(store, `agent-land/${id}.json`) as Journal | undefined) : undefined;
  const entries =
    parent?.entries ??
    (kind === 'operation'
      ? (waitJson(store, `agent-land/${finishChild(id, 'overlap-land')}.json`) as Journal | undefined)
          ?.entries
      : undefined) ??
    [];
  let submissions = readLaneSubmissions(
    store,
    kind === 'lane' ? id : undefined,
    kind === 'operation' ? id : undefined,
  ).filter(
    s =>
      kind === 'lane' ||
      s.operationId === id ||
      s.entryOperationId === id ||
      entries.some(e => e.command.operationId === s.entryOperationId),
  );
  if (kind === 'lane') {
    const head = store.select('lanes', id)?.head;
    submissions = submissions.filter(s => s.attemptHead === head).slice(-1);
  }
  return submissions.map(original => {
    const entry = store.select('landingEntries', original.entryOperationId);
    const batch = entry?.batchId ? store.select('landingBatches', entry.batchId) : undefined;
    // Entries receive their settled runId only after batch diagnosis. Follow
    // the recorded probes in the meantime, including a shared cumulative run.
    const probes =
      entry?.status === 'checking' && batch?.status === 'checking'
        ? (batch.diagnosis?.nodes ?? batch.prefixes)
            .filter(prefix => prefix.entryIds.includes(entry.id))
            .flatMap(prefix => {
              const run = store.select('runs', prefix.runId);
              return run && run.viewId === prefix.viewId && run.head === prefix.head ? [run] : [];
            })
        : [];
    const observedProbes = probes.map(check);
    const liveProbe =
      probes.filter((_, index) => activeCheck(observedProbes[index]!.status)).at(-1) ?? probes.at(-1);
    const finish = waitJson(store, `agent-finish/${original.operationId}.json`) as Journal | undefined;
    const child = entries.find(e => e.command.operationId === original.entryOperationId);
    const matchingRun = [...runIds]
      .map(id => store.select('runs', id))
      .filter(run =>
        run?.inputs.some(pin => pin.laneId === original.laneId && pin.head === original.attemptHead),
      )
      .at(-1);
    const runId =
      liveProbe?.id ??
      entry?.runId ??
      child?.result?.runId ??
      (child?.single
        ? finishChild(original.entryOperationId, `single:${child.single.attempt}:run`)
        : finish?.attempts?.at(-1)?.operations.run) ??
      (!entry && original.attemptId ? matchingRun?.id : undefined);
    const run = runId ? store.select('runs', runId) : undefined;
    const observed = run ? check(run) : undefined;
    let submission: Submission = original;
    if (
      observed?.status === 'pending-infra' &&
      (original.outcome === 'pending' || original.cause === 'infra')
    )
      submission = {
        ...original,
        state: original.state === 'superseded' ? 'superseded' : 'pending',
        outcome: 'pending',
        pendingReason: 'pending-infra',
        cause: null,
        terminal: original.state === 'superseded',
        complete: false,
      };
    if (
      original.state === 'pending' &&
      original.pendingReason === 'queued' &&
      observed &&
      activeCheck(observed.status)
    )
      submission = { ...original, pendingReason: 'checking' };
    // A durable result/dead-run observation may precede the driver's metadata publication.
    if (
      original.outcome === 'pending' &&
      original.pendingReason !== 'waiting-for-review' &&
      // A failing combination can still yield a passing shorter prefix. Only
      // the driver's settlement attributes that outcome to an individual entry.
      !liveProbe &&
      observed?.terminal &&
      !observed.ok
    ) {
      const outcome = submissionOutcome({ status: observed.status });
      submission = {
        ...original,
        ...outcome,
        outcome: outcome.state,
        state: original.state === 'superseded' ? 'superseded' : outcome.state,
        terminal: true,
        complete: false,
      };
    }
    return {
      ...submission,
      type: 'submission' as const,
      id: submission.submissionId,
      status: submission.state,
      ok: submission.complete,
      failureClass:
        submission.cause === 'infra'
          ? 'infrastructure'
          : submission.cause === 'check-failed'
            ? 'check'
            : null,
      reason:
        entry?.reason ??
        finish?.result?.reason ??
        finish?.result?.message ??
        child?.result?.reason ??
        child?.result?.message ??
        finish?.attempts?.at(-1)?.error?.message ??
        observed?.reason ??
        submission.cause ??
        submission.pendingReason,
      runId: runId ?? null,
      checkStatus: observed?.status ?? null,
      logPath: observed?.logPath ?? null,
      stderrPath: observed?.stderrPath ?? null,
      failingShardLogPaths: observed?.failingShardLogPaths ?? [],
    };
  });
}
export function submissionTarget(
  type: 'lane' | 'operation',
  id: string,
  submissions: ReturnType<typeof waitSubmissions>,
): WaitEvent {
  const terminal = submissions.every(s => s.terminal),
    failed = submissions.find(s => s.terminal && !s.ok),
    pending = submissions.find(s => !s.terminal),
    selected = failed ?? pending ?? submissions[0]!;
  return {
    ...selected,
    type,
    id,
    status: terminal ? (failed?.state ?? 'landed') : (pending?.pendingReason ?? 'queued'),
    terminal,
    ok: terminal && submissions.every(s => s.ok),
    submissions,
  };
}
