// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Ferdinando Valsecchi
// Account > Projects as words (Item 3d5d8839): what needs the person comes first, then every project by its newest
// activity; each row says, with its own nouns, what is held, what is moving and how far its Items are. No clock in
// the read: ages are worked out when the rows arrive, in whole hours like the server's order.
import type { FunctionReturnType } from 'convex/server';
import type { api } from '../../../../convex/_generated/api';
import { mainHealth, unverifiedMain } from '../flow/model';

export type ProjectRow = FunctionReturnType<typeof api.accountProjects.list>['page'][number];
/** The pages read so far: their rows in server order, and whether the cursor has more. */
export type AccountRead = { projects: readonly ProjectRow[]; more: boolean };
type Count = ProjectRow['held'];

export const roleWords: Record<ProjectRow['role'], string> = {
  owner: 'Owner',
  write: 'Can write',
  read: 'Can read',
};
const n = (count: Count) => `${count.atLeast ? 'at least ' : ''}${count.n.toLocaleString()}`;
const noun = (count: Count, one: string, many: string) =>
  `${n(count)} ${count.n === 1 && !count.atLeast ? one : many}`;

/** Projects with actionable decisions come first; each group keeps the server's activity order. */
export function grouped(rows: readonly ProjectRow[]) {
  return {
    needs: rows.filter(row => (row.attention?.n ?? 0) > 0),
    rest: rows.filter(row => !row.attention?.n),
  };
}

/** Advance a read's compact decision schedule in the browser. No requests are made at a deadline. */
export function attentionAt(read: AccountRead, now: number) {
  let nextAt = Infinity;
  const projects = read.projects.map(row => {
    let attention = row.attention;
    for (const { at, n, atLeast } of row.attentionChanges ?? []) {
      if (at > now) {
        nextAt = Math.min(nextAt, at);
        break;
      }
      attention = { n, atLeast };
    }
    return attention && attention !== row.attention ? { ...row, attention } : row;
  });
  return { data: { ...read, projects }, nextAt };
}

export function attentionTotal(read: AccountRead) {
  return {
    n: read.projects.reduce((sum, row) => sum + (row.attention?.n ?? 0), 0),
    atLeast: read.more || read.projects.some(row => row.attention?.atLeast !== false),
  };
}

/** The page sentence: the answer, then at most one more clause (DESIGN.md rule 45). */
export function sentence(read: AccountRead) {
  const { needs } = grouped(read.projects);
  const total = `${read.more ? 'at least ' : ''}${read.projects.length.toLocaleString()} ${read.projects.length === 1 ? 'project' : 'projects'}`;
  if (!read.projects.length) return read.more ? 'Projects not fully reported.' : 'No projects yet.';
  const { n: decisions, atLeast } = attentionTotal(read);
  const shown = `${total[0]!.toUpperCase()}${total.slice(1)}.`;
  if (!decisions)
    return `${atLeast ? 'What needs you is not fully reported' : 'Nothing needs you'}. ${shown}`;
  return `${atLeast ? 'At least ' : ''}${decisions.toLocaleString()} ${decisions === 1 ? 'decision needs' : 'decisions need'} you${atLeast ? '' : `, in ${needs.length === 1 ? needs[0]!.name : `${needs.length} projects`}`}. ${shown}`;
}

export function attentionWords(row: ProjectRow) {
  if (!row.attention?.n)
    return row.attention?.atLeast === false ? null : 'What needs you is not fully reported';
  return `${n(row.attention)} ${row.attention.n === 1 ? 'decision needs you' : 'decisions need you'}`;
}
export function laneWords(row: ProjectRow) {
  return row.lanes.n ? noun(row.lanes, 'Lane open', 'Lanes open') : 'No open Lanes';
}
/** Items, Done / In progress / Left, in the standing line's order; "not reported" until the plan is counted. */
export function itemWords(row: ProjectRow) {
  if (!row.items) return 'Items not reported';
  const { done, inProgress, left } = row.items;
  if (!done.n && !inProgress.n && !left.n) return 'No Items yet';
  return `Items: ${n(done)} done, ${n(inProgress)} in progress, ${n(left)} left`;
}

const hour = 3_600_000;
/** "updated …" in whole hours, matching the list's hourly order. */
export function updatedWords(at: number, now: number) {
  const hours = Math.floor(Math.max(0, now - at) / hour);
  if (hours < 1) return 'updated this hour';
  if (hours < 24) return `updated ${hours} h ago`;
  const days = Math.floor(hours / 24);
  return `updated ${days} ${days === 1 ? 'day' : 'days'} ago`;
}
/** The row's one line of context: role, visibility, main, and when it last moved. */
export function metaWords(row: ProjectRow, now: number) {
  const main =
    mainHealth(row.verdict ?? null, row.verdict?.checkedAt ?? undefined, now)?.word ??
    unverifiedMain(row.checksConfigured);
  return [
    roleWords[row.role],
    row.visibility === 'public' ? 'Public' : 'Private',
    main,
    updatedWords(row.activityAt, now),
  ].join(' · ');
}
