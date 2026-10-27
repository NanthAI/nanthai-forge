import { landingPositions } from './landing-records-index.js';
// SPDX-License-Identifier: Apache-2.0
import { latestTestContract } from './intent-test-contract.js';
import { NativeSource } from './native-source.js';
import type { WorkStore } from './work-store.js';
import type { ChannelMove, WorkView } from './work-types.js';
import type { SemanticPlan } from './intent-semantic-conflict.js';

/** Snapshot only Intents whose saved deltas participate in this clean composition.
 * Accepted history is streamed in pages; unrelated Work/Intent history is never loaded. */
export function semanticCompositionPlan(
  store: WorkStore,
  view: WorkView,
  main: string,
): SemanticPlan | undefined {
  if (!store.native || !latestTestContract(store.select('intents', view.intentId))) return;
  const ids = new Set([view.intentId]),
    seenViews = new Set<string>(),
    seenLanes = new Set<string>();
  for (const pin of view.inputs) {
    const lane = store.select('lanes', pin.laneId);
    if (lane) ids.add(lane.intentId);
  }
  const ancestry = new NativeSource(store.root).ancestry();
  for (let offset: number | null = 0; offset !== null;) {
    const page = store.page('channelMoves', offset, 100) as {
      records: ChannelMove[];
      nextOffset: number | null;
    };
    for (const move of page.records) {
      if (
        move.status !== 'accepted' ||
        !ancestry.contains(main, move.head) ||
        ancestry.contains(view.base, move.head)
      )
        continue;
      if (seenViews.has(move.viewId)) continue;
      seenViews.add(move.viewId);
      const accepted = store.select('views', move.viewId);
      if (!accepted) continue;
      ids.add(accepted.intentId);
      for (const pin of accepted.inputs) {
        if (seenLanes.has(pin.laneId)) continue;
        seenLanes.add(pin.laneId);
        const lane = store.select('lanes', pin.laneId);
        if (lane) ids.add(lane.intentId);
      }
    }
    offset = page.nextOffset;
  }
  const members: SemanticPlan['members'] = [];
  for (const intentId of ids) {
    const intent = store.select('intents', intentId),
      contract = latestTestContract(intent);
    if (intent && contract)
      members.push({ intentId, outcome: intent.outcome, version: contract.version, tests: contract.tests });
  }
  return members.length > 1 ? { primaryIntentId: view.intentId, members } : undefined;
}

export function readSemanticConflicts(store: WorkStore, candidateId: string) {
  const tx = store.readRecords();
  try {
    if (!tx)
      return (store.load().landingEntries ?? [])
        .flatMap(entry => entry.semanticConflicts ?? [])
        .filter(conflict => conflict.candidateId === candidateId);
    const conflicts = [];
    for (const position of landingPositions(store, tx, 'landingEntries', ['conflict']))
      for (const conflict of tx.at('landingEntries', position).semanticConflicts ?? [])
        if (conflict.candidateId === candidateId) conflicts.push(conflict);
    return conflicts;
  } finally {
    tx?.dispose();
  }
}
