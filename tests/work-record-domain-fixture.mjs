// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Ferdinando Valsecchi
import assert from 'node:assert/strict';

/** Independent fixture placement: logical seeds must not inherit the server router's bugs. */
/** Item history and Work events live in the 8-copy data table on every partition. */
const historyCollections = new Set(['planningItems', 'planningVersions', 'planningComments', 'events']);
/** As the work writer: a logical insert of Item history or Work events lands in the data table. */
export const fixtureInsertTable = (table, collection) =>
  ['projectWorkRecords', 'projectPlanningRecords'].includes(table) && historyCollections.has(collection)
    ? 'projectWorkDataRecords'
    : table;
export function fixtureWorkRecordTable(collection) {
  if (historyCollections.has(collection)) return 'projectWorkDataRecords';
  if (collection.startsWith('planningSearch')) return 'projectPlanningRecords';
  if (
    collection.endsWith(':payload') ||
    collection.startsWith('source') ||
    collection.startsWith('_workStore')
  )
    return 'projectWorkDataRecords';
  return collection.startsWith('planning') ? 'projectPlanningRecords' : 'projectWorkRecords';
}

/** Fail at the seed, before a narrow reader reports an unrelated missing payload. */
export function assertWorkRecordDomain(table, row, legacy = false) {
  if (!['projectWorkRecords', 'projectPlanningRecords', 'projectWorkDataRecords'].includes(table)) return;
  if (legacy && table === 'projectWorkRecords') return;
  assert.equal(
    table,
    fixtureWorkRecordTable(row.collection),
    'Work fixture physical domain; use logical seeding',
  );
}
