// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID, createHash } from 'node:crypto';
import { outputFixture, store, read, api, key } from './hosted-output-fixture.mjs';
import { code } from './hosted-checks-fixture.mjs';
import {
  outputMessage,
  outputStreamId,
  outputRootObject,
  outputKey,
  signOutput,
  outputMessageSchema,
} from '../dist/hosted-check-output.js';
const pin = value => ({
  sha256: createHash('sha256').update(value).digest('hex'),
  size: Buffer.byteLength(value),
});
const chunk = (s, sequence, text, offset = sequence, stream = s.stream) => ({
  kind: 'chunk',
  chunk: { stream, sequence, offset, object: pin(text) },
});
const seal = (s, chunks, text, stream = s.stream) => ({
  kind: 'seal',
  seal: { stream, chunks, bytes: Buffer.byteLength(text), sha256: pin(text).sha256 },
});
const rows = s => s.tables.projectHostedOutputChunks.size;

test('out-of-order/duplicate chunks reconcile; gaps and offset conflicts cannot seal', async () => {
  const s = await outputFixture();
  await s.apply(chunk(s, 2, 'c'));
  await s.apply(chunk(s, 0, 'a'));
  const duplicate = await s.apply(chunk(s, 2, 'c'));
  assert.equal(duplicate.duplicate, true);
  await assert.rejects(s.apply(chunk(s, 2, 'x')), code('WORK_OPERATION_CHANGED'));
  await assert.rejects(s.apply(seal(s, 3, 'abc')), code('EVIDENCE_CHANGED'));
  await assert.rejects(s.apply(chunk(s, 1, 'b', 8)), code('EVIDENCE_CHANGED'));
  await s.apply(chunk(s, 1, 'b'));
  await s.apply(seal(s, 3, 'abc'));
  assert.equal((await s.apply(seal(s, 3, 'abc'))).duplicate, true);
  await assert.rejects(s.apply(seal(s, 3, 'abd')), code('WORK_OPERATION_CHANGED'));
  await assert.rejects(s.apply(chunk(s, 3, 'd')), code('EVIDENCE_CHANGED'));
  assert.equal(rows(s), 3);
  const page = await s.chunks();
  assert.deepEqual(
    page.page.map(r => r.chunk.sequence),
    [2, 0, 1],
  );
  assert.deepEqual((await s.chunks(page.after)).page, []);
});

test('concurrent uploads retain one record per sequence and monotonic revisions', async () => {
  const s = await outputFixture();
  await Promise.all([s.apply(chunk(s, 0, 'a')), s.apply(chunk(s, 0, 'a')), s.apply(chunk(s, 1, 'b'))]);
  assert.equal(rows(s), 2);
  assert.deepEqual(
    (await s.chunks()).page.map(r => r.revision),
    [1, 2],
  );
  assert.equal((await s.manifest()).root.bytes, 2);
});

test('final manifest requires a terminal check, sealed streams, exact immutable root and complete indexes', async () => {
  const s = await outputFixture();
  await s.apply(chunk(s, 0, 'a'));
  let root = (await s.manifest()).root;
  await assert.rejects(s.apply({ kind: 'final', root }), code('EVIDENCE_CHANGED'));
  await s.pass(s.check);
  await assert.rejects(s.apply({ kind: 'final', root }), code('EVIDENCE_CHANGED'));
  await s.apply(seal(s, 1, 'a'));
  root = (await s.manifest()).root;
  await assert.rejects(s.apply({ kind: 'final', root: { ...root, chunks: 0 } }), code('EVIDENCE_CHANGED'));
  await s.apply({ kind: 'final', root });
  assert.equal((await s.manifest()).complete, true);
  assert.equal((await s.apply({ kind: 'final', root })).duplicate, true);
  await assert.rejects(
    s.apply(chunk(s, 0, 'z', 0, { ...s.stream, stream: 'stderr' })),
    code('EVIDENCE_CHANGED'),
  );
  assert.equal((await s.apply(chunk(s, 0, 'a'))).duplicate, true);
  const result = await s.run('outputComplete', read.completeOutputManifest, s.identity);
  assert.deepEqual(result.object, outputRootObject(root));
});

