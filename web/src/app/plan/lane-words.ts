// SPDX-License-Identifier: Apache-2.0
// The state word of an Item's Lane on the Plan board (Item d3357f40, mock 02-plan-board: "Checking", "Waiting its
// turn", "Needs you" with its reason), from reads the page already holds, never a read of its own: the shell's Needs
// me read (held and parked Lanes by Intent, needs/model.ts), the shell's line feed (each Lane's stop by Lane id) and
// the Plan's workers read (which Lane works on which Item). Words come from lane-state.ts and needs/model.ts, so the
// board says what Lanes and Needs me say. What none of them names stays "in Lane": nothing is guessed.
import { stateWords, type StateKind, type StateWord } from '../../ds';
import { laneState } from '../lane-state';
import type { LineFeed } from '../Line';
import { needsView, type NeedsRead } from '../needs/model';
import type { ActiveLane } from './workers';

export type ItemLane = {
  kind: StateKind;
  glyph: StateWord;
  word: string;
  /** Why, in a few words, beside the word ("check failed"). */
  why?: string;
  /** It waits on the reader (Needs me counts it). */
  you?: true;
};

const lower = (words: string) => words.charAt(0).toLowerCase() + words.slice(1);

/** Item id to its Lane's state. `asked` maps each asked Intent to its Item (workers.ts askedIntents): held, parked
 * and feed Lanes are tied to Items only through it, and a question through its Item or its Lane. Waiting on the reader
 * wins (a held or parked Lane, or a question that holds work), then any other hold Needs me names, then the newest
 * Lane the feed holds: its stop, or nothing ("in Lane") when that Lane is held for a reason no read names. */
export function itemLanes({
  asked,
  needs,
  feed,
  lanes,
  now,
}: {
  asked: ReadonlyMap<string, string> | null;
  needs: NeedsRead | undefined;
  feed: LineFeed | undefined;
  lanes: readonly ActiveLane[];
  now: number;
}): Map<string, ItemLane> {
  const out = new Map<string, ItemLane>();
  if (!asked?.size) return out;
  const items = new Set(asked.values());
  const laneIntent = new Map(lanes.flatMap(lane => (lane.laneId ? [[lane.laneId, lane.intentId]] : [])));
  const set = (intentId: string | null | undefined, lane: ItemLane) => {
    const item = intentId ? asked.get(intentId) : undefined;
    if (item && !out.has(item)) out.set(item, lane);
  };
  const you = (why: string): ItemLane => ({
    kind: 'waiting',
    glyph: 'Needs you',
    word: 'Needs you',
    why,
    you: true,
  });
  if (needs) {
    const view = needsView(needs, now);
    for (const row of view.now) set(row.intentId, you(lower(row.tag)));
    for (const row of view.parked) set(row.intentId, you('parked'));
    // A question for the reader that holds work (never one asked ahead), by its Item or by its Lane.
    for (const ask of view.asks) {
      const item = ask.planningItemId && items.has(ask.planningItemId) ? ask.planningItemId : undefined;
      if (item && !out.has(item)) out.set(item, you('a question'));
      else if (ask.laneId) set(laneIntent.get(ask.laneId), you('a question'));
    }
    // A hold that asks nobody here: Needs me's own word for it (Conflict, Check failed, Main moved...), in its colour.
    for (const row of view.fyi)
      set(row.intentId, { kind: stateWords[row.word], glyph: row.word, word: row.tag });
  }
  if (feed) {
    const marks = new Map(feed.lanes.map(lane => [lane.laneId, lane]));
    const decided = new Set<string>();
    for (const lane of [...lanes].sort((a, b) => (b.at ?? 0) - (a.at ?? 0))) {
      const item = asked.get(lane.intentId);
      const mark = lane.laneId ? marks.get(lane.laneId) : undefined;
      if (!item || !mark || decided.has(item)) continue;
      // The newest Lane the feed holds decides; held for a reason no read names, it stays "in Lane".
      decided.add(item);
      if (mark.held) continue;
      const state = laneState({ stage: mark.stage, held: false, overlap: mark.overlap });
      set(lane.intentId, { kind: state.kind, glyph: state.glyph, word: state.word });
    }
  }
  return out;
}

/** Open Lanes that wait on the reader (Needs me's held and parked Lanes, each Lane once): the standing line's "need
 * you". Questions are not Lanes, so they are not counted here. */
export function lanesNeedingYou(needs: NeedsRead | undefined, now: number) {
  if (!needs) return null;
  const view = needsView(needs, now);
  const ids = new Set([
    ...view.now.map(row => row.laneId ?? row.submissionId ?? ''),
    ...view.parked.map(row => row.laneId),
  ]);
  ids.delete('');
  return { n: ids.size, atLeast: needs.more > 0 || needs.parkedMore === true };
}
