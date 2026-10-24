// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { collectHostedOutput } from '../dist/hosted-output-collector.js';
import { HostedOutputReader, verifyOutputBytes } from '../dist/hosted-output-reader.js';
const stream = { shard: 0, attempt: 0, executionId: 'synthetic-job', stream: 'stdout', name: '' };
const redaction = { secrets: ['synthetic-secret'], paths: ['/private/runner/workspace'] };
async function* slices(bytes, size = 3) {
  for (let i = 0; i < bytes.length; i += size) yield bytes.subarray(i, i + size);
}
const code = value => error => error.code === value;

test('collector batches redacted bytes, durably retains before PUT, and verifies full output without viewers', async t => {
  const source = Buffer.from('α /private/runner/workspace/src/test.ts synthetic-secret\n'.repeat(3000));
  const expected = Buffer.from('α [workspace]/src/test.ts [redacted]\n'.repeat(3000));
  const events = [],
    chunks = [],
    bytes = [],
    start = performance.now();
  let first = null;
  const seal = await collectHostedOutput(slices(source, 999), stream, redaction, {
    async retain(chunk, data) {
      chunks.push(chunk);
      bytes.push(Buffer.from(data));
      events.push(`retain-${chunk.sequence}`);
    },
    async publish(chunk, data) {
      first ??= performance.now() - start;
      verifyOutputBytes(chunk, data);
      events.push(`publish-${chunk.sequence}`);
    },
    async seal() {
      events.push('seal');
    },
  });
  assert.deepEqual(Buffer.concat(bytes), expected);
  assert(chunks.length < 10, 'batched chunks, never calls per line');
  assert.equal(seal.sha256, createHash('sha256').update(expected).digest('hex'));
  const reader = new HostedOutputReader(seal.stream);
  for (let i = 0; i < chunks.length; i++) {
    assert.equal(events[i * 2], `retain-${i}`);
    assert.equal(events[i * 2 + 1], `publish-${i}`);
    reader.accept(chunks[i], bytes[i]);
  }
  reader.verifySeal(seal);
  t.diagnostic(
    JSON.stringify({
      chunks: chunks.length,
      bytes: seal.bytes,
      chunkBytes: 65536,
      firstOutputMs: first,
      elapsedMs: performance.now() - start,
      sourceLines: 3000,
    }),
  );
});

test('storage backpressure never depends on a viewer and an unknown ack leaves durable exact replay', async () => {
  const retained = [];
  let fail = true,
    publishes = 0;
  const sink = {
    retain: async (chunk, bytes) => retained.push({ chunk, bytes: Buffer.from(bytes) }),
    publish: async () => {
      publishes++;
      if (fail) throw new Error('synthetic lost acknowledgment');
    },
    seal: async () => assert.fail('incomplete upload cannot seal'),
  };
  await assert.rejects(
    collectHostedOutput(slices(Buffer.from('synthetic-secret\nplain')), stream, redaction, sink, 4),
  );
  assert.equal(publishes, 1);
  assert.equal(retained.length, 1);
  assert.equal(retained[0].bytes.toString(), '[red');
  fail = false;
  await sink.publish(retained[0].chunk, retained[0].bytes);
  assert.equal(publishes, 2);
});

test('empty streams seal correctly; names and binary artifacts pass the same boundary redaction', async () => {
  let result;
  const sink = {
    retain: async () => {},
    publish: async () => {},
    seal: async seal => {
      result = seal;
    },
  };
  await collectHostedOutput(
    slices(Buffer.alloc(0)),
    { ...stream, stream: 'artifact', name: '/private/runner/workspace/report.bin' },
    redaction,
    sink,
  );
  assert.equal(result.bytes, 0);
  assert.equal(result.chunks, 0);
  assert.equal(result.stream.name, '[workspace]/report.bin');
  new HostedOutputReader(result.stream).verifySeal(result);
});

test('reader rejects corruption, gaps, changed streams, wrong sizes/offsets and incomplete final digests', async () => {
  const chunks = [],
    data = [];
  const seal = await collectHostedOutput(
    slices(Buffer.from('abcdefgh')),
    stream,
    redaction,
    {
      retain: async (chunk, bytes) => {
        chunks.push(chunk);
        data.push(bytes);
      },
      publish: async () => {},
      seal: async () => {},
    },
    4,
  );
  const reader = new HostedOutputReader(seal.stream);
  assert.throws(() => reader.accept(chunks[1], data[1]), code('EVIDENCE_CHANGED'));
  assert.throws(() => verifyOutputBytes(chunks[0], Buffer.from('xxxx')), code('R2_OBJECT_CHECKSUM_MISMATCH'));
  assert.throws(() => verifyOutputBytes(chunks[0], Buffer.from('a')), code('R2_OBJECT_CHECKSUM_MISMATCH'));
  assert.throws(() => reader.accept({ ...chunks[0], offset: 1 }, data[0]), code('EVIDENCE_CHANGED'));
  assert.throws(
    () => reader.accept({ ...chunks[0], stream: { ...stream, stream: 'stderr' } }, data[0]),
    code('EVIDENCE_CHANGED'),
  );
  reader.accept(chunks[0], data[0]);
  assert.throws(() => reader.verifySeal(seal), code('EVIDENCE_CHANGED'));
  reader.accept(chunks[1], data[1]);
  reader.verifySeal(seal);
  assert.throws(() => reader.verifySeal({ ...seal, sha256: 'a'.repeat(64) }), code('EVIDENCE_CHANGED'));
});

test('redacted artifact names cannot collapse distinct original streams', async () => {
  const seals = [];
  for (const name of ['/private/one/report.bin', '/private/two/report.bin']) {
    const result = await collectHostedOutput(
      slices(Buffer.from('bytes')),
      { ...stream, stream: 'artifact', name },
      { secrets: [], paths: ['/private/one', '/private/two'] },
      { retain: async () => {}, publish: async () => {}, seal: async () => {} },
    );
    seals.push(result);
  }
  assert.equal(seals[0].stream.name, seals[1].stream.name);
  assert.notEqual(seals[0].stream.identity, seals[1].stream.identity);
});
