// SPDX-License-Identifier: Apache-2.0
import { z } from 'zod';
import { waitTrainEvents } from './agent-wait-train.js';
import { waitSubmissions, submissionTarget } from './agent-wait-submission.js';
import { invariant } from './errors.js';
import { finishChild } from './agent-finish-journal.js';
import { CoordinationJournal } from './agent-coordination-journal.js';
import { activeCheck, infrastructure, waitJson, waitRun, type WaitEvent } from './agent-wait-run.js';
import type { WorkStore } from './work-store.js';
import type { CheckRun } from './work-types.js';

const fields = z.record(z.string(), z.unknown());
const finishSchema = z.object({
  schema: z.literal(1),
  attempts: z.array(
    z.object({
      operations: z.object({ run: z.uuid() }),
      status: z.string().optional(),
      error: z.object({ message: z.string() }).optional(),
    }),
  ),
  result: fields.optional(),
});
const landSchema = z.object({
  schema: z.literal(1),
  entries: z.array(
    z.object({
      command: z.object({ operationId: z.uuid() }),
      result: fields.optional(),
      single: z.object({ attempt: z.number().int().nonnegative() }).optional(),
    }),
  ),
});
const pending = (status: string) =>
  [
    'queued',
    'checking',
    'waiting',
    'waiting to land',
    'landing',
    'waiting-for-dependency',
    'preparing',
    'running',
  ].includes(status);
const success = (status: string) =>
  ['accepted', 'already-accepted', 'passed', 'completed', 'landed'].includes(status);
function outcome(
  id: string,
  status: string,
  terminal: boolean,
  detail: Record<string, unknown> = {},
): WaitEvent {
  return {
    ...detail,
    type: 'operation',
    id,
    status: status === 'accepted' || status === 'already-accepted' ? 'landed' : status,
    terminal,
    ok: terminal && success(status),
    failureClass: infrastructure(status) ? 'infrastructure' : status === 'failed' ? 'check' : null,
  };
}

