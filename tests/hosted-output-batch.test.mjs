// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { performance } from 'node:perf_hooks';
import { getFunctionName } from 'convex/server';
import { startFakeR2, fakeR2Config } from './fake-r2.mjs';
import { outputFixture, api, read, key } from './hosted-output-fixture.mjs';
import { moduleUrl } from './convex-module.mjs';
import { collectHostedOutput } from '../dist/hosted-output-collector.js';
import { hostedOutputPublisher } from '../dist/hosted-output-transfer.js';
import { outputStreamId, outputMessage, signOutput } from '../dist/hosted-check-output.js';
import { digest } from '../dist/hash.js';
import { code } from './hosted-checks-fixture.mjs';
const batch = await import(moduleUrl('../convex/projectHostedOutputBatch.ts'));

async function setup(t) {
  const fake = await startFakeR2(),
    restoreFetch = fake.install();
  const env = {
    R2_ACCOUNT_ID: fakeR2Config.accountId,
    R2_BUCKET: fakeR2Config.bucket,
    R2_ACCESS_KEY_ID: fakeR2Config.accessKeyId,
    R2_SECRET_ACCESS_KEY: fakeR2Config.secretAccessKey,
    FORGE_HOSTED_CHECK_KEY_SYNTHETIC: key,
  };
  const saved = Object.fromEntries(Object.keys(env).map(k => [k, process.env[k]]));
  Object.assign(process.env, env);
  t.after(async () => {
    restoreFetch();
    for (const [k, value] of Object.entries(saved))
      if (value === undefined) delete process.env[k];
      else process.env[k] = value;
    await fake.close();
  });
  const s = await outputFixture();
  let calls = 0,
    beforeApply;
  const invoke = async (name, fn, args) => {
    calls++;
    return s.transaction(name, fn, args);
  };
  const entriesArgs = entries => ({
    projectId: s.projectId,
    entries: entries.map(({ message, signature }) => ({ message: JSON.stringify(message), signature })),
  });
  const singleArgs = (message, signature) => ({
    projectId: s.projectId,
    message: JSON.stringify(message),
    signature,
  });
  const commit = async (module, args) => {
    calls++;
    return JSON.parse(
      await module.commit._handler(
        {
          runMutation: async (ref, input) => {
            const name = getFunctionName(ref).split(':').at(-1);
            if (name === 'apply' && beforeApply) await beforeApply();
            return invoke(`batch${name}`, module[name], input);
          },
        },
        args,
      ),
    );
  };
  const transport = {
    prepare: async (message, signature) =>
      JSON.parse(await invoke('singlePrepare', api.prepare, singleArgs(message, signature))),
    commit: (message, signature) => commit(api, singleArgs(message, signature)),
    prepareBatch: async entries =>
      JSON.parse(await invoke('batchPrepare', batch.prepare, entriesArgs(entries))),
    commitBatch: entries => commit(batch, entriesArgs(entries)),
    put: (url, headers, bytes) => fetch(url, { method: 'PUT', headers, body: bytes }),
  };
  return {
    s,
    fake,
    transport,
    invoke,
    entriesArgs,
    count: () => calls,
    setBeforeApply: fn => {
      beforeApply = fn;
    },
  };
}

test('2 MiB compact output publishes in eight calls including seals/final, and one signing window', async t => {
  const { s, transport, invoke, count } = await setup(t);
  const publisher = hostedOutputPublisher(s.check, key, transport),
    retained = [];
  const bytes = Buffer.alloc(2 * 1024 * 1024, 65),
    baseline = s.counts.length,
    start = performance.now();
  let root;
  const commitBatch = transport.commitBatch;
  transport.commitBatch = async entries => {
    const receipts = await commitBatch(entries);
    root = receipts.at(-1).root;
    assert.deepEqual(
      receipts.map(item => item.revision),
      Array.from({ length: 33 }, (_, i) => i + 1),
    );
    return receipts;
  };
  const seal = await collectHostedOutput(
    (async function* () {
      yield bytes;
    })(),
    s.stream,
    { secrets: [], paths: [] },
    publisher.sink(async (chunk, data) => retained.push({ chunk, bytes: Buffer.from(data) })),
  );
  assert.equal(seal.chunks, 32);
  assert.equal(count(), 4);
  const measured = s.counts.slice(baseline);
  const publicationWrites = measured.reduce((n, c) => n + c.writes, 0);
  await s.pass(s.check);
  const finalBaseline = s.counts.length;
  await publisher.final(root);
  const allPublication = measured.concat(s.counts.slice(finalBaseline));
  const signingBaseline = s.counts.length;
  assert.equal(count(), 8);
  const targets = JSON.parse(
    await invoke('batchDownloads', read.downloads, {
      ...s.identity,
      entries: retained.map(({ chunk }) => ({
        streamId: outputStreamId(chunk.stream),
        sequence: chunk.sequence,
      })),
    }),
  );
  assert.equal(count(), 9);
  assert.equal(targets.length, 32);
  for (let i = 0; i < targets.length; i++) assert.deepEqual(targets[i].object, retained[i].chunk.object);
  assert.equal((await s.manifest()).complete, true);
  assert.equal(s.tables.projectHostedOutputChunks.size, 32);
  t.diagnostic(
    JSON.stringify({
      beforePublicationCalls: 128,
      afterChunkAndSealCalls: 4,
      afterPublicationIncludingFinal: 8,
      viewerSigningCalls: 1,
      documents: allPublication.reduce((n, c) => n + c.documents, 0),
      writes: allPublication.reduce((n, c) => n + c.writes, 0),
      chunkWindowDocuments: measured.reduce((n, c) => n + c.documents, 0),
      chunkWindowWrites: publicationWrites,
      viewerSigningDocuments: s.counts
        .slice(signingBaseline)
        .filter(c => c.name === 'batchDownloads')
        .reduce((n, c) => n + c.documents, 0),
      bufferedBytes: bytes.length,
      rssBytes: process.memoryUsage().rss,
      wallMs: Math.round(performance.now() - start),
    }),
  );
});

