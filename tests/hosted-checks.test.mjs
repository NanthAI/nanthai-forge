// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { getFunctionName } from 'convex/server';
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
import { hostedVerdictKey, hostedCheckCallbackSchema } from '../dist/hosted-check-evidence.js';

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

test('same-transaction run reuse still rejects mismatched identity, changed definition and revoked authority', async () => {
  const s = await checksFixture();
  const run = await s.pass(await s.activate((await s.enqueue(s.selection())).id));
  const pins = {
    projectId: s.projectId,
    runId: run.id,
    actor: 'owner',
    candidateId: run.request.candidateId,
    head: run.request.expectedHead,
    checkId: run.check.id,
    definition: run.check.definition,
    configuration: run.request.expectedConfiguration,
    environment: run.request.expectedEnvironment,
    authorityEpoch: 1,
  };
  const store = await import(moduleUrl('../convex/projectHostedCheckStore.ts'));
  const evidence = (change = {}) =>
    s.run(
      'loadedEvidence',
      async ctx => {
        const loaded = (await store.loadHostedCheck(ctx, pins)).run;
        return read.requireHostedCheckEvidence(ctx, { ...pins, ...change }, loaded);
      },
      {},
    );
  assert.equal((await evidence()).id, run.id);
  assert.equal(s.counts.at(-1).readDocumentsByTable.projectHostedCheckRuns, 1);
  await assert.rejects(evidence({ runId: randomUUID() }), code('EVIDENCE_CHANGED'));
  await assert.rejects(evidence({ authorityEpoch: 2 }), code('SOURCE_AUTHORITY_CHANGED'));
  await s.configure(
    { kind: 'definition', checkId: s.checkId, command: { ...command, args: ['changed.mjs'] } },
    s.definition.digest,
  );
  await assert.rejects(evidence(), code('EVIDENCE_CHANGED'));
});

