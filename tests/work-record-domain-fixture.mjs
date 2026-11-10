// SPDX-License-Identifier: Apache-2.0
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

/** Fail at the seed, before a narrow reader reports an unrelated missing payload. */
export function assertWorkRecordDomain(table, row, legacy = false) {
  if (!['projectWorkRecords', 'projectPlanningRecords', 'projectWorkDataRecords'].includes(table)) return;
  if (legacy && table === 'projectWorkRecords') return;
  assert.equal(
    table,
    fixtureWorkRecordTable(row.collection),
    'Work fixture physical domain; use logical seeding or an explicit legacy migration fixture',
  );
}