test('batch replay preserves every ordered receipt after a lost ack and rejects changed payloads', async t => {
  const { s, transport } = await setup(t),
    publisher = hostedOutputPublisher(s.check, key, transport);
  const chunks = ['one', 'two'].map((value, sequence) => ({
    chunk: { stream: s.stream, sequence, offset: sequence * 3, object: { sha256: digest(value), size: 3 } },
    bytes: Buffer.from(value),
  }));
  const commit = transport.commitBatch;
  let lost = true;
  transport.commitBatch = async entries => {
    const receipts = await commit(entries);
    if (lost) {
      lost = false;
      throw Error('lost batch reply');
    }
    return receipts;
  };
  await assert.rejects(publisher.publishBatch(chunks), /lost batch reply/);
  const replay = await publisher.publishBatch(chunks);
  assert.deepEqual(
    replay.map(({ duplicate, revision }) => ({ duplicate, revision })),
    [
      { duplicate: true, revision: 1 },
      { duplicate: true, revision: 2 },
    ],
  );
  assert.equal(s.tables.projectHostedOutputChunks.size, 2);
  const changed = structuredClone(chunks);
  changed[1].bytes = Buffer.from('bad');
  changed[1].chunk.object.sha256 = digest('bad');
  await assert.rejects(publisher.publishBatch(changed), code('WORK_OPERATION_CHANGED'));
  assert.equal(s.tables.projectHostedOutputChunks.size, 2);
  assert.deepEqual(replay.at(-1).root, (await s.manifest()).root);
  const seal = { stream: s.stream, chunks: 2, bytes: 6, sha256: digest('onetwo') };
  await publisher.publishBatch([], seal);
  const [duplicateSeal] = await publisher.publishBatch([], seal);
  assert(duplicateSeal.duplicate);
  assert.deepEqual(duplicateSeal.root, (await s.manifest()).root);
  await s.pass(s.check);
  await publisher.final(duplicateSeal.root);
  assert.equal((await s.manifest()).complete, true, 'lost seal ack still provides the final collector root');
});

test('every batch boundary rejects revocation, foreign signatures, missing bytes and changed execution', async t => {
  const { s, transport, invoke, entriesArgs, setBeforeApply } = await setup(t);
  const bytes = Buffer.from('safe'),
    chunk = {
      stream: s.stream,
      sequence: 0,
      offset: 0,
      object: { sha256: digest(bytes), size: bytes.length },
    };
  const message = outputMessage(s.check, { kind: 'chunk', chunk }),
    entry = { message, signature: signOutput(message, key) };
  await assert.rejects(transport.commitBatch([entry]), code('R2_OBJECT_MISSING'));
  const [prepared] = await transport.prepareBatch([entry]);
  await transport.put(prepared.target.url, prepared.target.headers, bytes);
  setBeforeApply(() =>
    s.patch('hostedProjects', s.projectId, { sourceAuthority: { mode: 'server', epoch: 2 } }),
  );
  await assert.rejects(transport.commitBatch([entry]), code('SOURCE_AUTHORITY_CHANGED'));
  assert.equal(s.tables.projectHostedOutputChunks.size, 0);
  s.patch('hostedProjects', s.projectId, { sourceAuthority: { mode: 'server', epoch: 1 } });
  setBeforeApply(null);
  for (const entries of [
    [],
    Array(101).fill(entry),
    [{ ...entry, signature: 'forged' }],
    [
      {
        message: { ...message, executionId: 'foreign' },
        signature: signOutput({ ...message, executionId: 'foreign' }, key),
      },
    ],
  ])
    await assert.rejects(transport.prepareBatch(entries));
  await transport.commitBatch([entry]);
  // A later invalid item aborts the whole apply transaction; no partial receipt.
  const next = { ...chunk, sequence: 1, offset: 999 },
    nextMessage = outputMessage(s.check, { kind: 'chunk', chunk: next });
  await assert.rejects(
    invoke(
      'batchApplyAtomic',
      batch.apply,
      entriesArgs([entry, { message: nextMessage, signature: signOutput(nextMessage, key) }]),
    ),
  );
  assert.equal(s.tables.projectHostedOutputChunks.size, 1);
  await assert.rejects(
    s.transaction(
      'batchSignRevoked',
      read.downloads,
      { ...s.identity, entries: [{ streamId: outputStreamId(s.stream), sequence: 0 }] },
      'stranger',
    ),
    code('PROJECT_UNAVAILABLE'),
  );
});

test('single-record reference path measures 128 chunk calls and 135 including seal and final', async t => {
  const { s, transport, count } = await setup(t);
  const publisher = hostedOutputPublisher(s.check, key, {
    prepare: transport.prepare,
    commit: transport.commit,
    put: transport.put,
  });
  const sink = publisher.sink(async () => {});
  let seal;
  await collectHostedOutput(
    (async function* () {
      yield Buffer.alloc(2 * 1024 * 1024, 65);
    })(),
    s.stream,
    { secrets: [], paths: [] },
    {
      ...sink,
      seal: async value => {
        seal = value;
      },
    },
  );
  assert.equal(count(), 128);
  await sink.seal(seal);
  await s.pass(s.check);
  await publisher.final((await s.manifest()).root);
  assert.equal(count(), 135);
  t.diagnostic(JSON.stringify({ measuredBeforeChunkCalls: 128, measuredBeforeWithSealAndFinal: 135 }));
});
