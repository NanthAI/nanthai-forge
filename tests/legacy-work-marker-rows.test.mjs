// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Ferdinando Valsecchi
// One-off delete of the unread partition layout markers (Item c0af6cfa, F5 leftover). Deleted with the job.
import test from 'node:test';
import assert from 'node:assert/strict';
import { itemWorkFixture as fixture } from './item-work-fixture.mjs';
import { moduleUrl } from './convex-module.mjs';
const job = await import(moduleUrl('../convex/legacyWorkMarkerRows.ts'));
const prior = process.env.CONVEX_CLOUD_URL;
test.before(() => (process.env.CONVEX_CLOUD_URL = 'https://synthetic-dev-1.convex.cloud'));
test.after(() => {
  if (prior === undefined) delete process.env.CONVEX_CLOUD_URL;
  else process.env.CONVEX_CLOUD_URL = prior;
});

async function partitions() {
  const s = await fixture({ details: true });
  const projectId = s.auth.projectId;
  const generation = recordsGenerationId =>
    s.ctx.db.insert('projectWorkGenerations', {
      projectId,
      backupId: 'backup',
      format: 11,
      status: 'ready',
      initialRevision: 0,
      revision: 0,
      nextBatch: 0,
      metadata: '{}',
      ...(recordsGenerationId ? { recordsGenerationId } : {}),
    });
  const row = (generationId, collection, value) =>
    s.ctx.db.insert('projectWorkDataRecords', {
      projectId,
      generationId,
      collection,
      key: 'tables',
      parent: '',
      position: 0,
      value: JSON.stringify(value),
    });
  const moved = await generation();
  await generation(moved); // shares the first partition's records: no marker of its own
  const copying = await generation();
  await generation(); // never marked
  const ids = {
    moved: await row(moved, '_workStoreLayout', { layout: 'moved' }),
    copying: await row(copying, '_workStoreLayout', { layout: 'copying' }),
    progress: await row(copying, '_workStoreLayoutProgress', { phase: 'copy', nextCursor: null }),
  };
  const left = () => [...s.tables.projectWorkDataRecords.values()].map(row => row._id);
  const run = (args = {}) =>
    job.markerRowsRun._handler(
      { runMutation: (_ref, input) => job.markerRowsPage._handler(s.ctx, input) },
      { deployment: 'synthetic-dev-1', apply: false, budgetBytes: 50_000_000, ...args },
    );
  return { ids, left, run, s };
}

test('a dry run counts the markers it would delete and writes nothing', async () => {
  const { left, run } = await partitions();
  const before = left();
  const result = await run();
  assert.equal(result.stopped, null);
  assert.equal(result.counts.found, 3);
  assert.equal(result.counts.deleted, 1, 'only the moved marker is deletable');
  assert.deepEqual(left(), before);
  assert.equal(result.blocked.length, 2, 'an unfinished layout and its progress row stay listed');
});

test('apply deletes only moved markers, never an unfinished layout, and a replay finds nothing more to delete', async () => {
  const { ids, left, run } = await partitions();
  await run({ apply: true });
  assert(!left().includes(ids.moved), 'the moved marker is gone');
  assert(left().includes(ids.copying), 'a copying marker is kept');
  assert(left().includes(ids.progress), 'a progress row is kept');
  const replay = await run({ apply: true });
  assert.equal(replay.counts.deleted, 0);
});

test('a deployment argument that does not name this deployment refuses before any read', async () => {
  const { run, left } = await partitions();
  const before = left();
  await assert.rejects(run({ deployment: 'prod-lookalike', apply: true }), /deployment/i);
  assert.deepEqual(left(), before);
});

test('the run stops at its read budget and says so', async () => {
  const { run } = await partitions();
  const result = await run({ budgetBytes: 1 });
  assert.equal(result.stopped, 'budget');
  assert.equal(result.counts.found, 0);
});

test('a page never reads past its allowance: oversized rows stop the page and the run says why', async () => {
  const { left, run, s } = await partitions();
  // Six more partitions, each marked by a ~900 KiB progress row (under Convex's document limit): together they
  // pass one page's 4 MiB allowance, so a read refuses to start instead of running past it.
  for (let i = 0; i < 6; i++) {
    const generation = await s.ctx.db.insert('projectWorkGenerations', {
      projectId: s.auth.projectId,
      backupId: 'backup',
      format: 11,
      status: 'ready',
      initialRevision: 0,
      revision: 0,
      nextBatch: 0,
      metadata: '{}',
    });
    await s.ctx.db.insert('projectWorkDataRecords', {
      projectId: s.auth.projectId,
      generationId: generation,
      collection: '_workStoreLayoutProgress',
      key: 'tables',
      parent: '',
      position: 0,
      value: JSON.stringify({ phase: 'copy', pad: 'x'.repeat(900 * 1024) }),
    });
  }
  const before = left().length;
  const result = await run({ apply: true });
  assert.equal(result.stopped, 'page');
  assert(result.readBytes < 6 * 1024 * 1024, `read ${result.readBytes}`);
  assert.equal(left().length, before - 1, 'only the moved marker was deleted before the stop');
});
