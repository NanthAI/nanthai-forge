// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { getFunctionName } from 'convex/server';
import { transfers } from './hosted-compose-fixture.mjs';
import { syncFixture, api, jobApi, code } from './hosted-sync-fixture.mjs';
import { maxima } from './hosted-compose-fixture.mjs';
const target = s => ({ kind: 'main', head: s.main.head, receiptId: s.main.receipt.id });
test('resolution pins the immutable Candidate conflict even after original Lanes save again', async () => {
  const s = await syncFixture(),
    { a, b, candidate } = await s.conflict();
  const later = await s.save(a, [s.file('a.txt', 'left\n'), s.hidden, s.file('later', 'retained')]);
  const r = s.request('resolution', { candidateId: candidate.id, conflicts: candidate.result.conflicts });
  await s.prepareSync(r);
  await assert.rejects(
    s.prepareSync({ ...r, conflicts: { ...r.conflicts, size: r.conflicts.size + 1 } }),
    code('WORK_OPERATION_CHANGED'),
  );
  const { terminal, output } = await s.execute(r),
    result = terminal.outcome.result;
  assert.equal(result.status, 'conflict');
  const exact = JSON.parse(s.objects.get(candidate.result.conflicts.sha256));
  assert.equal(result.resolution.left, exact.left);
  assert.equal(result.resolution.right, exact.right);
  assert.deepEqual(result.resolution.conflicts, candidate.result.conflicts);
  assert.equal((await s.readLane(a.laneId)).entry.head, later.head);
  const draft = JSON.parse(s.objects.get(result.lane.head));
  assert.match(
    s.objects.get(draft.files.find(f => f.path === 'a.txt').blob).toString(),
    /^<<<<<<< lane\nleft\n=======\nright\n>>>>>>> target\n$/,
  );
  assert(!output.reads.some(p => p.sha256 === s.hidden.blob));
  assert.equal(draft.parents.length, 1, 'draft does not claim a resolved right parent');
  const saved = await s.save((await s.readLane(result.lane.laneId)).entry, [
    s.file('a.txt', 'chosen\n'),
    s.hidden,
  ]);
  const completed = await s.execute(s.request('resolve', { laneId: saved.laneId, expected: s.pins(saved) }));
  assert.equal(completed.terminal.outcome.result.status, 'resolved');
  const resolved = (await s.readLane(saved.laneId)).entry;
  assert.deepEqual(JSON.parse(s.objects.get(resolved.head)).parents, [saved.head, exact.right]);
  // Resolution first, then the original selection (including any suffix) at explicitly observed heads.
  const composed = s.selection([resolved, later, b]);
  await s.prepare(composed);
  await s.stage(composed);
  await s.submit(composed);
  const final = await s.publish(await s.work(composed));
  assert.equal(final.outcome.result.result.status, 'clean');
  const files = JSON.parse(s.objects.get(final.outcome.result.result.head)).files;
  assert(files.some(f => f.path === 'later'));
  assert.equal(s.objects.get(files.find(f => f.path === 'a.txt').blob).toString(), 'chosen\n');
  assert.deepEqual((await s.prepareSync(r)).terminal, terminal, 'old retry does not rewind saved resolution');
});
test('unresolved markers fail resolution; original draft and source remain recoverable', async () => {
  const s = await syncFixture(),
    { candidate } = await s.conflict();
  const { terminal } = await s.execute(
    s.request('resolution', { candidateId: candidate.id, conflicts: candidate.result.conflicts }),
  );
  const entry = (await s.readLane(terminal.outcome.result.lane.laneId)).entry,
    r = s.request('resolve', { laneId: entry.laneId, expected: s.pins(entry) });
  await s.prepareSync(r);
  await s.submitSync(r);
  await assert.rejects(s.workSync(r), code('CONFLICT_MARKERS'));
  assert.equal((await s.readLane(entry.laneId)).entry.head, entry.head);
});
test('sync has one Lane CAS winner and retains a concurrent newer save', async () => {
  const s = await syncFixture(),
    lane = await s.lane(s.state([s.baseFile, s.hidden, s.file('lane', 'local')], [s.baseline.sha256]));
  const r = s.request('sync', { laneId: lane.laneId, expected: s.pins(lane), target: target(s) });
  await s.prepareSync(r);
  await s.submitSync(r);
  const output = await s.workSync(r);
  const newer = await s.save(lane, [
    s.baseFile,
    s.hidden,
    s.file('lane', 'local'),
    s.file('newer', 'never overwrite'),
  ]);
  const terminal = await s.publishSync(output);
  assert.equal(terminal.outcome.status, 'failed');
  assert.equal(terminal.outcome.error.code, 'WORK_STALE');
  assert.equal((await s.readLane(lane.laneId)).entry.head, newer.head);
  assert.deepEqual(await s.publishSync(output), terminal);
});
test('sync retains disjoint work and does not conflict with a later save in another Lane', async () => {
  const s = await syncFixture(),
    lane = await s.lane(s.state([s.baseFile, s.hidden, s.file('lane', 'local')], [s.baseline.sha256]));
  const main = s.state([s.baseFile, s.hidden, s.file('accepted', 'main')], [s.baseline.sha256]);
  s.moveMain(main.sha256, 'new-main');
  const r = s.request('sync', {
    laneId: lane.laneId,
    expected: s.pins(lane),
    target: { kind: 'main', head: main.sha256, receiptId: 'new-main' },
  });
  const other = await s.lane(s.baseline);
  await s.prepareSync(r);
  await s.submitSync(r);
  const output = await s.workSync(r);
  const next = await s.save(other, [s.baseFile, s.hidden, s.file('unrelated', 'saved')]);
  // Main moving again cannot reinterpret the already pinned sync.
  s.moveMain(s.baseline.sha256, 'newer-main');
  const result = (await s.publishSync(output)).outcome.result;
  assert.equal(result.status, 'merged');
  assert.deepEqual(
    JSON.parse(s.objects.get(result.lane.head)).files.map(f => f.path),
    ['a.txt', 'accepted', 'hidden.bin', 'lane'],
  );
  assert.equal((await s.readLane(other.laneId)).entry.head, next.head);
  assert(!output.reads.some(p => p.sha256 === s.hidden.blob));
  assert.equal(s.scheduled.filter(item => item.name.includes('SyncJobs:complete')).length, 1);
});
test('sync conflicts create a resolution sibling without moving the original Lane', async () => {
  const s = await syncFixture(),
    { a, candidate } = await s.conflict();
  const clean = s.state([s.file('a.txt', 'main\n'), s.hidden], [s.baseline.sha256]);
  s.moveMain(clean.sha256, 'conflicting-main');
  const r = s.request('sync', {
    laneId: a.laneId,
    expected: s.pins(a),
    target: { kind: 'main', head: clean.sha256, receiptId: 'conflicting-main' },
  });
  const { terminal } = await s.execute(r),
    result = terminal.outcome.result;
  assert.equal(result.status, 'conflict');
  assert.notEqual(result.lane.laneId, a.laneId);
  assert.equal((await s.readLane(a.laneId)).entry.head, a.head);
  assert.equal(result.resolution.left, a.head);
  assert.equal(result.resolution.right, clean.sha256);
  assert.equal(result.resolution.candidateId, null);
  assert(candidate.id);
});
test('main ABA, stale source versions, foreign conflicts and non-clean targets fail explicitly', async () => {
  const s = await syncFixture(),
    { a, candidate } = await s.conflict();
  const r = s.request('sync', { laneId: a.laneId, expected: s.pins(a), target: target(s) });
  s.moveMain(s.main.head, 'ABA');
  await assert.rejects(s.prepareSync(r), code('CHANNEL_CHANGED'));
  await assert.rejects(
    s.prepareSync({ ...r, operationId: randomUUID(), expected: { ...r.expected, version: 1 } }),
    code('WORK_STALE'),
  );
  await assert.rejects(
    s.prepareSync(
      s.request('sync', {
        laneId: a.laneId,
        expected: s.pins(a),
        target: { kind: 'candidate', candidateId: candidate.id, head: a.head },
      }),
    ),
    code('WORK_STALE'),
  );
  await assert.rejects(
    s.prepareSync(
      s.request('resolution', {
        candidateId: candidate.id,
        conflicts: { ...candidate.result.conflicts, sha256: '0'.repeat(64) },
      }),
    ),
    code('WORK_STALE'),
  );
  await assert.rejects(
    s.prepareSync(
      s.request('resolution', { candidateId: randomUUID(), conflicts: candidate.result.conflicts }),
    ),
    code('NOT_FOUND'),
  );
});
test('completed retries recheck current access, retain terminal pins across epoch movement, and never redispatch', async () => {
  const s = await syncFixture(),
    lane = await s.lane(s.baseline),
    r = s.request('sync', { laneId: lane.laneId, expected: s.pins(lane), target: target(s) });
  const { terminal, output } = await s.execute(r);
  assert.equal(terminal.outcome.result.status, 'up-to-date');
  s.patch('hostedProjects', s.projectId, { sourceAuthority: { mode: 'server', epoch: 2 } });
  assert.deepEqual(await s.publishSync(output), terminal);
  assert.deepEqual((await s.prepareSync(r)).terminal, terminal);
  s.patch('hostedProjects', s.projectId, { removal: 'deleting' });
  await assert.rejects(s.publishSync(output), code('PROJECT_UNAVAILABLE'));
  await assert.rejects(
    s.call('revokedProgress', api.progress, { projectId: s.projectId, operationId: r.operationId }, 'reader'),
    code('PROJECT_UNAVAILABLE'),
  );
  assert.equal(s.tables.projectHostedSyncs.size, 1);
});
test('signed output and current authority are required at publication; original operation wins duplicate delivery', async () => {
  const s = await syncFixture(),
    lane = await s.lane(s.baseline),
    r = s.request('sync', { laneId: lane.laneId, expected: s.pins(lane), target: target(s) });
  await Promise.all([s.prepareSync(r), s.prepareSync(r)]);
  await s.submitSync(r);
  const output = await s.workSync(r);
  await assert.rejects(
    s.publishSync({ ...output, manifest: output.manifest + '\n' }),
    code('SOURCE_HASH_MISMATCH'),
  );
  s.patch('hostedProjects', s.projectId, { sourceAuthority: { mode: 'server', epoch: 2 } });
  await assert.rejects(s.publishSync(output), code('SOURCE_AUTHORITY_CHANGED'));
  s.patch('hostedProjects', s.projectId, { sourceAuthority: { mode: 'server', epoch: 1 } });
  const [a, b] = await Promise.all([s.publishSync(output), s.publishSync(output)]);
  assert.deepEqual(a, b);
  assert.equal(s.tables.projectHostedSyncs.size, 1);
  assert(
    s.counts
      .filter(c => c.name === 'syncPublish')
      .every(c => !c.touched.some(t => ['projectHostedChannels', 'projectHostedComposePages'].includes(t))),
  );
});
test('source-job failure is retained and finalization needs no browser or recurring sync', async () => {
  const s = await syncFixture(),
    lane = await s.lane(s.baseline),
    r = s.request('sync', { laneId: lane.laneId, expected: s.pins(lane), target: target(s) });
  await s.prepareSync(r);
  const { jobId } = await s.submitSync(r),
    job = await s.activate(jobId);
  await s.callback(job, { status: 'failed', code: 'SYNTHETIC_FAILURE' });
  assert.equal(await s.call('syncFailure', jobApi.resultDownload, { projectId: s.projectId, jobId }), null);
  assert.equal((await s.progressSync(r)).terminal.outcome.error.code, 'SYNTHETIC_FAILURE');
  assert(s.scheduled.every(item => !/watch|poll|cron|interval/i.test(item.name)));
});