test('separate shard attempts, stdout/stderr, binary artifacts and empty streams remain retained', async () => {
  const s = await outputFixture();
  const descriptors = [
    s.stream,
    { ...s.stream, stream: 'stderr' },
    { ...s.stream, attempt: 1, executionId: 'synthetic-retry' },
    { ...s.stream, stream: 'artifact', name: 'reports/results.bin' },
  ];
  for (const stream of descriptors) {
    await s.apply(chunk(s, 0, '\0\u0001', 0, stream));
    await s.apply(seal(s, 1, '\0\u0001', stream));
  }
  await s.apply(seal(s, 0, '', { ...s.stream, shard: 1 }));
  assert.equal((await s.streams()).page.length, 5);
  const root = (await s.manifest()).root;
  assert.equal(root.streams, 5);
  assert.equal(root.bytes, 8);
  assert.equal((await s.manifest()).sealed, 5);
});

test('signed metadata is fenced to current project, actor, execution, source, plan and epoch, including retries', async () => {
  const s = await outputFixture();
  const body = chunk(s, 0, 'a');
  for (const overrides of [
    { projectId: 'foreign' },
    { runId: randomUUID() },
    { operationId: randomUUID() },
    { executionId: 'foreign' },
    { head: 'f'.repeat(64) },
    { planDigest: 'f'.repeat(64) },
    { fence: 99 },
    { authorityEpoch: 2 },
  ])
    await assert.rejects(s.apply(body, overrides));
  await assert.rejects(s.apply(body, {}, 'f'.repeat(64)), code('EVIDENCE_CHANGED'));
  await assert.rejects(s.apply(chunk(s, 0, 'a', 0, { ...s.stream, shard: 2 })), code('EVIDENCE_CHANGED'));
  await s.apply(body);
  s.patch('hostedProjects', s.projectId, { sourceAuthority: { mode: 'server', epoch: 2 } });
  await assert.rejects(s.apply(body));
  s.patch('hostedProjects', s.projectId, {
    sourceAuthority: { mode: 'server', epoch: 1 },
    removal: 'deleting',
  });
  await assert.rejects(s.apply(body), code('PROJECT_UNAVAILABLE'));
});

test('revoked contributors cannot publish a fresh or duplicate chunk', async () => {
  const s = await outputFixture();
  const grant = s.insert('projectContributors', { projectId: s.projectId, contributor: 'collector-actor' });
  const row = [...s.tables.projectHostedCheckRuns.values()].find(row => row.runId === s.check.id);
  const run = JSON.parse(row.value);
  run.actor = 'collector-actor';
  s.patch('projectHostedCheckRuns', row._id, { value: JSON.stringify(run) });
  await s.apply(chunk(s, 0, 'a'));
  s.tables.projectContributors.delete(grant);
  await assert.rejects(s.apply(chunk(s, 0, 'a')), code('PROJECT_UNAVAILABLE'));
  await assert.rejects(s.apply(chunk(s, 1, 'b')), code('PROJECT_UNAVAILABLE'));
});

test('metadata, pages and download signing recheck current reader access; public anonymous reads stay available', async () => {
  const s = await outputFixture();
  await s.apply(chunk(s, 0, 'a'));
  const grant = s.insert('projectReaders', { projectId: s.projectId, reader: 'reader' });
  assert.equal((await s.manifest('reader')).root.chunks, 1);
  assert.equal((await s.chunks(0, 'reader')).page.length, 1);
  assert.equal((await s.streams(null, 'reader')).page.length, 1);
  s.tables.projectReaders.delete(grant);
  for (const invoke of [
    () => s.manifest('reader'),
    () => s.chunks(0, 'reader'),
    () => s.streams(null, 'reader'),
  ])
    await assert.rejects(invoke(), code('PROJECT_UNAVAILABLE'));
  await assert.rejects(
    s.call(
      'outputDownload',
      read.download,
      { ...s.identity, streamId: outputStreamId(s.stream), sequence: 0 },
      'reader',
    ),
    code('PROJECT_UNAVAILABLE'),
  );
  await assert.rejects(s.manifest(null), code('PROJECT_UNAVAILABLE'));
  s.patch('hostedProjects', s.projectId, { visibility: 'public' });
  assert.equal((await s.manifest(null)).root.chunks, 1);
});

