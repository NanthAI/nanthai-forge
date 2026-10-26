// SPDX-License-Identifier: Apache-2.0
import { editWork } from './work-edit.js';
import { editRecordProjection } from './work-record-edit.js';
import { preparePostAcceptRecords, postAcceptRecords } from './post-accept-records.js';
import { foregroundQueued } from './check-queue.js';
import { recoverRuns } from './work-run.js';
import { recoveryAllowed, recoveryResult } from './optimistic-recovery.js';
import { failedMainCheck, fixMainIntentId } from './post-accept-fix-forward.js';
import { recordFixForward } from './post-accept-fix-forward.js';
import { selectMainAudit } from './post-accept-selection.js';
import { invariant } from './errors.js';
import type { WorkStore } from './work-store.js';
import type { WorkData } from './work-types.js';

export async function selectPostAccept(
  store: WorkStore,
  push?: { channel: string; checkId: string },
  signal?: AbortSignal,
) {
  const edit = (data: WorkData) => {
    if (foregroundQueued()) return { wait: true as const };
    recoverRuns(store, data, false);
    recordFixForward(data);
    // Completion can publish after the outer observation. Do not report idle
    // before the newly failed audit has reached recovery or fix-forward.
    if (
      recoveryAllowed(data) &&
      data.runs.some(
        run =>
          failedMainCheck(run) &&
          !recoveryResult(data, run) &&
          !data.intents.some(intent => intent.id === fixMainIntentId(run)),
      )
    )
      return { wait: true as const };
    const selected = selectMainAudit(data, push);
    if (!selected) return;
    if ('wait' in selected) return { wait: true as const };
    return {
      ...selected,
      check: data.checks.find(check => check.id === selected.checkId)!,
      revision: data.revision,
    };
  };
  const prepared = store.readRecords?.();
  if (!prepared) return editWork(store, edit);
  try {
    await preparePostAcceptRecords(store, prepared, signal);
  } finally {
    prepared.dispose();
  }
  // Admission reads only selected records from the current pointer. Concurrent
  // builders cannot invalidate a whole-Work preparation or make it spin.
  return store.lockedAsync(() => {
    const tx = store.readRecords();
    invariant(tx, 'INVALID_WORK_STORE', 'Audit record lookup became unavailable.');
    try {
      const result = editRecordProjection(
        store,
        tx,
        postAcceptRecords(store, tx, push),
        ['channelMoves', 'views', 'runs', 'intents'],
        edit,
        undefined,
        true,
      );
      invariant(
        !(result instanceof Promise),
        'INVALID_WORK_STORE',
        'Audit publication must finish within its lock.',
      );
      if (result && !('wait' in result)) result.revision = store.revision();
      return result;
    } finally {
      tx.dispose();
    }
  });
}
