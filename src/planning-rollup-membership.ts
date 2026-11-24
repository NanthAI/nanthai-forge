// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Ferdinando Valsecchi
import { rollupContribution, type RollupBranch, type RollupCounts } from './planning-rollup.js';
import type { PlanningItem } from './work-planning-types.js';

type Member = Pick<PlanningItem, 'status' | 'initiativeId' | 'parentId'>;
export type RollupScope = `parent:${string}` | `initiative:${string}`;
export const emptyRollupCounts = (): RollupCounts => ({
  total: 0,
  unsettled: 0,
  progress: 0,
  started: 0,
  done: 0,
  running: 0,
});
const fields = Object.keys(emptyRollupCounts()) as (keyof RollupCounts)[];

export function addRollupCounts(target: RollupCounts, counts: RollupCounts, sign: 1 | -1 = 1) {
  for (const field of fields) target[field] += sign * counts[field];
}

/** Only the direct member's display status or its own open Lane can start the Initiative.
 * Descendants may belong to different Initiatives. */
export const initiativeContribution = (status: Member['status'], branch?: RollupBranch) =>
  rollupContribution(
    status,
    branch ? { ...branch, unsettled: 0, running: Number(!!branch.lane) } : undefined,
  );

/** An Item is a direct member of two independent scopes. Moves touch the old and new scopes once each. */
export function rollupMembershipChanges(
  before: Member | null,
  after: Member | null,
  beforeBranch?: RollupBranch,
  afterBranch?: RollupBranch,
) {
  const changes = new Map<RollupScope, RollupCounts>();
  const add = (key: RollupScope, counts: RollupCounts, sign: 1 | -1) => {
    if (!counts.total) return;
    let delta = changes.get(key);
    if (!delta) changes.set(key, (delta = emptyRollupCounts()));
    addRollupCounts(delta, counts, sign);
  };
  const count = (row: Member | null, sign: 1 | -1, branch?: RollupBranch) => {
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
