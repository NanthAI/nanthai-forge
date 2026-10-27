import test from 'node:test';
import assert from 'node:assert/strict';
import { getFunctionName } from 'convex/server';
import { moduleUrl } from './convex-module.mjs';
import { fixture, upload } from './project-exchange-fixture.mjs';
import { readHosted } from './hosted-read.mjs';
const { exchangeObjectReader } = await import(moduleUrl('../convex/projectExchangeReader.ts'));
const code = expected => error => (error.data?.code ?? error.code) === expected;

test('one action reuses verified immutable bytes but preserves current access and storage checks on every use', async () => {
  const s = fixture(),
    bytes = Buffer.from('unchanged metadata'),
    pin = await upload(s, bytes),
    reader = exchangeObjectReader(s.ctx);
  const run = s.ctx.runQuery,
    metadata = s.ctx.storage.getMetadata;
  let resolutions = 0,
    metadataReads = 0;
  s.ctx.runQuery = async (...args) => {
    if (getFunctionName(args[0]) === 'projectObjects:resolve') resolutions++;
    return run(...args);
  };
  s.ctx.storage.getMetadata = async (...args) => {
    metadataReads++;
    return metadata(...args);
  };
  const first = (await reader.read('project', 'owner', [pin]))[0];
  first.fill(0);
  assert.deepEqual(await reader.read('project', 'owner', [pin]), [bytes]);
  assert.equal(s.reads(), 1);
  assert.equal(resolutions, 4);
  assert.equal(metadataReads, 2);
  assert.deepEqual(await exchangeObjectReader(s.ctx).read('project', 'owner', [pin]), [bytes]);
  assert.equal(s.reads(), 2, 'a new action does not inherit memoized bytes');
  await assert.rejects(reader.read('project', 'stranger', [pin]), code('PROJECT_UNAVAILABLE'));
  s.tables.hostedProjects.get('project').removal = 'deleting';
  await assert.rejects(reader.read('project', 'owner', [pin]), code('PROJECT_UNAVAILABLE'));
});

test('logical State pins use bounded initial and final resolve windows without changing their order', async () => {
  const s = fixture(),
    windows = [],
    bytes = Buffer.alloc(700000, 1);
  const pins = [];
  for (let i = 0; i < 6; i++) {
    bytes[0] = i;
    pins.push(await upload(s, Buffer.from(bytes)));
  }
  const query = s.ctx.runQuery;
  s.ctx.runQuery = (ref, args) => {
    if (getFunctionName(ref) === 'projectObjects:resolve') windows.push(args.digests);
    return query(ref, args);
  };
  const values = await exchangeObjectReader(s.ctx, false, 0).read('project', 'owner', pins);
  assert.deepEqual(
    values.map(b => b[0]),
    [0, 1, 2, 3, 4, 5],
  );
  assert.equal(windows.length, 6);
  assert(windows.every(w => w.length === 2));
  await assert.rejects(
    exchangeObjectReader(s.ctx).read('project', 'stranger', []),
    code('PROJECT_UNAVAILABLE'),
  );
});

test('memoized bytes are isolated by project, exact pin and storage identity; removed storage is not hidden', async () => {
  const s = fixture(),
    bytes = Buffer.from('shared bytes'),
    pin = await upload(s, bytes),
    reader = exchangeObjectReader(s.ctx);
  await reader.read('project', 'owner', [pin]);
  s.tables.hostedProjects.set('other', { ...s.tables.hostedProjects.get('project'), _id: 'other' });
  await upload(s, bytes, 'other');
  await reader.read('other', 'owner', [pin]);
  assert.equal(s.reads(), 2);
  await assert.rejects(
    reader.read('project', 'owner', [{ ...pin, size: pin.size + 1 }]),
    code('INVALID_WORK_BACKUP'),
  );
  const row = [...s.tables.projectObjects.values()].find(row => row.projectId === 'project');
  row.storageId = await s.ctx.storage.store(new Blob([bytes]));
  await reader.read('project', 'owner', [pin]);
  assert.equal(s.reads(), 3);
  s.files.delete(row.storageId);
  await assert.rejects(reader.read('project', 'owner', [pin]), code('INVALID_WORK_BACKUP'));
});

