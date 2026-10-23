// SPDX-License-Identifier: Apache-2.0
import { existsSync, readFileSync, renameSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { syncDirectory } from './native-durability.js';
import { randomUUID } from 'node:crypto';
import type { ActionsJournal } from './github-actions-export.js';
import type { WorkRecordTransaction } from './work-record-transaction.js';
import type { WorkStore } from './work-store.js';
import type { CheckRun } from './work-types.js';

/** Reopen only unresolved provider operations; recovery observes the original identity. */
export function strandedActionsRun(store: WorkStore, run: CheckRun | undefined): boolean {
  if (run?.status !== 'interrupted' || run.backend?.actual !== 'github-actions' || run.cancelRequested)
    return false;
  try {
    const path = join(store.directory, `check-${run.id}`);
    const journal = JSON.parse(readFileSync(join(path, 'github-actions.json'), 'utf8')) as ActionsJournal;
    const unresolvedPush = journal.pushOutcome === 'ambiguous' || journal.pushOutcome === 'accepted';
    const unresolvedDispatch =
      journal.pushed &&
      journal.dispatching &&
      (journal.dispatchOutcome === undefined || ['ambiguous', 'accepted'].includes(journal.dispatchOutcome));
    if (
      !run.backend.pin ||
      journal.pin !== run.backend.pin ||
      !journal.commit ||
      journal.runId ||
      (!unresolvedPush && !unresolvedDispatch)
    )
      return false;
    const result = join(path, 'result.json');
    if (existsSync(result)) {
      const receipt = JSON.parse(readFileSync(result, 'utf8')) as CheckRun;
      if (receipt.status !== 'interrupted' || receipt.backend?.pin !== run.backend.pin) return false;
    }
    return true;
  } catch {
    return false; // Unavailable or inconsistent evidence cannot authorize a new dispatch.
  }
}

/** Under the owner lock, retain the old receipt before claiming the same run again. */
export function retainInterruptedActionsReceipt(store: WorkStore, run: CheckRun) {
  const path = join(store.directory, `check-${run.id}`, 'result.json');
  if (existsSync(path)) {
    renameSync(path, `${path}.interrupted-${randomUUID()}`);
    syncDirectory(dirname(path));
  }
}

/** Resume the retained batch without changing its prefix, run or acceptance pins. */
export function reopenActionsLanding(tx: WorkRecordTransaction, run: CheckRun) {
  const entries = Array.from(
    { length: tx.manifest.collections.landingEntries?.count ?? 0 },
    (_, position) => ({ position, entry: tx.at('landingEntries', position) }),
  );
  const batches = new Set(
    entries
      .map(({ entry }) => entry)
      .filter(entry => entry.status === 'interrupted' && entry.runId === run.id)
      .map(entry => entry.batchId),
  );
  for (const id of batches) {
    if (!id) continue;
    const saved = tx.find('landingBatches', id);
    if (saved?.record.status !== 'completed' || saved.record.acceptanceId) continue;
    tx.replace('landingBatches', saved.position, { ...saved.record, status: 'checking' });
    for (const { entry, position } of entries) {
      if (entry.batchId !== id || entry.status !== 'interrupted' || entry.runId !== run.id) continue;
      tx.replace('landingEntries', position, { ...entry, status: 'checking' });
    }
  }
}
