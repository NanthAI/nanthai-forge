// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Ferdinando Valsecchi
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { moduleUrl } from './convex-module.mjs';
import { itemWorkFixture } from './item-work-fixture.mjs';
const { page: prepare } = await import(moduleUrl('../convex/projectPlanningInboundPrepare.ts'));
const { visibleItemWork, itemWorkRelated } = await import(moduleUrl('../convex/projectItemWorkDetails.ts'));
const { workRecordWriter, finishWorkRecordWrites } = await import(
  moduleUrl('../convex/projectWorkRecordWriter.ts')
);
const collection = epoch => `_workStorePlanningInbound:${epoch}`;

async function fixture() {
  const s = await itemWorkFixture({ details: true });
  const projectId = s.auth.projectId;
  const project = () => s.ctx.db.get(projectId);
  const partition = (await project()).work.generationId;
  const operationId = randomUUID();
  const repair = (after, overrides = {}) =>
    s.call('prepare inbound', prepare, {
      projectId,
      owner: 'owner',
      partition,
      operationId,
      after,
      ...overrides,
    });
  const complete = async (first, overrides = {}) => {
    let result = first ?? (await repair(null, overrides));
    for (let i = 0; !result.complete && i < 40; i++) result = await repair(result.after, overrides);
    assert(result.complete);
  };
  const related = (owner, cursor = null) =>
    s.run('Related links', async () => {
      const visible = await visibleItemWork(s.ctx, await project(), s.itemId, owner);
      return itemWorkRelated(s.ctx, visible, cursor);
    });
  const all = async (owner, start) => {
    const shown = new Map();
    let page = start ?? (await related(owner));
    for (let i = 0; i < 100; i++) {
      for (const link of page.links) shown.set(`${link.kind}:${link.id}`, link);
      if (page.next === null) return [...shown.values()];
      page = await related(owner, page.next);
    }
    assert.fail('Related did not drain its position cursor');
  };
  const root = key =>
    [...s.tables.projectPlanningRecords.values()].find(
      row => row.collection === 'planningSearch' && row.key === key,
    );
  const edit = (key, fields) =>
    s.run('publish a planning root', async () => {
      const ctx = workRecordWriter(s.ctx);
      const before = await ctx.db.get(root(key)._id);
      await ctx.db.patch(before._id, { value: JSON.stringify({ ...JSON.parse(before.value), ...fields }) });
      await finishWorkRecordWrites(ctx);
    });
  const pointers = () =>
    [...s.tables.projectWorkDataRecords.values()].filter(row => row.collection.startsWith(collection('')));
  return { ...s, partition, operationId, repair, complete, related, all, edit, root, pointers };
}

const depends = id => ({ kind: 'depends-on', id });

test('Prepared Related pages show the same ordered links and shelf visibility as a 300-root scan', async () => {
  const s = await fixture();
  const target = s.itemId;
  for (let i = 0; i < 300; i++)
    await s.planning(randomUUID(), {
      title: `Source ${i}`,
      status: i % 5 === 0 ? 'archived' : i % 7 === 0 ? 'deleted' : 'closed',
      ...(i % 13 === 0 ? { purged: true } : {}),
      ...(i % 3 === 0 ? { relations: [depends(target)] } : {}),
    });
  const oldFirst = await s.related(true);
  assert(oldFirst.next);
  const oldRemainder = await s.all(true, await s.related(true, oldFirst.next));
  const [owner, member] = [await s.all(true), await s.all(false)];
  await s.complete();
  await s.ctx.db.insert('projectWorkDataRecords', {
    projectId: s.auth.projectId,
    generationId: s.partition,
    collection: collection(s.operationId),
    parent: `live:${target}`,
    position: 999,
    key: `${s.dependencyId}:${target}`,
    value: '',
  });
  assert.deepEqual(await s.all(true), owner);
  assert.deepEqual(await s.all(false), member);
  assert.deepEqual(await s.all(true, await s.related(true, oldFirst.next)), oldRemainder);
  assert(owner.length > member.length);
  assert(owner.some(link => link.kind === 'Split into' && link.id === s.followUpId));
});

