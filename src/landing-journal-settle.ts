// SPDX-License-Identifier: Apache-2.0
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { FinishJournal, retainedFinishCommand, type FinishAttempt } from './agent-finish-journal.js';
import { withQueueSlot } from './landing-queue.js';
import { pendingLands, saveLandJournal, type LandEntry } from './land-journal.js';
import { ForgeError } from './errors.js';
import { finishSubmissions } from './landing-submission-read.js';
import type { FinishAction } from './agent-workflow-schema.js';
import type { WorkStore } from './work-store.js';

type Fields = Record<string, unknown>;
const stopped = (status: string, code: string, message: string): Fields => ({
  status,
  code,
  message,
  terminal: true,
  complete: false,
  next: 'Start a new finish with a new operationId and available inputs; this terminal receipt is retained.',
});

/** Only immutable absence or an explicit replacement/cancellation ends recovery.
 * A newer save alone does not invalidate a pinned Candidate. */
function permanentOutcome(
  store: WorkStore,
  command: FinishAction,
  attempts: FinishAttempt[],
): Fields | undefined {
  const queued = store.select('landingEntries', command.operationId);
  // Queue completion retains the ordinary detailed receipt path. Only an
  // explicit queued cancellation needs settlement here; active Candidates and
  // completed checks/acceptances already have a canonical driver outcome.
  if (queued) {
    if (queued.status === 'cancelled')
      return stopped('cancelled', 'CANCELLED', queued.reason ?? 'The queued finish was cancelled.');
    return;
  }
  for (const attempt of attempts) {
    const accepted = store.select('channelMoves', attempt.operations.accept);
    if (accepted?.status === 'accepted')
      return { status: 'accepted', terminal: true, complete: true, acceptanceId: accepted.id };
  }
  const attempt = attempts.at(-1)!;
  if (store.select('runs', attempt.operations.run)?.status === 'cancelled' || attempt.status === 'cancelled')
    return stopped(
      'cancelled',
      'CANCELLED',
      'The retained finish was cancelled. Start a new finish to try again.',
    );
  const pins = [{ laneId: command.laneId, head: attempt.head }, ...(command.withInputs ?? [])];
  for (const pin of pins) {
    const lane = store.select('lanes', pin.laneId);
    if (!lane || (['completed', 'abandoned'].includes(lane.state) && !existsSync(store.path(lane.id))))
      return stopped(
        'interrupted',
        'LANE_UNAVAILABLE',
        `Retained finish Lane ${pin.laneId} is unavailable. Start a new finish from an available Lane.`,
      );
    if (lane.state === 'abandoned')
      return stopped('cancelled', 'LANE_ABANDONED', `Retained finish Lane ${lane.id} was abandoned.`);
  }
  const lane = store.select('lanes', command.laneId)!;
  const position = lane.checkpoints.findIndex(checkpoint => checkpoint.operation?.id === command.operationId);
  if (position >= 0) {
    for (const checkpoint of lane.checkpoints.slice(position + 1).reverse()) {
      const id = checkpoint.operation?.id;
      const newer = id ? retainedFinishCommand(store, id) : undefined;
      const accept = newer?.accept as FinishAction['accept'];
      if (newer?.laneId === command.laneId && accept?.channel === command.accept?.channel)
        return {
          ...stopped(
            'superseded',
            'LANDING_SUPERSEDED',
            `Finish ${command.operationId} was superseded by finish ${id}.`,
          ),
          supersededBy: id,
        };
    }
  }
  if (store.native) {
    const heads = [
      ...pins.map(pin => pin.head),
      attempt.previous,
      attempt.sync?.head,
      attempt.view?.head,
      ...(command.dependencies ?? []).map(pin => pin.head),
    ];
    for (const head of heads)
      if (typeof head === 'string' && !existsSync(join(store.directory, 'objects', head)))
        return stopped(
          'interrupted',
          'FINISH_INPUT_UNAVAILABLE',
          `Retained finish input State ${head} no longer exists. Start a new finish with available inputs.`,
        );
  }
}

/** The parent slot fences journal writes against an in-flight driver. No Work
 * writer lock, source restoration or check registration is needed to settle. */
