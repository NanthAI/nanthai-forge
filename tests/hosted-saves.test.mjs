// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { saveFixture, api, jobApi, maxima } from './hosted-saves-fixture.mjs';
const code = value => error => (error.data?.code ?? error.code) === value;

test('lost stage, submit and final replies reconcile exactly one save without rewinding later work', async () => {
  const s = await saveFixture(),
    x = await s.prepare([s.change()]);
  await s.stage(x);
  await s.stage(x);
  const first = await s.submit(x),
    second = await s.submit(x);
  assert.equal(first.jobId, second.jobId);
  assert.equal(s.tables.projectHostedRecordHeads.size, 2); // Lane + one source job.
  const output = await s.work(x),
    terminal = await s.publish(output);
  assert.equal(terminal.outcome.status, 'completed');
  assert.equal(terminal.outcome.result.sourceVersion, 1);
  assert(s.scheduled.some(task => task.name === 'projectHostedSaveJobs:complete'));
  assert.deepEqual(await s.publish(output), terminal);
  const replay = JSON.parse(
    await s.call('prepare', api.prepare, { projectId: s.projectId, request: JSON.stringify(x.request) }),
  );
  assert.deepEqual(replay.terminal, terminal);
  const clean = await s.prepare([], {
    expected: { ...s.expected, head: output.head, version: 1, sourceVersion: 1 },
  });
  await s.submit(clean);
  assert.deepEqual(await s.publish(output), terminal);
  assert.equal([...s.tables.projectHostedRecordHeads.values()].filter(row => row.kind === 'save').length, 2);
  assert.deepEqual(output.reads.map(p => p.sha256).includes(s.hidden.sha256), false);
});
test('two concurrently publishing saves have one CAS winner and retain the stale loser delta', async () => {
  const s = await saveFixture(),
    a = await s.prepare([s.change('a')]),
    b = await s.prepare([s.change('b')]);
  await s.stage(a);
  await s.stage(b);
  await s.submit(a);
  await s.submit(b);
  const ao = await s.work(a),
    bo = await s.work(b);
  const terminals = await Promise.all([s.publish(ao), s.publish(bo)]);
  assert.deepEqual(terminals.map(t => t.outcome.status).sort(), ['completed', 'failed']);
  const loser = terminals.find(t => t.outcome.status === 'failed');
  assert.equal(loser.outcome.error.code, 'WORK_STALE');
  assert.equal([...s.tables.projectHostedRecordHeads.values()].filter(row => row.kind === 'save').length, 1);
  assert.equal(s.tables.projectHostedSavePages.size, 2);
  assert.deepEqual(await s.publish(bo), terminals[1]);
});
test('clean save succeeds without worker or Lane version change', async () => {
  const s = await saveFixture(),
    x = await s.prepare([]),
    result = await s.submit(x);
  assert.equal(result.outcome.result.unchanged, true);
  assert.equal(result.outcome.result.head, s.baseline.sha256);
  assert.equal(result.outcome.result.version, 0);
  assert.equal(s.scheduled.length, 0);
});
test('staging rejects uncommitted blobs, changed retries, missing pages, foreign objects and reordered paths', async () => {
  const s = await saveFixture(),
    change = s.change(),
    x = await s.prepare([change]);
  await assert.rejects(s.submit(x), code('SOURCE_JOB_INVALID'));
  await assert.rejects(
    s.call('prepare', api.prepare, {
      projectId: s.projectId,
      request: JSON.stringify({ ...x.request, message: 'changed' }),
    }),
    code('WORK_OPERATION_CHANGED'),
  );
  const row = [...s.tables.projectObjects.values()].find(row => row.digest === change.after.blob);
  s.patch('projectObjects', row._id, { r2Committed: false });
  await assert.rejects(s.stage(x), code('SOURCE_UNAVAILABLE'));
  s.patch('projectObjects', row._id, { r2Committed: true });
  await s.stage(x);
  await assert.rejects(
    s.call('stage', api.stage, {
      projectId: s.projectId,
      operationId: x.request.operationId,
      index: 0,
      page: JSON.stringify({ ...x.pages[0].value, changes: [s.change('other')] }),
    }),
    code('WORK_OPERATION_CHANGED'),
  );
  const foreign = s.change('foreign');
  const foreignRow = [...s.tables.projectObjects.values()].find(row => row.digest === foreign.after.blob);
  s.patch('projectObjects', foreignRow._id, { projectId: 'foreign-project' });
  const y = await s.prepare([foreign]);
  await assert.rejects(s.stage(y), code('SOURCE_UNAVAILABLE'));
});
test('source result cannot publish before a callback, with forged bytes, or with missing State membership', async () => {
  const s = await saveFixture(),
    x = await s.prepare([s.change()]);
  await s.stage(x);
  await s.submit(x);
  const pending = [...s.tables.projectHostedSaves.values()][0];
  await assert.rejects(
    s.call('publish', jobApi.publish, { projectId: s.projectId, jobId: pending.jobId, result: '{}' }),
    code('SOURCE_JOB_INVALID'),
  );
  const output = await s.work(x);
  await assert.rejects(
    s.publish({ ...output, manifest: output.manifest + ' ' }),
    code('SOURCE_HASH_MISMATCH'),
  );
  const stateRow = [...s.tables.projectObjects.values()].find(row => row.digest === output.head);
  s.patch('projectObjects', stateRow._id, { r2Committed: false });
  await assert.rejects(s.publish(output), code('SOURCE_UNAVAILABLE'));
  s.patch('projectObjects', stateRow._id, { r2Committed: true });
  assert.equal((await s.publish(output)).outcome.status, 'completed');
});
test('current contributor revocation and authority epochs are checked on staging, publication and completed retry', async () => {
  const s = await saveFixture(),
    grant = s.insert('projectContributors', { projectId: s.projectId, contributor: 'writer' });
  const x = await s.prepare([s.change()]);
  await s.stage(x);
  await s.submit(x);
  const output = await s.work(x);
  s.patch('hostedProjects', s.projectId, { sourceAuthority: { mode: 'server', epoch: 2 } });
  await assert.rejects(s.publish(output), code('SOURCE_AUTHORITY_CHANGED'));
  s.patch('hostedProjects', s.projectId, { sourceAuthority: { mode: 'server', epoch: 1 } });
  await s.publish(output);
  s.tables.projectContributors.delete(grant);
  await assert.rejects(
    s.call('prepare', api.prepare, { projectId: s.projectId, request: JSON.stringify(x.request) }, 'writer'),
    code('PROJECT_UNAVAILABLE'),
  );
  await assert.rejects(
    s.call('progress', api.progress, { projectId: s.projectId, operationId: randomUUID() }, null),
    code('PROJECT_UNAVAILABLE'),
  );
});
test('250 changed paths stage in bounded pages and final publication has constant reads', async t => {
  const s = await saveFixture(),
    changes = Array.from({ length: 250 }, (_, i) => {
      const pin = s.put(`value ${i}`);
      return {
        path: `new/${String(i).padStart(4, '0')}`,
        before: null,
        after: { blob: pin.sha256, mode: 'file', content: { object: pin, recipe: null } },
      };
    });
  const x = await s.prepare(changes);
  assert.deepEqual(
    x.pages.map(p => p.value.changes.length),
    [100, 100, 50],
  );
  await s.stage(x);
  await s.submit(x);
  const output = await s.work(x);
  await s.publish(output);
  t.diagnostic(JSON.stringify({ pages: x.pages.length, worker: output.metrics }));
});
test.after(() => console.log('H07 per-function maxima', JSON.stringify(maxima)));

