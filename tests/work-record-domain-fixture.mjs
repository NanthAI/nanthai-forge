// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Ferdinando Valsecchi
import assert from 'node:assert/strict';

/** Independent fixture placement: logical seeds must not inherit the server router's bugs. */
export function fixtureWorkRecordTable(collection) {
  if (collection.startsWith('planningSearch')) return 'projectPlanningRecords';
  if (
    collection.endsWith(':payload') ||
    collection.startsWith('source') ||
    collection === 'viewFiles' ||
    collection.startsWith('_workStore')
  )
    return 'projectWorkDataRecords';
  return collection.startsWith('planning') ? 'projectPlanningRecords' : 'projectWorkRecords';
}

/** A partition whose layout marker says its Item history and Work events left the legacy tables. */
export function fixtureMovedPartition(tables, generationId) {
  for (const row of tables.projectWorkDataRecords?.values() ?? [])
    if (row.collection === '_workStoreLayout' && row.generationId === generationId)
      return ['cleaning', 'moved'].includes(JSON.parse(row.value).layout);
  return false;
}
export const fixtureMovedCollection = collection => movedCollections.has(collection);
const movedCollections = new Set(['planningItems', 'planningVersions', 'planningComments', 'events']);
/** Fail at the seed, before a narrow reader reports an unrelated missing payload. */
export function assertWorkRecordDomain(table, row, legacy = false) {
  if (!['projectWorkRecords', 'projectPlanningRecords', 'projectWorkDataRecords'].includes(table)) return;
  if (legacy && table === 'projectWorkRecords') return;
  // Item history and Work events live in the data table once their partition moved (Item 411727ba row 3).
  if (movedCollections.has(row.collection) && table === 'projectWorkDataRecords') return;
  assert.equal(
    table,
    fixtureWorkRecordTable(row.collection),
    'Work fixture physical domain; use logical seeding or an explicit legacy migration fixture',
  );
}
