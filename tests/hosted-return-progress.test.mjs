// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { gunzipSync } from 'node:zlib';
import { getFunctionName } from 'convex/server';
import { moduleUrl } from './convex-module.mjs';
import { fixture, checkpoint, modules, upload } from './project-exchange-fixture.mjs';
import { materializeWork } from '../dist/work-hosted-index.js';
import { digest } from '../dist/hash.js';
const progress = await import(moduleUrl('../convex/projectSourceReturnProgress.ts'));
const stageStore = await import(moduleUrl('../convex/projectReturnIndexStage.ts'));
const index = await import(moduleUrl('../convex/projectWorkIndexActions.ts'));
const ordered = rows =>
  rows
    .map(({ collection, key, parent, position, value, actor, status }) => ({
      collection,
      key,
      parent,
      position,
      value,
      actor,
      status,
    }))
    .sort((a, b) =>
      JSON.stringify([a.collection, a.key]).localeCompare(JSON.stringify([b.collection, b.key])),
    );

async function setup(t, count = 24, width = 30) {
  const s = fixture(),
    base = await checkpoint(t, s);
  const backupId = await modules.projectExchangeActions.publish._handler(s.ctx, base.input);
  await modules.projectWorkActions.initialize._handler(s.ctx, {
    projectId: 'project',
    backupId,
    operationId: randomUUID(),
  });
  const generationId = await index.ensure._handler(s.ctx, { projectId: 'project' });
  const data = base.store.load(),
    parents = new Map(),
    states = new Map(),
    files = [],
    heads = [];
  for (let i = 0; i < count; i++) {
    const state = {
      schema: 1,
      kind: 'forge-source-state',
      parents: heads.length ? [heads.at(-1)] : [],
      files: Array.from({ length: width }, (_, j) => ({
        path: `file-${j}`,
        mode: 'file',
        blob: digest(j === 0 ? `change-${i}` : `fixed-${j}`),
      })),
      message: 'Synthetic',
      at: 'now',
    };
    const bytes = Buffer.from(JSON.stringify(state)),
      pin = await upload(s, bytes);
    heads.push(pin.sha256);
    parents.set(pin.sha256, state.parents);
    states.set(
      pin.sha256,
      state.files.map(({ path, blob, mode }) => ({ path, blob, mode })),
    );
    files.push({ path: `objects/${pin.sha256}`, ...pin });
  }
  data.nativeHead = heads.at(-1);
  data.revision = 2;
  data.intents.push({
    id: 'intent',
    base: heads[0],
    outcome: 'Synthetic long history',
    constraints: '',
    createdAt: 'now',
    status: 'active',
    notes: [],
  });
  data.lanes.push({
    id: 'lane',
    intentId: 'intent',
    base: heads[0],
    head: heads.at(-1),
    path: 'lane',
    createdAt: 'now',
    checkpoints: heads.slice(1).map((head, i) => ({ head, parent: heads[i], at: 'now', message: '' })),
  });
  data.views.push(
    ...heads
      .slice(1)
      .filter((_, i) => i % 4 === 0)
      .map((head, i) => ({
        id: `view-${i}`,
        intentId: 'intent',
        base: heads[0],
        head,
        status: 'clean',
        at: 'now',
        inputs: [{ laneId: 'lane', head }],
      })),
  );
  const manifest = { ...base.manifest, files, head: data.nativeHead, revision: 1 };
  const originalBackup = s.tables.projectBackups.get(backupId),
    candidateId = 'candidate';
  const backup = { ...originalBackup, _id: candidateId, preview: { ...originalBackup.preview, revision: 1 } };
  s.tables.projectBackups.set(candidateId, backup);
  const operationId = randomUUID(),
    input = { projectId: 'project', expectedBackupId: backupId, revision: 0, operationId };
  const partitionId = await stageStore.begin._handler(s.ctx, {
    projectId: 'project',
    owner: 'owner',
    generationId,
    revision: 0,
    backupId: candidateId,
    localRevision: 1,
    metadata: '{}',
    operationId,
    at: 'now',
    progress: true,
  });
  const initial = {
    snapshot: { data, manifest, backup },
    generationId,
    final: {
      projectId: 'project',
      owner: 'owner',
      backupId: candidateId,
      expectedBackupId: backupId,
      expectedRevision: 0,
      localRevision: 1,
      operationId,
      request: 'request',
      command: '{}',
      at: 'now',
    },
  };
  return {
    ...s,
    data,
    manifest,
    parents: Object.assign(parents, { files: states }),
    initial,
    input,
    partitionId,
    backupId,
  };
}

