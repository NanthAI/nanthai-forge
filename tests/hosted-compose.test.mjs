// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { composeFixture, api, jobApi, code, maxima } from './hosted-compose-fixture.mjs';
import { saveBytes } from '../dist/hosted-save.js';
const selected = async s =>
  s.selection([await s.lane(s.state([s.file('a.txt', 'A\nb\nc\n'), s.hidden], [s.baseline.sha256]))]);
test('ordered multi-Lane compose publishes one clean immutable Candidate and leaves Lane/main untouched', async () => {
  const s = await composeFixture(),
    a = await s.lane(s.state([s.file('a.txt', 'A\nb\nc\n'), s.hidden], [s.baseline.sha256])),
    b = await s.lane(s.state([s.file('a.txt', 'a\nb\nC\n'), s.hidden], [s.baseline.sha256]));
  const x = s.selection([a, b]);
  await s.prepare(x);
  await s.stage(x);
  const beforeLanes = JSON.stringify(
    [...s.tables.projectHostedRecordHeads.values()].filter(r => r.kind === 'lane'),
  );
  const first = await s.submit(x),
    duplicate = await s.submit(x);
  assert.deepEqual(first, duplicate);
  const output = await s.work(x),
    terminal = await s.publish(output),
    candidate = terminal.outcome.result;
  assert.equal(candidate.result.status, 'clean');
  assert.deepEqual(candidate.base, x.request.expectedMain);
  assert.equal(candidate.algorithm, `forge-native-compose-v1@${'a'.repeat(64)}`);
  const state = JSON.parse(s.objects.get(candidate.result.head));
  assert.equal(s.objects.get(state.files.find(f => f.path === 'a.txt').blob).toString(), 'A\nb\nC\n');
  assert.equal(
    JSON.stringify([...s.tables.projectHostedRecordHeads.values()].filter(r => r.kind === 'lane')),
    beforeLanes,
  );
  assert(!output.reads.some(p => p.sha256 === s.hidden.blob));
  assert(s.scheduled.some(t => t.name === 'projectHostedComposeJobs:complete'));
  assert.deepEqual(
    JSON.parse(
      await s.call('candidate', api.candidate, { projectId: s.projectId, candidateId: candidate.id }),
    ),
    candidate,
  );
  assert.equal(s.tables.projectHostedStates.size, 4);
  s.moveMain();
  await s.advance(a);
  s.patch('hostedProjects', s.projectId, { sourceAuthority: { mode: 'server', epoch: 2 } });
  assert.deepEqual(await s.publish(output), terminal);
  assert.deepEqual(await s.submit(x), terminal);
  assert.deepEqual((await s.prepare(x)).terminal, terminal);
  assert.equal(s.tables.projectHostedRecordHeads.size, 5);
});
test('stale main ABA and stale/foreign Lane selections fail without a Candidate', async () => {
  const s = await composeFixture(),
    x = await selected(s);
  s.moveMain();
  await assert.rejects(s.prepare(x), code('CHANNEL_CHANGED'));
  s.moveMain(s.main.head, 'main-0');
  await s.prepare(x);
  await s.advance(x.pages.inputs[0].value.entries[0]);
  await assert.rejects(s.stage(x), code('WORK_STALE'));
  const foreign = await s.lane(s.baseline, { intentId: randomUUID() }),
    y = s.selection([foreign]);
  await s.prepare(y);
  await assert.rejects(s.stage(y), code('WORK_STALE'));
  assert(![...s.tables.projectHostedRecordHeads.values()].some(r => r.kind === 'candidate'));
});
test('staged exact old heads remain immutable when Lane or main advances during computation', async () => {
  const s = await composeFixture(),
    x = await selected(s);
  await s.prepare(x);
  await s.stage(x);
  await s.submit(x);
  await s.advance(x.pages.inputs[0].value.entries[0]);
  s.moveMain();
  const output = await s.work(x),
    result = (await s.publish(output)).outcome.result;
  assert.deepEqual(result.base, x.request.expectedMain);
  assert.deepEqual(JSON.parse(s.objects.get(result.inputs.sha256)).entries, x.pages.inputs[0].value.entries);
});
test('changed requests/pages, duplicate Lane entries and unregistered uploaded States are rejected', async () => {
  const s = await composeFixture(),
    x = await selected(s);
  await s.prepare(x);
  await assert.rejects(
    s.prepare({ ...x, request: { ...x.request, message: 'changed' } }),
    code('WORK_OPERATION_CHANGED'),
  );
  await s.stage(x);
  const old = x.pages.inputs[0].value;
  await assert.rejects(
    s.call('composeStage', api.stage, {
      projectId: s.projectId,
      operationId: x.request.operationId,
      kind: 'inputs',
      index: 0,
      page: JSON.stringify({ ...old, entries: [] }),
    }),
    code('WORK_OPERATION_CHANGED'),
  );
  const duplicate = s.selection([...old.entries, ...old.entries]);
  await s.prepare(duplicate);
  await assert.rejects(s.stage(duplicate), code('BAD_ARGUMENT'));
  const pin = s.state([s.file('unregistered', 'bytes')], [s.baseline.sha256]),
    lane = await s.lane(pin);
  for (const [id, row] of s.tables.projectHostedStates)
    if (row.head === pin.sha256) s.tables.projectHostedStates.delete(id);
  const y = s.selection([lane]);
  await s.prepare(y);
  await assert.rejects(s.stage(y), code('SOURCE_UNAVAILABLE'));
});
test('unsigned/forged output and wrong input cannot publish source or Candidate', async () => {
  const s = await composeFixture(),
    x = await selected(s);
  await s.prepare(x);
  await s.stage(x);
  const submitted = await s.submit(x);
  await assert.rejects(s.publish({ jobId: submitted.jobId, manifest: '{}' }), code('SOURCE_JOB_INVALID'));
  const output = await s.work(x);
  await assert.rejects(
    s.publish({ ...output, manifest: output.manifest + ' ' }),
    code('SOURCE_HASH_MISMATCH'),
  );
  assert.equal([...s.tables.projectHostedRecordHeads.values()].filter(r => r.kind === 'candidate').length, 0);
  await s.publish(output);
});
test('current authorization and epoch apply at preparation, staging, callback and publication', async () => {
  const s = await composeFixture(),
    x = await selected(s);
  await s.prepare(x);
  await assert.rejects(
    s.call(
      'composeProgress',
      api.progress,
      { projectId: s.projectId, operationId: x.request.operationId },
      null,
    ),
    code('PROJECT_UNAVAILABLE'),
  );
  await assert.rejects(
    s.call(
      'composeProgress',
      api.progress,
      { projectId: s.projectId, operationId: x.request.operationId },
      'stranger',
    ),
    code('PROJECT_UNAVAILABLE'),
  );
  await s.stage(x);
  await s.submit(x);
  const output = await s.work(x);
  s.patch('hostedProjects', s.projectId, { sourceAuthority: { mode: 'server', epoch: 2 } });
  await assert.rejects(s.publish(output), code('SOURCE_AUTHORITY_CHANGED'));
  s.patch('hostedProjects', s.projectId, { sourceAuthority: { mode: 'server', epoch: 1 }, removal: 'trash' });
  await assert.rejects(s.publish(output), code('PROJECT_UNAVAILABLE'));
});
test('dependencies compose first and repeated pins retain native semantics', async () => {
  const s = await composeFixture(),
    x = await selected(s);
  await s.prepare(x);
  await s.stage(x);
  await s.submit(x);
  const dep = (await s.publish(await s.work(x))).outcome.result;
  const pin = { sha256: dep.result.head, size: s.objects.get(dep.result.head).length };
  const b = await s.lane(s.state([s.file('a.txt', 'a\nb\nC\n'), s.hidden], [s.baseline.sha256]));
  const y = s.selection(
    [b],
    [
      ...Array.from({ length: 2 }, () => ({
        candidateId: dep.id,
        head: pin.sha256,
        state: { object: pin, recipe: null },
      })),
    ],
  );
  await s.prepare(y);
  await s.stage(y);
  await s.submit(y);
  const out = (await s.publish(await s.work(y))).outcome.result;
  const state = JSON.parse(s.objects.get(out.result.head));
  assert.equal(s.objects.get(state.files[0].blob).toString(), 'A\nb\nC\n');
  assert.deepEqual(JSON.parse(s.objects.get(out.dependencies.sha256)).entries[0].candidateId, dep.id);
});
test('250 inputs page validation and constant publication stay bounded with unrelated retained history', async t => {
  const s = await composeFixture(),
    entries = [];
  for (let i = 0; i < 250; i++) entries.push(await s.lane(s.baseline));
  for (let i = 0; i < 10050; i++)
    s.insert('projectHostedRecordHeads', {
      projectId: s.projectId,
      kind: 'lane',
      key: randomUUID(),
      parent: randomUUID(),
      status: 'completed',
      version: 99,
      recordId: `unused-${i}`,
    });
  const x = s.selection(entries);
  assert.deepEqual(
    x.pages.inputs.map(p => p.value.entries.length),
    [100, 100, 50],
  );
  await s.prepare(x);
  await s.stage(x);
  await s.submit(x);
  const output = await s.work(x);
  await s.publish(output);
  assert.equal(output.metrics.selected, 250);
  assert(!output.reads.some(p => p.sha256 === s.hidden.blob));
  assert(s.counts.filter(c => c.name === 'composePublish').every(c => c.documents < 40));
  t.diagnostic(JSON.stringify({ metrics: output.metrics, maxima }));
});

