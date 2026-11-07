// SPDX-License-Identifier: Apache-2.0
import { firstWriteNoticeId, type NowOverlapSignals } from './now-overlap-signals.js';

/**
 * The Now page's one reactive overlap read, cut to what the page renders (Issue 1b66b35a).
 * The old reply sent whole answer records (text, delivery ids) and every saved path of every open Lane,
 * each detection twice: 60 KB per 100 answers, 84-149 KB with signals, resent on each invalidation.
 */
export const NOW_OVERLAP_VIEW_BUDGET = 20 * 1024;
/** Notice ids are SHA-256 hex; 16 hex (64 bits) tells apart a Lane's notices with no realistic collision. */
export const NOTICE_KEY_HEX = 16;
/** "Changed on main" rows per Lane; the rest is one count row that links to the Lane. */
export const BEHIND_MAIN_PATHS = 20;

export const noticeKey = (noticeId: string) => noticeId.slice(0, NOTICE_KEY_HEX);

export type NowOverlapAnswerRow = { laneId: string; noticeId: string; actor: string; at: string };
/**
 * Signals with each Lane id and path sent once: other fields hold indexes into `lanes` and `paths`.
 * Edits keep only paths two Lanes share (the page renders no single-Lane path). A detection is sent
 * once per Lane pair, without its id (the client derives it); `to` lists the receiving Lanes only when
 * the per-Lane cap left one out.
 */
export type ViewSignals = {
  lanes: { laneId: string; head?: string }[];
  paths: string[];
  edits: { lane: number; paths: number[] }[];
  behindMain: { lane: number; paths: number[]; more?: number }[];
  notices: { file: number; lanes: number[]; to?: number[] }[];
  complete: boolean;
};
export type NowOverlapView = {
  /** Answered notice keys per open Lane. */
  answered: Record<string, string[]>;
  /** When the caller answered, newest first: "Answered today" needs only these. */
  mine: string[];
  /** Every open Lane's answers were read. */
  complete: boolean;
  signals: ViewSignals;
};

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
  const pairs = new Map<string, { file: number; lanes: number[]; to: number[] }>();
  for (const notice of signals.notices) {
    const pair = pairs.get(notice.noticeId) ?? {
      file: path(notice.file),
      lanes: notice.lanes.map(id => lane(id)),
      to: [],
    };
    pair.to.push(lane(notice.laneId));
    pairs.set(notice.noticeId, pair);
  }
  const notices = [...pairs.values()].map(({ to, ...pair }) =>
    to.length === pair.lanes.length && pair.lanes.every(at => to.includes(at)) ? pair : { ...pair, to },
  );
  return { lanes, paths, edits, behindMain, notices, complete: signals.complete };
}

/** The client side of viewSignals: the signals the page renders, detections with their derived ids. */
export function readViewSignals(view: ViewSignals): NowOverlapSignals {
  const laneId = (at: number) => view.lanes[at]!.laneId,
    head = (at: number) => view.lanes[at]!.head ?? '',
    path = (at: number) => view.paths[at]!;
  return {
    notices: view.notices.flatMap(notice => {
      const lanes = notice.lanes.map(laneId),
        file = path(notice.file),
        noticeId = firstWriteNoticeId(lanes, file);
      return (notice.to ?? notice.lanes).map(at => ({ laneId: laneId(at), noticeId, file, lanes }));
    }),
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

export function nowOverlapView(
  signals: NowOverlapSignals,
  rows: readonly NowOverlapAnswerRow[],
  caller: string,
  complete: boolean,
): NowOverlapView {
  const answered: Record<string, Set<string>> = {};
  const mine: string[] = [];
  for (const row of rows) {
    (answered[row.laneId] ??= new Set()).add(noticeKey(row.noticeId));
    if (row.actor === caller) mine.push(row.at);
  }
  return {
    answered: Object.fromEntries(Object.entries(answered).map(([laneId, keys]) => [laneId, [...keys]])),
    mine: mine.sort().reverse().slice(0, 100),
    complete,
    signals: viewSignals(signals),
  };
}
