// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Ferdinando Valsecchi
import { moduleUrl } from './convex-module.mjs';

const buckets = await import(moduleUrl('../convex/projectHostedOverlapChanges.ts'));
const { presencePaths } = await import(moduleUrl('../src/hosted-presence.ts'));

/** An overlap Lane row of a fixture with its saved list rebuilt from the Lane's bucket rows (Item 411727ba):
 * tests that read what peers and advice read compare this, not the slim stored row. */
export const withSavedList = (s, row) =>
  row && {
    ...row,
    changes: buckets.joinOverlapBuckets(
      [...s.tables.projectHostedOverlapChanges.values()]
        .filter(bucket => bucket.laneId === row.laneId)
        .map(bucket => bucket.changes),
    ),
  };

/** The stored form of a fixture Lane row written with its whole saved list as `changes` (default '[]'): the slim
 * row the Lane record write stores, plus its bucket rows. */
export function slimOverlapLane({ changes = '[]', ...row }) {
  return {
    row: {
      lastActivityAt: 4_000_000_000_000,
      ...row,
      pathSummary: presencePaths(changes),
      ...(buckets.hasSymbolFacts(changes) ? { symbolFacts: true } : {}),
    },
    buckets: [...buckets.splitOverlapChanges(changes)].map(([bucket, text]) => ({
      projectId: row.projectId,
      laneId: row.laneId,
      bucket,
      changes: text,
    })),
  };
}

/** Seeds a fixture Lane row given with its whole saved list (`changes`) through `insert(table, row)`, stored as the
 * Lane record write stores it. Returns what inserting the Lane row returned. */
export function seedOverlapLane(insert, lane) {
  const { row, buckets: rows } = slimOverlapLane(lane);
  const id = insert('projectHostedOverlapLanes', row);
  for (const bucket of rows) insert('projectHostedOverlapChanges', bucket);
  return id;
}

/** Replaces the saved list of a seeded fixture Lane row (`s` has `tables`, `insert` and `patch`), as a record write
 * that changed it would: its bucket rows and its summary fields. */
export function replaceOverlapList(s, row, changes) {
  const saved = slimOverlapLane({ ...row, changes });
  for (const [id, bucket] of [...s.tables.projectHostedOverlapChanges])
    if (bucket.projectId === row.projectId && bucket.laneId === row.laneId)
      s.tables.projectHostedOverlapChanges.delete(id);
  s.patch('projectHostedOverlapLanes', row._id, {
    pathSummary: saved.row.pathSummary,
    symbolFacts: saved.row.symbolFacts,
  });
  for (const bucket of saved.buckets) s.insert('projectHostedOverlapChanges', bucket);
}
