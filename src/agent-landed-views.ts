// SPDX-License-Identifier: Apache-2.0
import { allRecords } from './agent-lifecycle.js';
import { NativeSource } from './native-source.js';
import { gitIsAncestor } from './work-git.js';
import type { LandingEntry } from './landing-batch-types.js';
import type { WorkStore } from './work-store.js';
import type { ChannelMove, WorkView } from './work-types.js';

export function noopLandingViews(store: WorkStore, channel: string) {
  const records = store.readRecords();
  const entries = records
    ? records.manifest.collections.landingEntries
      ? allRecords<LandingEntry>(store, 'landingEntries')
      : []
    : (store.load().landingEntries ?? []);
  return entries.flatMap(entry => {
    if (entry.channel !== channel || entry.status !== 'accepted' || !entry.alreadyOnMain) return [];
    const view = store.select('views', entry.viewId);
    return view?.status === 'clean' && view.head === entry.head ? [{ view, main: entry.alreadyOnMain }] : [];
  });
}

/** Exact submitted inputs can land through a Channel move or a retained no-op
 * receipt. Neither coincidental containment nor Lane completion is a receipt. */
export function landedViews(store: WorkStore, channel: string, head: string) {
  const ancestry = store.native ? new NativeSource(store.root).ancestry() : undefined;
  const contains = (candidate: string) =>
    ancestry ? ancestry.contains(head, candidate) : gitIsAncestor(store.root, candidate, head);
  const moves = allRecords<ChannelMove>(store, 'channelMoves').filter(
    move => move.channel === channel && move.status === 'accepted' && contains(move.head),
  );
  const results: { view: WorkView; move: ChannelMove; alreadyOnMain: boolean }[] = [];
  for (const move of moves) {
    const view = store.select('views', move.viewId);
    if (view) results.push({ view, move, alreadyOnMain: false });
  }
  for (const { view, main } of noopLandingViews(store, channel)) {
    const move = moves.find(move => move.head === main);
    if (move) results.push({ view, move, alreadyOnMain: true });
  }
  return { results, contains };
}