test('concurrent equal reads share only successful bytes, settle failures and recheck grants after retrieval', async () => {
  const s = fixture(),
    bytes = Buffer.from('verified content'),
    pin = await upload(s, bytes),
    reader = exchangeObjectReader(s.ctx);
  await Promise.all([reader.read('project', 'owner', [pin]), reader.read('project', 'owner', [pin])]);
  assert.equal(s.reads(), 1);
  const row = [...s.tables.projectObjects.values()][0],
    broken = exchangeObjectReader(s.ctx),
    saved = s.files.get(row.storageId).blob;
  s.files.get(row.storageId).blob = new Blob(['wrong']);
  await assert.rejects(broken.read('project', 'owner', [pin]), code('INVALID_WORK_BACKUP'));
  s.files.get(row.storageId).blob = saved;
  assert.deepEqual(await broken.read('project', 'owner', [pin]), [bytes]);
  const get = s.ctx.storage.get,
    during = exchangeObjectReader(s.ctx);
  s.tables.projectContributors.set('grant', {
    _id: 'grant',
    projectId: 'project',
    contributor: 'contributor',
  });
  s.ctx.storage.get = async id => {
    const value = await get(id);
    s.tables.projectContributors.delete('grant');
    return value;
  };
  await assert.rejects(during.read('project', 'contributor', [pin]), code('PROJECT_UNAVAILABLE'));
  s.ctx.storage.get = get;
  // Failed authority is never memoized: the current grant is checked again.
  await assert.rejects(during.read('project', 'contributor', [pin]), code('PROJECT_UNAVAILABLE'));
  assert.deepEqual(await during.read('project', 'owner', [pin]), [bytes]);
});

test('fresh source return reuses shared checkpoint bytes within the action while preserving complete Work', async t => {
  const { checkpoint, preparedCheckpoint, modules } = await import('./project-exchange-fixture.mjs');
  const { randomUUID } = await import('node:crypto');
  const s = fixture(),
    first = await checkpoint(t, s),
    data = first.store.load(),
    id = randomUUID();
  data.intents.push({
    id,
    base: data.nativeHead,
    outcome: 'Retain original history',
    constraints: '',
    status: 'active',
    createdAt: '2026-01-01T00:00:00.000Z',
    notes: Array.from({ length: 1000 }, (_, i) => ({
      kind: 'comment',
      text: `Original note ${i} ${'history '.repeat(30)}`,
      at: '2026-01-01T00:00:00.000Z',
    })),
    extension: { preserved: true },
  });
  data.revision++;
  first.store.save(data);
  const base = await preparedCheckpoint(s, first.store),
    backupId = await modules.projectExchangeActions.publish._handler(s.ctx, base.input);
  await modules.projectWorkActions.initialize._handler(s.ctx, {
    projectId: 'project',
    backupId,
    operationId: randomUUID(),
  });
  const candidateData = first.store.load();
  candidateData.intents[0].notes.push({
    kind: 'comment',
    text: 'One local result',
    at: '2026-01-01T00:01:00.000Z',
  });
  candidateData.revision++;
  first.store.save(candidateData);
  const next = await preparedCheckpoint(s, first.store);
  next.input.previous = backupId;
  const candidateId = await modules.projectExchangeActions.publish._handler(s.ctx, next.input);
  const get = s.ctx.storage.get,
    counts = new Map();
  s.ctx.storage.get = async key => {
    counts.set(key, (counts.get(key) ?? 0) + 1);
    return get(key);
  };
  const input = {
    projectId: 'project',
    backupId: candidateId,
    expectedBackupId: backupId,
    revision: data.revision,
    operationId: randomUUID(),
  };
  const returned = await modules.projectSourceReturn.returnSource._handler(s.ctx, input);
  assert.equal(returned.revision, candidateData.revision + 1);
  assert(
    [...counts.values()].every(count => count === 1),
    'one source-return action reads each immutable storage binding at most once',
  );
  const shared = [...base.tree.objects.keys()].filter(key => next.tree.objects.has(key));
  assert(shared.length > 5, 'fixture contains substantial reusable metadata');
  counts.clear();
  const { accounting: _accounting, ...originalReceipt } = returned;
  assert.deepEqual(await modules.projectSourceReturn.returnSource._handler(s.ctx, input), originalReceipt);
  assert.equal(counts.size, 0, 'original return retry remains early');
  const result = JSON.parse(await readHosted(s.ctx, { projectId: 'project' }));
  assert.deepEqual(result.data.intents, candidateData.intents);
  assert.deepEqual(result.data.intents[0].extension, { preserved: true });
});

