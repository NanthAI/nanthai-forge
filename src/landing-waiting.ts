// SPDX-License-Identifier: Apache-2.0
import type { LandingEntry, LandingWaiting } from './landing-batch-types.js';
import type { WorkData } from './work-types.js';

export function landingWait(
  data: WorkData,
  rule: string,
  reason: string,
  entries: LandingEntry[] = [],
): LandingWaiting {
  return {
    rule,
    reason,
    entries: entries.map(entry => ({
      entryId: entry.id,
      inputs: data.views.find(view => view.id === entry.viewId)?.inputs ?? [],
    })),
  };
}
/** Derived from canonical batch/run records as well as persisted at driver transitions.
 * A read can explain a settlement even while the writer waits for the Work lock. */
export function checkingWait(
  data: Pick<WorkData, 'landingBatches' | 'runs'>,
  entry: LandingEntry,
): LandingWaiting {
  const batch = data.landingBatches?.find(batch => batch.id === entry.batchId);
  const runIds = batch?.prefixes.map(prefix => prefix.runId) ?? [];
  const live = data.runs.filter(
    run => runIds.includes(run.id) && ['queued', 'preparing', 'running'].includes(run.status),
  );
  const confirming =
    batch?.confirmation &&
    !batch.confirmation.verdict &&
    !data.runs.some(
      run => run.id === batch.confirmation!.runId && !['queued', 'preparing', 'running'].includes(run.status),
    );
  const rule = !batch
    ? 'batch-recovery'
    : confirming
      ? 'failure-confirmation'
      : batch.status === 'composing'
        ? 'composition'
        : batch.settlement ||
            (!live.length && runIds.length && runIds.some(id => data.runs.some(run => run.id === id)))
          ? 'settlement'
          : live.length
            ? 'check'
            : 'check-admission';
  return {
    rule,
    reason:
      rule === 'failure-confirmation'
        ? 'Waiting for one fresh check of the failed boundary Candidate before attribution.'
        : rule === 'settlement'
          ? 'Check observations are retained; waiting for batch settlement on main.'
          : rule === 'batch-recovery'
            ? 'Waiting for the driver to reconcile the retained batch.'
            : rule === 'composition'
              ? 'Waiting for batch composition.'
              : rule === 'check'
                ? 'Waiting for recorded check runs.'
                : 'Waiting for check admission or adoption.',
    entries: [],
    ...(entry.batchId ? { batchId: entry.batchId } : {}),
    runIds,
  };
}
