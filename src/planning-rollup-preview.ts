// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Ferdinando Valsecchi
import { isShelved, type PlanningItem } from './work-planning-types.js';
import { rollupBranch, rollupContribution, rollupDecision, type RollupWork } from './planning-rollup.js';
import {
  addRollupCounts,
  emptyRollupCounts,
  initiativeContribution,
  type RollupScope,
} from './planning-rollup-membership.js';

type Seed = Pick<PlanningItem, 'id' | 'kind' | 'version' | 'status' | 'parentId' | 'initiativeId'> & {
  work: RollupWork;
  checked: number;
  unchecked: number;
  pinned?: true;
  incomplete?: true;
  completionHeld?: true;
};
type Change = Pick<Seed, 'id' | 'kind' | 'version'> & {
  from: Seed['status'];
} & NonNullable<ReturnType<typeof rollupDecision>>;

/** Evaluation order is leaf-first; a cycle never supplies settled facts. Unknown facts block their
 * parent and Initiative, not unrelated branches. Callers must report these holds as incomplete coverage. */
export function previewPlanningRollup(rows: Iterable<Seed>) {
  const byId = new Map<string, Seed>();
  for (const row of rows) {
    if (isShelved(row.status)) continue;
    if (byId.has(row.id)) throw new Error('Preview received duplicate planning roots. Restart the dry run.');
    byId.set(row.id, row);
  }
  const tallies = new Map<RollupScope, ReturnType<typeof emptyRollupCounts>>();
  const tally = (scope: RollupScope) => {
    let value = tallies.get(scope);
    if (!value) tallies.set(scope, (value = emptyRollupCounts()));
    return value;
  };
  const remaining = new Map<string, number>();
  const parentOf = (row: Seed) => {
    const parent = row.parentId && byId.get(row.parentId);
    return parent && parent.kind === 'issue' ? parent.id : undefined;
  };
  for (const row of byId.values()) {
    if (row.kind === 'initiative') continue;
    const parent = parentOf(row);
    if (parent) remaining.set(parent, (remaining.get(parent) ?? 0) + 1);
  }
  const ready = [...byId.values()].filter(row => row.kind === 'issue' && !remaining.get(row.id));
  const changes: Change[] = [];
  const transitions: Record<string, number> = {};
  const known = (row: Seed) => !row.incomplete && row.work !== 'unknown';
  const blocked = new Set([...byId.values()].filter(row => !known(row)).map(row => row.id));
  const move = (row: Seed, scope: RollupScope) => {
    if (blocked.has(row.id)) return row.status;
    const result = rollupDecision(row, tally(scope), true);
    if (!result) return row.status;
    const key = `${row.kind}:${row.status}:${result.status}`;
    transitions[key] = (transitions[key] ?? 0) + 1;
    changes.push({ id: row.id, version: row.version, kind: row.kind, from: row.status, ...result });
    return result.status;
  };
  const pass = (
    row: Seed,
    id: string,
    scope: RollupScope,
    status: Seed['status'],
    branch?: ReturnType<typeof rollupBranch>,
  ) => {
    if (blocked.has(row.id)) blocked.add(id);
    else
      addRollupCounts(
        tally(scope),
        scope.startsWith('initiative:')
          ? initiativeContribution(status, branch)
          : rollupContribution(status, branch),
      );
  };
  for (let index = 0; index < ready.length; index++) {
    const row = ready[index]!;
    const scope = `parent:${row.id}` as const;
    const status = move(row, scope);
    const branch = rollupBranch(tally(scope), row.work);
    const parent = parentOf(row);
    if (parent) {
      pass(row, parent, `parent:${parent}`, status, branch);
      const left = remaining.get(parent)! - 1;
      remaining.set(parent, left);
      if (!left) ready.push(byId.get(parent)!);
    }
    if (row.initiativeId) pass(row, row.initiativeId, `initiative:${row.initiativeId}`, status, branch);
  }
  let cyclicItems = 0;
  for (const [id, pending] of remaining) {
    if (!pending) continue;
    cyclicItems++;
    blocked.add(id);
    const group = byId.get(id)?.initiativeId;
    if (group) blocked.add(group);
  }
  let blockedInitiatives = 0;
  let incompleteItems = 0;
  let pinned = 0;
  let proposed = 0;
  for (const row of byId.values()) {
    if (row.pinned) pinned++;
    if (row.status === 'proposed') proposed++;
    if (!known(row)) incompleteItems++;
    if (row.kind !== 'initiative') continue;
    if (blocked.has(row.id)) blockedInitiatives++;
    else move(row, `initiative:${row.id}`);
  }
  return {
    transitions,
    changes,
    cyclicItems,
    blockedInitiatives,
    incompleteRows: incompleteItems,
    pinned,
    proposed,
  };
}

type Page = {
  fence: { generation: string; revision: number };
  from: string;
  after: string | null;
  rootsRead: number;
  targeted?: true;
  rows: Seed[];
};

/** A whole-Plan report is diagnostic and requires one revision; targeted apply has independent Item fences. */
function readFencedPages(pages: readonly Page[]) {
  const selected = pages[0]?.fence;
  let next: string | null = '';
  let rootsRead = 0;
  const rows: Page['rows'] = [];
  for (const page of pages) {
    if (
      page.targeted ||
      page.from !== next ||
      page.fence.generation !== selected?.generation ||
      page.fence.revision !== selected.revision ||
      (page.after !== null && page.after <= page.from)
    )
      throw new Error('The dry run has a missing, repeated, or stale page. Restart the dry run.');
    next = page.after;
    rootsRead += page.rootsRead;
    rows.push(...page.rows);
  }
  if (next !== null) throw new Error('The dry run did not read every page.');
  return { selected: selected!, rootsRead, rows };
}

function reportForDryRun(
  dryRun: ReturnType<typeof readFencedPages>,
  result: ReturnType<typeof previewPlanningRollup>,
) {
  const { changes, ...report } = result;
  return {
    ...report,
    rootsRead: dryRun.rootsRead,
    wouldChange: changes.length,
    complete: report.incompleteRows === 0 && report.cyclicItems === 0 && report.blockedInitiatives === 0,
  };
}

export function summarizeRollupDryRun(pages: readonly Page[]) {
  const dryRun = readFencedPages(pages);
  return reportForDryRun(dryRun, previewPlanningRollup(dryRun.rows));
}
