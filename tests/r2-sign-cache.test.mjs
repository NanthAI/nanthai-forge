// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setup, client, pinOf } from './r2-harness.mjs';
import { SignedDownloadCache, readSigned } from '../dist/exchange-r2-read.js';

const pins = values => values.map(pinOf).map(p => ({ sha256: p.digest, size: p.size }));
const content = values => values.map(value => ({ pin: pins([value])[0], bytes: Buffer.from(value) }));
const code = expected => error => error.code === expected || error.data?.code === expected;
const stage = t => {
  const dir = mkdtempSync(join(tmpdir(), 'forge-signed-cache-'));
  t.after(() => rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }));
  return dir;
};
const countSigns = reader => {
  const calls = [],
    run = reader.client.mutation;
  reader.client.mutation = (ref, args) => {
    if (args.digests) calls.push([...args.digests]);
    return run(ref, args);
  };
  return calls;
};

test('fake R2 repeated fetch rounds measure signing calls', async t => {
  const { s, fake } = await setup(t),
    values = Array.from({ length: 130 }, (_, i) => `cache measurement ${i}`),
    reader = client(s);
  await reader.uploadBatch(content(values));
  const calls = countSigns(reader);
  for (let round = 0; round < 3; round++) {
    const result = await reader.blobs.getSigned('project', pins(values));
    assert.deepEqual(
      values.map(value => result.get(pinOf(value).digest).toString()),
      values,
    );
  }
  const gets = fake.requests.filter(r => r.method === 'GET').length;
  t.diagnostic(`N=130 M=3 signDownloads=${calls.length} GETs=${gets}`);
  assert.equal(calls.length, 2);
  assert.deepEqual(
    calls.map(call => call.length).sort((a, b) => b - a),
    [100, 30],
  );
  assert.equal(gets, 390);
});

test('only uncached digests are signed, still in pages of at most 100', async t => {
  const { s } = await setup(t),
    reader = client(s),
    values = Array.from({ length: 230 }, (_, i) => `partial cache ${i}`);
  await reader.uploadBatch(content(values));
  const calls = countSigns(reader);
  await reader.blobs.getSigned('project', pins(values.slice(0, 110)));
  calls.length = 0;
  await reader.blobs.getSigned('project', pins(values));
  assert.deepEqual(
    calls.map(call => call.length).sort((a, b) => b - a),
    [100, 20],
  );
  assert.deepEqual(new Set(calls.flat()), new Set(pins(values.slice(110)).map(p => p.sha256)));
});

test('reuse stops exactly at the 60 second margin of the signed lifetime', async t => {
  t.mock.timers.enable({ apis: ['Date'], now: Date.parse('2026-10-20T12:00:00Z') });
  const { s } = await setup(t),
    reader = client(s),
    wanted = pins(['lifetime']);
  await reader.uploadBatch(content(['lifetime']));
  const calls = countSigns(reader);
  await reader.blobs.getSigned('project', wanted);
  t.mock.timers.tick(239_999);
  await reader.blobs.getSigned('project', wanted);
  assert.equal(calls.length, 1);
  t.mock.timers.tick(1);
  await reader.blobs.getSigned('project', wanted);
  assert.equal(calls.length, 2);
  t.mock.timers.tick(239_999);
  await reader.blobs.getSigned('project', wanted);
  assert.equal(calls.length, 2);
});

test('a cached 403 re-signs once, retains the replacement, and discards a denied replacement', async t => {
  const { s, fake } = await setup(t),
    reader = client(s),
    wanted = pins(['expired']);
  await reader.uploadBatch(content(['expired']));
  const calls = countSigns(reader);
  await reader.blobs.getSigned('project', wanted);
  fake.forbidGets = 1;
  await reader.blobs.getSigned('project', wanted);
  assert.equal(calls.length, 2);
  await reader.blobs.getSigned('project', wanted);
  assert.equal(calls.length, 2);
  fake.forbidGets = 2;
  await assert.rejects(reader.blobs.getSigned('project', wanted), code('EXCHANGE_DOWNLOAD_DENIED'));
  assert.equal(calls.length, 3, 'one fresh signing attempt for the cached 403');
  await reader.blobs.getSigned('project', wanted);
  assert.equal(calls.length, 4, 'failed replacement must not stay cached');
});

test('current authority is checked again when a cached URL needs renewal', async t => {
  t.mock.timers.enable({ apis: ['Date'], now: Date.parse('2026-10-20T12:00:00Z') });
  const { s } = await setup(t),
    reader = client(s),
    wanted = pins(['guarded cache']);
  await reader.uploadBatch(content(['guarded cache']));
  const calls = countSigns(reader);
  await reader.blobs.getSigned('project', wanted);
  s.caller('stranger');
  t.mock.timers.tick(240_000);
  await assert.rejects(reader.blobs.getSigned('project', wanted), code('PROJECT_UNAVAILABLE'));
  assert.equal(calls.length, 2);
});

