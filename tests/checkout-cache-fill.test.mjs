// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import fs from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import { digest } from '../dist/hash.js';
import { HostedCheckoutCache } from '../dist/hosted-checkout-cache.js';
import { withCheckoutMaterialization } from '../dist/checkout-materialization.js';

function setup(t, count = 600) {
  const root = mkdtempSync(join(tmpdir(), 'forge-cache-fill-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const machine = join(root, 'machine'),
    bytes = new Map();
  mkdirSync(machine);
  for (let i = 0; i < count; i++) {
    const value = Buffer.from(`ordinary source ${i}`);
    bytes.set(digest(value), value);
  }
  const ids = [...bytes.keys()],
    calls = { objects: 0, downloads: 0 };
  const transport = () => ({
    objects: async ids => {
      calls.objects++;
      return ids.map(sha256 => ({ sha256, size: bytes.get(sha256).length }));
    },
    downloadToFile: async (pin, path) => {
      calls.downloads++;
      writeFileSync(path, bytes.get(pin.sha256), { mode: 0o600 });
    },
  });
  const cache = (name, client = transport()) =>
    new HostedCheckoutCache(join(root, name), client, undefined, machine, true);
  const ensure = (cache, selected = ids) =>
    withCheckoutMaterialization(cache.root, () => cache.ensure(selected), { paths: cache.ioPaths });
  return { root, machine, bytes, ids, calls, transport, cache, ensure };
}

test('concurrent misses for the same shared object set fill once and keep page-call budgets', async t => {
  const s = setup(t),
    caches = ['one', 'two', 'three'].map(name => s.cache(name));
  await Promise.all(caches.map((cache, i) => s.ensure(cache, i % 2 ? s.ids.toReversed() : s.ids)));
  assert.deepEqual(s.calls, { objects: 6, downloads: 600 });
  assert.equal(
    caches.reduce((n, c) => n + c.machineObjects, 0),
    1200,
  );
  for (const id of s.ids) assert.equal(digest(readFileSync(join(s.machine, id))), id);
});

test('a failed fill releases its peer and never vouches for corrupt downloaded bytes', async t => {
  const s = setup(t, 30),
    bad = s.transport();
  bad.downloadToFile = async (_, path) => writeFileSync(path, 'corrupt', { mode: 0o600 });
  let release, ready;
  const hold = new Promise(r => (release = r)),
    entered = new Promise(r => (ready = r));
  const objects = bad.objects;
  bad.objects = async ids => {
    ready();
    await hold;
    return objects(ids);
  };
  const leader = s.ensure(s.cache('bad', bad));
  await entered;
  const follower = s.ensure(s.cache('good'));
  release();
  const results = await Promise.allSettled([leader, follower]);
  assert.equal(results[0].status, 'rejected');
  assert.equal(results[0].reason.code, 'INVALID_NATIVE_SOURCE');
  assert.equal(results[1].status, 'fulfilled');
  for (const id of s.ids) assert.equal(digest(readFileSync(join(s.machine, id))), id);
});

test('peers reverify shared bytes after a fill instead of trusting the completed lease', async t => {
  const s = setup(t, 30),
    client = s.transport(),
    rename = fs.rename;
  let release,
    ready,
    tampered = false;
  const hold = new Promise(r => (release = r)),
    entered = new Promise(r => (ready = r));
  const objects = client.objects;
  client.objects = async ids => {
    ready();
    await hold;
    return objects(ids);
  };
  fs.rename = async (...args) => {
    await rename(...args);
    if (!tampered && args[1] === join(s.machine, s.ids[0])) {
      tampered = true;
      writeFileSync(args[1], 'tampered', { mode: 0o600 });
    }
  };
  syncBuiltinESMExports();
  t.after(() => {
    fs.rename = rename;
    syncBuiltinESMExports();
  });
  const leader = s.ensure(s.cache('first', client));
  await entered;
  const follower = s.ensure(s.cache('second'));
  await new Promise(r => setImmediate(r));
  release();
  await Promise.all([leader, follower]);
  assert(tampered);
  assert.equal(s.calls.downloads, 31, 'the waiting peer refetches the tampered object');
  assert.equal(digest(readFileSync(join(s.machine, s.ids[0]))), s.ids[0]);
});

test('an unrelated object set progresses while a slow cache fill is waiting on transport', async t => {
  const s = setup(t, 2),
    client = s.transport();
  let release, ready;
  const hold = new Promise(r => (release = r)),
    entered = new Promise(r => (ready = r));
  const objects = client.objects;
  client.objects = async ids => {
    ready();
    await hold;
    return objects(ids);
  };
  const pending = s.ensure(s.cache('slow', client), [s.ids[0]]);
  await entered;
  try {
    await s.ensure(s.cache('independent'), [s.ids[1]]);
  } finally {
    release();
    await pending;
  }
});