test('cursor continuation bounds transactions and RPCs, resumes lost steps and publishes exact complete projection', async t => {
  const s = await setup(t),
    saved = { ...progress.RETURN_BUDGET };
  Object.assign(progress.RETURN_BUDGET, { states: 3, sourceBytes: 12000, rows: 5, rowBytes: 40000 });
  t.after(() => Object.assign(progress.RETURN_BUDGET, saved));
  const mutation = s.ctx.runMutation,
    query = s.ctx.runQuery;
  let writes = 0,
    writeBytes = 0,
    reads = 0,
    readBytes = 0,
    steps = 0,
    dropped = false;
  const account = value => {
    if (value) {
      reads++;
      readBytes += Buffer.byteLength(JSON.stringify(value));
    }
    return value;
  };
  const get = s.ctx.db.get,
    dbQuery = s.ctx.db.query,
    insert = s.ctx.db.insert,
    patch = s.ctx.db.patch;
  s.ctx.db.get = async (...args) => account(await get(...args));
  s.ctx.db.query = (...args) => {
    const q = dbQuery(...args);
    const unique = q.unique;
    q.unique = async (...a) => account(await unique(...a));
    return q;
  };
  s.ctx.db.insert = async (table, row) => {
    writes++;
    writeBytes += Buffer.byteLength(JSON.stringify(row));
    return insert(table, row);
  };
  s.ctx.db.patch = async (id, row) => {
    writes++;
    writeBytes += Buffer.byteLength(JSON.stringify(row));
    return patch(id, row);
  };
  s.ctx.runQuery = async (ref, args) => {
    assert(Buffer.byteLength(JSON.stringify(args)) < 64000);
    reads = readBytes = 0;
    const result = await query(ref, args);
    assert(reads <= 20);
    assert(readBytes < 128000);
    assert(Buffer.byteLength(JSON.stringify(result)) < 128000);
    return result;
  };
  s.ctx.runMutation = async (ref, args) => {
    reads = readBytes = writes = writeBytes = 0;
    assert(Buffer.byteLength(JSON.stringify(args)) < 64000);
    const result = await mutation(ref, args);
    assert(writes <= 10, `transaction writes ${writes}`);
    assert(writeBytes < 64000);
    assert(reads <= 30);
    assert(readBytes < 128000);
    assert(Buffer.byteLength(JSON.stringify(result)) < 64000);
    if (getFunctionName(ref) === 'projectReturnIndexStage:batch' && args.step === 2 && !dropped) {
      dropped = true;
      throw Error('synthetic lost reply');
    }
    return result;
  };
  const log = console.log,
    diagnostics = [];
  console.log = (name, fields) => diagnostics.push({ name, ...fields });
  t.after(() => {
    console.log = log;
  });
  let receipt;
  do {
    assert(steps++ < 1000, 'continuations terminate');
    const stage = structuredClone(s.tables.projectWorkGenerations.get(s.partitionId));
    try {
      receipt = await progress.returnProgress(s.ctx, stage, s.input, 'owner', s.initial);
    } catch (error) {
      assert.equal(error.message, 'synthetic lost reply');
    }
    if (!receipt) {
      assert.equal(s.tables.hostedProjects.get('project').work.backupId, s.backupId);
      assert(![...s.tables.projectWorkEvents.values()].some(e => e.operationId === s.input.operationId));
    }
  } while (!receipt);
  assert(dropped);
  assert(diagnostics.filter(d => d.name === 'source-return step').length > 30);
  assert(
    steps < diagnostics.filter(d => d.name === 'source-return step').length,
    'one action advances many durable steps',
  );
  for (const d of diagnostics.filter(d => d.name === 'source-return step')) {
    assert(d.rows <= 5);
    assert(d.rowBytes <= 40000);
    assert(d.states <= 3);
    assert(d.sourceBytes <= 12000);
  }
  const expected = materializeWork(s.data, s.manifest, [], 'objects', s.parents);
  assert.deepEqual(
    ordered([...s.tables.projectWorkRecords.values()].filter(r => r.generationId === s.partitionId)),
    ordered(expected.entries),
  );
  assert.deepEqual(
    JSON.parse(s.tables.projectWorkGenerations.get(s.partitionId).metadata),
    expected.metadata,
  );
  assert.equal(s.tables.projectWorkGenerations.get(s.partitionId).returnCursor, undefined);
  assert.equal(receipt.at, 'now');
  assert.equal(
    [...s.tables.projectWorkEvents.values()].filter(e => e.operationId === s.input.operationId).length,
    1,
  );
});

