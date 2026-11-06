// SPDX-License-Identifier: Apache-2.0
// Signing budget of an exchange pull: the exchange's pins are signed once, in pages of at most 100
// digests, not once per 8-object download batch (Issue 8618024c).
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { getFunctionName } from 'convex/server';
import { setup, client } from './r2-harness.mjs';
import { initNative } from '../dist/native-work.js';
import { WorkStore } from '../dist/work-store.js';
import { pullNativeExchange } from '../dist/native-exchange.js';
import { transferArchiveFixture } from './native-archive-fixture.mjs';

const FILES = 800;
/** Count documents (and their JSON bytes) the fixture database hands to Convex functions. */
function meterReads(s) {
  const meter = { docs: 0, bytes: 0 };
  const count = value => {
    const rows = Array.isArray(value) ? value : value?.page ? value.page : value && value._id ? [value] : [];
    for (const row of rows) {
      meter.docs++;
      meter.bytes += JSON.stringify(row).length;
    }
  };
  const wrap = target =>
    new Proxy(target, {
      get(object, key) {
        const value = object[key];
        if (typeof value !== 'function') return value;
        return (...args) => {
          const result = value.apply(object, args);
          if (result && typeof result.then === 'function') return result.then(done => (count(done), done));
          return result && typeof result === 'object' ? wrap(result) : result;
        };
      },
    });
  const { query, get } = s.ctx.db;
  s.ctx.db.query = table => wrap(query(table));
  s.ctx.db.get = async id => {
    const row = await get(id);
    count(row);
    return row;
  };
  return meter;
}
async function published(t, count = FILES) {
  const { s, fake } = await setup(t),
    dir = mkdtempSync(join(tmpdir(), 'forge-sign-batch-')),
    root = join(dir, 'owner');
  t.after(() => rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }));
  mkdirSync(root);
  for (let i = 0; i < count; i++) writeFileSync(join(root, `f${i}.txt`), `signing batch file ${i}\n`);
  initNative(root);
  const sender = client(s),
    result = await transferArchiveFixture(new WorkStore(root), sender);
  const reads = meterReads(s);
  const receiver = (batched = true) => {
    const exchange = client(s);
    if (!batched) exchange.prepareDownloads = undefined;
    exchange.manifest = async () => ({
      json: result.json,
      digest: result.digest,
      size: Buffer.byteLength(result.json),
    });
    const calls = [];
    const run = exchange.client.mutation;
    exchange.client.mutation = async (ref, args) => {
      const name = getFunctionName(ref);
      const before = { ...reads },
        value = await run(ref, args);
      if (name === 'projectObjectDownloads:signDownloads')
        calls.push({
          digests: args.digests.length,
          signed: value.length,
          docs: reads.docs - before.docs,
          bytes: reads.bytes - before.bytes,
        });
      return value;
    };
    return { exchange, calls };
  };
  return { s, fake, dir, result, receiver };
}

test('a pull signs its pins in pages of at most 100 digests', async t => {
  const { fake, dir, result, receiver } = await published(t),
    { exchange, calls } = receiver(),
    gets = fake.requests.filter(r => r.method === 'GET').length;
  await pullNativeExchange(result.backupId, join(dir, 'pulled'), exchange);
  const signedDigests = calls.reduce((sum, call) => sum + call.digests, 0);
  t.diagnostic(
    `files=${FILES} signDownloads calls=${calls.length} digests=${signedDigests} ` +
      `GETs=${fake.requests.filter(r => r.method === 'GET').length - gets}`,
  );
  assert.equal(readFileSync(join(dir, 'pulled', 'f799.txt'), 'utf8'), 'signing batch file 799\n');
  assert.ok(calls.every(call => call.digests <= 100));
  // 800 files plus the manifest-listed Work object: at most ceil(n / 100) pages, never per 8-object batch.
  assert.ok(calls.length <= Math.ceil((signedDigests + 99) / 100) + 1, `calls=${calls.length}`);
  assert.ok(calls.length <= 10, `calls=${calls.length}`);
});

const total = calls => ({
  calls: calls.length,
  docs: calls.reduce((sum, call) => sum + call.docs, 0),
  kb: Math.round(calls.reduce((sum, call) => sum + call.bytes, 0) / 1024),
});
test('before and after: one pull and ten pulls (an 8-shard check with two retried shards)', async t => {
  const { dir, result, receiver } = await published(t, 300),
    report = {};
  for (const [label, batched] of [
    ['per-batch signing (before)', false],
    ['100-digest windows (after)', true],
  ]) {
    const one = receiver(batched);
    await pullNativeExchange(result.backupId, join(dir, `one-${batched}`), one.exchange);
    // Eight shards, each its own client, two of them started again: ten pulls.
    const shards = [];
    for (let shard = 0; shard < 10; shard++) {
      const run = receiver(batched);
      await pullNativeExchange(result.backupId, join(dir, `shard-${batched}-${shard}`), run.exchange);
      shards.push(...run.calls);
    }
    report[label] = { onePull: total(one.calls), tenPulls: total(shards) };
  }
  t.diagnostic(JSON.stringify(report));
  const before = report['per-batch signing (before)'],
    after = report['100-digest windows (after)'];
  // 300 files: about 38 per-batch calls become 4 pages (plus the Work snapshot).
  assert.ok(before.onePull.calls >= 38 && after.onePull.calls <= 5, JSON.stringify(report));
  // One document per digest stays; the per-call project and membership reads shrink with the calls.
  assert.ok(after.onePull.docs < before.onePull.docs && after.onePull.kb < before.onePull.kb);
  assert.ok(after.tenPulls.calls <= 50, JSON.stringify(report));
});

test('a 403 after the batched signing re-signs only the denied object and still succeeds', async t => {
  const { fake, dir, result, receiver } = await published(t, 40),
    clean = receiver(),
    denied = receiver();
  await pullNativeExchange(result.backupId, join(dir, 'clean'), clean.exchange);
  fake.forbidGets = 1;
  await pullNativeExchange(result.backupId, join(dir, 'denied'), denied.exchange);
  assert.equal(readFileSync(join(dir, 'denied', 'f39.txt'), 'utf8'), 'signing batch file 39\n');
  assert.equal(denied.calls.length, clean.calls.length + 1);
  assert.deepEqual(
    denied.calls.filter(call => call.digests === 1).length,
    clean.calls.filter(call => call.digests === 1).length + 1,
  );
});

test('a warm local cache signs nothing', async t => {
  const { dir, result, receiver } = await published(t, 30),
    first = receiver(),
    second = receiver();
  await pullNativeExchange(result.backupId, join(dir, 'one'), first.exchange);
  assert.ok(first.calls.length >= 1);
  // The first pull's staged tree is a valid object cache for the second.
  await pullNativeExchange(result.backupId, join(dir, 'two'), second.exchange, {
    cacheRoot: join(dir, 'one'),
  });
  // Only the Work snapshot, which is read before the file plan exists, is signed.
  assert.equal(second.calls.length, 1, `calls=${second.calls.length}`);
});
