// SPDX-License-Identifier: Apache-2.0
// Loose ends (Item fc1831eb) as data: the five groups from projectLooseEnds:read in reading order, each listed or
// marked not reported with its reason, and the words for what happened to each Lane the owner set aside. Pure.
import { waited, whoOf } from './model';

export type LooseRow = {
  laneId: string;
  intentId: string;
  title: string;
  actor: string;
  agent: string | null;
  paths: number;
  at: number;
  /** Another open Lane of the same Item is live: this one was left behind, and its agent abandons it. */
  replacedBy?: string;
  /** Current liveness evidence, for rows in the Still active group. */
  heldBy?: string;
};
type Group = { reported: true; rows: LooseRow[]; more: boolean } | { reported: false; why: string };
export type LooseEndsRead = {
  at: number;
  setAside: { authorityEpoch: number } | null;
  groups: Record<GroupKey, Group> & { active?: Group };
};
export type GroupKey = 'idle' | 'stopped' | 'checked' | 'projects' | 'dated';

const META: { key: GroupKey | 'active'; title: string; hint: string }[] = [
  { key: 'idle', title: 'Lanes nobody holds', hint: 'no save for days, oldest first' },
  { key: 'stopped', title: 'Stopped mid-task', hint: 'no save, sync or start for over 90 minutes' },
  { key: 'checked', title: 'Checked, never landed', hint: 'the check passed and nobody asked to land' },
  { key: 'projects', title: 'Leftover projects', hint: 'no landing for 30 days' },
  { key: 'dated', title: 'Waiting for a date', hint: 'a Done-when line due later' },
  { key: 'active', title: 'Still active', hint: 'has a live landing or recent activity' },
];

export function looseEndsView(read: LooseEndsRead, now: number) {
  const groups = META.flatMap(meta => {
    const group = read.groups[meta.key];
    if (!group) return [];
    return [
      {
        ...meta,
        reported: group.reported,
        why: group.reported ? null : group.why,
        more: group.reported && group.more,
        rows: group.reported
          ? group.rows.map(row => ({
              ...row,
              who: whoOf(row.actor, row.agent),
              age: waited(row.at, now),
            }))
          : [],
      },
    ];
  });
  const listed = groups.reduce((sum, group) => sum + (group.key === 'active' ? 0 : group.rows.length), 0);
  const quiet = groups.filter(group => !group.reported).length;
  return {
    groups,
    listed,
    sentence: {
      bold: listed
        ? `${listed.toLocaleString('en')} loose ${listed === 1 ? 'end' : 'ends'}.`
        : 'No loose ends reported.',
      rest: `Nothing here is deleted.${quiet ? ` ${quiet} of 5 groups are not reported yet; each says why.` : ''}`,
    },
  };
}

/** What `projectHostedDormant:abandon` said about one Lane, in words. A failed call is the only kind retry repeats. */
export function setAsideWord(result: string | 'failed') {
  switch (result) {
    case 'abandoned':
      return { word: 'Set aside', done: true, retry: false };
    case 'has-saved-work':
      return { word: 'Skipped: it holds work that is not on main', done: false, retry: false };
    case 'not-dormant':
      return { word: 'Skipped: it was saved meanwhile', done: false, retry: false };
    case 'pinned':
      return { word: 'Skipped: it is pinned', done: false, retry: false };
    case 'not-open':
    case 'not-found':
      return { word: 'Skipped: it is already closed', done: false, retry: false };
    case 'failed':
      return { word: 'Could not set aside', done: false, retry: true };
    default:
      return { word: `Skipped (${result})`, done: false, retry: false };
  }
}