test('durable cursors keep the immutable snapshot once and resume legacy embedded snapshots', async t => {
  const s = await setup(t, 8, 1425),
    mutate = s.ctx.runMutation;
  let dropped = false;
  s.ctx.runMutation = async (ref, args) => {
    const result = await mutate(ref, args);
    if (getFunctionName(ref) === 'projectReturnIndexStage:batch' && !dropped) {
      dropped = true;
      throw Error('synthetic lost reply');
    }
    return result;
  };
  await assert.rejects(
    progress.returnProgress(
      s.ctx,
      structuredClone(s.tables.projectWorkGenerations.get(s.partitionId)),
      s.input,
      'owner',
      s.initial,
    ),
    /synthetic lost reply/,
  );
  const stage = s.tables.projectWorkGenerations.get(s.partitionId);
  // Cursor and snapshot bodies are gzip JSON.
  const stored = async id => {
    const blob = await s.ctx.storage.get(id);
    assert.equal(blob.type, 'application/gzip');
    return JSON.parse(gunzipSync(Buffer.from(await blob.arrayBuffer())).toString('utf8'));
  };
  const position = await stored(stage.returnCursor);
  assert.equal(position.snapshot, undefined);
  assert.equal(position.snapshotRef, stage.returnSnapshot);
  assert.deepEqual(await stored(stage.returnSnapshot), s.initial.snapshot);
  const originalSnapshot = stage.returnSnapshot;
  // Simulate an already committed pre-deployment cursor, then resume its same pins.
  position.snapshot = s.initial.snapshot;
  delete position.snapshotRef;
  stage.returnCursor = await s.ctx.storage.store(new Blob([JSON.stringify(position)]));
  delete stage.returnSnapshot;
  s.ctx.runMutation = mutate;
  let receipt;
  do {
    receipt = await progress.returnProgress(s.ctx, structuredClone(stage), s.input, 'owner');
  } while (!receipt);
  assert.equal(stage.returnSnapshot, undefined);
  assert.equal(stage.returnCursor, undefined);
  assert.equal(receipt.at, 'now');
  // The synthetic legacy conversion orphaned this fixture-only original snapshot.
  await s.ctx.storage.delete(originalSnapshot);
});

