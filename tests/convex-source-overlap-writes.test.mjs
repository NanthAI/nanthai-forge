// SPDX-License-Identifier: Apache-2.0
// A merge step publishes its outputs one by one (merged blob, tree pages, State, result), and each
// R2 write is a signed PUT plus a HEAD check. With overlapWrites those writes run behind the merge
// work after them; outputs keep upload order and a failed write surfaces at settle.
import test from 'node:test';
import assert from 'node:assert/strict';
import { moduleUrl } from './convex-module.mjs';
import { digest } from '../dist/hash.js';
import { fakeSourceR2 } from './convex-source-r2-fixture.mjs';
const { convexSourceTransport } = await import(moduleUrl('../convex/projectConvexSourceTransport.ts'));

const forbiddenStorage = {
  store: () => assert.fail('R2 mode never stores Convex bytes'),
  get: () => assert.fail('R2 mode never reads Convex bytes'),
};
const object = text => {
  const bytes = Buffer.from(text);
  return {
    pin: { sha256: digest(bytes), size: bytes.length },
    stream: (async function* () {
      yield bytes;
    })(),
  };
};
function slowR2(t) {
  const r2 = fakeSourceR2(t),
    fake = globalThis.fetch;
  let inFlight = 0;
  r2.maxInFlight = 0;
  globalThis.fetch = async (target, init = {}) => {
    if ((init.method ?? 'GET') !== 'PUT') return fake(target, init);
    r2.maxInFlight = Math.max(r2.maxInFlight, ++inFlight);
    try {
      await new Promise(resolve => setTimeout(resolve, 20));
      return await fake(target, init);
    } finally {
      inFlight--;
    }
  };
  return r2;
}
const identity = { projectId: 'project', jobId: 'job', step: 0 };

test('overlapped source writes run together and keep upload order once settled', async t => {
  const r2 = slowR2(t),
    { io, outputs, settle, clock } = convexSourceTransport(
      { storage: forbiddenStorage },
      identity,
      [],
      undefined,
      { overlapWrites: true },
    );
  const items = ['blob', 'tree', 'state', 'result'].map(object);
  for (const item of items) await io.upload(item.pin, item.stream);
  assert.equal(outputs.length, 0, 'upload returned before its write finished');
  await settle();
  assert.deepEqual(
    outputs.map(output => output.sha256),
    items.map(item => item.pin.sha256),
  );
  assert(outputs.every(output => output.r2Key));
  assert(r2.maxInFlight > 1, 'writes overlapped');
  assert.equal(r2.requests.filter(method => method === 'HEAD').length, 4, 'every write is still verified');
  assert.equal(clock.value().writes, 4);
});

test('a failed overlapped write fails the step at settle; the default transport stays one at a time', async t => {
  const r2 = slowR2(t);
  const overlapped = convexSourceTransport({ storage: forbiddenStorage }, identity, [], undefined, {
    overlapWrites: true,
  });
  r2.hooks.lostPut = true;
  const lost = object('lost');
  await overlapped.io.upload(lost.pin, lost.stream);
  await assert.rejects(overlapped.settle(), { name: 'SourceIoError' });

  const serial = convexSourceTransport({ storage: forbiddenStorage }, identity);
  const items = ['a', 'b'].map(object);
  for (const item of items) await serial.io.upload(item.pin, item.stream);
  assert.equal(serial.outputs.length, 2, 'without overlap, outputs are complete after each upload');
});

test("consecutive quanta can describe and read this action's verified output without a resolver or another R2 read", async t => {
  const r2 = fakeSourceR2(t);
  const transport = convexSourceTransport(
    { storage: forbiddenStorage, runMutation: () => assert.fail('no repeated resolver') },
    identity,
  );
  const item = object('verified output');
  await transport.io.upload(item.pin, item.stream);
  assert.deepEqual(await transport.io.describeBatch([item.pin.sha256]), [{ object: item.pin, recipe: null }]);
  const parts = [];
  for await (const part of await transport.io.read(item.pin)) parts.push(part);
  assert.equal(Buffer.concat(parts).toString(), 'verified output');
  assert.equal(r2.requests.filter(method => method === 'GET').length, 0);
  assert.equal(
    transport.clock.value().r2b,
    1,
    'only the verification HEAD is signed; a cached output needs no GET signature',
  );
});

test('V8 fallback hand-off bounds serialized text even when UTF-8 controls expand in JSON', () => {
  const text = '\0'.repeat(400 * 1024),
    bytes = Buffer.from(text),
    small = Buffer.from('small plan');
  const transport = convexSourceTransport({ storage: forbiddenStorage }, identity, [], undefined, {
    preloaded: [
      { sha256: digest(bytes), size: bytes.length, text },
      { sha256: digest(small), size: small.length, text: small.toString() },
    ],
  });
  assert.deepEqual(
    transport.preloaded().map(value => value.text),
    ['small plan'],
  );
  assert(Buffer.byteLength(JSON.stringify(transport.preloaded())) <= 2 * 1024 * 1024);
});
