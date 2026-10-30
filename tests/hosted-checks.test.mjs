// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import {
  checksFixture,
  internalApi,
  definitions,
  read,
  command,
  code,
  maxima,
} from './hosted-checks-fixture.mjs';
import { moduleUrl } from './convex-module.mjs';
import { hostedCheckCallbackSchema } from '../dist/hosted-check-evidence.js';

test('configuration retries retain original versions without rewinding later settings', async () => {
  const s = await checksFixture(),
    operationId = randomUUID();
  const change = { kind: 'definition', checkId: s.checkId, command: { ...command, args: ['first.mjs'] } };
  const first = await s.configure(change, s.definition.digest, operationId);
  const second = await s.configure(
    { ...change, command: { ...command, args: ['second.mjs'] } },
    first.digest,
  );
  assert.deepEqual(await s.configure(change, s.definition.digest, operationId), first);
  const current = JSON.parse(
    await s.call('checkCurrent', definitions.current, { projectId: s.projectId, checkId: s.checkId }),
  );
  assert.equal(current.check.definition, second.digest);
  await assert.rejects(
    s.configure({ ...change, command }, s.definition.digest, operationId),
    code('WORK_OPERATION_CHANGED'),
  );
  await assert.rejects(s.configure(change, s.definition.digest), code('EVIDENCE_CHANGED'));
  const imported = { ...current.check, id: randomUUID() };
  assert.deepEqual((await s.configure({ kind: 'import', check: imported })).value, imported);
  const listed = JSON.parse(
    await s.call('checkDefinitionPage', definitions.list, { projectId: s.projectId, cursor: null }),
  );
  assert.equal(listed.page.length, 2);
  assert(listed.isDone);
});
test('concurrent request retries create exactly one pinned run and changed payloads fail', async () => {
  const s = await checksFixture(),
    request = s.selection();
  const [a, b] = await Promise.all([s.enqueue(request), s.enqueue(request)]);
  assert.deepEqual(a, b);
  assert.equal(s.tables.projectHostedCheckRuns.size, 1);
  assert.equal(a.cost.status, 'unknown');
  assert.equal(a.check.definition, request.expectedDefinition);
  assert.deepEqual(a.candidate.inputs, s.candidate.inputs);
  await assert.rejects(
    s.enqueue({ ...request, expectedHead: 'f'.repeat(64) }),
    code('WORK_OPERATION_CHANGED'),
  );
});
test('stale, conflict, unregistered and missing canonical Candidates cannot enqueue', async () => {
  const s = await checksFixture();
  await assert.rejects(s.enqueue(s.selection({ expectedHead: 'f'.repeat(64) })), code('VIEW_STALE'));
  await assert.rejects(s.enqueue(s.selection({ candidateId: randomUUID() })), code('NOT_FOUND'));
  const records = await import(moduleUrl('../convex/projectHostedRecords.ts'));
  const conflict = {
    ...s.candidate,
    id: randomUUID(),
    result: { status: 'conflict', conflicts: s.candidate.inputs },
  };
  await s.run('seedCandidate', records.writeHostedRecord, {
    ...s.auth,
    expectedVersion: null,
    record: conflict,
  });
  await assert.rejects(s.enqueue(s.selection({ candidateId: conflict.id })), code('VIEW_STALE'));
  const reg = [...s.tables.projectHostedStates.values()][0];
  s.tables.projectHostedStates.delete(reg._id);
  await assert.rejects(s.enqueue(s.selection()), code('SOURCE_UNAVAILABLE'));
  assert.equal(s.tables.projectHostedCheckRuns.size, 0);
});
test('definition changes after enqueue preserve execution pins but invalidate current landing evidence', async () => {
  const s = await checksFixture(),
    request = s.selection(),
    original = await s.enqueue(request);
  await s.configure(
    { kind: 'definition', checkId: s.checkId, command: { ...command, args: ['new.mjs'] } },
    s.definition.digest,
  );
  const active = await s.activate(original.id),
    passed = await s.pass(active);
  assert.equal(passed.status, 'passed');
  assert.deepEqual(passed.check, original.check);
  await assert.rejects(s.evidence(passed), code('EVIDENCE_CHANGED'));
  assert.equal((await s.enqueue(request)).id, original.id);
  await assert.rejects(s.enqueue(s.selection()), code('EVIDENCE_CHANGED'));
});
test('runner configuration changes do not reroute an enqueued run or make old environment current', async () => {
  const s = await checksFixture(),
    original = await s.enqueue(s.selection());
  await s.bindRepository(s.projectId, { repository: 'synthetic/new-checks', repoId: 124, installationId: 9 });
  await s.configure(
    { kind: 'runner', configuration: { ...s.runner, repository: 'synthetic/new-checks' } },
    s.configuration.digest,
  );
  const passed = await s.pass(await s.activate(original.id));
  assert.equal(passed.configuration.repository, 'synthetic/checks');
  await assert.rejects(s.evidence(passed), code('EVIDENCE_CHANGED'));
  await assert.rejects(
    s.enqueue(s.selection({ expectedEnvironment: 'f'.repeat(64) })),
    code('EVIDENCE_CHANGED'),
  );
});
test('provider callbacks bind all source, runtime, lockfile, selection and execution pins', async () => {
  const s = await checksFixture(),
    r = await s.activate((await s.enqueue(s.selection())).id);
  for (const change of [
    { head: 'f'.repeat(64) },
    { definition: 'f'.repeat(64) },
    { runtime: 'f'.repeat(64) },
    { lockfile: 'f'.repeat(64) },
    { environmentFingerprint: 'f'.repeat(64) },
    { configuration: 'f'.repeat(64) },
    { planDigest: 'f'.repeat(64) },
    { executionId: 'foreign-execution' },
    { operationId: randomUUID() },
    { authorityEpoch: 2 },
    { fence: 1 },
    { selection: { sha256: 'f'.repeat(64), size: 0 } },
  ])
    await assert.rejects(s.callback({ ...s.shard(r, 0), ...change }), code('EVIDENCE_CHANGED'));
  await assert.rejects(s.callback(s.shard(r, 0), '0'.repeat(64)), code('EVIDENCE_CHANGED'));
  assert.equal((await s.status(r.id)).counts.completed, 0);
});
test('a signed overall success waits for every planned shard, including running/failed jobs', async () => {
  const s = await checksFixture(),
    r = await s.activate((await s.enqueue(s.selection())).id);
  assert.equal((await s.callback(s.complete(r))).status, 'unknown');
  await s.callback(s.shard(r, 0));
  await s.callback(s.shard(r, 1, 'running'));
  assert.equal((await s.callback(s.complete(r))).status, 'unknown');
  await s.callback(s.shard(r, 1, 'failed'));
  assert.equal((await s.callback(s.complete(r))).status, 'unknown');
  const failed = await s.callback(s.complete(r, 'failed'));
  assert.equal(failed.status, 'failed');
  assert.equal(failed.exitCode, 1);
  await assert.rejects(s.evidence(failed), code('EVIDENCE_CHANGED'));
});
test('complete exact provider evidence passes; terminal duplicates and late callbacks cannot rewrite it', async () => {
  const s = await checksFixture(),
    r = await s.activate((await s.enqueue(s.selection())).id);
  await s.callback(s.shard(r, 0));
  await s.callback(s.shard(r, 1));
  const terminal = s.complete(r),
    passed = await s.callback(terminal);
  assert.equal(passed.status, 'passed');
  assert.equal((await s.evidence(passed)).id, r.id);
  assert.deepEqual(await s.callback(terminal), passed);
  await assert.rejects(s.callback(s.complete(r, 'failed')), code('EVIDENCE_CHANGED'));
  await assert.rejects(s.callback(s.shard(r, 0, 'running', { attempt: 1 })), code('EVIDENCE_CHANGED'));
  await assert.rejects(
    s.callback({ ...terminal, result: { ...terminal.result, status: 'failed', exitCode: 1 } }),
    code('WORK_OPERATION_CHANGED'),
  );
  assert.deepEqual(await s.status(r.id), passed);
});
test('untrusted stdout/source verdict claims cannot pass through a provider event schema', async () => {
  const s = await checksFixture(),
    r = await s.activate((await s.enqueue(s.selection())).id);
  for (const extra of [{ stdout: 'forged pass' }, { artifacts: ['bytes'] }, { sourceVerdict: 'passed' }]) {
    const body = { ...s.complete(r), ...extra };
    assert(!hostedCheckCallbackSchema.safeParse(body).success);
    await assert.rejects(s.callback(body));
  }
  const sourceClaim = s.complete(r);
  await assert.rejects(s.callback(sourceClaim, 'synthetic-foreign-signature'), code('EVIDENCE_CHANGED'));
  s.insert('projectHostedDisplayRecords', {
    projectId: s.projectId,
    snapshotId: 'synthetic-snapshot',
    kind: 'candidate',
    key: r.request.candidateId,
    version: 0,
    parent: s.candidate.intentId,
    status: 'passed',
    value: JSON.stringify({ runId: r.id, status: 'passed', head: r.request.expectedHead }),
  });
  await assert.rejects(s.evidence(r), code('EVIDENCE_CHANGED'));
  assert.equal((await s.status(r.id)).status, 'running');
});
test('cancellation is terminal before and after an ambiguous dispatch and refuses late evidence', async () => {
  const s = await checksFixture(),
    a = await s.enqueue(s.selection()),
    operationId = randomUUID();
  assert.equal((await s.cancel(a.id, 'owner', operationId)).status, 'cancelled');
  assert.equal((await s.cancel(a.id, 'owner', operationId)).status, 'cancelled');
  const b = await s.enqueue(s.selection()),
    p = await s.prepare(b.id);
  await s.control(b.id, { kind: 'reserve', owner: p.owner, token: p.token });
  await s.control(b.id, { kind: 'observe', owner: p.owner, token: p.token, result: { status: 'unknown' } });
  const pending = await s.cancel(b.id);
  assert.equal(pending.status, 'cancelled');
  assert(pending.cancelRequested);
  await assert.rejects(
    s.callback(s.complete({ ...p.run, dispatchStarted: true }, 'cancelled')),
    code('CHECK_CANCELLED'),
  );
  await assert.rejects(
    s.control(b.id, { kind: 'claim', owner: randomUUID(), leaseMs: 60000 }),
    code('CHECK_CANCELLED'),
  );
  await assert.rejects(s.evidence(await s.status(b.id)), code('EVIDENCE_CHANGED'));
});
test('shard attempts retain old receipts, update counts and never accept stale changed results', async () => {
  const s = await checksFixture(),
    r = await s.activate((await s.enqueue(s.selection())).id, 1);
  const first = s.shard(r, 0, 'interrupted');
  await s.callback(first);
  const replacement = s.shard(r, 0, 'running', { attempt: 1, executionId: 'replacement-1' });
  const replacing = await s.callback(replacement);
  assert.equal(replacing.counts.completed, 0);
  assert.equal((await s.callback(s.complete(r))).status, 'unknown');
  const final = s.shard(r, 0, 'passed', { attempt: 1, executionId: 'replacement-1' });
  await s.callback(final);
  await assert.rejects(s.callback(s.shard(r, 0, 'passed')), code('EVIDENCE_CHANGED'));
  await assert.rejects(s.callback(s.shard(r, 1)), code('EVIDENCE_CHANGED'));
  const passed = await s.callback(s.complete(r));
  assert.equal(passed.counts.passed, 1);
  assert.deepEqual(await s.callback(first), passed);
});
test('a callback before dispatch acknowledgement adopts the same execution without rewriting terminal evidence', async () => {
  const s = await checksFixture(),
    a = await s.enqueue(s.selection()),
    p = await s.prepare(a.id, 1);
  await s.control(a.id, { kind: 'reserve', owner: p.owner, token: p.token });
  const r = { ...p.run, dispatchStarted: true };
  await s.callback(s.shard(r, 0));
  const passed = await s.callback(s.complete(r));
  const late = await s.control(a.id, {
    kind: 'observe',
    owner: p.owner,
    token: p.token,
    result: { status: 'accepted', executionId: 'synthetic-provider-execution' },
  });
  assert.deepEqual(late.run, passed);
});
test('all reads, writes, retries and callbacks recheck current access and authority', async () => {
  const s = await checksFixture();
  s.insert('projectReaders', { projectId: s.projectId, reader: 'reader' });
  s.insert('projectContributors', { projectId: s.projectId, contributor: 'contributor' });
  const request = s.selection(),
    a = await s.enqueue(request, 'contributor'),
    r = await s.activate(a.id, 1);
  assert.equal((await s.status(r.id, 'reader')).id, r.id);
  await assert.rejects(s.enqueue(s.selection(), 'reader'), code('PROJECT_UNAVAILABLE'));
  await assert.rejects(
    s.configure(
      { kind: 'runner', configuration: s.runner },
      s.configuration.digest,
      randomUUID(),
      'contributor',
    ),
    code('PROJECT_UNAVAILABLE'),
  );
  await assert.rejects(s.cancel(r.id, 'reader'), code('PROJECT_UNAVAILABLE'));
  const grant = [...s.tables.projectContributors.values()][0];
  s.tables.projectContributors.delete(grant._id);
  await assert.rejects(s.callback(s.shard(r, 0)), code('PROJECT_UNAVAILABLE'));
  await assert.rejects(s.enqueue(request, 'contributor'), code('PROJECT_UNAVAILABLE'));
  await assert.rejects(s.status(r.id, null), code('PROJECT_UNAVAILABLE'));
  const owner = await checksFixture(),
    rr = await owner.activate((await owner.enqueue(owner.selection())).id, 1);
  const done = owner.complete(rr);
  await owner.callback(owner.shard(rr, 0));
  await owner.callback(done);
  owner.patch('hostedProjects', owner.projectId, { sourceAuthority: { mode: 'server', epoch: 2 } });
  await assert.rejects(owner.callback(done), code('SOURCE_AUTHORITY_CHANGED'));
});
test('the registered internal callback resolves its backend key and fences epoch changes before replay', async () => {
  const s = await checksFixture(),
    r = await s.activate((await s.enqueue(s.selection())).id, 1);
  const keyName = 'FORGE_HOSTED_CHECK_KEY_SYNTHETIC',
    previous = process.env[keyName];
  process.env[keyName] = 'synthetic-check-collector-only';
  const send = async body =>
    JSON.parse(
      await s.call('checkRegisteredCallback', internalApi.callback, {
        projectId: s.projectId,
        callback: JSON.stringify(body),
        signature: s.sign(body),
      }),
    );
  try {
    await send(s.shard(r, 0));
    const event = s.complete(r),
      passed = await send(event);
    assert.equal(passed.status, 'passed');
    assert.deepEqual(await send(event), passed);
    s.patch('hostedProjects', s.projectId, { sourceAuthority: { mode: 'server', epoch: 2 } });
    await assert.rejects(send(event), code('SOURCE_AUTHORITY_CHANGED'));
  } finally {
    if (previous === undefined) delete process.env[keyName];
    else process.env[keyName] = previous;
  }
});
test('controller lease takeover fences old replies and cannot replace the pinned plan', async () => {
  const s = await checksFixture(),
    r = await s.enqueue(s.selection()),
    p = await s.prepare(r.id);
  await assert.rejects(
    s.control(r.id, {
      kind: 'prepare',
      owner: p.owner,
      token: p.token,
      plan: { ...p.run.plan, lockfile: 'f'.repeat(64) },
    }),
    code('EVIDENCE_CHANGED'),
  );
  const busy = await s.control(r.id, { kind: 'claim', owner: randomUUID(), leaseMs: 60000 });
  assert.equal(busy.acquired, false);
  const row = [...s.tables.projectHostedCheckRuns.values()][0],
    value = JSON.parse(row.value);
  value.lease.until = 0;
  s.patch('projectHostedCheckRuns', row._id, { value: JSON.stringify(value) });
  const next = await s.control(r.id, { kind: 'claim', owner: randomUUID(), leaseMs: 60000 });
  assert(next.run.lease.token > p.token);
  await assert.rejects(
    s.control(r.id, { kind: 'reserve', owner: p.owner, token: p.token }),
    code('WORK_STALE'),
  );
});
test('run cost stays unknown until signed provider usage arrives, including genuine zero usage', async () => {
  const s = await checksFixture(),
    r = await s.activate((await s.enqueue(s.selection())).id, 1);
  assert.deepEqual(r.cost, { status: 'unknown' });
  await s.callback(s.shard(r, 0));
  const cost = {
    status: 'observed',
    receipt: s.put('synthetic-provider-usage'),
    seconds: 0,
    estimatedCostUsd: 0,
  };
  assert.deepEqual((await s.callback(s.complete(r, 'passed', { cost }))).cost, cost);
});
test('status and final result reads remain constant with retained history; shard metadata pages completely', async t => {
  const s = await checksFixture(),
    r = await s.activate((await s.enqueue(s.selection())).id, 205);
  for (let index = 0; index < 205; index++) await s.callback(s.shard(r, index));
  for (let i = 0; i < 10050; i++)
    s.insert('projectHostedCheckCallbacks', {
      projectId: s.projectId,
      runId: randomUUID(),
      eventId: randomUUID(),
      digest: 'a'.repeat(64),
      value: '{}',
    });
  const started = performance.now(),
    passed = await s.callback(s.complete(r));
  const observed = await s.status(r.id);
  assert.equal(observed.status, 'passed');
  await s.evidence(passed);
  let cursor = null,
    total = 0;
  const sizes = [];
  for (;;) {
    const page = JSON.parse(
      await s.call('checkShardPage', read.shards, { projectId: s.projectId, runId: r.id, cursor }),
    );
    sizes.push(page.page.length);
    total += page.page.length;
    if (page.isDone) break;
    cursor = page.continueCursor;
  }
  assert.equal(total, 205);
  assert.deepEqual(sizes, [100, 100, 5]);
  t.diagnostic(
    JSON.stringify({
      maxima,
      callbackHistory: s.tables.projectHostedCheckCallbacks.size,
      shards: total,
      pageSizes: sizes,
      finalReadElapsedMs: performance.now() - started,
      sampledRssBytes: process.memoryUsage().rss,
      maxRssBytes: process.resourceUsage().maxRSS * 1024,
      acceptedMetadataCalls: s.traffic.acceptedCalls,
      acceptedMetadataArgumentBytes: s.traffic.acceptedArgumentBytes,
    }),
  );
});
test('a Candidate published by the H08 trusted worker goes through the pinned provider check path', async () => {
  const { composeFixture } = await import('./hosted-compose-fixture.mjs');
  const source = await composeFixture();
  const selection = source.selection([await source.lane(source.baseline)]);
  await source.prepare(selection);
  await source.stage(selection);
  await source.submit(selection);
  const candidate = (await source.publish(await source.work(selection))).outcome.result;
  const s = await checksFixture({
    store: source,
    projectId: source.projectId,
    candidate,
    state: { sha256: candidate.result.head, size: source.objects.get(candidate.result.head).length },
  });
  const requested = await s.enqueue(s.selection());
  const passed = await s.pass(await s.activate(requested.id, 1));
  assert.equal((await s.evidence(passed)).id, requested.id);
  assert.equal(passed.request.candidateId, candidate.id);
  assert.deepEqual(passed.candidate.base, candidate.base);
  assert.deepEqual(passed.candidate.inputs, candidate.inputs);
  assert.equal(passed.candidate.algorithm, candidate.algorithm);
  assert.equal(source.tables.projectHostedChannels.size, 1);
});

test('one failed shard reports all four failed files and keeps flaky files separate in status', async () => {
  const s = await checksFixture();
  const r = await s.activate((await s.enqueue(s.selection())).id, 1);
  await s.callback(s.shard(r, 0, 'failed'));
  const contractReports = Object.fromEntries(
    Array.from({ length: 4 }, (_, i) => [
      `tests/failure-${i}.test.mjs`,
      { failed: true, firstError: `first assertion ${i}`, ...(i ? { durationMs: 10 } : {}) },
    ]),
  );
  contractReports['tests/flaky.test.mjs'] = {
    durationMs: 5,
    failed: false,
    flaky: true,
    firstError: 'first attempt',
    attempts: [
      { durationMs: 8, failed: true },
      { durationMs: 5, failed: false },
    ],
  };
  await s.callback(s.complete(r, 'failed', { contractReports }));
  const result = await s.status(r.id);
  assert.equal(result.counts.failed, 1, 'legacy counts describe shards');
  assert.deepEqual(result.testFiles.counts, { total: 5, failed: 4, flaky: 1 });
  assert.equal(result.testFiles.failed.length, 4);
  assert.equal(result.testFiles.flaky[0].report.attempts.length, 2);
  assert.deepEqual(result.contractReports, contractReports);
});
