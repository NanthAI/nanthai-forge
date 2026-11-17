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