test('action byte memo evicts by bytes without changing exact pins or current access', async () => {
  const s = fixture(),
    a = Buffer.alloc(1024, 1),
    b = Buffer.alloc(1024, 2),
    pa = await upload(s, a),
    pb = await upload(s, b),
    reader = exchangeObjectReader(s.ctx, false, 1024);
  await reader.read('project', 'owner', [pa]);
  await reader.read('project', 'owner', [pb]);
  assert.deepEqual(await reader.read('project', 'owner', [pa]), [a]);
  assert.equal(s.reads(), 3, 'an evicted object is verified again rather than accumulating history');
  await assert.rejects(reader.read('project', 'stranger', [pa]), code('PROJECT_UNAVAILABLE'));
});

test('object source return resumes a committed staging batch and publishes one complete receipt', async t => {
  const { checkpoint, preparedCheckpoint, modules } = await import('./project-exchange-fixture.mjs');
  const { randomUUID } = await import('node:crypto');
  const index = await import(moduleUrl('../convex/projectWorkIndexActions.ts'));
  const s = fixture(),
    base = await checkpoint(t, s),
    backupId = await modules.projectExchangeActions.publish._handler(s.ctx, base.input);
  await modules.projectWorkActions.initialize._handler(s.ctx, {
    projectId: 'project',
    backupId,
    operationId: randomUUID(),
  });
  const generationId = await index.ensure._handler(s.ctx, { projectId: 'project' });
  const data = base.store.load();
  data.revision++;
  base.store.save(data);
  const next = await preparedCheckpoint(s, base.store);
  next.input.previous = backupId;
  const candidateId = await modules.projectExchangeActions.publish._handler(s.ctx, next.input);
  const input = {
    projectId: 'project',
    backupId: candidateId,
    expectedBackupId: backupId,
    revision: 0,
    operationId: randomUUID(),
  };
  const mutate = s.ctx.runMutation;
  let dropped = false;
  s.ctx.runMutation = async (ref, args) => {
    const result = await mutate(ref, args);
    if (getFunctionName(ref) === 'projectReturnIndexStage:batch' && !dropped) {
      dropped = true;
      throw new Error('Lost staging reply');
    }
    return result;
  };
  await assert.rejects(modules.projectSourceReturn.returnSource._handler(s.ctx, input));
  const partition = [...s.tables.projectWorkGenerations.values()].find(
    row => row.returnOperationId === input.operationId,
  );
  assert.ok(partition);
  assert.equal(partition.nextBatch, 1);
  assert.equal(s.tables.hostedProjects.get('project').work.backupId, backupId);
  assert.equal(
    [...s.tables.projectWorkEvents.values()].filter(row => row.operationId === input.operationId).length,
    0,
  );
  s.ctx.runMutation = mutate;
  const observed = await modules.projectSourceReturn.returnSource._handler(s.ctx, {
    ...input,
    continuation: true,
    statusOnly: true,
  });
  assert.equal(observed.pending, true);
  assert.equal(observed.resumed, true);
  assert.equal(JSON.parse(observed.progress).step, 1);
  assert.equal(s.tables.hostedProjects.get('project').work.backupId, backupId);
  let returned;
  do {
    returned = await modules.projectSourceReturn.returnSource._handler(s.ctx, {
      ...input,
      continuation: true,
    });
  } while (returned.pending);
  const current = s.tables.projectWorkGenerations.get(generationId);
  assert.equal(
    current.recordsGenerationId ?? current._id,
    generationId,
    'small return preserves the selected record partition',
  );
  assert.equal(partition.returnCursor, undefined, 'published delta releases its computational cursor');
  assert.equal(current.backupId, candidateId);
  assert.equal(returned.at, partition.returnAt);
  assert.equal(partition.status, 'ready');
  assert.equal(
    [...s.tables.projectWorkGenerations.values()].filter(row => row.returnOperationId === input.operationId)
      .length,
    1,
  );
  assert.ok(returned.accounting.steps > 0);
  delete returned.accounting;
  const { accounting: _accounting, ...originalReceipt } = returned;
  assert.deepEqual(await modules.projectSourceReturn.returnSource._handler(s.ctx, input), originalReceipt);
  await assert.rejects(
    modules.projectSourceReturn.returnSource._handler(s.ctx, { ...input, backupId }),
    code('WORK_OPERATION_CHANGED'),
  );
});

