// SPDX-License-Identifier: Apache-2.0
// The Lanes place's reads (Item e317b6ea). All are existing bounded queries, sent together once the project id is
// known; none takes a clock-derived argument, so they re-run on server writes only and sleep with the tab
// (live-reads.ts). The line feed is not read here: the project frame already holds it and passes it down.
//
// Per view, at 50 open Lanes: the Lane page (one execution, about 7 indexed reads per Lane), the queue view (at most
// 20 entries, about 7 reads each) and, only while its region is open, the overlap view (20 KB budget); the
// newest landings only on History (one page of 30 receipts, 3 rows each for the Lane and Item). Idle: zero.
import { useState } from 'react';
import { useConvex, useMutation } from 'convex/react';
import { api } from '../../../../convex/_generated/api';
import type { Id } from '../../../../convex/_generated/dataModel';
import { useSafeQuery } from '../../safe-query';
import type { LaneMeta, QueueView, SharedFiles } from './model';

/** The same window the line feed shows (60), so every mark has its title. */
export const LANE_PAGE = 60;

const parse = <T>(value: string | undefined): T | undefined =>
  value === undefined ? undefined : (JSON.parse(value) as T);

export function useLaneMeta(projectId: Id<'hostedProjects'>) {
  const read = useSafeQuery(api.projectHostedLiveLanes.list, {
    projectId,
    cursor: null,
    limit: LANE_PAGE,
  });
  const page = parse<{ page: LaneMeta[]; isDone: boolean }>(read.value);
  return { lanes: page?.page, complete: page?.isDone ?? false, error: read.error };
}

export function useQueue(projectId: Id<'hostedProjects'>) {
  const read = useSafeQuery(api.projectHostedQueueView.read, { projectId });
  return { queue: parse<QueueView>(read.value), error: read.error };
}

export function useSharedFiles(projectId: Id<'hostedProjects'>, open: boolean) {
  const read = useSafeQuery(api.projectNowOverlaps.now, open ? { projectId } : 'skip');
  return { view: parse<{ signals: SharedFiles }>(read.value)?.signals, error: read.error };
}

/** One landing from `projectLandingReads:list` (History): the Item it landed for, who landed it and when. */
export type Landed = {
  sequence: number;
  receiptId: string;
  at: string;
  /** The landing message's first line; `message` is the message itself, shown on expand. */
  title: string | null;
  message: string | null;
  /** The Item it landed for, when its Intent is an Item's first. */
  item: { id: string; title: string } | null;
  actor: string | null;
  agent: boolean;
  agentRun: string | null;
  /** The model the agent run declared ('not-declared' or 'unknown' when it did not); null for a person. */
  model: string | null;
  automatic: boolean;
  laneId: string | null;
  read: boolean;
};
export type LandedPage = {
  started: boolean;
  through: number | null;
  newest: number | null;
  rows: Landed[];
  /** The `before` of the next page; null when nothing is left. */
  next: number | null;
  scanned: number;
};
/** History's filters, kept in the address: `by` a handle or handle/run, `item` an Item id. */
export type HistoryFilter = { unread: boolean; by: string | null; item: string | null };

/** History: the first page live (it re-runs when a landing is accepted or the reader marks), then earlier pages read
 * once each on "Show earlier". Changing a filter starts again from the first page. */
export function useHistoryPages(projectId: Id<'hostedProjects'>, filter: HistoryFilter) {
  const client = useConvex();
  const args = {
    projectId,
    view: filter.unread ? ('unread' as const) : ('recent' as const),
    ...(filter.by ? { by: filter.by } : {}),
    ...(filter.item ? { item: filter.item } : {}),
  };
  const key = JSON.stringify(args);
  const read = useSafeQuery(api.projectLandingReads.list, args);
  const first = parse<LandedPage>(read.value);
  type Earlier = {
    key: string;
    rows: Landed[];
    next: number | null;
    loaded: boolean;
    busy: boolean;
    error: boolean;
  };
  const none: Earlier = { key, rows: [], next: null, loaded: false, busy: false, error: false };
  const [earlier, setEarlier] = useState<Earlier>(none);
  const mine = earlier.key === key ? earlier : none;
  const seen = new Set(first?.rows.map(row => row.sequence));
  const rows = [...(first?.rows ?? []), ...mine.rows.filter(row => !seen.has(row.sequence))];
  const next = mine.loaded ? mine.next : (first?.next ?? null);
  const showEarlier = () => {
    if (next === null || mine.busy) return;
    setEarlier({ ...mine, busy: true, error: false });
    void client
      .query(api.projectLandingReads.list, { ...args, before: next })
      .then(text => {
        const page = JSON.parse(text) as LandedPage;
        setEarlier(was =>
          was.key === key
            ? {
                key,
                rows: [...was.rows, ...page.rows],
                next: page.next,
                loaded: true,
                busy: false,
                error: false,
              }
            : was,
        );
      })
      .catch(() => setEarlier(was => (was.key === key ? { ...was, busy: false, error: true } : was)));
  };
  return {
    page: first ? { ...first, rows, next } : undefined,
    error: read.error,
    showEarlier,
    busy: mine.busy,
    earlierFailed: mine.error,
  };
}

export function useMarkRead() {
  return useMutation(api.projectLandingReads.mark);
}
