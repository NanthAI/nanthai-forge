// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Ferdinando Valsecchi
import type { PlanningItem } from './work-planning-types.js';

/** Display states are journaled; counts are disposable. `progress` and `started` can flow through a pin. */
export type RollupCounts = {
  total: number;
  unsettled: number;
  progress: number;
  started: number;
  done: number;
};
export type RollupWork = 'none' | 'active' | 'completed' | 'abandoned' | 'unknown';
export const rollupReasons = {
  laneStarted: 'In progress: Lane started',
  childStarted: 'In progress: work started below',
  ownWorkDone: 'Done: linked work finished',
  checklistDone: 'Done: checklist completed',
  lastChildSettled: 'Done: last child settled',
  lastItemSettled: 'Done: last Item settled',
  allAbandoned: 'Abandoned: all Items abandoned',
  workReopened: 'Reopened: work is open again',
} as const;

export function rollupContribution(
  status: PlanningItem['status'],
  /** Only a parent scope inherits branch facts. An Initiative counts each stored member once. */
  branch?: Pick<RollupCounts, 'unsettled' | 'progress' | 'started'>,
): RollupCounts {
  if (status === 'archived' || status === 'deleted')
    return { total: 0, unsettled: 0, progress: 0, started: 0, done: 0 };
  const done = status === 'closed';
  const progress = status === 'in-progress';
  return {
    total: 1,
    unsettled: Number((!done && status !== 'abandoned') || !!branch?.unsettled),
    progress: Number(progress || !!branch?.progress),
    started: Number(done || progress || !!branch?.started),
    done: Number(done),
  };
}

/** A status pin owns the display, not evidence that work exists below the next parent. */
export function rollupBranch(scope: RollupCounts, work: RollupWork) {
  return {
    unsettled: Number(scope.unsettled > 0 || work === 'active'),
    progress: Number(scope.progress > 0 || work === 'active'),
    started: Number(scope.started > 0 || work === 'active' || work === 'completed'),
  };
}

type Subject = Pick<PlanningItem, 'status' | 'kind' | 'statusPin'> & {
  unchecked: number;
  checked: number;
  work: RollupWork;
  /** A compact evaluation needs to know that a pin exists, not its attribution. */
  pinned?: true;
};

/** Decide one row from retained facts, the same way on a live wake or in recompute preview.
 * An absent or incomplete counter is not an empty counter; its caller must prove coverage first. */
export function rollupDecision(subject: Subject, scope: RollupCounts, enabled: boolean) {
  const { kind, status, statusPin, work, unchecked, checked } = subject;
  if (subject.pinned || statusPin || status === 'proposed' || status === 'archived' || status === 'deleted')
    return null;
  const move = (next: Subject['status'], rule: keyof typeof rollupReasons) =>
    next === status ? null : { status: next, rule, reason: rollupReasons[rule] };
  if (kind === 'initiative' && !enabled) return null;
  const settled = status === 'closed' || status === 'abandoned';
  if (settled && enabled && scope.unsettled)
    return move(
      scope.started || work === 'active' || work === 'completed' ? 'in-progress' : 'open',
      'workReopened',
    );
  if (settled && kind === 'issue') return null;
  if (status === 'open' && kind === 'issue' && work === 'active') return move('in-progress', 'laneStarted');
  if (status === 'open' && enabled && scope.unsettled && scope.started)
    return move('in-progress', 'childStarted');
  if (enabled && scope.unsettled) return null;
  if (kind === 'initiative') {
    if (!scope.total || unchecked) return null;
    return scope.done ? move('closed', 'lastItemSettled') : move('abandoned', 'allAbandoned');
  }
  if (work === 'active' || work === 'abandoned' || work === 'unknown' || unchecked) return null;
  if (enabled && scope.total) return move('closed', 'lastChildSettled');
  if (work === 'completed') return move('closed', 'ownWorkDone');
  return enabled && checked ? move('closed', 'checklistDone') : null;
}
