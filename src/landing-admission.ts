import { wakeLandingWorker } from './landing-worker-wake.js';
import { waitingDependencies } from './agent-dependencies.js';
import { readLandCheckController } from './land-check-progress.js';
import { runReceiptWithFailure } from './agent-run-failure.js';
// SPDX-License-Identifier: Apache-2.0
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { FinishJournal } from './agent-finish-journal.js';
import { finishSubmissions } from './landing-submission-read.js';
import { readLandingWorkerStatus } from './landing-worker-status.js';
import { withQueueSlot } from './landing-queue.js';
import { ForgeError } from './errors.js';
import type { FinishAction } from './agent-workflow-schema.js';
import type { WorkStore } from './work-store.js';

/** Transport observation only. The durable journal and canonical Work own progress. */
export function landingAdmission(store: WorkStore, operationId: string, laneIds: string[]) {
  const worker = readLandingWorkerStatus(store);
  const message = worker.workers
    ? 'Request is durable. The owner worker drives pending work; disconnecting does not cancel it.'
    : 'Request is durable. The owner worker is not running; pending work remains queued until the owner service starts.';
  return {
    durable: true,
    landingWorker: worker,
    message,
    next: message,
    observe: {
      landing: { action: 'landing', operationId },
      status: { action: 'status', laneId: laneIds[0] },
      pending: { action: 'pending-status' },
      wait: { action: 'wait', laneIds, operationIds: [operationId], until: 'terminal' },
    },
  };
}

export async function admitFinish(
  store: WorkStore,
  command: FinishAction,
  checkpoint: () => Promise<{ result: Record<string, unknown> }>,
) {
  const path = join(store.directory, 'agent-finish', `${command.operationId}.json`);
  const observe = (journal: FinishJournal, saved?: Record<string, unknown>) => {
    wakeLandingWorker(store);
    const attempt = journal.state.attempts.at(-1)!;
    const run = !command.accept ? store.select('runs', attempt.operations.run) : undefined;
    const fields = journal.state.result ?? {
      operationId: command.operationId,
      phase: 'submission',
      status:
        run?.status ??
        attempt.status ??
        (attempt.run?.status === 'passed' && command.accept
          ? 'waiting to land'
          : (attempt.run?.status ?? 'queued')),
      ...(run ? { run: runReceiptWithFailure(store, run), view: attempt.view ?? null } : {}),
      checkpoint: saved ?? { laneId: command.laneId, head: journal.state.attempts[0]!.head },
      attempts: journal.state.attempts,
      terminal: false,
      complete: false,
    };
    const submissions = command.accept
      ? finishSubmissions(store, command, journal.state.attempts, fields)
      : undefined;
    const admission = landingAdmission(store, command.operationId, [command.laneId, ...(command.with ?? [])]);
    const dependencies =
      !command.accept && !fields.terminal
        ? waitingDependencies(store, [command.laneId, ...(command.with ?? [])])
        : [];
    const waitingOn =
      command.accept || fields.terminal
        ? undefined
        : run && ['queued', 'preparing', 'running'].includes(run.status)
          ? {
              kind: 'run',
              runId: run.id,
              status: run.status,
              controller: readLandCheckController(store, run),
            }
          : dependencies.length
            ? { kind: 'dependency', dependencies }
            : {
                kind: 'owner',
                root: store.root,
                operationId: command.operationId,
                worker: admission.landingWorker,
              };
    return {
      revision: store.revision(),
      result: {
        ...fields,
        ...(submissions
          ? {
              submissions,
              terminal: submissions.every(item => item.terminal),
              complete: submissions.every(item => item.complete),
            }
          : {}),
        ...admission,
        ...(waitingOn ? { waitingOn } : {}),
        ...(typeof fields.message === 'string' ? { message: fields.message } : {}),
      },
    };
  };
  // Existing journals are atomic snapshots; reading one never saves over its driver.
  if (existsSync(path)) return observe(new FinishJournal(store, command, command.expectedHead));
  const admitted = await withQueueSlot(
    join(store.directory, 'finish-queue', command.operationId),
    async () => {
      if (existsSync(path)) return observe(new FinishJournal(store, command, command.expectedHead));
      const saved = (await checkpoint()).result;
      const journal = new FinishJournal(store, command, saved.head as string, true);
      return observe(journal, saved);
    },
    { anchor: store.directory, phase: 'submitting finish' },
  );
  if ('value' in admitted) return admitted.value;
  throw new ForgeError('WORK_BUSY', `Replay finish operation ${command.operationId} to reconcile admission.`);
}