test('Preparation cannot skip a prefix, and subsequent writes maintain pairs without status-only churn', async () => {
  const s = await fixture();
  for (let i = 0; i < 24; i++) await s.planning(randomUUID(), { title: `Unrelated ${i}` });
  await assert.rejects(s.repair('invented cursor'), { code: 'WORK_STALE' });
  await assert.rejects(s.repair(null, { owner: 'unknown' }), { code: 'PROJECT_UNAVAILABLE' });
  const cold = await s.related(true);
  const first = await s.repair(null);
  assert(first.after);
  assert.deepEqual(await s.repair(null), { after: first.after, complete: false, processed: 0 });
  assert.deepEqual(await s.related(true), cold, 'coverage is not visible until the whole scope is prepared');
  await s.complete(first);
  const before = s.pointers();
  await s.edit(s.followUpId, { status: 'closed', title: 'Renamed evidence' });
  assert.deepEqual(s.pointers(), before);
  assert((await s.related(true)).links.some(link => link.title === 'Renamed evidence'));
  const targets = Array.from({ length: 20 }, () => randomUUID());
  await s.edit(s.settledBlockerId, { relations: targets.map(depends) });
  const source = () => s.pointers().filter(row => row.key.startsWith(`${s.settledBlockerId}:`));
  assert.equal(source().length, 20);
  const replacements = Array.from({ length: 20 }, () => randomUUID());
  await s.edit(s.settledBlockerId, { relations: replacements.map(depends) });
  assert.deepEqual(
    source()
      .map(row => row.parent.slice('live:'.length))
      .sort(),
    replacements.sort(),
  );
  await s.edit(s.followUpId, { purged: true, relations: undefined });
  assert(!s.pointers().some(row => row.key.startsWith(`${s.followUpId}:`)));
  assert(!(await s.related(true)).links.some(link => link.id === s.followUpId));
});

test('Owner-only Related overflow changes neither a reader’s links nor its continuation', async () => {
  const s = await fixture();
  const sources = Array.from({ length: 51 }, () => randomUUID());
  for (const source of sources)
    await s.planning(source, {
      title: 'Shelved evidence',
      status: 'archived',
      relations: [depends(s.itemId)],
    });
  await s.complete();
  const owner = await s.read({ details: true, only: 'related' });
  assert.equal(owner.moreRelated, true);
  await s.ctx.db.insert('projectReaders', { projectId: s.auth.projectId, reader: 'reader' });
  s.as('reader');
  const reader = await s.read({ details: true, only: 'related' });
  assert.equal(reader.moreRelated, false);
  assert.equal(await s.related(false).then(page => page.next), null);
  assert(!reader.related.some(link => sources.includes(link.id)));
  await s.edit(sources[0], { status: 'open' });
  assert((await s.read({ details: true, only: 'related' })).related.some(link => link.id === sources[0]));
  await s.edit(sources[0], { status: 'deleted' });
  const deleted = await s.read({ details: true, only: 'related' });
  assert.deepEqual(deleted, reader);
});

test('A rollback rebuild fences off old pointers and retires even rows whose source vanished', async () => {
  const s = await fixture();
  const sources = Array.from({ length: 105 }, () => randomUUID());
  for (const source of sources)
    await s.planning(source, { title: 'Before rollback', relations: [depends(s.itemId)] });
  await s.complete();
  assert(s.pointers().length > 100);
  const operationId = randomUUID();
  const recovery = { operationId, rebuild: s.operationId };
  const paused = await s.repair(null, recovery);
  assert.deepEqual(await s.repair(null, recovery), paused);
  // The old writer neither saw nor updated any pointers.
  const retained = s.root(sources[0]);
  await s.ctx.db.patch(retained._id, {
    value: JSON.stringify({ ...JSON.parse(retained.value), relations: [] }),
  });
  await s.ctx.db.delete(s.root(sources[1])._id);
  assert(s.pointers().some(row => row.key.startsWith(`${sources[1]}:`)));
  let step = await s.repair(paused.after, recovery);
  while (!step.after?.startsWith('retire:')) {
    assert(step.after, 'old epoch remains until the clean one is complete');
    step = await s.repair(step.after, recovery);
  }
  assert.equal((await s.ctx.db.get(s.partition)).planningInboundVersion, operationId);
  assert(!(await s.all(true)).some(link => sources.slice(0, 2).includes(link.id)));
  const retiring = await s.repair(step.after, recovery);
  assert.equal(retiring.processed, 100);
  assert(retiring.after);
  assert.equal((await s.repair(step.after, recovery)).after, retiring.after);
  await s.complete(retiring, recovery);
  assert.deepEqual(await s.repair(null, recovery), { after: null, processed: 0, complete: true });
  await assert.rejects(s.repair(null, { ...recovery, operationId: randomUUID() }), { code: 'WORK_STALE' });
  assert(s.pointers().every(row => row.collection === collection(operationId)));
  assert(!s.pointers().some(row => sources.slice(0, 2).some(id => row.key.startsWith(`${id}:`))));
});

test('Sparse Related reads stay small as unrelated planning roots get wide', async () => {
  const s = await fixture();
  for (let i = 0; i < 300; i++) await s.planning(randomUUID(), { title: `Root ${i}` }, 'x'.repeat(5000));
  const cold = await s.related(true);
  const scannedBytes = s.counts.at(-1).readBytes;
  assert(cold.next);
  await s.complete();
  const covered = await s.related(true);
  assert.deepEqual(covered.links, await s.all(true));
  assert.equal(covered.next, null);
  const bytes = s.counts.at(-1).readBytes;
  assert(bytes < 16000, `${bytes} read bytes for sparse Related`);
  assert(scannedBytes > 10 * bytes, `bounded scan read ${scannedBytes} bytes`);
});
