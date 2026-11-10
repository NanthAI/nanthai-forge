// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { v } from 'convex/values';
import { makeFunctionReference, queryGeneric } from 'convex/server';
import './check-runtime.mjs';
import { checkArgs, checkReturn, checkReturns, rawHandler } from './convex-args.mjs';
import { state } from './hosted-fixture.mjs';
import { recordsFixture } from './hosted-records-fixture.mjs';
import { lanesFixture } from './hosted-lanes-fixture.mjs';
import { readFileSync } from 'node:fs';
import { moduleUrl } from './convex-module.mjs';

const project = { owner: 'owner', key: 'test', name: 'Test', currentBackup: null, revision: 0 };
const ref = makeFunctionReference('projectActorNames:purgeDisplayNames');
const args = { cursor: null };

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
    for (const input of [{ ...args, index: 0, generation: 1 }, { cursor: 1 }, {}])
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

// Convex rejects a table with two indexes of the same name only at deploy time; catch merge duplicates here.
test('every Convex table defines each index name once', () => {
  const source = readFileSync(new URL('../convex/schema.ts', import.meta.url), 'utf8');
  const tables = source.split(/\n\s*[A-Za-z0-9_]+:\s*defineTable\(/).slice(1);
  assert.ok(tables.length > 10);
  for (const table of tables) {
    const chain = table.split(/\),\n/)[0];
    const names = [...chain.matchAll(/\.(?:index|searchIndex|vectorIndex)\(\s*'([^']+)'/g)].map(m => m[1]);
    const duplicates = names.filter((name, i) => names.indexOf(name) !== i);
    assert.deepEqual(duplicates, [], `duplicate index in table chain: ${chain.slice(0, 80)}`);
  }
});

// Issue 4c2635dc: the shared fixture checks every return against the declared `returns` validator.
// Until then it only checked that a value serialized, so a response production rejects passed.
const savedPage = route => ({
  page: [{ id: 'x', importId: 'own', name: 'Saved', route }],
  isDone: true,
  continueCursor: '',
});
const paginationOpts = { cursor: null, numItems: 10 };

test('the shared fixture fails a return value that does not match the declared validator', async () => {
  const s = state([]);
  s.caller('owner');
  const listRows = makeFunctionReference('savedViews:listRows');
  // A saved view without the required route fields, planted straight into the table.
  s.tables.savedViews.set('bookmark', {
    _id: 'bookmark',
    importId: 'own',
    owner: 'owner',
    name: 'Saved',
    route: {},
  });
  await assert.rejects(
    s.ctx.runQuery(listRows, { paginationOpts }),
    /ReturnsValidationError at savedViews:listRows\.page\[0\]\.route\.view \(missing\)/,
  );
  // The old check only asked whether the value serializes; this mismatch passed it.
  checkReturn(savedPage({}), 'savedViews:listRows');
  // A valid row passes the same call.
  s.tables.savedViews.get('bookmark').route = { view: 'source', state: 's', file: 'a.ts', line: 1 };
  assert.equal((await s.ctx.runQuery(listRows, { paginationOpts })).page.length, 1);
});

test('the history load return that failed in production (Issue 7c36abfb) fails the old fixture and passes the new one', async () => {
  const s = state([]);
  const load = (await import(moduleUrl('../convex/projectHistoryStore.ts'))).load;
  const ref = makeFunctionReference('projectHistoryStore:load');
  const chunk = { sha256: 'a'.repeat(64), size: 3 };
  await s.ctx.db.insert('projectHistory', {
    projectId: 'project',
    repository: 'example/repo',
    visibility: 'public',
    owner: 'owner',
    importCommit: 'b'.repeat(40),
    importState: 'state',
    status: 'ready',
    bytes: 3,
    packs: 1,
    attempt: 1,
    updatedAt: 1,
  });
  await s.ctx.db.insert('projectHistoryPacks', {
    projectId: 'project',
    tip: 'b'.repeat(40),
    haves: [],
    chunks: [chunk],
    framed: [chunk],
    bytes: 3,
    objects: 1,
    packSha1: 'c'.repeat(40),
    source: 'import',
    at: 1,
  });
  const loaded = await s.ctx.runQuery(ref, { projectId: 'project' });
  assert.deepEqual(loaded.packs[0].framed, [chunk]);
  // The shipped validator before the fix had no `framed` on a pack view.
  const oldWire = JSON.parse(load.exportReturns());
  let dropped = 0;
  (function drop(node) {
    if (node && typeof node === 'object') {
      if (node.type === 'object' && node.value?.framed && node.value?.tip) {
        delete node.value.framed;
        dropped++;
      }
      Object.values(node).forEach(drop);
    }
  })(oldWire);
  assert.equal(dropped, 1, 'the declared validator carries framed on the pack view');
  const declared = load.exportReturns;
  load.exportReturns = () => JSON.stringify(oldWire);
  try {
    await assert.rejects(
      s.ctx.runQuery(ref, { projectId: 'project' }),
      /ReturnsValidationError at projectHistoryStore:load .*packs\[0\]\.framed \(extra field\)/,
    );
    checkReturn(loaded, 'projectHistoryStore:load'); // the old fixture accepted exactly this value
    assert.throws(() => checkReturns(load, loaded, 'projectHistoryStore:load'), /extra field/);
  } finally {
    load.exportReturns = declared;
  }
  checkReturns(load, loaded, 'projectHistoryStore:load');
});

test('return checks skip functions without a declared validator and read undefined as null', () => {
  checkReturns({ exportReturns: () => 'null' }, { anything: [1n] }, 'plain');
  const nothing = { exportReturns: () => JSON.stringify(v.null().json) };
  checkReturns(nothing, undefined, 'void');
  assert.throws(() => checkReturns(nothing, 0, 'void'), /ReturnsValidationError at void/);
});

test('direct _handler calls check the declared returns validator; undeclared returns pass through exactly', async () => {
  let value = { id: 'a' };
  const typed = queryGeneric({ args: {}, returns: v.object({ id: v.string() }), handler: async () => value });
  assert.equal(await typed._handler({}, {}), value);
  value = { id: 'a', extra: 1 };
  await assert.rejects(typed._handler({}, {}), /ReturnsValidationError at _handler\.extra \(extra field\)/);
  assert.equal(
    await typed[rawHandler]({}, {}),
    value,
    'fixtures that check under a name call the raw handler',
  );
  const sync = queryGeneric({ args: {}, returns: v.null(), handler: () => 0 });
  assert.throws(() => sync._handler({}, {}), /ReturnsValidationError at _handler/);
  const promise = Promise.resolve({ anything: true });
  const untyped = queryGeneric({ args: {}, handler: () => promise });
  assert.equal(untyped._handler({}, {}), promise);
});

test('deploy-invalid literal validator identifiers fail locally while dynamic planning state keys keep their output (5a85cb5f)', () => {
  const wire = validator => ({ exportReturns: () => JSON.stringify(validator.json) });
  for (const key of ['in-progress', 'has space', 'dotted.name', '']) {
    const invalid = v.object({ [key]: v.number() });
    for (const validator of [invalid, v.array(invalid), v.object({ nested: v.union(v.null(), invalid) })])
      assert.throws(() => checkReturns(wire(validator), null, 'definition'), /ValidatorDefinitionError/);
    assert.throws(
      () => checkArgs({ exportArgs: () => JSON.stringify(invalid.json) }, {}, 'definition'),
      /ValidatorDefinitionError/,
    );
  }
  const states = { proposed: 0, open: 2, 'in-progress': 1, closed: 392, abandoned: 1 };
  checkReturns(wire(v.record(v.string(), v.number())), states, 'planning counts');
  assert.throws(
    () => checkReturns(wire(v.record(v.string(), v.number())), { ...states, open: 'two' }, 'planning counts'),
    /ReturnsValidationError/,
  );
});
