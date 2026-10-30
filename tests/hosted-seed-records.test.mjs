// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { ConvexError } from 'convex/values';
import { moduleUrl } from './convex-module.mjs';
import {
  fixture,
  checkpoint,
  preparedCheckpoint,
  seedRecordCheckpoint,
  modules,
} from './project-exchange-fixture.mjs';
import { land } from './source-landings-fixture.mjs';
import { ConvexExchange } from '../dist/exchange-client.js';
for (const name of ['projectHostedSeedRecordStore', 'projectHostedSeedRecords'])
  modules[name] = await import(moduleUrl(`../convex/${name}.ts`));
const backfill = (s, dryRun = true) =>
  modules.projectHostedSeedRecords.backfill
    ._handler(s.ctx, {
      projectId: 'project',
      dryRun,
    })
    .then(JSON.parse);
async function seeded(t, records = true) {
  const s = fixture(),
    first = await checkpoint(t, s);
  const prepared = await preparedCheckpoint(s, first.store, 0, undefined, { records });
  const backupId = await seedRecordCheckpoint(s, prepared);
  return { s, store: first.store, prepared, backupId };
}

test('seed records backfill is project-scoped, dry-run, provenance checked and idempotent', async t => {
  const f = await seeded(t),
    { s, backupId } = f;
  const backup = s.tables.projectBackups.get(backupId);
  assert.equal(backup.validatedWorkRecords, 1);
  delete backup.validatedWorkRecords;
  s.tables.projectBackups.set('unrelated', { ...backup, _id: 'unrelated', operationId: randomUUID() });
  const expected = [{ projectId: 'project', backupId, operationId: backup.operationId }];
  assert.deepEqual(await backfill(s), { dryRun: true, changes: expected });
  assert.equal(backup.validatedWorkRecords, undefined);
  assert.deepEqual(await backfill(s, false), { dryRun: false, changes: expected });
  assert.equal(backup.validatedWorkRecords, 1);
  assert.equal(s.tables.projectBackups.get('unrelated').validatedWorkRecords, undefined);
  let calls = 0;
  const run = s.ctx.runQuery;
  s.ctx.runQuery = (...args) => {
    calls++;
    return run(...args);
  };
  assert.deepEqual(await backfill(s, false), { dryRun: false, changes: [] });
  assert.equal(calls, 1, 'already repaired seeds need only the indexed inspection');
  delete backup.validatedWorkRecords;
  backup.operationId = randomUUID();
  assert.deepEqual((await backfill(s, false)).changes, []);
});

test('backfill excludes incomplete, non-seed, Git and schema-1 native backups', async t => {
  const f = await seeded(t, false),
    { s, backupId } = f;
  assert.equal(s.tables.projectBackups.get(backupId).validatedWorkRecords, undefined);
  assert.deepEqual((await backfill(s, false)).changes, []);
  const seed = [...s.tables.projectHostedSeeds.values()][0];
  const original = { ...seed };
  seed.nextPage--;
  assert.deepEqual((await backfill(s, false)).changes, []);
  Object.assign(seed, original);
  seed.request = JSON.stringify({ ...JSON.parse(seed.request), format: 'git' });
  assert.deepEqual((await backfill(s, false)).changes, []);
  s.tables.projectHostedSeeds.clear();
  assert.deepEqual((await backfill(s, false)).changes, []);
});
