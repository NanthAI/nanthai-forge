// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { getFunctionName } from 'convex/server';
import { startFakeR2, fakeR2Config } from './fake-r2.mjs';
import { outputFixture, api, read, key } from './hosted-output-fixture.mjs';
import { collectHostedOutput } from '../dist/hosted-output-collector.js';
import { hostedOutputPublisher } from '../dist/hosted-output-transfer.js';
import { HostedOutputReader, verifyOutputBytes } from '../dist/hosted-output-reader.js';
import { outputStreamId, outputKey, outputMessage, signOutput } from '../dist/hosted-check-output.js';
import { code } from './hosted-checks-fixture.mjs';

async function setup(t) {
  const fake = await startFakeR2();
  const restoreFetch = fake.install();
  const env = {
    R2_ACCOUNT_ID: fakeR2Config.accountId,
    R2_BUCKET: fakeR2Config.bucket,
    R2_ACCESS_KEY_ID: fakeR2Config.accessKeyId,
    R2_SECRET_ACCESS_KEY: fakeR2Config.secretAccessKey,
    FORGE_HOSTED_CHECK_KEY_SYNTHETIC: key,
  };
  const original = Object.fromEntries(Object.keys(env).map(k => [k, process.env[k]]));
  Object.assign(process.env, env);
  t.after(async () => {
    restoreFetch();
    for (const k of Object.keys(env)) {
      if (original[k] === undefined) delete process.env[k];
      else process.env[k] = original[k];
    }
    await fake.close();
  });
  const s = await outputFixture();
  const invoke = (name, fn, message, signature) => {
    metadataArgs.push(JSON.stringify(message));
    return s
      .call(name, fn, { projectId: s.projectId, message: JSON.stringify(message), signature })
      .then(JSON.parse);
  };
  const metadataArgs = [];
  let beforeApply = null;
  const commit = async (message, signature) => {
    metadataArgs.push(JSON.stringify(message));
    return JSON.parse(
      await api.commit._handler(
        {
          async runMutation(ref, args) {
            const name = getFunctionName(ref);
            if (name.endsWith(':authorize')) return s.call('outputAuthorize', api.authorize, args);
            assert(name.endsWith(':apply'));
            if (beforeApply) await beforeApply();
            return s.call('outputApply', api.apply, args);
          },
        },
        { projectId: s.projectId, message: JSON.stringify(message), signature },
      ),
    );
  };
  const transport = {
    prepare: (message, signature) => invoke('outputPrepare', api.prepare, message, signature),
    commit,
    put: (url, headers, bytes) => fetch(url, { method: 'PUT', headers, body: bytes }),
  };
  return {
    s,
    fake,
    transport,
    commit,
    metadataArgs,
    setBeforeApply: fn => {
      beforeApply = fn;
    },
  };
}

