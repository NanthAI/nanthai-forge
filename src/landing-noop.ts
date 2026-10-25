import { landingRecords } from './landing-records.js';
// SPDX-License-Identifier: Apache-2.0
import { optimisticLanding } from './autonomy-policy.js';
import { readPolicy } from './work-autonomy.js';
import { completeAccepted } from './agent-lifecycle.js';
import { composeLandingSource } from './landing-compose-source.js';
import type { NativeSource } from './native-source.js';
import type { WorkService } from './work.js';
import type { WorkData } from './work-types.js';
import type { LandingEntry } from './landing-batch-types.js';

const undo = 'Reopen the Lane and finish again if it still has work to land.';
/** State metadata and merge parents are not source changes. */
export const sameLandingTree = (source: NativeSource, left: string, right: string) =>
  left === right || source.tree(source.state(left).files) === source.tree(source.state(right).files);
/** Exact Lane/head pins of an entry; equal keys are the same submitted source. */
export const entryPins = (data: WorkData, entry: LandingEntry) =>
  JSON.stringify(
    (data.views.find(view => view.id === entry.viewId)?.inputs ?? [])
      .map(pin => `${pin.laneId}:${pin.head}`)
      .sort(),
  );
/** Content already on main lands without a check, an acceptance or a Channel move. */
export function markAlreadyOnMain(entry: LandingEntry, main: string) {
  entry.status = 'accepted';
  entry.alreadyOnMain = main;
  entry.terminalAt = new Date().toISOString();
  entry.reason = `Already on main at ${main}; no check, acceptance or Channel move was needed.`;
}
/** Under the Work lock, before selection: saves known to predate completion
 * never run. Contained content is reported as landed; anything else is dropped
 * with an explicit reason and undo. Newer saves retain ordinary landing. */
export function settleCompletedLanes(
  work: WorkService,
  data: WorkData,
  channel: string,
  main: string | null,
  source: NativeSource,
) {
  for (const entry of data.landingEntries ?? []) {
    if (entry.channel !== channel || entry.status !== 'queued') continue;
    const candidate = data.views.find(view => view.id === entry.viewId);
    if (candidate?.status !== 'clean' || candidate.head !== entry.head) continue;
    const inputs = candidate.inputs;
    if (
      !inputs.length ||
      !inputs.every(pin => {
        const lane = data.lanes.find(lane => lane.id === pin.laneId);
        if (lane?.state !== 'completed') return false;
        const completed = [...(lane.lifecycle ?? [])].reverse().find(event => event.to === 'completed');
        const saved = [...lane.checkpoints].reverse().find(checkpoint => checkpoint.head === pin.head);
        // A later save is new work, even when completion metadata is unchanged.
        // Missing lifecycle timing cannot prove that a submitted save is stale.
        return completed && (!saved || saved.at < completed.at);
      })
    )
      continue;
    const result =
      main && composeLandingSource(work.store, source, candidate, main, 'Contained landing', entry.arrivedAt);
    if (main && result && result.head && sameLandingTree(source, result.head, main)) {
      markAlreadyOnMain(entry, main);
      continue;
    }
    entry.status = 'cancelled';
    entry.terminalAt = new Date().toISOString();
    entry.reason = `Every input Lane was completed before this landing ran, and its content is not on ${channel}; nothing landed. ${undo}`;
  }
}
/** Complete the Lanes of entries that were already on main, as acceptance would.
 * Retry-safe: completion of an already completed Lane is a no-op. */
export async function completeAlreadyOnMain(work: WorkService, channel: string) {
  const data = landingRecords(work.store, channel),
    policy = readPolicy(work.store);
  if (optimisticLanding(policy) || !policy.lifecycle.completeOnAccept) return;
  for (const entry of data.landingEntries ?? []) {
    if (entry.channel !== channel || !entry.alreadyOnMain || entry.keepOpen) continue;
    const inputs = data.views.find(view => view.id === entry.viewId)?.inputs ?? [];
    if (
      inputs.some(pin =>
        data.lanes.some(
          lane =>
            lane.id === pin.laneId &&
            lane.head === pin.head &&
            ['active', 'paused', 'ready'].includes(lane.state),
        ),
      )
    )
      await completeAccepted(work, entry.viewId);
  }
}