test('continuation rechecks owner and source CAS and rejects changed original pins', async t => {
  for (const scenario of ['owner', 'revision', 'pins']) {
    const s = await setup(t, 2, 2);
    const mutate = s.ctx.runMutation;
    s.ctx.runMutation = async (ref, args) => {
      const result = await mutate(ref, args);
      if (getFunctionName(ref) === 'projectReturnIndexStage:batch')
        throw Error('synthetic interrupt after commit');
      return result;
    };
    await assert.rejects(
      progress.returnProgress(
        s.ctx,
        structuredClone(s.tables.projectWorkGenerations.get(s.partitionId)),
        s.input,
        'owner',
        s.initial,
      ),
      /synthetic interrupt after commit/,
    );
    s.ctx.runMutation = mutate;
    if (scenario === 'owner') s.tables.hostedProjects.get('project').owner = 'other';
    if (scenario === 'revision') {
      const head = [...s.tables.projectWorkHeads.values()][0];
      (head ?? s.tables.hostedProjects.get('project').work).revision++;
    }
    const input = { ...s.input, ...(scenario === 'pins' ? { revision: 1 } : {}) };
    await assert.rejects(
      progress.returnProgress(
        s.ctx,
        structuredClone(s.tables.projectWorkGenerations.get(s.partitionId)),
        input,
        'owner',
      ),
      e => ['PROJECT_UNAVAILABLE', 'WORK_STALE', 'WORK_OPERATION_CHANGED'].includes(e.data?.code ?? e.code),
    );
    assert.equal(s.tables.hostedProjects.get('project').work.backupId, s.backupId);
  }
});

test('9,200 retained objects and 854 MiB logical source publish through bounded steps', async t => {
  const s = await setup(t, 24, 30);
  const files = s.manifest.files,
    logicalTarget = 854 * 1024 * 1024;
  let remaining = logicalTarget - files.reduce((sum, p) => sum + p.size, 0);
  while (files.length < 9200) {
    const size = Math.floor(remaining / (9200 - files.length)),
      sha256 = digest(`synthetic-blob-${files.length}`);
    files.push({ path: `objects/${sha256}`, sha256, size });
    remaining -= size;
  }
  assert.equal(
    files.reduce((sum, p) => sum + p.size, 0),
    logicalTarget,
  );
  const log = console.log,
    diagnostics = [];
  console.log = (name, fields) => diagnostics.push({ name, ...fields });
  t.after(() => {
    console.log = log;
  });
  let receipt,
    steps = 0;
  do {
    assert(steps++ < 500);
    receipt = await progress.returnProgress(
      s.ctx,
      structuredClone(s.tables.projectWorkGenerations.get(s.partitionId)),
      s.input,
      'owner',
      s.initial,
    );
  } while (!receipt);
  for (const d of diagnostics.filter(d => d.name === 'source-return step')) {
    assert(d.rows <= 100);
    assert(d.rowBytes <= 500000);
    assert(d.states <= 16);
    assert(d.sourceBytes <= 2 * 1024 * 1024);
  }
  const actual = [...s.tables.projectWorkRecords.values()].filter(r => r.generationId === s.partitionId);
  assert.equal(actual.filter(r => r.collection === 'sourceBlobs').length, 9200);
  assert.equal(actual.filter(r => r.collection === 'viewDetails').length, s.data.views.length);
  t.diagnostic(
    JSON.stringify({ objects: files.length, logicalBytes: logicalTarget, steps, rows: actual.length }),
  );
});

test('exchange client loops over pending continuations using identical original pins', async () => {
  const { ConvexExchange } = await import('../dist/exchange-client.js');
  const transport = new ConvexExchange(
    'https://fixture.invalid',
    'synthetic-token',
    'project',
    randomUUID(),
    null,
  );
  const calls = [],
    receipt = { operationId: 'receipt', revision: 42 };
  transport.client.action = async (ref, args) => {
    assert.equal(getFunctionName(ref), 'projectSourceReturn:returnSource');
    calls.push(args);
    return calls.length < 4 ? { pending: true } : receipt;
  };
  assert.deepEqual(await transport.returnSource('new', 'old', 41, 'original'), receipt);
  assert.equal(calls.length, 4);
  assert(calls.every(c => JSON.stringify(c) === JSON.stringify(calls[0])));
  assert.equal(calls[0].continuation, true);
});

