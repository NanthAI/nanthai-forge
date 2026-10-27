import { nativeFirstAttemptLandRate } from './first-attempt-native.js';
import { setImmediate as yieldTurn } from 'node:timers/promises';
import { landingMatch, prepareLandingRecords } from './landing-records-index.js';
import { assertLandingWorkerActive } from './landing-worker-context.js';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { invariant } from './errors.js';
import { landingAdmission } from './landing-admission.js';
import { resolveLandEntry } from './land-request-identity.js';
import { readLandingProgress } from './land-progress.js';
import { phaseSummary } from './land-phases.js';
// SPDX-License-Identifier: Apache-2.0
import { landSubmissions } from './landing-submission-read.js';
import { submissionLine, queuedOutcome } from './landing-submission.js';
import type { LandEntry } from './land-journal.js';
import type { LandJournal } from './land-journal.js';
import type { LandCommand } from './land-schema.js';
import type { WorkStore } from './work-store.js';
/** Work can publish acceptance before its parent journal observes settlement.
 * Never combine a terminal submission with stale queue/check diagnostics. */
function entryOutcome(store: WorkStore, entry: LandEntry): Record<string, unknown> {
  const queued = store.select('landingEntries', entry.command.operationId);
  if (!queued) return entry.result ?? {};
  const { checkStatus, ...current } = queuedOutcome(store, queued);
  const conflict = queued.conflictViewId ? store.select('views', queued.conflictViewId)?.details : undefined;
  const pending = ['queued', 'checking'].includes(queued.status);
  return {
    ...(pending && ['WORK_BUSY', 'WORK_STALE', 'SOURCE_CHANGED'].includes(String(entry.result?.code))
      ? { code: entry.result!.code, message: entry.result!.message }
      : {}),
    ...current,
    ...(checkStatus ? { checkStatus } : {}),
    ...(queued.batchId ? { batchId: queued.batchId } : {}),
    ...(queued.runId ? { runId: queued.runId } : {}),
    ...(queued.acceptanceId ? { acceptanceId: queued.acceptanceId } : {}),
    viewId: queued.conflictViewId ?? queued.viewId,
    ...(conflict === undefined ? {} : { conflict }),
    ...(queued.previewDiagnostic
      ? { code: 'INTEGRATION_PREVIEW_EXCLUDED', preview: queued.previewDiagnostic }
      : {}),
    status: pending ? 'waiting' : queued.status === 'awaiting-review' ? 'review-needed' : current.status,
  };
}

