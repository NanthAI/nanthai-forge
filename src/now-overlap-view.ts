// SPDX-License-Identifier: Apache-2.0
import type { NowOverlapSignals } from './now-overlap-signals.js';

/**
 * The Now page's one reactive overlap read, cut to what the page renders (Issue 1b66b35a): every
 * saved path of every open Lane would be resent on each invalidation.
 */
export const NOW_OVERLAP_VIEW_BUDGET = 20 * 1024;
/** "Changed on main" rows per Lane; the rest is one count row that links to the Lane. */
export const BEHIND_MAIN_PATHS = 20;

/**
 * Signals with each Lane id and path sent once: other fields hold indexes into `lanes` and `paths`.
 * Edits keep only paths two Lanes share (the page renders no single-Lane path).
 */
export type ViewSignals = {
  lanes: { laneId: string; head?: string }[];
  paths: string[];
  edits: { lane: number; paths: number[] }[];
  behindMain: { lane: number; paths: number[]; more?: number }[];
  complete: boolean;
};
export type NowOverlapView = { signals: ViewSignals };

export function viewSignals(signals: NowOverlapSignals): ViewSignals {
  const lanes: ViewSignals['lanes'] = [],
    paths: string[] = [];
  const laneAt = new Map<string, number>(),
    pathAt = new Map<string, number>();
  const lane = (laneId: string, head?: string) => {
    let at = laneAt.get(laneId);
    if (at === undefined) {
      laneAt.set(laneId, (at = lanes.length));
      lanes.push({ laneId, ...(head === undefined ? {} : { head }) });
    } else if (head !== undefined) lanes[at]!.head ??= head;
    return at;
  };
  const path = (value: string) => {
    let at = pathAt.get(value);
    if (at === undefined) pathAt.set(value, (at = paths.push(value) - 1));
    return at;
  };
  const sharing = new Map<string, number>();
  for (const edit of signals.edits)
    for (const value of new Set(edit.paths)) sharing.set(value, (sharing.get(value) ?? 0) + 1);
  const edits = signals.edits.map(edit => ({
    lane: lane(edit.laneId, edit.head),
    paths: edit.paths.filter(value => sharing.get(value)! > 1).map(path),
  }));
  const behindMain = signals.behindMain.map(edit => {
    const shown = edit.paths.slice(0, BEHIND_MAIN_PATHS);
    const more = edit.paths.length - shown.length + (edit.more ?? 0);
    return { lane: lane(edit.laneId, edit.head), paths: shown.map(path), ...(more ? { more } : {}) };
  });
  return { lanes, paths, edits, behindMain, complete: signals.complete };
}

/** The client side of viewSignals: the signals the page renders. */
export function readViewSignals(view: ViewSignals): NowOverlapSignals {
  const laneId = (at: number) => view.lanes[at]!.laneId,
    head = (at: number) => view.lanes[at]!.head ?? '',
    path = (at: number) => view.paths[at]!;
  return {
    edits: view.edits.map(edit => ({
      laneId: laneId(edit.lane),
      head: head(edit.lane),
      paths: edit.paths.map(path),
    })),
    behindMain: view.behindMain.map(edit => ({
      laneId: laneId(edit.lane),
      head: head(edit.lane),
      paths: edit.paths.map(path),
      ...(edit.more ? { more: edit.more } : {}),
    })),
    complete: view.complete,
  };
}
