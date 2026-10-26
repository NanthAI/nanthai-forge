// SPDX-License-Identifier: Apache-2.0
import { readdirSync } from 'node:fs';
import { readSource } from './files.js';
import { receiptSchema } from './work-run-receipt.js';
import type { WorkStore } from './work-store.js';
import type { CheckRun } from './work-types.js';

/** Missing completion evidence never authorizes log pruning. An explicit,
 * retained supersession can authorize only regenerable source copies. */
export function terminalReceipt(store: WorkStore, run: CheckRun, directory: string) {
  try {
    const bytes = readSource(directory, 'result.json', 4 * 1024 * 1024);
    if (bytes) {
      const parsed = receiptSchema.safeParse(JSON.parse(bytes.toString('utf8')));
      if (!parsed.success) return { blocker: 'Terminal receipt is invalid; copies and evidence retained.' };
      const receipt = parsed.data;
      if (
        receipt.status !== run.status ||
        receipt.endedAt !== run.endedAt ||
        receipt.backend?.actual !== run.backend?.actual ||
        receipt.backend?.pin !== run.backend?.pin
      )
        return { blocker: 'Terminal receipt does not match the recorded run; copies and evidence retained.' };
      return { sourceOnly: false };
    }
    const archived = readdirSync(directory).filter(name => name.startsWith('result.json.interrupted-'));
    const reason = archived.length
      ? 'Only archived interrupted receipts remain; no current terminal receipt.'
      : 'Terminal receipt is missing.';
    if (
      run.status === 'interrupted' &&
      archived.length > 0 &&
      Number.isFinite(Date.parse(run.endedAt ?? '')) &&
      run.cancelRequested &&
      run.cancellation?.reason === 'superseded' &&
      run.cancellation.supersededBy
    ) {
      // A renamed receipt from an earlier retry is not the current completion.
      // Require exact terminal time/provider pins before using archived evidence.
      const matching = archived.some(name => {
        const bytes = readSource(directory, name, 4 * 1024 * 1024);
        const receipt = bytes && receiptSchema.safeParse(JSON.parse(bytes.toString('utf8')));
        return (
          receipt &&
          receipt.success &&
          receipt.data.status === 'interrupted' &&
          receipt.data.endedAt === run.endedAt &&
          receipt.data.backend?.actual === run.backend?.actual &&
          receipt.data.backend?.pin === run.backend?.pin
        );
      });
      if (!matching)
        return {
          blocker:
            'Archived interrupted receipts do not match the recorded run; copies and evidence retained.',
        };
      const original = store.select('views', run.viewId),
        successor = store.select('views', run.cancellation.supersededBy),
        family = (inputs: CheckRun['inputs']) => JSON.stringify(inputs.map(input => input.laneId).sort());
      if (
        original &&
        successor &&
        original.id !== successor.id &&
        original.intentId === successor.intentId &&
        family(original.inputs) === family(successor.inputs) &&
        Date.parse(successor.at) > Date.parse(original.at)
      )
        return {
          sourceOnly: true,
          reason: `${reason} Recorded interrupted run is explicitly superseded by Candidate ${successor.id}; only its source copies are eligible.`,
        };
    }
    return { blocker: `${reason} Interruption or supersession is unproven; copies and evidence retained.` };
  } catch {
    return { blocker: 'Terminal receipt is unreadable or invalid; copies and evidence retained.' };
  }
}

/** A terminal Work row alone cannot settle an ambiguous remote launch. */
export function remoteExecutionBlocker(directory: string) {
  try {
    const bytes = readSource(directory, 'modal-executions.json', 4 * 1024 * 1024);
    if (!bytes) return undefined;
    const journal = JSON.parse(bytes.toString('utf8'));
    if (
      !Array.isArray(journal.executions) ||
      journal.creating ||
      journal.executions.some(
        (execution: { exitCode?: number; stopped?: number }) =>
          execution.exitCode === undefined && execution.stopped === undefined,
      )
    )
      return 'Remote execution journal still has an unresolved launch or execution; copies and evidence retained.';
  } catch {
    return 'Remote execution journal is unreadable or invalid; copies and evidence retained.';
  }
  return undefined;
}