function landingSnapshot(
  store: WorkStore,
  command: LandCommand,
  journal: Pick<LandJournal, 'state'>,
  wait?: boolean,
) {
  const replay = wait === false ? { ...command, wait: false } : command;
  const resolved = journal.state.entries.map(entry => resolveLandEntry(store, entry));
  const entries = resolved.map(entry => {
    // A settled deleted-Lane receipt still carries its selected inputs/reason;
    // no current Lane remains from which to derive a submission presentation.
    const submissions =
      entry.result?.settled && entry.inputs.some(pin => !store.select('lanes', pin.laneId))
        ? []
        : landSubmissions(store, entry);
    const outcome = entryOutcome(store, entry);
    const phases =
      submissions[0]?.phases ??
      readLandingProgress(store, entry.command.operationId, entry, undefined, false);
    return {
      operationId: entry.command.operationId,
      message: entry.command.message,
      inputs: entry.inputs,
      ...outcome,
      status: entry.result?.settled
        ? String(outcome.status)
        : submissions.every(item => item.state === 'superseded')
          ? 'superseded'
          : submissions.every(item => item.complete)
            ? 'accepted'
            : String(outcome.status ?? 'waiting'),
      phases,
      submissions,
    };
  });
  const settlements = new Map(
    resolved.filter(entry => entry.result?.settled).map(entry => [entry.command.operationId, entry.result!]),
  );
  const complete = (entry: (typeof entries)[number]) =>
    settlements.has(entry.operationId)
      ? settlements.get(entry.operationId)!.complete === true
      : entry.submissions.every(item => item.complete);
  const terminal = (entry: (typeof entries)[number]) =>
    settlements.has(entry.operationId)
      ? settlements.get(entry.operationId)!.terminal === true
      : entry.submissions.every(item => item.terminal);
  const counts: Record<string, number> = {};
  for (const entry of entries) {
    const status = String(entry.status);
    counts[status] = (counts[status] ?? 0) + entry.inputs.length;
  }
  return {
    revision: store.revision(),
    result: {
      operationId: command.operationId,
      handle: {
        operationId: journal.state.entries.every(
          entry =>
            (entry.sourceOperationId ?? entry.sharedOperationId) ===
            (journal.state.entries[0]?.sourceOperationId ?? journal.state.entries[0]?.sharedOperationId),
        )
          ? (journal.state.entries[0]?.sourceOperationId ??
            journal.state.entries[0]?.sharedOperationId ??
            command.operationId)
          : command.operationId,
        entryIds: [...new Set(entries.map(entry => entry.operationId))],
      },
      phase: entries.every(complete)
        ? 'landed'
        : entries.every(terminal)
          ? entries.every(entry => entry.status === 'superseded')
            ? 'superseded'
            : 'terminal-failed'
          : (entries.find(entry => entry.submissions.some(item => !item.terminal))?.phases.current ??
            'queued'),
      complete: entries.every(complete),
      terminal: entries.every(terminal),
      summary: entries.flatMap(entry =>
        entry.submissions.map(
          submission => `${submission.laneId.slice(0, 8)}: ${submissionLine(submission)}`,
        ),
      ),
      table: [
        'Lane\tHead\tResult\tPhase durations',
        ...entries.flatMap(entry =>
          entry.submissions.map(
            item =>
              `${item.laneId}\t${item.head}\t${item.state}${item.cause ? ` (${item.cause})` : ''}\t${phaseSummary(entry.phases)}`,
          ),
        ),
      ].join('\n'),
      counts,
      firstAttemptLandRate: nativeFirstAttemptLandRate(store),
      entries,
      replay: {
        command: replay,
        shell: `nforge agent '${store.root.replaceAll("'", "'\\''")}' land '${JSON.stringify(replay).replaceAll("'", "'\\''")}'`,
      },
    },
  };
}

/** All queue, check, acceptance and submission projections share one immutable
 * Work pointer even when a controller publishes during a client observation. */
export function landReceipt(...args: Parameters<typeof landingSnapshot>) {
  return args[0].observing(() => landingSnapshot(...args));
}

/** Drivers prime only this request's selected evidence between event-loop turns.
 * The final receipt shares those immutable reads under the same pinned pointer. */
export async function observeLandReceipt(...args: Parameters<typeof landingSnapshot>) {
  const [store, , journal] = args;
  return store.observing(async () => {
    const tx = store.readRecords();
    try {
      if (tx) await prepareLandingRecords(store, tx);
      const pause = async () => {
        await yieldTurn();
        assertLandingWorkerActive();
      };
      for (const retained of journal.state.entries) {
        const entry = resolveLandEntry(store, retained);
        const queued = store.select('landingEntries', entry.command.operationId);
        await pause();
        if (queued?.viewId) store.select('views', queued.viewId);
        for (const pin of entry.inputs) {
          store.select('lanes', pin.laneId);
          await pause();
        }
        if (queued?.batchId) {
          store.select('landingBatches', queued.batchId);
          await pause();
        }
        if (queued?.runId) {
          store.select('runs', queued.runId);
          await pause();
        }
        if (tx)
          for (const position of landingMatch(
            store,
            tx,
            'landingBatches',
            'entryId',
            entry.command.operationId,
          )) {
            const batch = tx.at('landingBatches', position);
            await pause();
            for (const prefix of batch.prefixes) {
              store.select('runs', prefix.runId);
              await pause();
            }
          }
      }
      return landReceipt(...args);
    } finally {
      tx?.dispose();
    }
  });
}

/** Reconnect by operation id without recreating a journal, capturing source,
 * repairing scheduling or entering the writer queue. */
export function readLandingHandle(store: WorkStore, operationId: string) {
  const path = join(store.directory, 'agent-land', `${operationId}.json`);
  invariant(existsSync(path), 'NOT_FOUND', 'Landing operation not found.');
  const state = JSON.parse(readFileSync(path, 'utf8')) as LandJournal['state'];
  invariant(state.schema === 1 && state.command, 'INVALID_WORK_STORE', 'Landing request is unavailable.');
  const response = landReceipt(store, state.command, { state }, false);
  return {
    ...response,
    result: { ...response.result, ...landingAdmission(store, operationId, state.command.laneIds) },
  };
}
