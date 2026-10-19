// SPDX-License-Identifier: Apache-2.0
import { filterIntents, type IntentRow } from './model';

/** Presentation buckets only. Landing has no recorded state and shares Ready. */
export const boardColumns = ['planned', 'working', 'checking', 'ready', 'done'] as const;
export type BoardColumn = (typeof boardColumns)[number];
export const boardLabels = {
  planned: 'Planned',
  working: 'Working',
  checking: 'Checking',
  ready: 'Ready',
  done: 'Done',
};
export function intentColumn(row: IntentRow): BoardColumn {
  if (row.planned) return 'planned';
  if (filterIntents([row], 'done').length) return 'done';
  if (filterIntents([row], 'ready').length) return 'ready';
  return row.tone === 'running' ? 'checking' : 'working';
}
export function intentColumns(rows: readonly IntentRow[]) {
  const sorted = filterIntents(rows, 'all');
  return Object.fromEntries(
    boardColumns.map(column => [column, sorted.filter(row => intentColumn(row) === column)]),
  ) as Record<BoardColumn, IntentRow[]>;
}
export function recentDone(rows: readonly IntentRow[], now: number) {
  return rows.filter(row => {
    const at = (row.status === 'completed' ? row.landedAt : undefined) ?? row.lastAt;
    return at && Date.parse(at) >= now - 7 * 86_400_000;
  });
}
export function intentFlags(row: IntentRow) {
  return {
    paused: row.open.some(lane => lane.paused || lane.label === 'Paused'),
    needsYou: row.open.some(
      lane => lane.tone === 'conflict' || lane.tone === 'waiting' || lane.tone === 'passed',
    ),
    failed: row.open.some(lane => lane.tone === 'failed'),
  };
}