test('signed wrong-plan results cannot forge ancestry authority; failed jobs retain a terminal original operation', async () => {
  const s = await composeFixture(),
    x = await selected(s);
  await s.prepare(x);
  await s.stage(x);
  const submitted = await s.submit(x);
  const output = await s.compute((await s.progress(x)).input),
    wrong = JSON.parse(output.manifest);
  wrong.input = { sha256: 'f'.repeat(64), size: 5 };
  const manifest = Buffer.from(saveBytes(wrong)),
    pin = s.put(manifest),
    job = await s.activate(submitted.jobId);
  await s.callback(job, { status: 'completed', output: pin });
  await assert.rejects(
    s.publish({ jobId: job.id, manifest: manifest.toString() }),
    code('SOURCE_JOB_INVALID'),
  );
  const y = await selected(s);
  await s.prepare(y);
  await s.stage(y);
  const second = await s.submit(y),
    failed = await s.activate(second.jobId);
  await s.callback(failed, { status: 'failed', code: 'SOURCE_HASH_MISMATCH' });
  assert.equal(
    await s.call('resultDownload', jobApi.resultDownload, { projectId: s.projectId, jobId: failed.id }),
    null,
  );
  const terminal = (await s.progress(y)).terminal;
  assert.equal(terminal.outcome.status, 'failed');
  assert.equal(terminal.outcome.error.code, 'SOURCE_HASH_MISMATCH');
  assert.deepEqual(await s.submit(y), terminal);
  assert.equal([...s.tables.projectHostedRecordHeads.values()].filter(r => r.kind === 'candidate').length, 0);
});

