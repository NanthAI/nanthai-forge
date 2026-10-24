// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { ConvexExchange } from '../dist/exchange-client.js';
import { ExchangeDownloadCache } from '../dist/exchange-download-cache.js';
import { digest } from '../dist/hash.js';
import { getFunctionName } from 'convex/server';
import { fixture, upload, modules } from './project-exchange-fixture.mjs';

test('exchange downloads ask only for missing hashes and authorize every cache hit', async () => {
  const client = new ConvexExchange('https://fixture.convex.cloud', 'fixture', 'project', 'op', null);
  const bytes = [Buffer.from('first'), Buffer.from('second')];
  const pins = bytes.map(value => ({ sha256: digest(value), size: value.length }));
  let downloaded = 0,
    checks = 0,
    denied = false;
  client.client.mutation = async () => []; // no R2 objects
  client.client.action = async (_ref, args) =>
    args.digests.map(sha256 => {
      const i = pins.findIndex(pin => pin.sha256 === sha256);
      downloaded += bytes[i].length;
      return { data: bytes[i], digest: sha256, size: bytes[i].length };
    });
  client.objects = async digests => {
    checks++;
    if (denied) throw new Error('PROJECT_UNAVAILABLE');
    return digests.map(id => pins.find(pin => pin.sha256 === id));
  };
  const first = await client.downloadBatch([pins[0]]);
  first[0].fill(0);
  assert.deepEqual(await client.downloadBatch(pins), bytes);
  assert.equal(downloaded, 11, 'mixed hit/miss transfers the second object only');
  assert.deepEqual(await client.download(pins[0]), bytes[0]);
  assert.equal(downloaded, 11);
  assert.equal(checks, 2);
  denied = true;
  await assert.rejects(client.downloadBatch(pins), /PROJECT_UNAVAILABLE/);
  await assert.rejects(client.download(pins[0]), /PROJECT_UNAVAILABLE/);
  assert.equal(downloaded, 11);
  client.objects = async () => [{ ...pins[0], size: pins[0].size + 1 }];
  await assert.rejects(client.download(pins[0]), error => error.code === 'INVALID_WORK_BACKUP');
});

test('byte cache evicts by bytes, isolates returned buffers and does not reuse a different size', () => {
  const cache = new ExchangeDownloadCache(5);
  const a = { sha256: 'a', size: 3 },
    b = { sha256: 'b', size: 3 };
  cache.put(a, Buffer.from('one'));
  cache.get(a).fill(0);
  assert.equal(cache.get(a).toString(), 'one');
  assert.equal(cache.get({ ...a, size: 2 }), undefined);
  cache.put(b, Buffer.from('two'));
  assert.equal(cache.get(a), undefined);
  cache.put({ sha256: 'large', size: 6 }, Buffer.alloc(6));
  assert.equal(cache.get(b).toString(), 'two');
});

test('mixed batch rechecks cached authority after fetching missing bytes', async () => {
  const client = new ConvexExchange('https://fixture.convex.cloud', 'fixture', 'project', 'op', null);
  const values = [Buffer.from('cached'), Buffer.from('missing')];
  const pins = values.map(bytes => ({ sha256: digest(bytes), size: bytes.length }));
  let revoked = false;
  client.client.mutation = async () => []; // no R2 objects
  client.client.action = async (_ref, args) =>
    args.digests.map(id => {
      const i = pins.findIndex(pin => pin.sha256 === id);
      if (i === 1) revoked = true;
      return { digest: id, size: values[i].length, data: values[i] };
    });
  client.objects = async () => {
    assert.equal(revoked, true, 'authority check follows missing-byte transfer');
    throw new Error('PROJECT_UNAVAILABLE');
  };
  await client.downloadBatch([pins[0]]);
  await assert.rejects(client.downloadBatch(pins), /PROJECT_UNAVAILABLE/);
});

test('multi-range objects remain uncached even when the total cache budget could hold them', () => {
  const cache = new ExchangeDownloadCache();
  const small = Buffer.alloc(2 * 1024 * 1024),
    large = Buffer.alloc(small.length + 1);
  const smallPin = { sha256: digest(small), size: small.length },
    largePin = { sha256: digest(large), size: large.length };
  cache.put(smallPin, small);
  cache.put(largePin, large);
  assert.deepEqual(cache.get(smallPin), small);
  assert.equal(cache.get(largePin), undefined);
});

test('small cached downloads use real current reader authority and exact project bindings', async () => {
  const s = fixture(),
    bytes = Buffer.from('small cached source'),
    pin = await upload(s, bytes);
  const client = new ConvexExchange('https://fixture.convex.cloud', 'fixture', 'project', 'op', null);
  client.client = {
    query: (ref, args) => {
      const [name, method] = getFunctionName(ref).split(':');
      return modules[name][method]._handler(s.ctx, args);
    },
    action: s.ctx.runAction,
    mutation: s.ctx.runMutation,
  };
  assert.deepEqual(await client.download(pin), bytes);
  const reads = s.reads();
  assert.deepEqual(await client.download(pin), bytes);
  assert.deepEqual(await client.downloadBatch([pin]), [bytes]);
  assert.equal(s.reads(), reads, 'warm objects use binding queries without storage bodies');
  s.caller('stranger');
  await assert.rejects(client.download(pin), error => error.data?.code === 'PROJECT_UNAVAILABLE');
  await assert.rejects(client.downloadBatch([pin]), error => error.data?.code === 'PROJECT_UNAVAILABLE');
  s.caller('owner');
  [...s.tables.projectObjects.values()][0].removed = true;
  await assert.rejects(client.download(pin), error => error.data?.code === 'SOURCE_UNAVAILABLE');
});