test('operational expiry keeps active checks and all verdict/source/receipt evidence while reclaiming only aged raw detail', async t => {
  const s = await checksFixture();
  const expiry = await import(moduleUrl('../convex/projectOperationalExpiry.ts'));
  const r = await s.activate((await s.enqueue(s.selection())).id);
  const input = {
    projectId: s.projectId,
    runId: r.id,
    phase: 'callbacks',
    dueAt: 0,
    continue: false,
    operationId: 'exhaust-check',
  };
  // Bypass checksFixture's small control-write ceiling: this test deliberately seeds detail pages.
  const expire = args =>
    s.store?.call('exhaustExpiry', expiry.check, args) ?? s.call('exhaustExpiry', expiry.check, args);
  const active = await expire(input);
  assert.equal(active.kept, true);
  const shardCallbacks = [];
  for (let i = 0; i < r.plan.shardCount; i++) {
    const shard = s.shard(r, i);
    shardCallbacks.push(shard);
    await s.callback(shard);
  }
  const terminalCallback = s.complete(r);
  const complete = await s.callback(terminalCallback);
  const terminal = [...s.tables.projectHostedCheckRuns.values()][0];
  const report = { 'tests/kept.test.mjs': { durationMs: 1, failed: false, attempts: [] } };
  s.patch('projectHostedCheckRuns', terminal._id, {
    value: JSON.stringify({ ...complete, contractReports: report }),
    proof: 'immutable-receipt-proof',
    verdictKey: hostedVerdictKey(complete),
    reportParts: 1,
    reportDigest: 'synthetic-report-digest',
  });
  s.insert('projectHostedActionsResults', {
    projectId: s.projectId,
    runId: r.id,
    index: -1000,
    digest: 'synthetic-report-digest',
    reports: JSON.stringify(report),
  });
  const reusedCandidateId = randomUUID();
  const reuseAlias = s.insert('projectHostedCheckCallbacks', {
    projectId: s.projectId,
    runId: r.id,
    eventId: `reuse:${reusedCandidateId}`,
    digest: hostedVerdictKey(complete),
    value: JSON.stringify({ candidateId: reusedCandidateId, actor: 'owner' }),
  });
  const aliasBefore = structuredClone(s.tables.projectHostedCheckCallbacks.get(reuseAlias));
  for (let i = 0; i < 17; i++)
    s.insert('projectHostedCheckCallbacks', {
      projectId: s.projectId,
      runId: r.id,
      eventId: `legacy-event-${i}`,
      digest: `legacy-digest-${i}`,
      value: JSON.stringify({ raw: 'legacy'.repeat(100) }),
    });
  const callbackReceipts = [...s.tables.projectHostedCheckCallbacks.values()].map(
    ({ value: _value, ...receipt }) => receipt,
  );
  const immutableTables = [
    'projectHostedAcceptances',
    'projectHostedRecords',
    'projectWorkEvents',
    'projectObjects',
  ];
  const immutable = immutableTables.map(name => [...s.tables[name]]);
  assert.equal((await expire(input)).kept, true, 'newly terminal raw callbacks stay seven days');
  const ended = Date.parse(complete.endedAt);
  const wakes = s.scheduled.filter(task => getFunctionName(task.fn).startsWith('projectOperationalExpiry:'));
  assert.equal(wakes.length, 2, 'one terminal transition arms exactly two maintenance phases');
  assert.deepEqual(
    wakes.map(task => [task.args.phase, task.args.dueAt - ended]),
    [
      ['callbacks', 7 * 86_400_000],
      ['detail', 30 * 86_400_000],
    ],
  );
  t.mock.method(Date, 'now', () => ended + 8 * 86_400_000);
  const first = await expire(input);
  assert.deepEqual(await expire(input), first, 'a lost page reply replays without another deletion');
  assert(first.rows > 0 && first.rows <= 8);
  assert(first.bytes > 0 && first.nextCursor);
  let callbackPage = first;
  for (let part = 1; callbackPage.more && part < 10; part++)
    callbackPage = await expire({ ...input, part, cursor: callbackPage.nextCursor });
  assert.equal(callbackPage.more, false, 'raw callback pages resume without dropping receipt rows');
  assert.equal(s.tables.projectHostedCheckCallbacks.size, callbackReceipts.length);
  assert.deepEqual(
    [...s.tables.projectHostedCheckCallbacks.values()].map(({ value: _value, ...receipt }) => receipt),
    callbackReceipts,
  );
  assert.deepEqual(
    s.tables.projectHostedCheckCallbacks.get(reuseAlias),
    aliasBefore,
    'same-tree reuse provenance remains readable',
  );
  assert(
    [...s.tables.projectHostedCheckCallbacks.values()]
      .filter(row => !row.eventId.startsWith('reuse:'))
      .every(row => row.value === '{}'),
  );
  assert.equal(
    (await s.callback(shardCallbacks[0])).id,
    complete.id,
    'old shard event still reconciles after raw expiry',
  );
  await assert.rejects(
    s.callback({ ...terminalCallback, result: { ...terminalCallback.result, exitCode: 123 } }),
    code('WORK_OPERATION_CHANGED'),
  );
  assert.equal(
    (await s.callback(terminalCallback)).id,
    complete.id,
    'original terminal callback retry still reconciles after raw expiry',
  );
  assert(s.tables.projectHostedCheckShards.size > 0, 'shard detail keeps its thirty-day window');
  assert.equal((await expire({ ...input, phase: 'detail' })).kept, true);
  t.mock.method(Date, 'now', () => ended + 31 * 86_400_000);
  let result;
  for (let i = 0; i < 10; i++) {
    result = await expire({ ...input, phase: 'detail', part: i });
    if (!result.more) break;
  }
  assert.equal(result.more, false, 'bounded pages finish');
  const after = s.tables.projectHostedCheckRuns.get(terminal._id);
  assert.deepEqual(
    JSON.parse(after.value),
    Object.fromEntries(Object.entries({ ...complete }).filter(([key]) => key !== 'contractReports')),
  );
  assert.equal(after.proof, 'immutable-receipt-proof');
  assert.equal(after.reportParts, undefined);
  assert.equal(after.reportDigest, undefined);
  assert.equal(s.tables.projectHostedActionsResults.size, 0);
  assert.equal(s.tables.projectHostedCheckShards.size, 0);
  assert.deepEqual(
    immutableTables.map(name => [...s.tables[name]]),
    immutable,
  );
  assert.deepEqual(await expire({ ...input, phase: 'detail', part: 10 }), {
    rows: 0,
    bytes: 0,
    more: false,
    kept: false,
  });
  assert.equal((await s.evidence(complete)).id, complete.id, 'exact passing evidence remains usable');
  const reusedEvidence = candidateId =>
    s.run(
      'expiredReuseEvidence',
      ctx =>
        read.requireHostedCheckEvidence(ctx, {
          projectId: s.projectId,
          runId: complete.id,
          actor: 'owner',
          candidateId,
          head: complete.request.expectedHead,
          checkId: complete.check.id,
          definition: complete.check.definition,
          configuration: complete.request.expectedConfiguration,
          environment: complete.request.expectedEnvironment,
          authorityEpoch: 1,
        }),
      {},
    );
  assert.equal(
    (await reusedEvidence(reusedCandidateId)).id,
    complete.id,
    'same-tree alias remains valid after both expiry windows',
  );
  await assert.rejects(reusedEvidence(randomUUID()), code('EVIDENCE_CHANGED'));
});