test('cache entries do not cross projects, clients, or content sizes', async t => {
  const { s } = await setup(t),
    reader = client(s),
    wanted = pins(['isolated']);
  await reader.uploadBatch(content(['isolated']));
  s.tables.hostedProjects.set('other', { ...s.tables.hostedProjects.get('project'), _id: 'other' });
  const calls = countSigns(reader);
  await reader.blobs.getSigned('project', wanted);
  assert.equal((await reader.blobs.getSigned('other', wanted)).size, 0);
  assert.equal(calls.length, 2);
  const other = client(s),
    otherCalls = countSigns(other);
  await other.blobs.getSigned('project', wanted);
  assert.equal(otherCalls.length, 1);
  reader.client = other.client;
  await reader.blobs.getSigned('project', wanted);
  assert.equal(otherCalls.length, 2, 'replacing the client does not retain prior signed authority');
  await assert.rejects(
    reader.blobs.getSigned('project', [{ ...wanted[0], size: wanted[0].size + 1 }]),
    code('INVALID_WORK_BACKUP'),
  );
  assert.equal(otherCalls.length, 3);
});

test('each GET using a cached URL still verifies the digest', async t => {
  const { s, fake } = await setup(t),
    reader = client(s),
    wanted = pins(['verify each read']);
  await reader.uploadBatch(content(['verify each read']));
  const calls = countSigns(reader);
  await reader.blobs.getSigned('project', wanted);
  fake.corrupt.add(fake.key(`v1/p/project/o/${wanted[0].sha256}`));
  await assert.rejects(reader.blobs.getSigned('project', wanted), code('BLOB_DIGEST_MISMATCH'));
  assert.equal(calls.length, 1);
});

test('verified local bytes skip signing for batch, single, and file reads', async t => {
  const { s, fake } = await setup(t),
    reader = client(s),
    wanted = pins(['verified locally']),
    dir = stage(t);
  await reader.uploadBatch(content(['verified locally']));
  const calls = countSigns(reader);
  await reader.downloadBatch(wanted);
  const gets = fake.requests.filter(r => r.method === 'GET').length;
  await reader.downloadBatch(wanted);
  await reader.download(wanted[0]);
  await reader.downloadToFile(wanted[0], join(dir, 'content'));
  assert.equal(calls.length, 1);
  assert.equal(fake.requests.filter(r => r.method === 'GET').length, gets);
  assert.equal(readFileSync(join(dir, 'content'), 'utf8'), 'verified locally');
  s.caller('stranger');
  await assert.rejects(reader.downloadToFile(wanted[0], join(dir, 'denied')), code('PROJECT_UNAVAILABLE'));
  assert.deepEqual(readdirSync(dir), ['content']);
});

test('cached signed URLs never appear in console output, files, or download errors', async t => {
  const { s, fake } = await setup(t),
    reader = client(s),
    wanted = pins(['private payload']),
    dir = stage(t),
    logs = [];
  await reader.uploadBatch(content(['private payload']));
  for (const method of ['log', 'info', 'warn', 'error', 'debug'])
    t.mock.method(console, method, (...args) => logs.push(args.map(String).join(' ')));
  await reader.downloadToFile(wanted[0], join(dir, 'first'));
  await reader.downloadToFile(wanted[0], join(dir, 'second'));
  fake.forbidGets = 2;
  await assert.rejects(reader.downloadToFile(wanted[0], join(dir, 'failed')), error => {
    assert.doesNotMatch(String(error), /https?:|X-Amz-|Signature/i);
    return code('EXCHANGE_DOWNLOAD_DENIED')(error);
  });
  assert.deepEqual(logs, []);
  assert.deepEqual(readdirSync(dir).sort(), ['first', 'second']);
  for (const name of readdirSync(dir)) assert.equal(readFileSync(join(dir, name), 'utf8'), 'private payload');
});

test('unparseable URL lifetimes are fetched but never cached', async t => {
  const { s } = await setup(t),
    reader = client(s),
    wanted = pins(['no parsed expiry']),
    cache = new SignedDownloadCache();
  await reader.uploadBatch(content(['no parsed expiry']));
  let calls = 0;
  const sign = async (projectId, digests) => {
    calls++;
    const result = await reader.client.mutation('projectObjectDownloads:signDownloads', {
      projectId,
      digests,
    });
    return result.map(row => ({ ...row, url: `https://fixture.invalid/no-expiry/${row.digest}` }));
  };
  const fetch = globalThis.fetch;
  t.mock.method(globalThis, 'fetch', (url, init) =>
    String(url).startsWith('https://fixture.invalid/no-expiry/')
      ? Promise.resolve(new Response('no parsed expiry'))
      : fetch(url, init),
  );
  await readSigned(sign, 'project', wanted, cache);
  await readSigned(sign, 'project', wanted, cache);
  assert.equal(calls, 2);
});
