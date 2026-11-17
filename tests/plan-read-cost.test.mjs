// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { meterWorkIO } from './hosted-read-set.mjs';
import { planFixture } from './plan-read-fixture.mjs';
import { moduleUrl } from './convex-module.mjs';
const { planView } = await import(moduleUrl('../convex/projectPlanView.ts'));
const { PLAN_ROWS, decodePlanPage } = await import(moduleUrl('../convex/projectPlanRows.ts'));
const { workRecordWriter, finishWorkRecordWrites } = await import(
  moduleUrl('../convex/projectWorkRecordWriter.ts')
);
const budget = JSON.parse(readFileSync(new URL('./fixtures/plan-read-budget.json', import.meta.url)));
const shape = result => ({ ...result, rows: JSON.parse(result.rows) });
for (const [name, scale, sparse] of [
  ['dogfood', 1, false],
  ['doubled', 2, false],
  ['sparse', 1, true],
  ['sparseDoubled', 2, true],
])
  test(`the ${name} Plan reads compact pages within its byte and storage budget without changing rows or counts`, async t => {
    const s = await planFixture(t, scale, sparse),
      io = meterWorkIO(s.ctx, s.tables);
    let before, after;
    const legacy = await io.cost(async () => {
      before = await planView(s.ctx, s.projectId);
    });
    const build = await io.cost(() => s.project());
    const compact = await io.cost(async () => {
      after = await planView(s.ctx, s.projectId);
    });
    assert.deepEqual(shape(after), shape(before));
    assert.equal(compact.writeDocuments, 0, 'opening or re-running a Plan view never writes or prepares');
    assert(compact.readBytes <= budget[name].readBytes, JSON.stringify(compact));
    const pages = [...s.tables.projectWorkDataRecords.values()].filter(row => row.collection === PLAN_ROWS);
    const stored = pages.reduce((n, row) => n + Buffer.byteLength(JSON.stringify(row)), 0);
    assert(stored <= budget[name].projectionBytes);
    assert(pages.length <= budget[name].projectionPages);
    assert(
      build.writeDocuments <= s.roots.length + pages.length + 1,
      'a batch flushes each compact page once',
    );
    for (const page of pages)
      for (const row of decodePlanPage(page.value, page.parent)) assert(!('body' in row));
    // An ordinary title/owner/order/checklist update replaces one page, at the same operation boundary.
    const id = s.roots[22 * scale + 1];
    const fields = {
      title: 'Keep the revised planning title exact',
      owner: '@member',
      order: 'M',
      doneWhen: [3, 4],
      version: 4,
      inLane: true,
    };
    const original = { ...s.tables.projectPlanningRecords.get(id) };
    const canonicalWrite = await io.cost(() => s.patch(id, fields, false));
    const { _id, _creationTime, ...originalFields } = original;
    await s.ctx.db.replace(_id, originalFields);
    const update = await io.cost(() => s.patch(id, fields));
    const ioDelta =
      compact.readBytes +
      update.readBytes +
      update.writeBytes -
      canonicalWrite.readBytes -
      canonicalWrite.writeBytes -
      legacy.readBytes;
    assert(ioDelta < 0, 'a planning write plus one open Plan tab must use less total DB I/O');
    assert.equal(
      update.migrationWrites,
      0,
      'current Plan metadata does not revive Work-store migration copies',
    );
    assert(update.writeDocuments <= budget.changedPageWrites);
    assert(update.readBytes <= budget.changedPageReadBytes, JSON.stringify(update));
    assert(update.writeBytes <= budget.changedPageWriteBytes, JSON.stringify(update));
    const row = JSON.parse((await planView(s.ctx, s.projectId)).rows).find(
      row => row.id === JSON.parse(s.tables.projectPlanningRecords.get(id).value).id,
    );
    assert.equal(row.title, 'Keep the revised planning title exact');
    assert.equal(row.owner, '@member');
    assert.equal(row.inLane, true);
    assert.deepEqual(row.doneWhen, [3, 4]);
    t.diagnostic(
      JSON.stringify({
        name,
        legacy,
        compact,
        build,
        update,
        canonicalWrite,
        modeledDbDeltaPer1000: (ioDelta * 1000 * 0.2) / 1e9,
        pages: pages.length,
        stored,
        replyBytes: Buffer.byteLength(after.rows),
        processMaxRssKiB: process.resourceUsage().maxRSS,
      }),
    );
  });
test('closing, moving, reopening and deleting an Item update its Plan counts without stale positions', async t => {
  const s = await planFixture(t);
  await s.project();
  const id = s.roots[23],
    root = s.tables.projectPlanningRecords.get(id),
    original = JSON.parse(root.value);
  const initial = await planView(s.ctx, s.projectId);
  const count = (r, id) => r.settled.find(g => g.initiativeId === id)?.done ?? 0;
  const closing = workRecordWriter(s.ctx);
  const borrowed = await closing.db.get(id);
  // A caller may edit its returned object; the read cache must keep the previous root's fields.
  borrowed.value = JSON.stringify({ ...original, status: 'closed' });
  await closing.db.patch(id, {
    value: borrowed.value,
    planning: { ...borrowed.planning, status: 'closed', open: false },
  });
  await finishWorkRecordWrites(closing);
  let read = await planView(s.ctx, s.projectId);
  assert.equal(count(read, original.initiativeId), count(initial, original.initiativeId) + 1);
  await s.patch(id, { initiativeId: s.initiatives[1] });
  read = await planView(s.ctx, s.projectId);
  assert.equal(count(read, original.initiativeId), count(initial, original.initiativeId));
  assert.equal(count(read, s.initiatives[1]), count(initial, s.initiatives[1]) + 1);
  await s.patch(id, { status: 'open' });
  read = await planView(s.ctx, s.projectId);
  assert.equal(count(read, s.initiatives[1]), count(initial, s.initiatives[1]));
  assert(JSON.parse(read.rows).some(row => row.id === original.id));
  const writer = workRecordWriter(s.ctx);
  await writer.db.delete(id);
  await finishWorkRecordWrites(writer);
  assert(!JSON.parse((await planView(s.ctx, s.projectId)).rows).some(row => row.id === original.id));
});

test('an async mutation flushes writes made after its first await before resolving, and propagates a failed flush', async t => {
  const { mutation } = await import(moduleUrl('../convex/server.ts'));
  const s = await planFixture(t);
  await s.project();
  const id = s.roots[23];
  const update = mutation(async (ctx, { title }) => {
    await Promise.resolve();
    const root = await ctx.db.get(id);
    await ctx.db.patch(id, { value: JSON.stringify({ ...JSON.parse(root.value), title }) });
    return title;
  });
  const title = 'A delayed write is visible when its mutation resolves';
  assert.equal(await update._handler(s.ctx, { title }), title);
  assert(JSON.parse((await planView(s.ctx, s.projectId)).rows).some(row => row.title === title));
  const failure = Error('synthetic projection flush failure');
  const db = new Proxy(s.ctx.db, {
    get(target, key) {
      if (key === 'patch')
        return (id, fields) => {
          if (s.tables.projectWorkDataRecords.has(id)) throw failure;
          return target.patch(id, fields);
        };
      const value = Reflect.get(target, key);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
  await assert.rejects(
    update._handler({ ...s.ctx, db }, { title: 'The failed flush must not report success' }),
    error => error === failure,
  );
});