test('legacy catch-up resumes exact steps, pauses for landings, and stops after preserving live work and immutable evidence', async t => {
  const s = await checksFixture();
  const expiry = await import(moduleUrl('../convex/projectOperationalExpiry.ts'));
  const passed = await s.pass(await s.activate((await s.enqueue(s.selection())).id));
  const terminal = [...s.tables.projectHostedCheckRuns.values()][0];
  const endedAt = new Date(Date.now() - 31 * 86_400_000).toISOString();
  s.patch('projectHostedCheckRuns', terminal._id, {
    value: JSON.stringify({
      ...passed,
      endedAt,
      contractReports: { 'kept.test.mjs': { durationMs: 1, failed: false, attempts: [] } },
    }),
    proof: 'keep-exact-proof',
  });
  for (let i = 0; i < 19; i++)
    s.insert('projectHostedCheckCallbacks', {
      projectId: s.projectId,
      runId: passed.id,
      eventId: `legacy-${i}`,
      digest: `digest-${i}`,
      value: JSON.stringify({ raw: 'x'.repeat(2000) }),
    });
  const alias = s.insert('projectHostedCheckCallbacks', {
    projectId: s.projectId,
    runId: passed.id,
    eventId: 'reuse:keep',
    digest: 'keep',
    value: '{"candidateId":"keep"}',
  });
  const activeId = randomUUID();
  const active = s.insert('projectHostedCheckRuns', {
    ...Object.fromEntries(Object.entries(terminal).filter(([k]) => !k.startsWith('_'))),
    runId: activeId,
    status: 'running',
    value: JSON.stringify({ ...passed, id: activeId, status: 'running', endedAt: null }),
  });
  const liveCallback = s.insert('projectHostedCheckCallbacks', {
    projectId: s.projectId,
    runId: activeId,
    eventId: 'live',
    digest: 'live',
    value: '{"raw":"live"}',
  });
  const recentId = randomUUID();
  s.insert('projectHostedCheckRuns', {
    ...Object.fromEntries(Object.entries(terminal).filter(([k]) => !k.startsWith('_'))),
    runId: recentId,
    value: JSON.stringify({ ...passed, id: recentId }),
  });
  const summaryId = randomUUID();
  s.insert('projectHostedCheckRuns', {
    ...Object.fromEntries(Object.entries(terminal).filter(([k]) => !k.startsWith('_'))),
    runId: summaryId,
    value: JSON.stringify({
      ...passed,
      id: summaryId,
      configuration: {
        provider: 'ci-status',
        ci: {
          adapter: 'github-actions',
          repository: 'synthetic/checks',
          workflow: '.github/workflows/test.yml',
        },
        runtime: 'e'.repeat(64),
        environmentFingerprint: 'e'.repeat(64),
      },
    }),
  });
  const queueId = s.insert('projectHostedLandingQueues', {
    projectId: s.projectId,
    channel: 'main',
    sequence: 0,
    fence: 0,
    wake: null,
    lease: null,
    status: { total: 2, groups: 2, horizon: [], lastProgressAt: new Date().toISOString(), serviceMs: 100 },
  });
  const immutableNames = [
    'projectHostedRecords',
    'projectHostedAcceptances',
    'projectWorkEvents',
    'projectObjects',
  ];
  const immutable = immutableNames.map(n => [...s.tables[n]]);
  const liveBefore = structuredClone(s.tables.projectHostedCheckRuns.get(active));
  const aliasBefore = structuredClone(s.tables.projectHostedCheckCallbacks.get(alias));
  await s.store.call('dueExpiryArmsCatchup', expiry.check, {
    projectId: s.projectId,
    runId: activeId,
    phase: 'callbacks',
    operationId: 'due-live-expiry',
    dueAt: 0,
  });
  assert.equal(
    s.scheduled.filter(w => getFunctionName(w.fn) === 'projectOperationalExpiry:catchup').length,
    1,
  );
  const operationId = `exhaust-catchup:v1:${s.projectId}`;
  const call = (step, extra = {}) =>
    s.store
      .call('catchup', expiry.catchup, {
        projectId: s.projectId,
        operationId,
        step,
        pages: 1,
        continue: false,
        ...extra,
      })
      .then(JSON.parse);
  let p = await call(0);
  assert(
    p.step === 1 && !p.paused && p.queue === 2,
    'stable queued landings do not prevent initial catch-up',
  );
  const first = structuredClone(p);
  assert.deepEqual(await call(0), first, 'lost response reconciles without running another step');
  s.patch('projectHostedLandingQueues', queueId, {
    status: { total: 3, groups: 3, horizon: [], lastProgressAt: new Date().toISOString(), serviceMs: 100 },
  });
  const paused = await call(p.step);
  assert(paused.paused && paused.step === p.step);
  assert.deepEqual(paused.totals, p.totals, 'queue growth prevents cleanup work');
  p = await call(p.step, { resume: true });
  assert(
    !p.paused && p.queue === 3 && p.step > paused.step,
    'explicit resume adopts the newly observed queued load',
  );
  s.patch('projectHostedLandingQueues', queueId, {
    status: { total: 3, groups: 3, horizon: [], lastProgressAt: new Date().toISOString(), serviceMs: 130 },
  });
  assert((await call(p.step)).paused, 'landing service-time growth also pauses');
  p = await call(p.step, { resume: true });
  assert(
    !p.paused && p.step > paused.step,
    'an explicit resume adopts the observed service baseline under stable queued load',
  );
  s.patch('projectHostedLandingQueues', queueId, {
    status: { total: 0, groups: 0, horizon: [], lastProgressAt: new Date().toISOString(), serviceMs: 100 },
  });
  for (let n = 0; n < 100 && p.phase !== 'done'; n++) p = await call(p.step);
  assert.equal(p.phase, 'done');
  assert(p.totals.find(x => x.table === 'projectHostedCheckCallbacks').rows >= 19);
  assert(p.totals.find(x => x.table === 'projectHostedCheckRuns').bytes > 0);
  assert.equal(s.tables.projectHostedCheckRuns.get(terminal._id).proof, 'keep-exact-proof');
  assert.deepEqual(s.tables.projectHostedCheckRuns.get(active), liveBefore);
  assert.equal(s.tables.projectHostedCheckCallbacks.get(liveCallback).value, '{"raw":"live"}');
  assert.deepEqual(s.tables.projectHostedCheckCallbacks.get(alias), aliasBefore);
  assert.deepEqual(
    immutableNames.map(n => [...s.tables[n]]),
    immutable,
  );
  assert(
    !s.scheduled.some(w => w.args.runId === summaryId),
    'summary-only CI runs never arm empty cleanup wakes',
  );
  const wakes = s.scheduled.length;
  assert.deepEqual(await call(p.step), p);
  assert.equal(s.scheduled.length, wakes, 'completed catch-up adds no idle wake');
  assert(
    s.scheduled.some(w => w.args.runId === recentId && w.args.phase === 'callbacks'),
    'young terminal rows get their missed future wake',
  );
  const { armExpiryCatchup } = await import(moduleUrl('../convex/projectOperationalExpiryCatchup.ts'));
  await s.run('armCompletedCatchup', ctx => armExpiryCatchup(ctx, s.projectId), {});
  assert.equal(s.scheduled.length, wakes, 'later terminal traffic does not restart the completed walk');
});
