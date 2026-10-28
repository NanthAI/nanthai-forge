// SPDX-License-Identifier: Apache-2.0
export type SourceReturnProgress = {
  phase: string;
  step: number;
  done: number;
  total: number;
  elapsedMs: number;
  etaSeconds: number | null;
  resumed: boolean;
  itemDone?: number;
  itemTotal?: number;
  itemPending?: number;
  rowsPending?: number;
  /** Per-push totals so far (servers before accounting omit them). */
  storageReads?: number;
  storageBytes?: number;
  steps?: number;
  invocations?: number;
};
const megabytes = (bytes: number) => `${(bytes / 1e6).toFixed(1)} MB`;
export function formatSourceReturnProgress(event: SourceReturnProgress) {
  if (event.phase !== 'complete' && event.total === 0 && event.done === 0) return '';
  const elapsed = Math.ceil(event.elapsedMs / 1000);
  if (event.phase === 'complete')
    return `source return complete: elapsed ${elapsed}s${
      event.storageBytes === undefined
        ? ''
        : `, ${event.steps} steps in ${event.invocations} calls, ${megabytes(event.storageBytes)} read from storage`
    }\n`;
  return `${event.resumed ? `source return: resuming from step ${event.step}\n` : ''}source return ${event.phase}: ${event.total ? `${event.done}/${event.total} items` : `${event.done} items processed`}${event.itemDone === undefined ? '' : `, current item ${event.itemDone}${event.itemTotal === undefined ? ` visited, ${event.itemPending} pending` : `/${event.itemTotal}`}`}${event.rowsPending ? `, ${event.rowsPending} rows pending` : ''} (step ${event.step}), elapsed ${elapsed}s, ETA ${event.etaSeconds === null ? 'pending' : `${event.etaSeconds}s`}\n`;
}