test('callback finalizer completes without an editing client and reconciles a lost final reply', async t => {
  const s = await saveFixture(),
    x = await s.prepare([s.change()]);
  await s.stage(x);
  await s.submit(x);
  const output = await s.work(x);
  const env = {
      R2_ACCOUNT_ID: 'h07-finalize',
      R2_BUCKET: 'synthetic',
      R2_ACCESS_KEY_ID: 'synthetic-id',
      R2_SECRET_ACCESS_KEY: 'synthetic-secret',
    },
    saved = Object.fromEntries(Object.keys(env).map(k => [k, process.env[k]]));
  Object.assign(process.env, env);
  t.after(() => {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });
  let gets = 0;
  t.mock.method(globalThis, 'fetch', async () => {
    gets++;
    return new Response(output.manifest);
  });
  const ctx = {
    runMutation: async (ref, args) => {
      const { getFunctionName } = await import('convex/server');
      const name = getFunctionName(ref);
      return s.call(
        name.endsWith('resultDownload') ? 'resultDownload' : 'publish',
        name.endsWith('resultDownload') ? jobApi.resultDownload : jobApi.publish,
        args,
      );
    },
  };
  const terminal = JSON.parse(
    await jobApi.complete._handler(ctx, { projectId: s.projectId, jobId: output.jobId }),
  );
  assert.equal(terminal.outcome.status, 'completed');
  assert.equal(gets, 1);
  assert.equal(await jobApi.complete._handler(ctx, { projectId: s.projectId, jobId: output.jobId }), null);
  assert.equal(gets, 1);
});