test('R3 write-only stage restarts disposable rows and retains the original timestamp', async t => {
  const s = await setup(t, 2, 2),
    old = s.tables.projectWorkGenerations.get(s.partitionId);
  old.nextBatch = 7;
  delete old.returnStep;
  const next = await stageStore.begin._handler(s.ctx, {
    projectId: 'project',
    owner: 'owner',
    generationId: s.initial.generationId,
    revision: 0,
    backupId: 'candidate',
    localRevision: 1,
    metadata: '{}',
    operationId: s.input.operationId,
    at: 'now',
    progress: true,
  });
  assert.notEqual(next, old._id);
  assert.equal(old.returnOperationId, undefined);
  assert.equal(s.tables.projectWorkGenerations.get(next).returnAt, 'now');
  assert.equal(s.tables.projectWorkGenerations.get(next).nextBatch, 0);
  assert.equal(s.tables.hostedProjects.get('project').work.backupId, s.backupId);
});

test('unavailable optional ancestry/provenance remains unknown without denying source return', async t => {
  const s = await setup(t, 8, 5),
    query = s.ctx.runQuery;
  s.ctx.runQuery = (ref, args) => {
    if (getFunctionName(ref) === 'projectObjects:resolve')
      throw Error('synthetic unavailable derived source');
    return query(ref, args);
  };
  const log = console.log;
  console.log = () => {};
  t.after(() => {
    console.log = log;
  });
  let receipt,
    steps = 0;
  do {
    assert(steps++ < 100);
    receipt = await progress.returnProgress(
      s.ctx,
      structuredClone(s.tables.projectWorkGenerations.get(s.partitionId)),
      s.input,
      'owner',
      s.initial,
    );
  } while (!receipt);
  const details = [...s.tables.projectWorkRecords.values()].filter(
    r => r.generationId === s.partitionId && r.collection === 'viewDetails',
  );
  assert.equal(details.length, s.data.views.length);
  assert(details.every(r => JSON.parse(r.value).provenanceAvailable === false));
  assert.equal(s.tables.hostedProjects.get('project').work.backupId, 'candidate');
});

test('an in-flight R3 writer cannot append into a computational cursor partition', async t => {
  const s = await setup(t, 2, 2),
    row = s.tables.projectWorkGenerations.get(s.partitionId);
  row.returnStep = 0;
  const before = s.tables.projectWorkRecords.size;
  assert.equal(
    await stageStore.batch._handler(s.ctx, {
      projectId: 'project',
      owner: 'owner',
      generationId: s.initial.generationId,
      revision: 0,
      partitionId: s.partitionId,
      batch: 0,
      entries: [{ collection: 'intents', key: 'legacy', parent: '', position: 0, value: '{}' }],
      last: false,
    }),
    false,
  );
  assert.equal(s.tables.projectWorkRecords.size, before);
  assert.equal(row.nextBatch, 0);
  assert.equal(row.returnStep, 0);
});

test('native return cursor publishes Lane/View diffstats once with changed-file bytes and current authority', async t => {
  const s = await setup(t, 4, 2);
  const { compare } = await import(moduleUrl('../convex/projectDiffstats.ts'));
  for (let i = 0; i < 4; i++) {
    const pin = await upload(s, Buffer.from(`change-${i}`));
    s.manifest.files.push({ path: `objects/${pin.sha256}`, ...pin });
  }
  const action = s.ctx.runAction;
  let comparisons = 0;
  s.ctx.runAction = (ref, args) => {
    if (getFunctionName(ref) === 'projectDiffstats:compare') {
      comparisons++;
      return compare._handler(s.ctx, args);
    }
    return action(ref, args);
  };
  let receipt;
  for (let step = 0; step < 200 && !receipt; step++) {
    const stage = structuredClone(s.tables.projectWorkGenerations.get(s.partitionId));
    receipt = await progress.returnProgress(s.ctx, stage, s.input, 'owner', s.initial);
  }
  assert.ok(receipt);
  const rows = [...s.tables.projectWorkRecords.values()].filter(row => row.generationId === s.partitionId);
  for (const collection of ['lanes', 'views']) {
    const records = rows.filter(row => row.collection === collection);
    assert.equal(records.length, 1);
    assert.deepEqual(JSON.parse(records[0].value).changes, { files: 1, add: 1, del: 1 });
  }
  assert.equal(comparisons, 2);
  assert.equal(rows.filter(row => row.collection === 'diffstats').length, 2);
  assert.equal(JSON.parse(s.tables.projectWorkGenerations.get(s.partitionId).metadata).counts.diffstats, 2);
});