test('pending resolution cannot be mistaken for a completed clean composition', async () => {
  const s = await syncFixture(),
    { candidate } = await s.conflict();
  const { terminal } = await s.execute(
    s.request('resolution', { candidateId: candidate.id, conflicts: candidate.result.conflicts }),
  );
  const lane = (await s.readLane(terminal.outcome.result.lane.laneId)).entry;
  const x = s.selection([lane]);
  await s.prepare(x);
  await assert.rejects(s.stage(x), code('CONFLICT_MARKERS'));
});
test('sync descriptors and output reuse recheck exact execution, authority and project object binding', async () => {
  const s = await syncFixture(),
    lane = await s.lane(s.baseline),
    r = s.request('sync', { laneId: lane.laneId, expected: s.pins(lane), target: target(s) });
  await s.prepareSync(r);
  const { jobId } = await s.submitSync(r),
    job = await s.activate(jobId);
  await s.callback(job, { status: 'heartbeat', sequence: 1 });
  const dispatch = {
    schema: 1,
    projectId: s.projectId,
    jobId,
    operationId: job.operationId,
    jobKind: 'sync',
    attempt: job.attempt,
    fence: job.fence,
    authorityEpoch: 1,
    input: job.input,
    inputDigest: job.inputDigest,
    provider: job.control.provider,
    worker: job.control.worker,
    runtime: job.control.runtime,
    dispatchKey: job.control.dispatchKey,
  };
  const args = {
    projectId: s.projectId,
    input: JSON.stringify(dispatch),
    executionId: 'synthetic-execution',
    sha256: s.baseline.sha256,
  };
  assert.deepEqual(JSON.parse(await s.call('syncDescribe', transfers.describe, args)), {
    object: s.baseline,
    recipe: null,
  });
  await assert.rejects(
    s.call('syncDescribe', transfers.describe, { ...args, executionId: 'forged' }),
    code('SOURCE_JOB_FENCED'),
  );
  await assert.rejects(
    s.call('syncDescribe', transfers.describe, { ...args, sha256: 'f'.repeat(64) }),
    code('SOURCE_UNAVAILABLE'),
  );
  await assert.rejects(
    s.call('syncDescribe', transfers.describe, {
      ...args,
      input: JSON.stringify({ ...dispatch, fence: dispatch.fence + 1 }),
    }),
    code('SOURCE_JOB_FENCED'),
  );
  const { sha256, ...grantArgs } = args;
  assert(sha256);
  assert.deepEqual(
    await s.call('syncReuse', transfers.grant, { ...grantArgs, pin: s.baseline, action: 'upload' }),
    { stored: true },
  );
  s.patch('hostedProjects', s.projectId, { sourceAuthority: { mode: 'server', epoch: 2 } });
  await assert.rejects(s.call('syncDescribe', transfers.describe, args), code('SOURCE_AUTHORITY_CHANGED'));
});
test('short finalizer fetches only its signed manifest, retries once, and is independent of retained history', async t => {
  const s = await syncFixture(),
    lane = await s.lane(s.baseline),
    r = s.request('sync', { laneId: lane.laneId, expected: s.pins(lane), target: target(s) });
  await s.prepareSync(r);
  await s.submitSync(r);
  const output = await s.workSync(r);
  for (let i = 0; i < 10050; i++)
    s.insert('projectHostedRecordHeads', {
      projectId: s.projectId,
      kind: 'lane',
      key: randomUUID(),
      version: 0,
      parent: '',
      status: 'unselected',
      recordId: 'unselected-record',
    });
  let fetched = 0;
  const resultBytes = s.objects.get(output.output.sha256);
  t.mock.method(globalThis, 'fetch', async () => {
    fetched++;
    return new Response(resultBytes);
  });
  const env = {
      CONVEX_CLOUD_URL: 'https://example.convex.cloud',
      R2_ACCOUNT_ID: 'synthetic',
      R2_BUCKET: 'synthetic',
      R2_ACCESS_KEY_ID: 'synthetic',
      R2_SECRET_ACCESS_KEY: 'synthetic',
    },
    old = Object.fromEntries(Object.keys(env).map(key => [key, process.env[key]]));
  Object.assign(process.env, env);
  t.after(() => {
    for (const [key, value] of Object.entries(old)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });
  const ctx = {
    runMutation: (ref, args) => {
      const publish = getFunctionName(ref).endsWith(':publish');
      return s.call(
        publish ? 'syncPublish' : 'syncResultDownload',
        publish ? jobApi.publish : jobApi.resultDownload,
        args,
      );
    },
  };
  const args = { projectId: s.projectId, jobId: output.jobId };
  const terminal = JSON.parse(await jobApi.complete._handler(ctx, args));
  assert.equal(terminal.outcome.result.status, 'up-to-date');
  assert.equal(await jobApi.complete._handler(ctx, args), null);
  assert.equal(fetched, 1);
  assert(resultBytes.length < 4096);
  assert(s.counts.filter(c => c.name === 'syncPublish').every(c => c.ranges < 40 && c.documents < 40));
  t.diagnostic(
    JSON.stringify({
      metrics: output.metrics,
      finalizerDownloads: fetched,
      manifestBytes: resultBytes.length,
      unrelatedRows: 10050,
    }),
  );
});
test('save page records contain only schema-declared identity fields', async () => {
  const s = await syncFixture(),
    lane = await s.lane(s.baseline);
  await s.save(lane, [s.baseFile, s.hidden, s.file('changed', 'captured')]);
  for (const row of s.tables.projectHostedSavePages.values())
    assert.deepEqual(
      Object.keys(row).sort(),
      ['_creationTime', '_id', 'actor', 'digest', 'index', 'operationId', 'projectId'].sort(),
    );
});
test('metered sync maxima are bounded metadata-only transactions', t => {
  t.diagnostic(JSON.stringify(maxima));
});

test('a conflict inside dependency composition resolves before original dependencies and the unmerged suffix', async () => {
  const s = await syncFixture();
  const a = await s.lane(s.state([s.file('a.txt', 'left\n'), s.hidden], [s.baseline.sha256])),
    b = await s.lane(s.state([s.file('a.txt', 'right\n'), s.hidden], [s.baseline.sha256])),
    suffix = await s.lane(
      s.state([s.baseFile, s.hidden, s.file('suffix', 'preserved')], [s.baseline.sha256]),
    );
  const compose = async (inputs, dependencies = []) => {
    const x = s.selection(inputs, dependencies);
    await s.prepare(x);
    await s.stage(x);
    await s.submit(x);
    return (await s.publish(await s.work(x))).outcome.result;
  };
  const dependency = candidate => ({
    candidateId: candidate.id,
    head: candidate.result.head,
    state: {
      object: { sha256: candidate.result.head, size: s.objects.get(candidate.result.head).length },
      recipe: null,
    },
  });
  const dependencies = [dependency(await compose([a])), dependency(await compose([b]))];
  const original = await compose([suffix], dependencies);
  assert.equal(original.result.status, 'conflict');
  const draft = (
    await s.execute(
      s.request('resolution', { candidateId: original.id, conflicts: original.result.conflicts }),
    )
  ).terminal.outcome.result;
  const saved = await s.save((await s.readLane(draft.lane.laneId)).entry, [
    s.file('a.txt', 'chosen\n'),
    s.hidden,
  ]);
  await s.execute(s.request('resolve', { laneId: saved.laneId, expected: s.pins(saved) }));
  const resolved = (await s.readLane(saved.laneId)).entry;
  // Dependencies execute before Lane inputs, so prefix a clean resolution Candidate.
  const cleanResolution = await compose([resolved]);
  assert.equal(cleanResolution.result.status, 'clean');
  const final = await compose([suffix], [dependency(cleanResolution), ...dependencies]);
  assert.equal(final.result.status, 'clean');
  const files = JSON.parse(s.objects.get(final.result.head)).files;
  assert(files.some(file => file.path === 'suffix'));
  assert.equal(s.objects.get(files.find(file => file.path === 'a.txt').blob).toString(), 'chosen\n');
});