test('concurrent original-operation delivery commits one preparation, job and Candidate', async () => {
  const s = await composeFixture(),
    x = await selected(s);
  const prepared = await Promise.all([s.prepare(x), s.prepare(x)]);
  assert.deepEqual(prepared[0], prepared[1]);
  await s.stage(x);
  const jobs = await Promise.all([s.submit(x), s.submit(x)]);
  assert.deepEqual(jobs[0], jobs[1]);
  const output = await s.work(x),
    published = await Promise.all([s.publish(output), s.publish(output)]);
  assert.deepEqual(published[0], published[1]);
  assert.equal(s.tables.projectHostedComposes.size, 1);
  assert.equal([...s.tables.projectHostedRecordHeads.values()].filter(r => r.kind === 'candidate').length, 1);
  assert.equal([...s.tables.projectHostedRecordHeads.values()].filter(r => r.kind === 'job').length, 1);
  assert(
    s.counts.some(c => c.retries > 0),
    'fake exercises OCC reconciliation',
  );
});
test('same-position independent additions preserve exact declared Lane order', async () => {
  const s = await composeFixture(),
    base = s.state([s.file('a.txt', 'a\nz\n'), s.hidden]);
  s.moveMain(base.sha256, 'main-0');
  s.register(base);
  const a = await s.lane(s.state([s.file('a.txt', 'a\nleft\nz\n'), s.hidden], [base.sha256])),
    b = await s.lane(s.state([s.file('a.txt', 'a\nright\nz\n'), s.hidden], [base.sha256]));
  const heads = [];
  for (const inputs of [
    [a, b],
    [b, a],
  ]) {
    const x = s.selection(inputs, [], { expectedMain: { head: base.sha256, receiptId: 'main-0' } });
    await s.prepare(x);
    await s.stage(x);
    await s.submit(x);
    const candidate = (await s.publish(await s.work(x))).outcome.result,
      state = JSON.parse(s.objects.get(candidate.result.head));
    heads.push(s.objects.get(state.files[0].blob).toString());
  }
  assert.deepEqual(heads, ['a\nleft\nright\nz\n', 'a\nright\nleft\nz\n']);
});