test('full-partition diffstats batch many records into each durable step', async t => {
  const s = await setup(t, 41, 2);
  for (let i = 0; i < 41; i++) {
    const pin = await upload(s, Buffer.from(`change-${i}`));
    s.manifest.files.push({ path: `objects/${pin.sha256}`, ...pin });
  }
  const records = s.data.lanes.length + s.data.views.length;
  const mutate = s.ctx.runMutation;
  let diffstatSteps = 0;
  s.ctx.runMutation = async (ref, args) => {
    if (
      getFunctionName(ref) === 'projectReturnIndexStage:batch' &&
      JSON.parse(args.progress).phase === 'diffstats'
    )
      diffstatSteps++;
    return mutate(ref, args);
  };
  const log = console.log;
  console.log = () => {};
  t.after(() => {
    console.log = log;
  });
  let receipt;
  for (let call = 0; call < 50 && !receipt; call++)
    receipt = await progress.returnProgress(
      s.ctx,
      structuredClone(s.tables.projectWorkGenerations.get(s.partitionId)),
      s.input,
      'owner',
      s.initial,
    );
  assert.ok(receipt);
  // One record used to take a step per State read and per compare batch (3+ each).
  t.diagnostic(JSON.stringify({ records, diffstatSteps }));
  assert.ok(diffstatSteps * 2 <= records, `${diffstatSteps} diffstat steps for ${records} records`);
  const rows = [...s.tables.projectWorkRecords.values()].filter(row => row.generationId === s.partitionId);
  assert.equal(rows.filter(row => row.collection === 'views').length, s.data.views.length);
  for (const view of rows.filter(row => row.collection === 'views'))
    assert.deepEqual(JSON.parse(view.value).changes, { files: 1, add: 1, del: 1 });
  assert.equal(receipt.accounting.steps, s.tables.projectWorkGenerations.get(s.partitionId).returnStep);
});

test('an optional per-push budget stops after a committed step and resumes once raised', async t => {
  const s = await setup(t, 8, 5),
    saved = { ...progress.RETURN_BUDGET };
  Object.assign(progress.RETURN_BUDGET, { states: 1 });
  const log = console.log;
  console.log = () => {};
  t.after(() => {
    console.log = log;
    Object.assign(progress.RETURN_BUDGET, saved);
    delete process.env.FORGE_SOURCE_RETURN_MAX_STEPS;
  });
  process.env.FORGE_SOURCE_RETURN_MAX_STEPS = '1';
  const run = () =>
    progress.returnProgress(
      s.ctx,
      structuredClone(s.tables.projectWorkGenerations.get(s.partitionId)),
      s.input,
      'owner',
      s.initial,
    );
  await assert.rejects(
    run(),
    e => e.code === 'SOURCE_RETURN_BUDGET' && /push again to resume/.test(e.message),
  );
  const stopped = s.tables.projectWorkGenerations.get(s.partitionId);
  assert.equal(stopped.returnStep, 2, 'progress through the stopping step is saved');
  await assert.rejects(run(), e => e.code === 'SOURCE_RETURN_BUDGET');
  assert.equal(s.tables.hostedProjects.get('project').work.backupId, s.backupId);
  delete process.env.FORGE_SOURCE_RETURN_MAX_STEPS;
  let receipt;
  for (let call = 0; call < 50 && !receipt; call++) receipt = await run();
  assert.equal(receipt.at, 'now');
  assert.equal(s.tables.hostedProjects.get('project').work.backupId, 'candidate');
});

