// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { getFunctionName } from 'convex/server';
import { state } from './hosted-fixture.mjs';
import { moduleUrl } from './convex-module.mjs';
const { derivedArtifact, derivedBytes } = await import(moduleUrl('../convex/derivedArtifactActions.ts'));

async function native(t) {
  const previous = process.env.FORGE_BLOBS;
  process.env.FORGE_BLOBS = 'convex';
  t.after(() => {
    if (previous === undefined) delete process.env.FORGE_BLOBS;
    else process.env.FORGE_BLOBS = previous;
  });
  const s = state([]);
  const original = await s.ctx.storage.store(new Blob(['original']));
  const derive = pin =>
    derivedArtifact(
      s.ctx,
      original,
      'native-export',
      pin,
      async () => new Blob(['derived']),
      async () => {},
    );
  return { s, derive };
}

test('native derivatives reconcile lost store and attach replies without duplicate files', async t => {
  const { s, derive } = await native(t);
  const store = s.ctx.storage.store;
  let lostStore = true;
  s.ctx.storage.store = async blob => {
    const id = await store(blob);
    if (lostStore) {
      lostStore = false;
      throw Error('lost store reply');
    }
    return id;
  };
  const first = await derive('store');
  assert.equal(Buffer.from(await derivedBytes(s.ctx, first)).toString(), 'derived');
  assert.equal((await derive('store')).storageId, first.storageId);
  const mutation = s.ctx.runMutation;
  let lostAttach = true;
  s.ctx.runMutation = async (ref, args) => {
    const result = await mutation(ref, args);
    if (getFunctionName(ref) === 'derivedArtifacts:attach' && lostAttach) {
      lostAttach = false;
      throw Error('lost attach reply');
    }
    return result;
  };
  const second = await derive('attach');
  assert.equal((await derive('attach')).storageId, second.storageId);
  assert.equal(s.files.size, 3);
  assert.equal(s.tables.derivedArtifacts.size, 2);
});

test('2800 native artifact operations keep constant per-operation calls and document I/O', async t => {
  const { s, derive } = await native(t);
  const calls = new Map();
  let reads = 0,
    writes = 0;
  for (const method of ['runQuery', 'runMutation', 'runAction']) {
    const run = s.ctx[method];
    s.ctx[method] = (ref, args) => {
      const name = getFunctionName(ref);
      calls.set(name, (calls.get(name) ?? 0) + 1);
      return run(ref, args);
    };
  }
  for (const db of [s.ctx.db, s.ctx.db.system]) {
    const get = db.get;
    db.get = async id => {
      const row = await get(id);
      if (row) reads++;
      return row;
    };
  }
  const query = s.ctx.db.query;
  s.ctx.db.query = table => {
    const result = query(table),
      unique = result.unique;
    result.unique = async () => {
      const row = await unique();
      if (row) reads++;
      return row;
    };
    return result;
  };
  for (const method of ['insert', 'patch', 'delete']) {
    const run = s.ctx.db[method];
    s.ctx.db[method] = (...args) => {
      writes++;
      return run(...args);
    };
  }
  const count = 2800,
    started = performance.now();
  for (let i = 0; i < count; i++) assert((await derive(String(i))).storageId);
  assert.deepEqual(Object.fromEntries(calls), {
    'derivedArtifacts:get': count,
    'derivedArtifacts:reserve': count,
    'derivedArtifacts:attach': count,
  });
  assert.equal(reads, 6 * count);
  assert.equal(writes, 2 * count);
  assert.equal(s.tables.artifactBlobs.size, 0);
  assert.equal(s.scheduled.length, 0);
  t.diagnostic(
    JSON.stringify({
      operations: count,
      calls: 3 * count,
      reads,
      writes,
      wallMs: Math.round(performance.now() - started),
      peakRssKiB: process.resourceUsage().maxRSS,
    }),
  );
});
