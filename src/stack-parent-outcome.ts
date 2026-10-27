// SPDX-License-Identifier: Apache-2.0
import { allRecords } from './agent-lifecycle.js';
import type { WorkStore } from './work-store.js';
import type { Lane } from './work-types.js';
import type { LandingEntry } from './landing-batch-types.js';
/** Only a terminal submission of the saved parent pin changes the stack target.
 * A newer live retry keeps the dependency; lifecycle labels are not evidence. */
export function stackParentFailed(store: WorkStore, lane: Pick<Lane, 'stack'>) {
  const stack = lane.stack;
  if (!stack?.laneId || stack.detached) return false;
  const tx = store.readRecords?.();
  const history = tx
    ? tx.manifest.collections.landingEntries
      ? allRecords<LandingEntry>(store, 'landingEntries')
      : []
    : (store.load().landingEntries ?? []);
  const entries = history.filter(
    entry =>
      entry.channel === stack.channel &&
      store
        .select('views', entry.viewId)
        ?.inputs.some(pin => pin.laneId === stack.laneId && pin.head === stack.head),
  );
  const latest = entries.at(-1);
  return !!latest && ['failed', 'conflict', 'cancelled', 'interrupted'].includes(latest.status);
}