/** One pinned Work revision, selected records only on indexed owners. Journals are atomic snapshots. */
export function waitObservation(store: WorkStore, kind: 'lane' | 'operation', id: string) {
  return store.observing(() => {
    const events: WaitEvent[] = [],
      runIds = new Set<string>(),
      laneIds = new Set<string>();
    const checked = new Map<string, WaitEvent>();
    const check = (run: CheckRun) => {
      const previous = checked.get(run.id);
      if (previous) return previous;
      runIds.add(run.id);
      const observed = waitRun(store, run);
      events.push(...observed.children, observed.event);
      checked.set(run.id, observed.event);
      for (const input of run.inputs) laneIds.add(input.laneId);
      return observed.event;
    };
    const operation = (operationId: string): WaitEvent => {
      const run = store.select('runs', operationId);
      if (run) return { ...check(run), type: 'operation', id: operationId };
      const entry = store.select('landingEntries', operationId);
      if (entry) {
        const run = entry.runId && store.select('runs', entry.runId);
        const observed = run ? check(run) : undefined;
        return outcome(operationId, entry.status, !pending(entry.status), {
          reason: entry.reason ?? observed?.reason ?? null,
          runId: entry.runId ?? null,
          logPath: observed?.logPath ?? null,
          failingShardLogPaths: observed?.failingShardLogPaths ?? [],
          ...(observed && infrastructure(observed.status) ? { infrastructureStatus: observed.status } : {}),
        });
      }
      const finishBytes = waitJson(store, `agent-finish/${operationId}.json`);
      const finish = finishSchema.safeParse(finishBytes);
      invariant(
        finishBytes === undefined || finish.success,
        'INVALID_WORK_STORE',
        'Invalid finish wait journal.',
      );
      if (finish.success) {
        const attempt = finish.data.attempts.at(-1),
          result = finish.data.result;
        const run = attempt && store.select('runs', attempt.operations.run);
        const observed = run ? check(run) : undefined;
        const stopped = observed?.terminal && !observed.ok;
        const rawStatus = String(
          result?.status ??
            (stopped ? observed.status : (attempt?.status ?? (observed ? 'checking' : 'queued'))),
        );
        const status = activeCheck(rawStatus) && observed ? 'checking' : rawStatus;
        return outcome(
          operationId,
          status,
          ((!!result && result.terminal !== false) || !!stopped) && !pending(status),
          {
            reason: result?.reason ?? result?.message ?? attempt?.error?.message ?? observed?.reason ?? null,
            runId: run?.id ?? null,
            logPath: observed?.logPath ?? null,
            failingShardLogPaths: observed?.failingShardLogPaths ?? [],
            ...(observed && infrastructure(observed.status) ? { infrastructureStatus: observed.status } : {}),
          },
        );
      }
      const landBytes = waitJson(store, `agent-land/${operationId}.json`);
      const land = landSchema.safeParse(landBytes);
      invariant(landBytes === undefined || land.success, 'INVALID_WORK_STORE', 'Invalid land wait journal.');
      if (land.success) {
        const entries = land.data.entries.map(entry => {
          const current = operation(entry.command.operationId);
          if (current.status !== 'unknown') return current;
          const runId =
            typeof entry.result?.runId === 'string'
              ? entry.result.runId
              : entry.single
                ? finishChild(entry.command.operationId, `single:${entry.single.attempt}:run`)
                : undefined;
          const run = runId && store.select('runs', runId);
          const observed = run ? check(run) : undefined;
          const status =
            observed && infrastructure(observed.status)
              ? observed.status
              : String(entry.result?.status ?? (observed ? 'checking' : 'queued'));
          return {
            ...outcome(entry.command.operationId, status, !!entry.result && !pending(status), {
              reason: entry.result?.message ?? observed?.reason ?? null,
              runId: runId ?? null,
              logPath: observed?.logPath ?? null,
              failingShardLogPaths: observed?.failingShardLogPaths ?? [],
            }),
            failureClass: observed?.failureClass ?? null,
          };
        });
        events.push(...entries);
        const terminal = entries.length > 0 && entries.every(entry => entry.terminal);
        const failed = entries.find(entry => entry.terminal && !entry.ok);
        const status = terminal
          ? (failed?.status ?? 'landed')
          : entries.some(entry => entry.status === 'checking')
            ? 'checking'
            : 'queued';
        return {
          ...outcome(operationId, status, terminal),
          entries,
          failureClass: failed?.failureClass ?? null,
          reason: failed?.reason ?? null,
        };
      }
      return outcome(operationId, 'unknown', false, { reason: 'No local run, finish or land record yet.' });
    };
    let target: WaitEvent;
    if (kind === 'operation') target = operation(id);
    else {
      laneIds.add(id);
      const lane = store.select('lanes', id);
      if (!lane) target = { ...outcome(id, 'unknown', false), type: 'lane' };
      else {
        const tx = store.readRecords();
        const views = tx
          ? tx.all('views', lane.intentId, 'intentId')
          : store.load().views.filter(view => view.intentId === lane.intentId);
        const selected = views.filter(view =>
          view.inputs.some(input => input.laneId === id && input.head === lane.head),
        );
        const latest = selected.at(-1);
        const runs = selected.flatMap(view =>
          tx ? tx.all('runs', view.id, 'viewId') : store.load().runs.filter(run => run.viewId === view.id),
        );
        const last = runs.at(-1);
        const observed = last && check(last);
        const closed = ['completed', 'abandoned'].includes(lane.state);
        const conflict =
          lane.pendingSync?.sync?.status === 'conflict' ||
          !!lane.pendingMerge?.conflicts.length ||
          latest?.status === 'conflict';
        const status = closed
          ? lane.state
          : conflict
            ? 'conflict'
            : observed && !observed.ok
              ? activeCheck(observed.status)
                ? 'checking'
                : observed.status
              : lane.state;
        target = {
          type: 'lane',
          id,
          status,
          terminal: closed || conflict || (!!observed?.terminal && !observed.ok),
          ok: lane.state === 'completed',
          head: lane.head,
          state: lane.state,
          failureClass: observed?.failureClass ?? null,
          reason: conflict ? 'Source composition has conflicts.' : (observed?.reason ?? null),
          logPath: observed?.logPath ?? null,
          failingShardLogPaths: observed?.failingShardLogPaths ?? [],
        };
      }
    }
    const submissions = waitSubmissions(store, kind, id, check, runIds);
    if (submissions.length) {
      events.push(...submissions);
      for (const submission of submissions) laneIds.add(submission.laneId);
      target = submissionTarget(kind, id, submissions);
    }
    for (const laneId of laneIds)
      for (const notice of new CoordinationJournal(store).context(laneId).notices)
        events.push({
          type: 'notice',
          id: notice.noticeId,
          status: 'overlap',
          terminal: false,
          ok: false,
          reason: notice.reason,
          participants: notice.participants.map(p => p.lane),
          paths: notice.conflicts.map(c => c.path),
          proposedOrder: notice.proposedOrder,
        });
    events.push(...waitTrainEvents(store, laneIds));
    return { target, events, runIds: [...runIds] };
  });
}