test('bounded State actions recheck current source authority and exact content pins', async () => {
  const ancestry = await import(moduleUrl('../convex/projectWorkAncestry.ts'));
  const s = fixture(),
    pin = await upload(
      s,
      Buffer.from(
        JSON.stringify({
          schema: 1,
          kind: 'forge-source-state',
          parents: [],
          files: [{ path: 'a.ts', blob: 'a'.repeat(64), mode: 'file' }],
          message: 'fixture',
          at: 'now',
        }),
      ),
    );
  const input = { projectId: 'project', actor: 'owner', pins: [pin], paths: ['a.ts'] };
  const [state] = await ancestry.stateBatch._handler(s.ctx, input);
  assert.equal(state.head, pin.sha256);
  assert.equal(state.files[0].path, 'a.ts');
  await assert.rejects(
    ancestry.stateBatch._handler(s.ctx, { ...input, actor: 'stranger' }),
    code('PROJECT_UNAVAILABLE'),
  );
  await assert.rejects(
    ancestry.changedStates._handler(s.ctx, {
      projectId: 'project',
      actor: 'stranger',
      before: pin,
      after: pin,
    }),
    code('PROJECT_UNAVAILABLE'),
  );
  await assert.rejects(
    ancestry.stateBatch._handler(s.ctx, { ...input, pins: [{ ...pin, size: pin.size + 1 }] }),
    code('INVALID_WORK_BACKUP'),
  );
});

test('State windows batch parent/provenance reads and retain the diff when an optional save disappears', async () => {
  const ancestry = await import(moduleUrl('../convex/projectWorkAncestry.ts'));
  const s = fixture(),
    resolutions = [];
  const make = async (name, blob) =>
    upload(
      s,
      Buffer.from(
        JSON.stringify({
          schema: 1,
          kind: 'forge-source-state',
          parents: [],
          files: [{ path: 'a.ts', blob, mode: 'file' }],
          message: name,
          at: 'now',
        }),
      ),
    );
  const before = await make('before', 'a'.repeat(64)),
    after = await make('after', 'b'.repeat(64)),
    save = await make('save', 'c'.repeat(64));
  const run = s.ctx.runQuery;
  s.ctx.runQuery = async (ref, args) => {
    if (getFunctionName(ref) === 'projectObjects:resolve') resolutions.push(args.digests);
    return run(ref, args);
  };
  await ancestry.stateBatch._handler(s.ctx, {
    projectId: 'project',
    actor: 'owner',
    pins: [before, after, save],
    paths: ['a.ts'],
  });
  assert.equal(resolutions.length, 2);
  resolutions.length = 0;
  const input = { projectId: 'project', actor: 'owner', before, after, pins: [save] };
  const result = await ancestry.changedStates._handler(s.ctx, input);
  assert.equal(resolutions.length, 2);
  assert.deepEqual(result.paths, ['a.ts']);
  assert.equal(result.states[0].files[0].blob, 'c'.repeat(64));
  const malformed = await upload(s, Buffer.from('not a State'));
  const withMalformed = await ancestry.changedStates._handler(s.ctx, { ...input, pins: [malformed] });
  assert.deepEqual(withMalformed.paths, ['a.ts']);
  assert.deepEqual(withMalformed.states, []);
  s.tables.projectObjects.forEach(row => {
    if (row.digest === save.sha256) row.removed = true;
  });
  const partial = await ancestry.changedStates._handler(s.ctx, input);
  assert.deepEqual(partial.paths, ['a.ts']);
  assert.deepEqual(partial.states, []);
  await assert.rejects(
    ancestry.changedStates._handler(s.ctx, { ...input, actor: 'stranger' }),
    code('PROJECT_UNAVAILABLE'),
  );
});

test('uncached digest reads own their verified raw buffer without copying or sharing later reads', async () => {
  const s = fixture(),
    bytes = Buffer.from('Owned digest buffer'),
    pin = await upload(s, bytes);
  const buffers = [];
  s.ctx.storage.get = async () => ({
    arrayBuffer: async () => {
      const value = Uint8Array.from(bytes).buffer;
      buffers.push(value);
      return value;
    },
  });
  const reader = exchangeObjectReader(s.ctx, false, 0);
  const [first] = await reader.read('project', 'owner', [pin]);
  assert.equal(first.buffer, buffers[0]);
  first.fill(0);
  const [second] = await reader.read('project', 'owner', [pin]);
  assert.equal(second.buffer, buffers[1]);
  assert.notEqual(second.buffer, first.buffer);
  assert.deepEqual(second, bytes);
});