test('large history and late readers page only new metadata; no viewers cause no scheduled work', async t => {
  const s = await outputFixture();
  for (let i = 0; i < 10050; i++)
    s.insert('projectHostedOutputChunks', {
      projectId: 'unrelated',
      runId: randomUUID(),
      streamId: 'x',
      sequence: i,
      revision: i,
      value: '{}',
    });
  for (let i = 0; i < 105; i++) await s.apply(chunk(s, i, 'x'));
  const first = await s.chunks();
  const second = await s.chunks(first.after);
  const third = await s.chunks(second.after);
  assert.deepEqual([first.page.length, second.page.length, third.page.length], [50, 50, 5]);
  assert.equal(third.more, false);
  await s.apply(seal(s, 105, 'x'.repeat(105)));
  assert.deepEqual((await s.chunks(third.after)).page, []);
  await s.apply(chunk(s, 0, 'later', 0, { ...s.stream, stream: 'stderr' }));
  const later = await s.chunks(third.after);
  assert.equal(later.page.length, 1);
  assert.equal(later.page[0].chunk.object.size, 5);
  const maxima = { ranges: 0, documents: 0, readBytes: 0, writes: 0, writeBytes: 0 };
  for (const meter of s.counts.filter(m => m.name.startsWith('output'))) {
    for (const field of Object.keys(maxima)) maxima[field] = Math.max(maxima[field], meter[field]);
    assert(
      !meter.touched.some(t =>
        [
          'projectWorkRecords',
          'projectBackups',
          'projectHostedChannels',
          'projectHostedCheckShards',
        ].includes(t),
      ),
    );
  }
  t.diagnostic(
    JSON.stringify({
      maxima,
      processRss: process.memoryUsage().rss,
      maxRssKiB: process.resourceUsage().maxRSS,
    }),
  );
});

test('strict protocol rejects stdout/artifact byte bodies and checksum identity is provider neutral', () => {
  const body = {
    schema: 1,
    projectId: 'p',
    runId: randomUUID(),
    operationId: randomUUID(),
    authorityEpoch: 1,
    fence: 1,
    executionId: 'github-actions/123',
    head: 'a'.repeat(64),
    planDigest: 'b'.repeat(64),
    body: {
      kind: 'final',
      root: {
        schema: 1,
        runId: randomUUID(),
        executionId: 'actions',
        revision: 0,
        chain: 'a'.repeat(64),
        streams: 0,
        chunks: 0,
        bytes: 0,
      },
    },
  };
  assert(outputMessageSchema.safeParse(body).success);
  assert(!outputMessageSchema.safeParse({ ...body, stdout: 'secret' }).success);
  assert(!outputMessageSchema.safeParse({ ...body, body: { ...body.body, artifact: 'bytes' } }).success);
});

test('verified transfer uses exact namespace and rejects missing, failed, size or checksum mismatched HEADs', async () => {
  const s = await outputFixture();
  const message = outputMessage(s.check, chunk(s, 0, 'a'));
  const calls = [];
  const verify = result =>
    api.verifyOutputObject(s.projectId, message, {}, async (_config, objectKey) => {
      calls.push(objectKey);
      return result;
    });
  await assert.rejects(verify({ status: 'missing' }), code('R2_OBJECT_MISSING'));
  await assert.rejects(
    verify({ status: 'error', detail: 'synthetic unavailable' }),
    code('R2_VERIFY_FAILED'),
  );
  await assert.rejects(verify({ status: 'ok', size: 2, checksum: null }), code('R2_OBJECT_SIZE_MISMATCH'));
  await assert.rejects(
    verify({ status: 'ok', size: 1, checksum: 'wrong' }),
    code('R2_OBJECT_CHECKSUM_MISMATCH'),
  );
  await verify({
    status: 'ok',
    size: 1,
    checksum: Buffer.from(message.body.chunk.object.sha256, 'hex').toString('base64'),
  });
  assert(calls.every(key => key === outputKey(s.projectId, s.check.id, message.body.chunk.object)));
  assert.equal(rows(s), 0, 'verification alone never publishes metadata');
});