test('a duplicate continuation that reads a replaced cursor returns pending', async t => {
  const s = await setup(t, 8),
    saved = { ...progress.RETURN_BUDGET };
  Object.assign(progress.RETURN_BUDGET, { actionSteps: 1, states: 1, rows: 5 });
  t.after(() => Object.assign(progress.RETURN_BUDGET, saved));
  await progress.returnProgress(
    s.ctx,
    structuredClone(s.tables.projectWorkGenerations.get(s.partitionId)),
    s.input,
    'owner',
    s.initial,
  );
  const stage = structuredClone(s.tables.projectWorkGenerations.get(s.partitionId));
  assert(stage.returnCursor);
  const getMetadata = s.ctx.storage.getMetadata;
  let enter,
    release,
    held = false;
  const entered = new Promise(resolve => {
    enter = resolve;
  });
  const wait = new Promise(resolve => {
    release = resolve;
  });
  s.ctx.storage.getMetadata = async id => {
    if (id === stage.returnCursor && !held) {
      held = true;
      enter();
      await wait;
    }
    return getMetadata(id);
  };
  const duplicate = progress.returnProgress(s.ctx, stage, s.input, 'owner');
  await entered;
  await progress.returnProgress(s.ctx, structuredClone(stage), s.input, 'owner');
  release();
  assert.equal(await duplicate, null);
});

test('a late duplicate batch after publication returns the original receipt', async t => {
  const s = await setup(t, 3),
    mutate = s.ctx.runMutation;
  let enter,
    release,
    held = false;
  const entered = new Promise(resolve => {
    enter = resolve;
  });
  const wait = new Promise(resolve => {
    release = resolve;
  });
  s.ctx.runMutation = async (ref, input) => {
    if (getFunctionName(ref) === 'projectReturnIndexStage:batch' && !held) {
      held = true;
      enter();
      await wait;
    }
    return mutate(ref, input);
  };
  const stage = structuredClone(s.tables.projectWorkGenerations.get(s.partitionId));
  const duplicate = progress.returnProgress(s.ctx, stage, s.input, 'owner', s.initial);
  await entered;
  let receipt;
  do {
    receipt = await progress.returnProgress(
      s.ctx,
      structuredClone(s.tables.projectWorkGenerations.get(s.partitionId)),
      s.input,
      'owner',
      s.initial,
    );
  } while (!receipt);
  release();
  const { accounting: _accounting, ...stored } = receipt;
  assert.deepEqual(await duplicate, stored);
  assert.equal(
    [...s.tables.projectWorkEvents.values()].filter(e => e.operationId === s.input.operationId).length,
    1,
  );
});

test('competing preparation timestamps preserve the reserved stage without a mutation error', async t => {
  const s = await setup(t, 3),
    before = structuredClone(s.tables.projectWorkGenerations.get(s.partitionId));
  const args = {
    projectId: 'project',
    owner: 'owner',
    generationId: s.initial.generationId,
    revision: s.input.revision,
    backupId: before.backupId,
    localRevision: 1,
    metadata: '{}',
    operationId: s.input.operationId,
    at: 'competing timestamp',
    progress: true,
  };
  assert.equal(await stageStore.begin._handler(s.ctx, args), null);
  assert.deepEqual(s.tables.projectWorkGenerations.get(s.partitionId), before);
  await assert.rejects(
    stageStore.begin._handler(s.ctx, { ...args, backupId: 'other' }),
    error => error.data?.code === 'WORK_OPERATION_CHANGED',
  );
});
