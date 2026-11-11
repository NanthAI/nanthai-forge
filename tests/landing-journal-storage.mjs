// SPDX-License-Identifier: Apache-2.0
// Fixture inventory only: never used to choose rows for a production archive.
import assert from 'node:assert/strict';

export const journalStorageTables = [
  'projectHostedRecords',
  'projectHostedRecordBodies',
  'projectHostedRecordHeads',
  'projectHostedOperations',
  'projectHostedSavePages',
  'projectHostedDisplayRecords',
  'projectHostedSnapshots',
  'projectHostedSnapshotHeads',
  'projectHostedSnapshotPages',
  'projectCoordinationEvents',
];
const bytes = row => Buffer.byteLength(JSON.stringify({ ...row, _creationTime: 0 }));
const detailKinds = new Set(['activity', 'change', 'claim', 'release']);

/** Partition whole stored rows by actual head identity, never by a guessed version or age.
 * Superseded is a capacity upper bound: transactional consumers still need reader expansion.
 * Operation terminal rows are likewise an upper bound, not a claim that receipts can be discarded. */
export function journalStorageInventory(f) {
  const rows = table => [...f.tables[table].values()];
  const heads = rows('projectHostedRecordHeads');
  const current = new Set(heads.map(row => row.recordId));
  const records = rows('projectHostedRecords');
  const byBody = new Map();
  const recordClass = row =>
    current.has(row._id) ? 'current' : row.lifecyclePlanId ? 'prepared' : 'superseded';
  for (const row of records) {
    const refs = byBody.get(row.bodyId) ?? [];
    refs.push(row);
    byBody.set(row.bodyId, refs);
    if (row.inline === undefined) assert(f.tables.projectHostedRecordBodies.has(row.bodyId));
  }
  const selectedSnapshots = new Set(rows('projectHostedSnapshotHeads').map(row => row.snapshotId));
  const snapshotClass = row =>
    selectedSnapshots.has(row._id) ? 'selected' : row.status === 'published' ? 'superseded' : 'staging';
  const saves = rows('projectHostedSaves');
  const bodyClass = row => {
    const refs = byBody.get(row._id) ?? [];
    if (!refs.length) return row.revision === undefined ? 'unreferenced' : 'event';
    const classes = refs.map(recordClass);
    return classes.includes('current') ? 'current' : classes.includes('prepared') ? 'prepared' : 'superseded';
  };
  const classify = (table, row) => {
    switch (table) {
      case 'projectHostedRecords':
        return `${recordClass(row)}:${row.kind}`;
      case 'projectHostedRecordBodies': {
        const kind = byBody.get(row._id)?.[0]?.kind ?? 'unlinked';
        return `${bodyClass(row)}:${kind}`;
      }
      case 'projectHostedRecordHeads':
        return `current:${row.kind}`;
      case 'projectHostedOperations':
        return JSON.parse(row.value).terminal ? 'terminal' : 'active';
      case 'projectHostedSavePages': {
        const save = saves.find(s => s.actor === row.actor && s.operationId === row.operationId);
        const laneId = save && JSON.parse(save.value).request?.laneId;
        const head = heads.find(h => h.kind === 'lane' && h.key === laneId);
        return !head ? 'unresolved' : ['completed', 'abandoned'].includes(head.status) ? 'closed' : 'open';
      }
      case 'projectHostedDisplayRecords':
        return 'derived';
      case 'projectHostedSnapshots':
        return snapshotClass(row);
      case 'projectHostedSnapshotHeads':
        return 'selected';
      case 'projectHostedSnapshotPages': {
        const snapshot = f.tables.projectHostedSnapshots.get(row.snapshotId);
        return snapshot ? snapshotClass(snapshot) : 'unresolved';
      }
      case 'projectCoordinationEvents': {
        const kind = row.kind ?? row.command.kind;
        return detailKinds.has(kind)
          ? `${row.at < Date.now() - 14 * 86_400_000 ? 'archive' : 'hot'}:${kind}`
          : `retained:${kind}`;
      }
      default:
        assert.fail(`Unclassified journal table ${table}`);
    }
  };
  const tables = Object.fromEntries(
    journalStorageTables.map(table => {
      const classes = {};
      for (const row of rows(table)) {
        const key = classify(table, row);
        classes[key] ??= { rows: 0, bytes: 0 };
        classes[key].rows++;
        classes[key].bytes += bytes(row);
      }
      return [table, classes];
    }),
  );
  return {
    tables,
    currentCandidates: records
      .filter(row => row.kind === 'candidate' && current.has(row._id))
      .map(row => {
        const body = f.tables.projectHostedRecordBodies.get(row.bodyId);
        const value = JSON.parse(row.inline ?? body.value);
        return {
          id: row.key,
          bodyId: row.bodyId,
          bodyBytes: bytes(body),
          governanceBytes: Buffer.byteLength(JSON.stringify(value.governance ?? null)),
          paths: value.governance?.paths.length ?? 0,
        };
      }),
  };
}

/** Signed category deltas preserve head replacements: old current rows become superseded.
 * Clamp only after summing each whole table, exactly like the landing storage guard. */
export function journalStorageGrowth(before, after) {
  return Object.fromEntries(
    journalStorageTables.map(table => [
      table,
      Object.fromEntries(
        [...new Set([...Object.keys(before.tables[table]), ...Object.keys(after.tables[table])])]
          .sort()
          .map(kind => [
            kind,
            Object.fromEntries(
              ['rows', 'bytes'].map(metric => [
                metric,
                (after.tables[table][kind]?.[metric] ?? 0) - (before.tables[table][kind]?.[metric] ?? 0),
              ]),
            ),
          ]),
      ),
    ]),
  );
}
