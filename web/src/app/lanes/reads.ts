// SPDX-License-Identifier: Apache-2.0
// The Lanes place's reads (Item e317b6ea). All are existing bounded queries, sent together once the project id is
// known; none takes a clock-derived argument, so they re-run on server writes only and sleep with the tab
// (live-reads.ts). The line feed is not read here: the project frame already holds it and passes it down.
//
// Per view, at 50 open Lanes: the Lane page (one execution, about 7 indexed reads per Lane), the queue view (at most
// 20 entries, about 7 reads each) and, only while their regions are open, the overlap view (20 KB budget) and the
// newest landings (one page of 30 receipts, 2 rows each for the Lane). Idle: zero.
import { useMutation } from 'convex/react';
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

/** One landing from `projectLandingReads:list`: its title is the landing message's first line. */
export type Landed = {
  sequence: number;
  receiptId: string;
  at: string;
  title: string | null;
  actor: string | null;
  agent: boolean;
  automatic: boolean;
  laneId: string | null;
  read: boolean;
};
export type LandedPage = {
  started: boolean;
  through: number | null;
  newest: number | null;
  rows: Landed[];
  more: boolean;
};

/** `unread` for To read; `recent` (the newest 30, read or not) for Landed today, only while that region is open. */
export function useLandings(projectId: Id<'hostedProjects'>, view: 'unread' | 'recent', open = true) {
  const read = useSafeQuery(api.projectLandingReads.list, open ? { projectId, view } : 'skip');
  return { page: parse<LandedPage>(read.value), error: read.error };
}

export function useMarkRead() {
  return useMutation(api.projectLandingReads.mark);
}
