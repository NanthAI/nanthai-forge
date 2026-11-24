// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Ferdinando Valsecchi
import { rollupContribution, type RollupCounts } from './planning-rollup.js';
import type { PlanningItem } from './work-planning-types.js';

type Branch = Pick<RollupCounts, 'unsettled' | 'progress' | 'started'>;
type Member = Pick<PlanningItem, 'status' | 'initiativeId' | 'parentId'>;
export type RollupScope = `parent:${string}` | `initiative:${string}`;
export const emptyRollupCounts = (): RollupCounts => ({
  total: 0,
  unsettled: 0,
  progress: 0,
  started: 0,
  done: 0,
});
const fields = Object.keys(emptyRollupCounts()) as (keyof RollupCounts)[];

export function addRollupCounts(target: RollupCounts, counts: RollupCounts, sign: 1 | -1 = 1) {
  for (const field of fields) target[field] += sign * counts[field];
}

/** An Initiative counts each stored member's status once. Started evidence can pass through a pin
 * or Proposed status, but never changes whether the member itself is settled. */
export const initiativeContribution = (status: Member['status'], branch?: Branch) =>
  rollupContribution(status, branch ? { ...branch, unsettled: 0 } : undefined);

/** An Item is a direct member of two independent scopes. Moves touch the old and new scopes once each. */
export function rollupMembershipChanges(
  before: Member | null,
  after: Member | null,
  beforeBranch?: Branch,
  afterBranch?: Branch,
) {
  const changes = new Map<RollupScope, RollupCounts>();
  const add = (key: RollupScope, counts: RollupCounts, sign: 1 | -1) => {
    if (!counts.total) return;
    let delta = changes.get(key);
    if (!delta) changes.set(key, (delta = emptyRollupCounts()));
    addRollupCounts(delta, counts, sign);
  };
  const count = (row: Member | null, sign: 1 | -1, branch?: Branch) => {
    if (!row) return;
    if (row.parentId) add(`parent:${row.parentId}`, rollupContribution(row.status, branch), sign);
    if (row.initiativeId)
      add(`initiative:${row.initiativeId}`, initiativeContribution(row.status, branch), sign);
  };
  count(before, -1, beforeBranch);
  count(after, 1, afterBranch);
  for (const [key, delta] of changes) if (fields.every(field => delta[field] === 0)) changes.delete(key);
  return changes;
}
