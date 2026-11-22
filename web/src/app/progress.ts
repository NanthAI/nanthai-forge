// SPDX-License-Identifier: Apache-2.0
// One definition of the project's progress (Item 3fa3187d), for Needs me and Plan: Issues in this project, from the
// stored counter (convex/projectPlanCounts.ts). Done is every closed Issue, In progress is in-progress, Left is open,
// and proposed Issues are named beside Left. A figure from a capped read is a lower bound: shown "N+", never bare.
import type { StandingCell } from '../ds';

export type PlanCountsRead = {
  exact: boolean;
  issue: Record<'proposed' | 'open' | 'inProgress' | 'closed' | 'abandoned', number>;
  closedToday: { day: string; n: number } | null;
};
export type Progress = {
  done: number;
  inProgress: number;
  left: number;
  proposed: number;
  /** Issues closed today (UTC); null when not counted. */
  today: number | null;
  atLeast: boolean;
};

export function progressOf(read: PlanCountsRead | undefined, now = Date.now()): Progress | null {
  if (!read) return null;
  const day = new Date(now).toISOString().slice(0, 10);
  return {
    done: read.issue.closed,
    inProgress: read.issue.inProgress,
    left: read.issue.open,
    proposed: read.issue.proposed,
    today: !read.exact ? null : read.closedToday?.day === day ? read.closedToday.n : 0,
    atLeast: !read.exact,
  };
}

/** The three Standing cells; `extra` adds the page's own secondary words (Lanes open, the last landing). */
export function progressCells(
  progress: Progress | null,
  extra: { inProgress?: string; hrefs?: { done?: string; inProgress?: string; left?: string } } = {},
): { done: StandingCell; inProgress: StandingCell; left: StandingCell } {
  const join = (...words: (string | false | null | undefined)[]) =>
    words.filter(Boolean).join(', ') || undefined;
  if (!progress)
    return {
      done: { n: 0, more: 'loading', href: extra.hrefs?.done },
      inProgress: { n: 0, more: extra.inProgress, href: extra.hrefs?.inProgress },
      left: { n: 0, href: extra.hrefs?.left },
    };
  return {
    done: {
      n: progress.done,
      atLeast: progress.atLeast,
      more: progress.today ? `${progress.today.toLocaleString()} today` : undefined,
      href: extra.hrefs?.done,
    },
    inProgress: {
      n: progress.inProgress,
      atLeast: progress.atLeast,
      more: extra.inProgress,
      href: extra.hrefs?.inProgress,
    },
    left: {
      n: progress.left,
      atLeast: progress.atLeast,
      more: join(
        progress.proposed > 0 &&
          `${progress.proposed.toLocaleString()}${progress.atLeast ? '+' : ''} proposed`,
      ),
      href: extra.hrefs?.left,
    },
  };
}

/** An Initiative's breakdown (Item b7a0dff1, owner 2026-11-19): every Item it holds, counted once, in one fixed
 * order. Done is closed, In progress is in-progress, Open is planned, Proposed only when there is any, Removed is
 * dropped or abandoned. The parts add up to `total`, which is the header's chip; the roll draws its ticks in the
 * same order and colours (`tick`), so the words and the bar tell one story on the Plan list, the tree and the
 * Initiative page. Capped fallback counts have an explicit "N+" marker. */
export type InitiativeCounts = {
  done: number;
  inProgress: number;
  open: number;
  proposed: number;
  removed: number;
  atLeast: boolean;
  liveAtLeast?: boolean;
};
export type BreakdownKey = 'done' | 'inProgress' | 'open' | 'proposed' | 'removed';
export type BreakdownPart = { key: BreakdownKey; n: number; word: string; tick: string; atLeast: boolean };
export type Breakdown = { total: number; atLeast: boolean; parts: BreakdownPart[] };
const breakdownOrder: readonly { key: BreakdownKey; word: string; tick: string }[] = [
  { key: 'done', word: 'done', tick: 'ok' },
  { key: 'inProgress', word: 'in progress', tick: 'run' },
  { key: 'open', word: 'open', tick: 'open' },
  { key: 'proposed', word: 'proposed', tick: 'prop' },
  { key: 'removed', word: 'removed', tick: 'gone' },
];

export function initiativeBreakdown(counts: InitiativeCounts): Breakdown {
  const parts = breakdownOrder
    .filter(part => part.key !== 'proposed' || counts.proposed > 0)
    .map(part => ({
      ...part,
      n: counts[part.key],
      atLeast: Boolean(part.key === 'done' || part.key === 'removed' ? counts.atLeast : counts.liveAtLeast),
    }));
  return {
    total: parts.reduce((sum, part) => sum + part.n, 0),
    atLeast: counts.atLeast || Boolean(counts.liveAtLeast),
    parts,
  };
}

const partText = (part: BreakdownPart) => `${part.n.toLocaleString()}${part.atLeast ? '+' : ''} ${part.word}`;
/** "30 done · 12 in progress · 58 open · 1 removed". */
export const breakdownWords = (breakdown: Breakdown) => breakdown.parts.map(partText).join(' · ');
/** "100 Items" (or "1,000+ Items" past the cap). */
export const breakdownTotal = (breakdown: Breakdown) =>
  `${breakdown.total.toLocaleString()}${breakdown.atLeast ? '+' : ''} ${breakdown.total === 1 && !breakdown.atLeast ? 'Item' : 'Items'}`;
