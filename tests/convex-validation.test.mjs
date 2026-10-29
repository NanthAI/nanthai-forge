// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { v } from 'convex/values';
import { makeFunctionReference } from 'convex/server';
import { checkArgs } from './convex-args.mjs';
import { state } from './hosted-fixture.mjs';
import { recordsFixture } from './hosted-records-fixture.mjs';
import { lanesFixture } from './hosted-lanes-fixture.mjs';

const project = { owner: 'owner', key: 'test', name: 'Test', currentBackup: null, revision: 0 };
const ref = makeFunctionReference('projectActorNames:remember');
const args = { projectId: 'project', reader: 'owner', labels: [] };

test('exported argument validators are cached and enforce all Convex value kinds', () => {
  const validator = v.object({
    text: v.string(),
    number: v.number(),
    flag: v.boolean(),
    empty: v.null(),
    id: v.id('hostedProjects'),
    integer: v.int64(),
    bytes: v.bytes(),
    literal: v.literal(2n),
    choice: v.union(v.literal('yes'), v.literal(false)),
    rows: v.array(v.object({ label: v.string(), optional: v.optional(v.number()) })),
    record: v.record(v.string(), v.number()),
    any: v.any(),
  });
  let exports = 0;
  const fn = {
    exportArgs: () => {
      exports++;
      return JSON.stringify(validator.json);
    },
  };
  const input = {
    text: 'text',
    number: NaN,
    flag: true,
    empty: null,
    id: 'synthetic',
    integer: 1n,
    bytes: new ArrayBuffer(2),
    literal: 2n,
    choice: false,
    rows: [{ label: 'x' }],
    record: { x: 1 },
    any: { arbitrary: [null, 'x'] },
  };
  checkArgs(fn, input, 'synthetic');
  checkArgs({ exportArgs: fn.exportArgs }, input, 'synthetic-wrapper');
  assert.equal(exports, 1);
  for (const patch of [
    { extra: 1 },
    { text: undefined },
    { number: '1' },
    { flag: 0 },
    { empty: false },
    { id: 3 },
    { integer: 2n ** 63n },
    { bytes: [] },
    { literal: 1n },
    { choice: true },
    { rows: [{ label: 'x', extra: 1 }] },
    { rows: [{}] },
    { record: { x: false } },
    { record: [] },
    { any: new Map() },
  ])
    assert.throws(() => checkArgs(fn, { ...input, ...patch }, 'synthetic'));
  assert.throws(() => checkArgs(fn, null, 'synthetic'), /ArgumentValidationError/);
});

test('dispatchers and schedulers reject invalid args before executing or enqueueing', async () => {
  const s = state([]);
  for (const method of ['runMutation', 'runQuery', 'runAction']) {
    for (const input of [
      { ...args, index: 0, generation: 1 },
      { ...args, labels: [{}] },
      { reader: 'owner' },
    ])
      await assert.rejects(s.ctx[method](ref, input), /ArgumentValidationError/);
  }
  for (const method of ['runAfter', 'runAt']) {
    const before = s.scheduled.length;
    await assert.rejects(
      s.ctx.scheduler[method](0, ref, { ...args, generation: 1 }),
      /ArgumentValidationError/,
    );
    assert.equal(s.scheduled.length, before);
    await s.ctx.scheduler[method](0, ref, args);
  }
  assert.equal(s.scheduled.length, 2);
  let calls = 0;
  s.ctx.runQuery = async () => {
    calls++;
    return 'read';
  };
  s.ctx.scheduler = {
    runAfter: async () => {
      calls++;
      return 'scheduled';
    },
  };
  await assert.rejects(s.ctx.runQuery(ref, {}), /ArgumentValidationError/);
  await assert.rejects(s.ctx.scheduler.runAfter(0, ref, {}), /ArgumentValidationError/);
  assert.equal(calls, 0);
  assert.equal(await s.ctx.runQuery(ref, args), 'read');
  assert.equal(await s.ctx.scheduler.runAfter(0, ref, args), 'scheduled');
  assert.equal(calls, 2);
});

async function documents(ctx) {
  await assert.rejects(ctx.db.insert('hostedProjects', { owner: 'owner' }), /DocumentValidationError/);
  await assert.rejects(
    ctx.db.insert('hostedProjects', { ...project, unexpected: true }),
    /DocumentValidationError/,
  );
  await assert.rejects(ctx.db.insert('hostedProjects', { ...project, _id: 'forged' }), /system field/);
  const id = await ctx.db.insert('hostedProjects', project);
  const before = await ctx.db.get(id);
  for (const values of [
    { revision: 'wrong' },
    { key: undefined },
    { extra: 1 },
    { sourceAuthority: { mode: 'server', epoch: 1, extra: 1 } },
    { _creationTime: 0 },
  ]) {
    await assert.rejects(ctx.db.patch(id, values), /DocumentValidationError/);
    assert.deepEqual(await ctx.db.get(id), before);
  }
  for (const values of [
    { ...project, owner: undefined },
    { ...project, extra: 1 },
    { ...project, _id: 'wrong' },
  ]) {
    await assert.rejects(ctx.db.replace(id, values), /DocumentValidationError/);
    assert.deepEqual(await ctx.db.get(id), before);
  }
  await ctx.db.patch(id, { agentGuidance: 'temporary', ignored: undefined });
  await ctx.db.patch(id, { agentGuidance: undefined });
  assert.deepEqual(await ctx.db.get(id), before);
  await ctx.db.replace(id, { ...project, name: 'Replaced', _id: id, _creationTime: before._creationTime });
  assert.deepEqual(await ctx.db.get(id), { ...before, name: 'Replaced' });
  await ctx.db.replace(id, { ...project, _id: undefined, _creationTime: undefined });
  assert.deepEqual(await ctx.db.get(id), before);
  await assert.rejects(ctx.db.patch(id, { _id: undefined }), /system field/);
}

for (const name of ['hosted', 'records', 'lanes'])
  test(`${name} database validates complete documents and keeps rejected writes atomic`, async () => {
    if (name === 'hosted') await documents(state([]).ctx);
    else if (name === 'records') await documents(recordsFixture().ctx);
    else await lanesFixture().call('validation', { _handler: documents }, {});
  });

test('dogfood-size validation reuses one compiled function and adds no idle calls', async t => {
  let exports = 0;
  const fn = {
    exportArgs: () => {
      exports++;
      return JSON.stringify(v.object({ label: v.string() }).json);
    },
  };
  const start = performance.now();
  for (let i = 0; i < 32000; i++) checkArgs(fn, { label: String(i) }, 'scale');
  const s = state([]);
  assert.equal(exports, 1);
  assert.equal(s.scheduled.length, 0);
  assert.equal(s.tasks.size, 0);
  assert.equal(s.reads(), 0);
  t.diagnostic(
    JSON.stringify({
      validations: 32000,
      compiled: exports,
      wallMs: performance.now() - start,
      peakRssBytes: process.resourceUsage().maxRSS * 1024,
      convexCalls: 0,
      idleCalls: 0,
    }),
  );
});
