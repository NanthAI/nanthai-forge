// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Ferdinando Valsecchi
import assert from 'node:assert/strict';
import test from 'node:test';
import { moduleUrl } from './convex-module.mjs';
import { state } from './hosted-fixture.mjs';
const { page, run } = await import(moduleUrl('../convex/legacyWorkStoreMode.ts'));

test('the Work cleanup counts orphan comparison rows, stops at the reserve and replays without writes', async t => {
  const previous = process.env.CONVEX_CLOUD_URL;
  process.env.CONVEX_CLOUD_URL = 'https://fixture.convex.cloud';
  t.after(() => {
    if (previous === undefined) delete process.env.CONVEX_CLOUD_URL;
    else process.env.CONVEX_CLOUD_URL = previous;
  });
  const s = state([]);
  s.ctx.runMutation = (_ref, args) => page._handler(s.ctx, args);
  const collection = s.tables.projectWorkDataRecords;
  const put = (key, name, generationId = 'discarded-generation') =>
    collection.set(key, {
      _id: key,
      _creationTime: collection.size + 1,
      projectId: 'project',
      generationId,
      collection: name,
      key,
      parent: '',
      position: 0,
      value: '{}',
    });
  put('coverage', '_workStoreDigestCoverage');
  put('digest', '_workStoreDigests:notes');
  put('head', '_workStoreHeads:issue');
  put('history', 'planningVersions');
  put('plan', '_workStorePlan', 'kept-generation');
  put('orphan-head', '_workStoreHeads:issue', 'other-discarded-generation');
  const args = {
    family: 'comparison',
    cursor: null,
    deployment: 'fixture',
    apply: false,
    pages: 10,
    budgetBytes: 8 * 1024 * 1024,
  };
  await assert.rejects(run._handler(s.ctx, { ...args, deployment: 'wrong' }), { code: 'BAD_ARGUMENT' });
  const dry = await run._handler(s.ctx, args);
  assert.deepEqual([dry.found, dry.changed, dry.stopped], [4, 0, null]);
  const stopped = await run._handler(s.ctx, { ...args, apply: true, budgetBytes: 1024 * 1024 });
  assert.deepEqual([stopped.pages, stopped.changed, stopped.stopped], [0, 0, 'budget']);
  assert.equal(collection.size, 6);
  const first = await run._handler(s.ctx, { ...args, pages: 1 });
  assert.equal(first.stopped, 'pages');
  const rest = await run._handler(s.ctx, { ...args, cursor: first.nextCursor });
  assert.equal(first.found + rest.found, dry.found);
  assert.equal(rest.stopped, null);
  const applied = await run._handler(s.ctx, { ...args, apply: true });
  assert.deepEqual([applied.found, applied.changed, applied.stopped], [4, 4, null]);
  assert.deepEqual([...collection.keys()], ['history', 'plan']);
  const replay = await run._handler(s.ctx, args);
  assert.deepEqual([replay.found, replay.changed, replay.stopped], [0, 0, null]);
});
