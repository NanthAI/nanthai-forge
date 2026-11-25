// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Ferdinando Valsecchi
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { saveBytes } from '../dist/hosted-save.js';
import { saveFixture, api, jobApi, maxima } from './hosted-saves-fixture.mjs';
const code = value => error => (error.data?.code ?? error.code) === value;

test('lost stage, submit and final replies reconcile exactly one save without rewinding later work', async () => {
  const s = await saveFixture(),
    x = await s.prepare([s.change()]);
  await s.stage(x);
  await s.stage(x);
  const first = await s.submit(x),
    second = await s.submit(x);
  for (const io of s.counts.filter(row => row.name === 'submit'))
    assert.equal(
      io.readDocumentsByTable.projectHostedSaves,
      1,
      'a staged submit or its retry reads one save',
    );
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
test('final-page submit reads its save once, fences unfinished writes and replays a terminal receipt', async t => {
  const s = await saveFixture();
  const prepare = async change => {
    const x = await s.prepare([s.change(change)]);
    const page = x.pages[0].value;
    s.put(saveBytes(page));
    s.put(saveBytes(x.result.input));
    return { x, input: { index: 0, page: JSON.stringify(page) } };
  };
  const { x, input } = await prepare('change through final-page submit');
  const stale = await prepare('prepared before the authority changed');
  const submitted = await s.submit(x, input, true);
  assert.equal(submitted.status, 'submitted');
  assert.equal(s.tables.projectHostedSavePages.size, 1);
  const io = s.counts.findLast(row => row.name === 'submit');
  t.diagnostic(
    `final-page submit: ${io.documents} docs / ${io.readBytes} B read; ${io.writeBytes} B written`,
  );
  assert.equal(io.readDocumentsByTable.projectHostedSaves, 1);
  const terminal = await s.publish(await s.work(x));
  assert.equal(terminal.outcome.status, 'completed');

  s.patch('hostedProjects', s.projectId, { sourceAuthority: { mode: 'server', epoch: 2 } });
  await assert.rejects(s.submit(stale.x, stale.input, true), code('SOURCE_AUTHORITY_CHANGED'));
  assert.equal(s.tables.projectHostedSavePages.size, 1, 'the stale final page binds no data');
  assert.deepEqual(await s.submit(x, input, true), terminal, 'completed receipts replay across epochs');
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

test('a clean save reports the saving run’s hook state, and a retry keeps the original report', async () => {
  const s = await saveFixture();
  const overlap = [...s.tables.projectHostedOverlapLanes.values()].find(row => row.laneId === s.laneId);
  s.patch('projectHostedOverlapLanes', overlap._id, { agent: 'amber-fox' });
  const x = await s.prepare([], { authorship: { kind: 'agent' }, agentRun: 'amber-moth', hooks: 'off' });
  assert.equal(
    [...s.tables.projectHostedRecordHeads.values()].some(row => row.hooks),
    false,
    'preparing publishes no report',
  );
  await s.call('prepare', api.prepare, {
    projectId: s.projectId,
    request: JSON.stringify({ ...x.request, hooks: 'configured' }),
  });
  const terminal = await s.submit(x);
  assert.equal(terminal.outcome.result.unchanged, true);
  const save = [...s.tables.projectHostedRecordHeads.values()].find(row => row.kind === 'save');
  assert.deepEqual(save.hooks, {
    actor: 'owner',
    run: 'amber-moth',
    state: 'off',
    at: Date.parse(terminal.at),
  });
  assert.equal(s.tables.projectHostedOverlapLanes.get(overlap._id).agent, 'amber-fox');
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
test('publication and result download refuse a rolled epoch; publication loads its save once and a completed receipt replays', async t => {
  const s = await saveFixture(),
    x = await s.prepare([s.change()]);
  await s.stage(x);
  await s.submit(x);
  const output = await s.work(x);
  const download = () =>
    s.call('resultDownload', jobApi.resultDownload, { projectId: s.projectId, jobId: output.jobId });
  s.patch('hostedProjects', s.projectId, { sourceAuthority: { mode: 'server', epoch: 2 } });
  await assert.rejects(download(), code('SOURCE_AUTHORITY_CHANGED'));
  await assert.rejects(s.publish(output), code('SOURCE_AUTHORITY_CHANGED'));
  s.patch('hostedProjects', s.projectId, { sourceAuthority: { mode: 'server', epoch: 1 } });
  const terminal = await s.publish(output);
  assert.equal(terminal.outcome.status, 'completed');
  const io = s.counts.findLast(row => row.name === 'publish');
  // The job-index lookup and one loadSave; a second loadSave after terminal replay was the duplicate.
  assert.equal(io.readDocumentsByTable.projectHostedSaves, 2, 'publication loads its save once');
  t.diagnostic(`publish reads ${JSON.stringify(io.readDocumentsByTable)}`);
  s.patch('hostedProjects', s.projectId, { sourceAuthority: { mode: 'server', epoch: 2 } });
  assert.equal(await download(), null, 'a completed save has no result to download, whatever the epoch');
  assert.deepEqual(await s.publish(output), terminal, 'a completed receipt replays across epochs');
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
  // The job-index lookup and one loadSave (a second loadSave after the terminal check was the duplicate).
  const download = s.counts.findLast(row => row.name === 'resultDownload');
  assert.equal(download.readDocumentsByTable.projectHostedSaves, 2, 'a result download loads its save once');
  assert.equal(gets, 1);
  assert.equal(await jobApi.complete._handler(ctx, { projectId: s.projectId, jobId: output.jobId }), null);
  assert.equal(gets, 1);
});

for (const changed of [false, true]) {
  test(`save duration retains client plus server work on replay with unchanged calls and row writes (${changed ? 'changed' : 'clean'})`, async t => {
    let now = Date.parse('2026-11-10T12:00:00Z');
    t.mock.method(Date, 'now', () => now);
    const run = async measured => {
      const s = await saveFixture(),
        x = await s.prepare(changed ? [s.change()] : []);
      await s.stage(x);
      let terminal = await s.submit(x, measured ? { clientMs: 12000 } : {});
      now += 3000;
      if (changed) terminal = await s.publish(await s.work(x));
      const counts = s.counts.map(c => ({ name: c.name, documents: c.documents, writes: c.writes }));
      return { s, x, terminal, counts };
    };
    const baseline = await run(false),
      measured = await run(true);
    assert.deepEqual(measured.counts, baseline.counts, 'same Convex calls, document reads and row writes');
    const duration = changed ? 15000 : 12000;
    assert.equal(measured.terminal.outcome.result.durationMs, duration);
    const saved = [...measured.s.tables.projectHostedRecordHeads.values()].find(row => row.kind === 'save');
    assert.equal(
      JSON.parse(
        measured.s.tables.projectHostedRecordBodies.get(
          measured.s.tables.projectHostedRecords.get(saved.recordId).bodyId,
        ).value,
      ).durationMs,
      duration,
    );
    now += 90000;
    assert.deepEqual(
      await measured.s.submit(measured.x, { clientMs: 99999 }),
      measured.terminal,
      'retry retains original timing',
    );
    assert.equal(
      baseline.terminal.outcome.result.durationMs,
      undefined,
      'older clients retain their reply shape',
    );
    const added =
      Buffer.byteLength(JSON.stringify(measured.terminal.outcome.result)) -
      Buffer.byteLength(JSON.stringify(baseline.terminal.outcome.result));
    assert(added <= 100, 'duration adds at most 100 bytes to a save row or reply');
    const sum = (s, key) => s.counts.reduce((total, count) => total + count[key], 0);
    t.diagnostic(
      `save duration metadata: reply +${added} B; DB writes +${sum(measured.s, 'writeBytes') - sum(baseline.s, 'writeBytes')} B before replay`,
    );
  });
}

test('bad optional save timing never prevents saving source, and unsafe totals remain unknown', async () => {
  const { saveDurationMs } = await import('../dist/hosted-save.js');
  assert.equal(saveDurationMs(Number.MAX_SAFE_INTEGER, 1), undefined, 'overflow cannot fail publication');
  assert.equal(saveDurationMs(12000, 3000), 15000);
  for (const clientMs of [-1, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
    const s = await saveFixture(),
      x = await s.prepare([]);
    const result = await s.submit(x, { clientMs });
    assert.equal(result.outcome.status, 'completed');
    assert.equal(result.outcome.result.durationMs, undefined);
  }
});

test('save preparation retries after a model or app switch retain the original source and declaration', async () => {
  const s = await saveFixture();
  const first = await s.prepare([s.change()], {
    authorship: { kind: 'agent' },
    agentClient: 'fixture:model-one',
    agentRun: 'run-one',
  });
  const replay = JSON.parse(
    await s.call('prepare', api.prepare, {
      projectId: s.projectId,
      request: JSON.stringify({
        ...first.request,
        authorship: { kind: 'agent', declaration: 'unknown' },
        agentClient: 'another:model-two',
        agentRun: 'run-two',
      }),
    }),
  );
  assert.equal(replay.state.request.agentClient, 'fixture:model-one');
  assert.equal(replay.state.request.agentRun, 'run-one');
  assert.deepEqual(replay.input, first.result.input);
  assert.equal(s.tables.projectHostedSaves.size, 1);
});

test('canonical saves retain each declared model and person independently across one mixed Lane', async () => {
  const { moduleUrl } = await import('./convex-module.mjs');
  const records = await import(moduleUrl('../convex/projectHostedRecords.ts'));
  const { readAuthorship } = await import('../dist/work-actor-types.js');
  const s = await saveFixture();
  let expected = { ...s.expected };
  let before;
  const saved = [];
  for (const [i, stamp] of [
    { authorship: { kind: 'agent' }, agentClient: 'fixture:model-one', agentRun: 'quiet-otter' },
    { authorship: { kind: 'agent' }, agentClient: 'another:model-two', agentRun: 'quiet-otter' },
    { authorship: { kind: 'person' } },
    {},
  ].entries()) {
    const change = s.change(`version-${i}`);
    if (before) change.before = before;
    before = { blob: change.after.blob, mode: change.after.mode };
    const x = await s.prepare([change], { expected, ...stamp });
    await s.stage(x);
    await s.submit(x);
    const result = (await s.publish(await s.work(x))).outcome.result;
    assert.deepEqual(result.authorship, stamp.authorship);
    const read = await s.call(
      'readSavedAuthorship',
      {
        _handler: ctx =>
          records.readHostedRecord(ctx, {
            projectId: s.projectId,
            actor: 'owner',
            kind: 'save',
            key: result.saveId,
          }),
      },
      {},
    );
    const value = JSON.parse(read.value);
    assert.deepEqual(value.authorship, stamp.authorship);
    assert.equal(value.actor, 'owner', 'the account is server-owned and stored once');
    assert.equal(value.agentClient, stamp.agentClient);
    assert.equal(value.agentRun, stamp.agentRun);
    saved.push({ id: result.saveId, stamp: readAuthorship(value) });
    expected = {
      head: result.head,
      version: result.version,
      sourceVersion: result.sourceVersion,
      lifecycleVersion: 0,
    };
  }
  assert.deepEqual(
    saved.map(s => s.stamp.model),
    ['model-one', 'model-two', null, 'not-declared'],
  );
  const first = await s.call(
    'readFirstSaveAgain',
    {
      _handler: ctx =>
        records.readHostedRecord(ctx, {
          projectId: s.projectId,
          actor: 'owner',
          kind: 'save',
          key: saved[0].id,
        }),
    },
    {},
  );
  assert.equal(readAuthorship(JSON.parse(first.value)).model, 'model-one');
});