test('redacted live chunks and binary artifacts PUT directly to fake R2, survive duplicate ack and late viewer reconnect', async t => {
  const { s, fake, transport, metadataArgs } = await setup(t);
  const retained = [],
    publisher = hostedOutputPublisher(s.check, key, transport);
  let lostAck = true;
  const realCommit = transport.commit;
  transport.commit = async (...args) => {
    const result = await realCommit(...args);
    if (lostAck) {
      lostAck = false;
      throw new Error('synthetic lost ack');
    }
    return result;
  };
  const sink = publisher.sink(async (chunk, bytes) => retained.push({ chunk, bytes: Buffer.from(bytes) }));
  const text = Buffer.from('prefix synthetic-secret /private/runner/src/a.ts α\n'.repeat(400));
  async function* source() {
    for (let i = 0; i < text.length; i += 5) yield text.subarray(i, i + 5);
  }
  const redaction = { secrets: ['synthetic-secret'], paths: ['/private/runner'] };
  await assert.rejects(collectHostedOutput(source(), s.stream, redaction, sink, 4096));
  assert.equal(retained.length, 1);
  assert.equal((await s.chunks()).page.length, 1, 'lost response retained original metadata');
  await sink.publish(retained[0].chunk, retained[0].bytes);
  assert.equal((await s.chunks()).page.length, 1, 'replay did not duplicate');
  // Recollect the same original source under the same deterministic redaction /
  // chunk size. Existing chunks get create-only 412 + verified duplicate commit.
  const seal = await collectHostedOutput(
    source(),
    s.stream,
    redaction,
    publisher.sink(async () => {}),
    4096,
  );
  const artifact = { ...s.stream, stream: 'artifact', name: 'results/binary.bin' };
  const binary = Buffer.from([0, 255, 1, 254]);
  async function* artifactSource() {
    yield binary;
  }
  await collectHostedOutput(
    artifactSource(),
    artifact,
    redaction,
    publisher.sink(async () => {}),
    4096,
  );
  await s.pass(s.check);
  const root = (await s.manifest()).root;
  await publisher.final(root);
  assert.equal((await s.manifest()).complete, true);
  const index = await s.chunks();
  const reader = new HostedOutputReader(seal.stream),
    received = [];
  for (const entry of index.page
    .filter(r => r.streamId === outputStreamId(seal.stream))
    .sort((a, b) => a.chunk.sequence - b.chunk.sequence)) {
    const direct = JSON.parse(
      await s.call('outputDownload', read.download, {
        ...s.identity,
        streamId: entry.streamId,
        sequence: entry.chunk.sequence,
      }),
    );
    const response = await fetch(direct.url),
      bytes = new Uint8Array(await response.arrayBuffer());
    reader.accept(entry.chunk, bytes);
    received.push(Buffer.from(bytes));
  }
  reader.verifySeal(seal);
  const result = Buffer.concat(received).toString();
  assert(!result.includes('synthetic-secret') && !result.includes('/private/runner'));
  assert(result.includes('[redacted]') && result.includes('[workspace]/src/a.ts'));
  assert.equal(result, 'prefix [redacted] [workspace]/src/a.ts α\n'.repeat(400));
  const final = JSON.parse(
    await s.call('outputDownload', read.download, { ...s.identity, streamId: null, sequence: 0 }),
  );
  assert.deepEqual(await (await fetch(final.url)).json(), root);
  assert(fake.requests.some(r => r.method === 'PUT' && r.status === 412));
  assert(fake.requests.some(r => r.method === 'HEAD'));
  assert.equal(
    [...fake.objects.values()].some(bytes => bytes.includes(Buffer.from('synthetic-secret'))),
    false,
  );
  assert(
    metadataArgs.every(value => !value.includes('prefix [redacted]') && !value.includes('synthetic-secret')),
  );
  for (const row of s.tables.projectHostedOutputChunks.values())
    assert(!row.value.includes('prefix [redacted]'));
  const counts = Object.fromEntries(
    ['PUT', 'HEAD', 'GET'].map(method => [method, fake.requests.filter(r => r.method === method).length]),
  );
  t.diagnostic(
    JSON.stringify({
      r2: counts,
      retainedBytes: root.bytes,
      streams: root.streams,
      stdoutChunks: seal.chunks,
      objects: fake.objects.size,
      signedPuts: counts.PUT,
      signedHeads: counts.HEAD,
      signedGets: seal.chunks + 1,
      metadataCalls: metadataArgs.length,
      metadataArgumentBytes: metadataArgs.reduce((sum, value) => sum + Buffer.byteLength(value), 0),
    }),
  );
});

test('revocation between storage verification and apply cannot publish output or mint new read URLs', async t => {
  const { s, transport, setBeforeApply } = await setup(t);
  const bytes = Buffer.from('safe');
  const chunk = {
    stream: s.stream,
    sequence: 0,
    offset: 0,
    object: {
      sha256: (await import('node:crypto')).createHash('sha256').update(bytes).digest('hex'),
      size: bytes.length,
    },
  };
  const message = outputMessage(s.check, { kind: 'chunk', chunk }),
    signature = signOutput(message, key);
  const prepared = await transport.prepare(message, signature);
  await transport.put(prepared.target.url, prepared.target.headers, bytes);
  setBeforeApply(() =>
    s.patch('hostedProjects', s.projectId, { sourceAuthority: { mode: 'server', epoch: 2 } }),
  );
  await assert.rejects(transport.commit(message, signature));
  assert.equal(s.tables.projectHostedOutputChunks.size, 0);
  s.patch('hostedProjects', s.projectId, { sourceAuthority: { mode: 'server', epoch: 1 } });
  setBeforeApply(null);
  await transport.commit(message, signature);
  await assert.rejects(
    s.call(
      'outputDownload',
      read.download,
      { ...s.identity, streamId: outputStreamId(s.stream), sequence: 0 },
      'stranger',
    ),
    code('PROJECT_UNAVAILABLE'),
  );
});

test('immutable PUT cannot substitute corrupt bytes; direct readers detect later corrupt GETs', async t => {
  const { s, fake, transport } = await setup(t);
  const bytes = Buffer.from('a');
  const chunk = {
    stream: s.stream,
    sequence: 0,
    offset: 0,
    object: {
      sha256: (await import('node:crypto')).createHash('sha256').update(bytes).digest('hex'),
      size: 1,
    },
  };
  const message = outputMessage(s.check, { kind: 'chunk', chunk }),
    signature = signOutput(message, key);
  const prepared = await transport.prepare(message, signature);
  assert.equal(
    (await transport.put(prepared.target.url, prepared.target.headers, Buffer.from('x'))).status,
    400,
  );
  assert.equal((await transport.put(prepared.target.url, prepared.target.headers, bytes)).status, 200);
  await transport.commit(message, signature);
  fake.corrupt.add(fake.key(outputKey(s.projectId, s.check.id, chunk.object)));
  const direct = JSON.parse(
    await s.call('outputDownload', read.download, {
      ...s.identity,
      streamId: outputStreamId(s.stream),
      sequence: 0,
    }),
  );
  const actual = new Uint8Array(await (await fetch(direct.url)).arrayBuffer());
  assert.throws(() => verifyOutputBytes(chunk, actual), code('R2_OBJECT_CHECKSUM_MISMATCH'));
});
