// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { getFunctionName } from 'convex/server';
import { setup } from './hosted-planning-fixture.mjs';
import { prepareViewProvenance } from './view-provenance-fixture.mjs';
import { moduleUrl } from './convex-module.mjs';
import { NativeSource } from '../dist/native-source.js';
const reads = await import(moduleUrl('../convex/projectViewReads.ts'));
const actions = await import(moduleUrl('../convex/projectViewActions.ts'));
const index = await import(moduleUrl('../convex/projectWorkIndex.ts'));
const indexActions = await import(moduleUrl('../convex/projectWorkIndexActions.ts'));
const objects = await import(moduleUrl('../convex/projectObjects.ts'));
const parse = async promise => JSON.parse(await promise);

test('hosted View reads use indexed file/save and Lane/View records, with fresh authorization', async t => {
  let p;
  const s = await setup(t, true, async (root, work) => {
    p = await prepareViewProvenance(root, work);
  });
  await indexActions.ensure._handler(s.ctx, { projectId: s.projectId });
  const query = args =>
    reads.read._handler(s.ctx, {
      projectId: s.projectId,
      paginationOpts: { cursor: null, numItems: 1 },
      ...args,
    });
  const runQuery = s.ctx.runQuery;
  s.ctx.runQuery = (ref, args) => {
    const name = getFunctionName(ref);
    assert.notEqual(name, 'projectWork:events', 'View reads never replay the event journal');
    if (name === 'projectViewReads:read') return reads.read._handler(s.ctx, args);
    if (name === 'projectObjects:resolve') return objects.resolve._handler(s.ctx, args);
    return runQuery(ref, args);
  };
  s.ctx.storage.getUrl = async () => assert.fail('metadata queries never read source/history archives');
  const detail = await parse(query({ action: 'view', viewId: p.view.id }));
  const workspace = JSON.parse(await index.workspace._handler(s.ctx, { projectId: s.projectId }));
  assert.equal(workspace.counts.viewDetails, 2);
  assert.equal(workspace.counts.viewFiles, 2);
  assert.equal(workspace.counts.laneViews, 4);
  assert.equal(workspace.counts.viewAcceptances, 0);

  assert.equal(detail.provenanceAvailable, true);
  assert.deepEqual(
    detail.inputs.map(i => i.saveIndex),
    [1, 0],
  );
  assert.equal(detail.files.items[0].contributors.length, 2);
  assert.equal(detail.files.items[0].why[0].notes[0].excerpt, 'Keep both contributors');
  assert.equal((await parse(query({ action: 'view', viewId: p.earlier.id }))).status, 'superseded');
  const lane = await parse(query({ action: 'views', laneId: p.first.id }));
  assert.equal(lane.items[0].viewId, p.view.id);
  assert.ok(lane.nextCursor);
  assert.equal(
    (
      await parse(
        query({
          action: 'views',
          laneId: p.first.id,
          paginationOpts: { cursor: lane.nextCursor, numItems: 1 },
        }),
      )
    ).items[0].viewId,
    p.earlier.id,
  );
  await assert.rejects(query({ action: 'view', viewId: randomUUID() }), /View not found/);
  await assert.rejects(query({ action: 'view', viewId: p.view.id, generationId: 'different' }), /generation/);

  await s.send(
    {
      action: 'note',
      intentId: p.intent.id,
      kind: 'comment',
      text: 'New rationale after indexing',
    },
    detail.revision,
  );
  assert.equal(
    (await parse(query({ action: 'view', viewId: p.view.id }))).revision,
    workspace.revision + 1,
    'provenance plans pin the current Work head',
  );
  assert.equal(
    (await parse(query({ action: 'provenance', viewId: p.view.id }))).files.items[0].why[0].notes.length,
    2,
  );
  s.tables.projectWorkRecords.set('accepted', {
    _id: 'accepted',
    projectId: s.projectId,
    generationId: detail.generationId,
    collection: 'viewAcceptances',
    key: 'acceptance',
    parent: p.view.id,
    position: 100,
    value: JSON.stringify({
      id: 'acceptance',
      channel: 'main',
      head: p.view.head,
      at: '2026-01-01T00:00:00Z',
      actor: 'owner',
    }),
  });
  assert.equal((await parse(query({ action: 'view', viewId: p.view.id }))).status, 'accepted');
  assert.equal(
    (await parse(query({ action: 'views', laneId: p.first.id }))).items[0].accepted[0].actor,
    'owner',
  );
  const compact = await index.detail._handler(s.ctx, {
    projectId: s.projectId,
    collection: 'views',
    id: p.view.id,
  });
  assert.equal(JSON.parse(compact.value).viewStatus, 'accepted');

  // Populate this synthetic checkpoint's native objects. The same production
  // reader verifies project binding/digest and rechecks authority on memo hits.
  s.tables.projectBackups.get(s.backupId).transport = 'objects';
  const source = new NativeSource(s.root),
    originalGet = s.ctx.storage.get;
  for (const pin of detail.blobPins.filter(Boolean)) {
    const id = `blob:${pin.sha256}`,
      rowId = `object:${pin.sha256}`;
    s.files.set(id, { blob: new Blob([source.object(pin.sha256)]) });
    s.tables.projectObjects.set(rowId, {
      _id: rowId,
      projectId: s.projectId,
      digest: pin.sha256,
      size: pin.size,
      status: 'stored',
      storageId: id,
    });
  }
  const read = args =>
    actions.read._handler(s.ctx, {
      projectId: s.projectId,
      action: 'provenance',
      viewId: p.view.id,
      lines: true,
      paginationOpts: { cursor: null, numItems: 1 },
      ...args,
    });
  const provenance = await parse(read({}));
  assert.equal(provenance.available, true);
  assert.equal(provenance.files.items[0].lines.status, 'available');
  assert.equal(
    provenance.files.items[0].lines.ranges.find(range => range.startLine === 2).attributions[0].saveIndex,
    1,
  );
  const summary = await parse(read({ action: 'view' }));
  assert.deepEqual(summary.files.items, [{ path: 'a.ts', status: 'modified', additions: 3, deletions: 3 }]);

  s.caller(null);
  await assert.rejects(query({ action: 'view', viewId: p.view.id }), /Sign in/);
  await assert.rejects(read({}), /Sign in/);
  s.caller('outsider');
  await assert.rejects(query({ action: 'views', laneId: p.first.id }), /unavailable/);
  await assert.rejects(read({}), /unavailable/);
  s.tables.projectReaders.set('reader', { _id: 'reader', projectId: s.projectId, reader: 'outsider' });
  assert.equal((await parse(query({ action: 'view', viewId: p.view.id }))).viewId, p.view.id);
  // Revocation while loading source must also fail, including derived alignment caches.
  s.ctx.storage.get = async id => {
    const result = await originalGet(id);
    s.tables.projectReaders.delete('reader');
    return result;
  };
  await assert.rejects(read({}), /unavailable/);
  await assert.rejects(query({ action: 'view', viewId: p.view.id }), /unavailable/);
  s.caller('owner');
  s.ctx.storage.get = originalGet;
  // A blob bound only to a different project cannot be read through this plan.
  const blob = detail.blobPins.find(Boolean).sha256;
  s.tables.projectObjects.get(`object:${blob}`).projectId = 'other';
  await assert.rejects(read({}), /unavailable|not.*stored|missing/i);
});
