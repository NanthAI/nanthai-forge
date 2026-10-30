import { ForgeError } from '../dist/errors.js';
// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { writeFileSync, readFileSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { getFunctionName } from 'convex/server';
import { agentFixture } from './hosted-agent-fixture.mjs';
import { resolutionFixture } from './hosted-agent-resolution-fixture.mjs';
import { synthetic } from './hosted-revert-fixture.mjs';
import { finishFixture, desired, compose } from './hosted-finish-fixture.mjs';
import { saveHostedLane } from '../dist/hosted-save-client.js';
import { hostedLandingStateSchema, hostedLandingRequestSchema } from '../dist/hosted-landing.js';
import { finishSourceFingerprint } from '../dist/hosted-agent-finish-identity.js';
import { digest } from '../dist/hash.js';
import { calculateSelfMetrics } from '../dist/self-metrics.js';
import { readHostedMetricPages } from '../dist/self-metrics-hosted-pages.js';
import { fixture as metricFixture } from './self-metrics-hosted-fixture.mjs';
const priorEnv = Object.fromEntries(Object.keys(synthetic).map(key => [key, process.env[key]]));
test.before(() => Object.assign(process.env, synthetic));
test.after(() => {
  for (const [key, value] of Object.entries(priorEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});
// saveHostedLane consumes the real array-returning describe API directly;
// the generic transport fixture normally serializes its responses as JSON.
function rawSaveDescriptions(s) {
  const mutation = s.exchange.client.mutation;
  s.exchange.client.mutation = async (ref, args) => {
    const result = await mutation(ref, args);
    return getFunctionName(ref) === 'projectObjectDownloads:describe' && typeof result === 'string'
      ? JSON.parse(result)
      : result;
  };
}
const fail = s => {
  s.phase = 'terminal-failed';
  s.observation = { state: 'terminal-failed', cause: 'check-failed', pendingReason: null };
  s.error = { code: 'CHECK_FAILED', message: 'Synthetic flake' };
};

for (const shorthand of [false, true])
  test(`hosted finish retries a failed saved head with ${shorthand ? 'retry and reason' : 'a new operation'} and no save`, async t => {
    const s = agentFixture(t);
    await s.transport().dispatch('open', { laneId: s.lane.laneId });
    const command = { laneId: s.lane.laneId };
    const first = await s.transport().dispatch('finish', command);
    fail(s.operations.get(first.operationId));
    let before = s.calls.length;
    const refused = await s.transport().dispatch('finish', command);
    assert.equal(refused.operationId, first.operationId);
    assert.equal(refused.result.submission.phase, 'terminal-failed');
    assert.equal(refused.result.next, 'retry');
    assert.match(refused.result.retryCommand, /finish .*"retry":true.*"reason":"other"/);
    assert.equal(s.calls.length - before, 2, 'shorthand failure is discovery plus exact replay');
    const laterMessage = await s.transport().dispatch('finish', {
      ...command,
      message: 'A later caller note does not rewrite the failed request',
      priority: 'urgent',
    });
    assert.equal(laterMessage.operationId, first.operationId);
    assert.deepEqual(laterMessage.result.retry, refused.result.retry);
    const attempt = shorthand
      ? { retry: true, reason: 'flake' }
      : { operationId: randomUUID(), reason: 'flake' };
    before = s.calls.length;
    const retry = await s.transport().dispatch('finish', { ...command, ...attempt });
    assert.notEqual(retry.operationId, first.operationId);
    assert.notEqual(retry.result.composeOperationId, first.result.composeOperationId);
    assert.equal(retry.result.submission.request.retryReason, 'flake');
    assert(!s.calls.slice(before).some(c => /Saves|SaveJobs/.test(c.name)), 'no re-save');
    before = s.calls.length;
    const replay = await s.transport().dispatch('finish', { ...command, operationId: first.operationId });
    assert.equal(replay.result.submission.phase, 'terminal-failed');
    assert.equal(s.calls.length - before, 2, 'explicit replay stays at two calls');
  });

test('a terminal preparing finish replays without probing or resubmitting its old compose job', async t => {
  const s = agentFixture(t);
  s.pending(true);
  const command = { operationId: randomUUID(), laneId: s.lane.laneId };
  const first = await s.transport().dispatch('finish', command);
  assert.equal(first.result.submission.preparing, true);
  fail(s.operations.get(first.operationId));
  const before = s.calls.length;
  const replay = await s.transport().dispatch('finish', command);
  assert.equal(replay.result.submission.phase, 'terminal-failed');
  assert.deepEqual(
    s.calls.slice(before).map(call => call.name),
    ['projectHostedAgent:capabilities', 'projectHostedLandingDesired:submit'],
  );
});

test('current conflict recovery survives retry integration and unchanged-source retry skips saving', async t => {
  const s = await resolutionFixture(t, { overlap: true }),
    f = s.f;
  f.moveMain({ overlap: true });
  await s.transport().dispatch('open', { laneId: f.lane.laneId });
  const command = { laneId: f.lane.laneId, accept: true };
  const first = await s.transport().dispatch('finish', command);
  assert.equal(first.result.phase, 'conflict');
  assert.equal(first.result.next, 'retry');
  assert.deepEqual(first.result.recovery.conflict.paths, ['a.txt']);
  const replay = await s.transport().dispatch('finish', { ...command, operationId: first.operationId });
  assert.equal(replay.result.candidateId, first.result.candidateId);
  assert.equal(replay.result.recovery.conflict.laneId, first.result.recovery.conflict.laneId);
  const saved = await f.readLane(f.lane.laneId);
  f.moveMain();
  let uploads = 0;
  const uploadFile = s.exchange.uploadFile;
  s.exchange.uploadFile = (...args) => {
    uploads++;
    return uploadFile(...args);
  };
  const before = s.calls.length;
  const retry = await s.transport().dispatch('finish', { ...command, retry: true, reason: 'main-moved' });
  assert.notEqual(retry.operationId, first.operationId);
  assert.equal(retry.result.phase, 'finish');
  assert.equal((await f.readLane(f.lane.laneId)).head, saved.head);
  assert(!s.calls.slice(before).some(call => /HostedSaves|HostedSaveJobs/.test(call.name)));
  assert.equal(uploads, 0);
  await f.drain();
  await f.passChecks();
  await f.drain();
  assert.equal((await f.current(retry.result.submission.id)).submission.phase, 'landed');
});

test('a real edit after a retained composition conflict advances shorthand instead of replaying the conflict', async t => {
  const s = await resolutionFixture(t, { overlap: true }),
    f = s.f;
  f.moveMain({ overlap: true });
  await s.transport().dispatch('open', { laneId: f.lane.laneId });
  const command = { laneId: f.lane.laneId, accept: true };
  const first = await s.transport().dispatch('finish', command);
  assert.equal(first.result.phase, 'conflict');
  writeFileSync(join(s.root, 'a.txt'), 'theirs\nb\nc\n');
  const next = await s.transport().dispatch('finish', command);
  assert.notEqual(next.operationId, first.operationId);
  assert.equal(next.result.phase, 'finish');
});

for (const priority of [undefined, 'urgent'])
  test(`accept after a passed check-only finish reuses the exact Candidate and run (${priority ?? 'default'} priority); changed bytes get a new check`, async t => {
    const s = agentFixture(t);
    await s.transport().dispatch('open', { laneId: s.lane.laneId });
    const first = await s.transport().dispatch('finish', { laneId: s.lane.laneId, accept: false });
    const query = s.exchange.client.query;
    s.exchange.client.query = (ref, args) => {
      if (getFunctionName(ref) === 'projectHostedCheckRead:status') {
        s.calls.push({ name: getFunctionName(ref), args });
        return JSON.stringify({ id: first.result.run.id, status: 'passed' });
      }
      return query(ref, args);
    };
    const before = s.calls.length;
    const accepting = await s.transport().dispatch('finish', {
      laneId: s.lane.laneId,
      accept: true,
      ...(priority ? { priority } : {}),
    });
    assert.equal(accepting.result.submission.request.priority, priority);
    assert.deepEqual(accepting.result.submission.request.check, { kind: 'run', runId: first.result.run.id });
    assert.equal(accepting.result.submission.request.candidateId, s.candidate.id);
    assert(!s.calls.slice(before).some(c => /Checks:enqueue|ComposeJobs|Saves/.test(c.name)));
    fail(s.operations.get(accepting.operationId));
    writeFileSync(join(s.root, 'new.txt'), 'New source needs its own evidence\n');
    // A rejected save must remain a failed preparation, never the old passing check.
    rawSaveDescriptions(s);
    const mutation = s.exchange.client.mutation;
    const changed = Buffer.from('New source needs its own evidence\n');
    s.objects.set(digest(changed), changed);
    s.exchange.client.mutation = (ref, args) =>
      getFunctionName(ref) === 'projectHostedSaves:prepare'
        ? JSON.stringify({
            terminal: {
              outcome: {
                status: 'failed',
                error: { code: 'SYNTHETIC_SAVE_FAILURE', message: 'Synthetic failure' },
              },
            },
          })
        : mutation(ref, args);
    s.exchange.uploadFile = async () => {};
    s.exchange.missing = async pins => pins.map(p => p.sha256);
    const changedFinish = await s.transport().dispatch('finish', { laneId: s.lane.laneId, accept: false });
    assert.notEqual(changedFinish.operationId, first.operationId);
    assert.equal(changedFinish.result.phase, 'save');
    assert.equal(changedFinish.result.progress.outcome.status, 'failed');
    assert.equal(s.calls.filter(c => c.name === 'projectHostedChecks:enqueue').length, 1);
  });

test('finish reconciles a completed async checkpoint before capturing and never uploads the saved bytes again', async t => {
  const s = agentFixture(t);
  await s.transport().dispatch('open', { laneId: s.lane.laneId });
  rawSaveDescriptions(s);
  const operationId = randomUUID(),
    at = '2026-01-01T00:00:00.000Z';
  const bytes = Buffer.from('Checkpointed while the client was gone\n');
  writeFileSync(join(s.root, 'saved.txt'), bytes);
  const blob = digest(bytes);
  s.objects.set(blob, bytes);
  const oldHead = s.lane.head;
  const state = {
    schema: 1,
    kind: 'forge-source-state',
    parents: [oldHead],
    files: [{ path: 'saved.txt', blob, mode: 'file' }],
    message: 'Async checkpoint',
    at,
  };
  const head = digest(JSON.stringify(state));
  const mutation = s.exchange.client.mutation,
    query = s.exchange.client.query;
  s.exchange.client.mutation = (ref, args) => {
    const name = getFunctionName(ref);
    if (name === 'projectHostedSaves:prepare') return JSON.stringify({ terminal: null, input: {} });
    if (name === 'projectHostedSaves:stage') return JSON.stringify({});
    if (name === 'projectHostedSaveJobs:submit') return JSON.stringify({ status: 'submitted' });
    return mutation(ref, args);
  };
  s.exchange.client.query = (ref, args) => {
    if (getFunctionName(ref) === 'projectHostedSaves:progress')
      return JSON.stringify({ terminal: null, input: {} });
    return query(ref, args);
  };
  await saveHostedLane(s.root, { operationId, message: 'Async checkpoint' }, s.exchange);
  assert.equal(JSON.parse(readFileSync(join(s.root, '.forge/hosted-lane.json'))).selection.head, oldHead);
  s.lane.head = head;
  s.lane.sourceVersion = 1;
  s.lane.version = 1;
  s.exchange.client.mutation = mutation;
  s.exchange.client.query = (ref, args) => {
    if (getFunctionName(ref) === 'projectHostedSaves:progress') {
      s.calls.push({ name: getFunctionName(ref), args });
      return JSON.stringify({
        terminal: {
          outcome: {
            status: 'completed',
            result: {
              schema: 1,
              operationId,
              laneId: s.lane.laneId,
              saveId: randomUUID(),
              head,
              version: 1,
              sourceVersion: 1,
              unchanged: false,
              at,
            },
          },
        },
      });
    }
    return query(ref, args);
  };
  let uploads = 0;
  s.exchange.uploadFile = async () => {
    uploads++;
  };
  const before = s.calls.length;
  const finish = await s.transport().dispatch('finish', { laneId: s.lane.laneId });
  assert.equal(finish.result.phase, 'finish');
  assert.equal(uploads, 0);
  assert.equal(JSON.parse(readFileSync(join(s.root, '.forge/hosted-lane.json'))).selection.head, head);
  assert(!s.calls.slice(before).some(c => /Saves:prepare|SaveJobs/.test(c.name)));
  assert.equal(readFileSync(join(s.root, 'saved.txt'), 'utf8'), bytes.toString());
});

test('server new-op retry links a failed submission, preserves original replay and lands without another save', async t => {
  const f = await finishFixture(t);
  const original = f.request();
  const first = await f.enqueue(original);
  await f.drain();
  const run = [...f.tables.projectHostedCheckRuns.values()].map(r => JSON.parse(r.value))[0];
  const active = await f.rawChecks.activate(run.id);
  for (let i = 0; i < active.plan.shardCount; i++)
    await f.rawChecks.callback(f.rawChecks.shard(active, i, 'failed'));
  await f.rawChecks.callback(f.rawChecks.complete(active, 'failed'));
  await f.drain();
  assert.equal((await f.current(first.id)).submission.phase, 'terminal-failed');
  const main = f.moveMain();
  const recomposed = f.c.selection([f.lane], [], {
    expectedMain: { head: main.head, receiptId: main.receipt.id },
  });
  const candidate = await compose(f.c, recomposed);
  const retry = await f.enqueue({
    ...original,
    operationId: randomUUID(),
    candidateId: candidate.id,
    expectedHead: candidate.result.head,
    expectedMain: candidate.base,
    finish: { composeOperationId: recomposed.request.operationId, after: null },
    retryReason: 'main-moved',
  });
  assert.notEqual(retry.id, first.id);
  assert.equal(retry.supersedes, first.id);
  assert.equal(retry.retryReason, 'main-moved');
  const releasedReader = hostedLandingStateSchema
    .omit({ supersedes: true, retryReason: true })
    .extend({ request: hostedLandingRequestSchema.omit({ retryReason: true }) });
  const observed = await f.current(retry.id);
  assert(
    releasedReader.safeParse(observed.submission).success,
    'released strict readers retain their wire shape',
  );
  assert.equal(observed.submission.supersedes, undefined);
  assert.equal(observed.submission.request.retryReason, undefined);
  assert.equal((await f.enqueue(original)).id, first.id);
  assert.equal((await f.enqueue(original)).phase, 'terminal-failed');
  await f.drain();
  await f.passChecks();
  await f.drain();
  assert.equal((await f.current(retry.id)).submission.phase, 'landed');
  assert.equal(f.tables.projectHostedSaves?.size ?? 0, 0);
  assert.equal(f.tables.projectHostedCheckRuns.size, 2);
  assert.equal(f.pending().length, 0);
  const projected = metricFixture();
  for (const table of [
    'projectHostedAcceptances',
    'projectHostedLandingRequests',
    'projectHostedLandingAttempts',
    'projectHostedCheckRuns',
    'projectHostedOperations',
  ])
    projected.tables[table] = [...f.tables[table].values()].map(row => ({
      ...row,
      projectId: 'project',
      _creationTime: Date.parse('2026-10-29T00:00:00.000Z'),
    }));
  const { records } = await readHostedMetricPages(projected.query, {
    from: '2025-01-01T00:00:00.000Z',
    to: '2028-01-01T00:00:00.000Z',
  });
  const metrics = calculateSelfMetrics(records, {
    from: '2025-01-01T00:00:00.000Z',
    to: '2028-01-01T00:00:00.000Z',
  });
  assert.equal(
    metrics.metric1.days.reduce((n, d) => n + d.afterRetry, 0),
    1,
  );
  assert.equal(metrics.metric5.interventions, 1);
});

test('new desired operation after a rejected compose gets its own retained attempt', async t => {
  const f = await finishFixture(t);
  const command = {
    operationId: randomUUID(),
    authorityEpoch: 1,
    composeOperationId: f.selection.request.operationId,
    after: null,
    check: f.request().check,
  };
  const submit = request =>
    f
      .tx('retryDesired', desired.submit, { projectId: f.projectId, request: JSON.stringify(request) })
      .then(JSON.parse);
  const first = await submit(command);
  const row = [...f.tables.projectHostedOperations.values()].find(
    r => r.operationId === command.composeOperationId,
  );
  const operation = JSON.parse(row.value);
  operation.terminal.outcome = {
    status: 'failed',
    error: { code: 'SOURCE_REJECTED', message: 'Synthetic rejected compose' },
  };
  f.patch('projectHostedOperations', row._id, { value: JSON.stringify(operation) });
  await f.drain();
  assert.equal((await submit(command)).phase, 'terminal-failed');
  const recomposed = f.c.selection([f.lane]);
  await compose(f.c, recomposed);
  const retry = await submit({
    ...command,
    operationId: randomUUID(),
    composeOperationId: recomposed.request.operationId,
    retryReason: 'infra',
  });
  assert.notEqual(retry.id, first.id);
  assert.equal(retry.supersedes, first.id);
  await f.drain();
  await f.passChecks();
  await f.drain();
  assert.equal((await f.current(retry.id)).submission.phase, 'landed');
});

test('legacy saved Forge cache entries retain their identity without treating cache IO as source edits', async t => {
  const s = agentFixture(t);
  await s.transport().dispatch('open', { laneId: s.lane.laneId });
  const command = { laneId: s.lane.laneId };
  const empty = finishSourceFingerprint(s.root, command);
  const markerPath = join(s.root, '.forge/hosted-lane.json');
  const marker = JSON.parse(readFileSync(markerPath, 'utf8'));
  const path = 'queue-ahead-objects/objects/synthetic';
  const bytes = Buffer.from('synthetic historical cache');
  mkdirSync(join(s.root, 'queue-ahead-objects/objects'), { recursive: true });
  writeFileSync(join(s.root, path), bytes);
  marker.state.parents = [marker.selection.head];
  marker.state.files.push({ path, blob: digest(bytes), mode: 'file' });
  marker.selection.head = digest(JSON.stringify(marker.state));
  marker.materialized.push(path);
  writeFileSync(markerPath, JSON.stringify(marker));
  const saved = finishSourceFingerprint(s.root, command);
  assert.notEqual(saved, empty, 'accepted historical entries remain in the source identity');
  writeFileSync(join(s.root, path), 'synthetic local cache update');
  assert.equal(finishSourceFingerprint(s.root, command), saved);
  rmSync(join(s.root, path));
  assert.equal(finishSourceFingerprint(s.root, command), saved, 'cache deletion is not a source deletion');
  writeFileSync(join(s.root, 'real-source.ts'), 'export const changed = true;\n');
  assert.notEqual(finishSourceFingerprint(s.root, command), saved, 'real edits invalidate saved evidence');
});

test('dogfood-size finish history stays at two replay calls and bounded source scanning', async t => {
  const s = agentFixture(t);
  await s.transport().dispatch('open', { laneId: s.lane.laneId });
  const directory = `${s.root}.forge-client/agent`;
  mkdirSync(directory, { recursive: true });
  for (let i = 0; i < 1500; i++) writeFileSync(join(directory, `${randomUUID()}.json`), '{"unrelated":true}');
  const command = { laneId: s.lane.laneId };
  const first = await s.transport().dispatch('finish', command);
  fail(s.operations.get(first.operationId));
  const before = s.calls.length,
    started = performance.now();
  const result = await s.transport().dispatch('finish', command);
  assert.equal(result.result.next, 'retry');
  assert.equal(s.calls.length - before, 2);
  assert.equal(
    s.calls.slice(before).filter(c => /enqueue|submit|prepare/.test(c.name)).length,
    1,
    'one replay mutation, no new compute',
  );
  assert.equal(finishSourceFingerprint(s.root, command), finishSourceFingerprint(s.root, command));
  t.diagnostic(
    JSON.stringify({
      unrelatedRuns: 1500,
      replayCalls: s.calls.length - before,
      replayWallMs: performance.now() - started,
      scanBufferBytes: 1048576,
    }),
  );
});

test('short hosted landing entry id returns BAD_ARGUMENT before discovery', async t => {
  const s = agentFixture(t);
  for (const command of [{ operationId: 'short' }, { submissionId: 'short' }])
    await assert.rejects(s.transport().dispatch('landing', command), e => e.code === 'BAD_ARGUMENT');
  assert.equal(s.calls.length, 0);
});

test('retry admission reads constant metadata with twice the dogfood landing history', async t => {
  const f = await finishFixture(t),
    first = await f.enqueue(f.request());
  const table = f.tables.projectHostedLandingRequests;
  const row = [...table.values()][0];
  for (let i = 0; i < 1200; i++) {
    const id = `unrelated-${i}`;
    table.set(id, {
      ...row,
      _id: id,
      submissionId: randomUUID(),
      operationId: randomUUID(),
      selectionKey: `unrelated-${i}`,
      runnable: false,
    });
  }
  const state = JSON.parse(row.value);
  fail(state);
  f.patch('projectHostedLandingRequests', row._id, {
    phase: 'terminal-failed',
    runnable: false,
    value: JSON.stringify(state),
  });
  const before = f.counts.length,
    at = performance.now();
  const retry = await f.enqueue({ ...f.request(), retryReason: 'infra' });
  assert.equal(retry.supersedes, first.id);
  const calls = f.counts.slice(before);
  assert.equal(calls.length, 1);
  assert(calls[0].documents <= 90, 'constant selected metadata, independent of history size');
  assert(calls[0].writes <= 25);
  t.diagnostic(
    JSON.stringify({
      unrelatedSubmissions: 1200,
      calls: calls.length,
      documents: calls[0].documents,
      writes: calls[0].writes,
      wallMs: performance.now() - at,
    }),
  );
});

test('dogfood source fingerprint scans bounded buffers and keeps source out of finish history', async t => {
  const s = agentFixture(t);
  await s.transport().dispatch('open', { laneId: s.lane.laneId });
  for (let i = 0; i < 2800; i++) writeFileSync(join(s.root, `file-${i}.txt`), `synthetic source ${i}\n`);
  const before = process.memoryUsage(),
    start = performance.now();
  const fingerprint = finishSourceFingerprint(s.root, { laneId: s.lane.laneId });
  const after = process.memoryUsage();
  assert.match(fingerprint, /^[a-f0-9]{64}$/);
  assert(
    after.rss - before.rss < 128 * 1024 * 1024,
    'metadata plus bounded scan buffers, no whole-source retention',
  );
  assert.equal(s.calls.filter(c => /Saves|Compose|enqueue/.test(c.name)).length, 0);
  t.diagnostic(
    JSON.stringify({
      files: 2800,
      calls: 0,
      rssDeltaBytes: after.rss - before.rss,
      rssBytes: after.rss,
      peakRssBytes: process.resourceUsage().maxRSS * 1024,
      wallMs: performance.now() - start,
    }),
  );
});

test('a changed check definition requests fresh evidence after check-only finish', async t => {
  const s = agentFixture(t);
  await s.transport().dispatch('open', { laneId: s.lane.laneId });
  const first = await s.transport().dispatch('finish', { laneId: s.lane.laneId, accept: false });
  const query = s.exchange.client.query;
  s.exchange.client.query = async (ref, args) => {
    const name = getFunctionName(ref);
    if (name === 'projectHostedCheckRead:status') return JSON.stringify({ status: 'passed' });
    const value = await query(ref, args);
    if (name !== 'projectHostedCheckDefinitions:current') return value;
    const settings = JSON.parse(value);
    settings.check.definition = 'f'.repeat(64);
    return JSON.stringify(settings);
  };
  const accepted = await s.transport().dispatch('finish', { laneId: s.lane.laneId, accept: true });
  assert.equal(accepted.result.submission.request.check.kind, 'request');
  assert.equal(accepted.result.submission.request.check.expectedDefinition, 'f'.repeat(64));
  assert.notEqual(accepted.result.composeOperationId, first.result.composeOperationId);
});

test('concurrent shorthand finishes reserve one generation before network IO', async t => {
  const s = agentFixture(t);
  await s.transport().dispatch('open', { laneId: s.lane.laneId });
  const command = { laneId: s.lane.laneId };
  const attempts = await Promise.all(
    Array.from({ length: 8 }, () => s.transport().dispatch('finish', command)),
  );
  assert.equal(new Set(attempts.map(r => r.operationId)).size, 1);
  assert.equal(new Set(attempts.map(r => r.result.composeOperationId)).size, 1);
  assert.equal(new Set(attempts.map(r => r.result.submission.id)).size, 1);
  assert.equal(s.operations.size, 2, 'one compose and one landing operation');
});

for (const missing of [false, true])
  test(`finish resumes the original checkpoint after an unknown preparation reply (${missing ? 'missing' : 'pending'} progress)`, async t => {
    const s = agentFixture(t);
    await s.transport().dispatch('open', { laneId: s.lane.laneId });
    const operationId = randomUUID();
    s.lose('projectHostedSaves:prepare');
    await assert.rejects(
      saveHostedLane(s.root, { operationId, message: 'Interrupted clean checkpoint' }, s.exchange),
    );
    if (missing) {
      const query = s.exchange.client.query;
      s.exchange.client.query = (ref, args) => {
        if (getFunctionName(ref) === 'projectHostedSaves:progress')
          throw new ForgeError('NOT_FOUND', 'Synthetic missing preparation');
        return query(ref, args);
      };
    }
    const before = s.calls.length;
    const finish = await s.transport().dispatch('finish', { laneId: s.lane.laneId });
    assert.equal(finish.result.phase, 'finish');
    const saves = s.calls.slice(before).filter(call => call.name === 'projectHostedSaves:prepare');
    assert.equal(saves.length, 1);
    assert.equal(JSON.parse(saves[0].args.request).operationId, operationId);
    assert(!s.calls.slice(before).some(call => call.name === 'projectHostedSaveJobs:submit'));
  });

test('a pending checkpoint is reconciled before reserving finish source on replay', async t => {
  const s = agentFixture(t);
  await s.transport().dispatch('open', { laneId: s.lane.laneId });
  const saveId = randomUUID(),
    finishId = randomUUID();
  let completed = false;
  const terminal = {
    outcome: {
      status: 'completed',
      result: {
        schema: 1,
        operationId: saveId,
        laneId: s.lane.laneId,
        saveId: randomUUID(),
        head: s.lane.head,
        version: 0,
        sourceVersion: 0,
        unchanged: true,
        at: '2026-01-01T00:00:00.000Z',
      },
    },
  };
  const mutation = s.exchange.client.mutation,
    query = s.exchange.client.query;
  const saves = [];
  s.exchange.client.mutation = (ref, args) => {
    const name = getFunctionName(ref);
    if (name === 'projectHostedSaves:prepare') {
      saves.push(JSON.parse(args.request).operationId);
      return JSON.stringify({ terminal: completed ? terminal : null });
    }
    if (name === 'projectHostedSaveJobs:submit') return JSON.stringify({ status: 'submitted' });
    return mutation(ref, args);
  };
  s.exchange.client.query = (ref, args) =>
    getFunctionName(ref) === 'projectHostedSaves:progress'
      ? JSON.stringify({ terminal: completed ? terminal : null })
      : query(ref, args);
  await saveHostedLane(s.root, { operationId: saveId, message: 'Pending checkpoint' }, s.exchange);
  const pending = await s.transport().dispatch('finish', { operationId: finishId, laneId: s.lane.laneId });
  assert.equal(pending.operationId, finishId);
  assert.equal(pending.result.phase, 'save');
  completed = true;
  const finished = await s.transport().dispatch('finish', { operationId: finishId, laneId: s.lane.laneId });
  assert.equal(finished.result.phase, 'finish');
  assert.deepEqual(saves, [saveId, saveId], 'the original checkpoint is resumed, without a new save');
});