export async function settleFinish(store: WorkStore, command: FinishAction, error?: unknown) {
  const failure =
    error instanceof ForgeError && ['LANE_UNAVAILABLE', 'CANCELLED'].includes(error.code)
      ? stopped(error.code === 'CANCELLED' ? 'cancelled' : 'interrupted', error.code, error.message)
      : undefined;
  const outcomeFor = (attempts: FinishAttempt[]) => {
    const outcome = permanentOutcome(store, command, attempts);
    // A separately queued Candidate still owns its canonical outcome.
    return outcome ?? (!store.select('landingEntries', command.operationId) ? failure : undefined);
  };
  const path = join(store.directory, 'agent-finish', `${command.operationId}.json`);
  if (!existsSync(path)) return;
  let journal = new FinishJournal(store, command, command.expectedHead);
  if (journal.state.result) return journal.state.result.settled ? journal.state.result : undefined;
  if (!outcomeFor(journal.state.attempts)) return;
  const result = await withQueueSlot(
    join(store.directory, 'finish-queue', command.operationId),
    async () => {
      journal = new FinishJournal(store, command, command.expectedHead);
      if (journal.state.result) return journal.state.result.settled ? journal.state.result : undefined;
      const outcome = outcomeFor(journal.state.attempts);
      if (!outcome) return;
      const attempt = journal.state.attempts.at(-1)!;
      const receipt: Fields = {
        operationId: command.operationId,
        phase: 'recovery',
        ...outcome,
        settled: true,
        checkpoint: { laneId: command.laneId, head: journal.state.attempts[0]!.head },
        ...(attempt.sync ? { sync: attempt.sync } : {}),
        view: attempt.view ?? null,
        run: attempt.run ?? null,
        acceptance: attempt.acceptance ?? null,
        attempts: structuredClone(journal.state.attempts),
      };
      if (
        command.accept &&
        [command.laneId, ...(command.withInputs ?? []).map(pin => pin.laneId)].every(id =>
          store.select('lanes', id),
        )
      )
        receipt.submissions = finishSubmissions(store, command, journal.state.attempts, receipt);
      journal.state.result = JSON.parse(JSON.stringify(receipt)) as Fields;
      journal.save();
      return journal.state.result;
    },
    { waitMs: 0, anchor: store.directory },
  );
  return 'value' in result ? result.value : undefined;
}

/** Legacy land entries retain their own terminal reasons under the parent slot. */
export async function settleLand(store: WorkStore, operationId: string) {
  const retained = pendingLands(store).find(row => row.operationId === operationId);
  if (!retained) return true;
  if (
    !retained.state.entries.some(
      entry =>
        !entry.sourceOperationId &&
        (!entry.result || entry.result.status === 'waiting') &&
        permanentOutcome(store, entry.command, [landAttempt(entry)]),
    )
  )
    return false;
  const result = await withQueueSlot(
    join(store.directory, 'land-queue', operationId),
    async () => {
      const journal = pendingLands(store).find(row => row.operationId === operationId);
      if (!journal) return true;
      let changed = false;
      for (const entry of journal.state.entries) {
        if (entry.sourceOperationId || (entry.result && entry.result.status !== 'waiting')) continue;
        const outcome = permanentOutcome(store, entry.command, [landAttempt(entry)]);
        if (!outcome) continue;
        entry.result = { ...outcome, settled: true };
        changed = true;
      }
      if (changed) saveLandJournal(store, journal.path, journal.state);
      return journal.state.entries.every(
        entry => entry.sourceOperationId || (entry.result && entry.result.status !== 'waiting'),
      );
    },
    { waitMs: 0, anchor: store.directory },
  );
  return 'value' in result && result.value;
}
function landAttempt(entry: LandEntry): FinishAttempt {
  return {
    number: 0,
    operationId: entry.command.operationId,
    head: entry.inputs[0]!.head,
    previous: entry.single?.previous ?? null,
    operations: {
      sync: entry.command.operationId,
      compose: entry.command.operationId,
      run: entry.command.operationId,
      accept: entry.command.operationId,
    },
  };
}

/** Some drivers return an unresolved observation instead of throwing. Give those
 * the same bounded controller cooldown; self-generated wakes cannot hot-loop. */
export function requireRecoveryProgress(response: unknown) {
  const result = (response as { result?: Fields } | undefined)?.result;
  if (result?.terminal !== false) return;
  const transient = (fields: Fields) =>
    ['SOURCE_CHANGED', 'WORK_STALE', 'WORK_BUSY'].includes(String(fields.code));
  const issue = transient(result)
    ? result
    : Array.isArray(result.entries)
      ? (result.entries as Fields[]).find(entry => entry.status === 'waiting' && transient(entry))
      : undefined;
  if (issue)
    throw new ForgeError(
      String(issue.code),
      String(issue.message ?? 'Retained recovery is temporarily unavailable.'),
    );
}
