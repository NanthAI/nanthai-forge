import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { setImmediate } from 'node:timers/promises';
import { getFunctionName } from 'convex/server';
import { digest } from '../dist/hash.js';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { buildExchangeRoot } from '../dist/native-exchange-tree.js';
import { fixture, checkpoint, modules, preparedCheckpoint, upload } from './project-exchange-fixture.mjs';
const actions = modules.projectExchangeActions;
const code = expected => error => error.data?.code === expected;

test('exact publication reconciliation precedes storage validation and never rewinds a later selection', async t => {
  const s = fixture(),
    { input } = await checkpoint(t, s);
  assert.equal(await actions.published._handler(s.ctx, input), null);
  const id = await actions.publish._handler(s.ctx, input),
    project = s.tables.hostedProjects.get('project');
  project.currentBackup = 'newer';
  project.revision = 9;
  s.ctx.storage.get = s.ctx.storage.getMetadata = async () => {
    throw new Error('receipt must not read storage');
  };
  assert.equal(await actions.published._handler(s.ctx, input), id);
  assert.equal(await actions.publish._handler(s.ctx, input), id);
  assert.equal(project.currentBackup, 'newer');
  assert.equal(project.revision, 9);
  assert.equal(s.tables.projectBackups.size, 1);
  for (const changed of [{ digest: 'f'.repeat(64) }, { size: input.size + 1 }, { previous: 'different' }]) {
    await assert.rejects(
      actions.published._handler(s.ctx, { ...input, ...changed }),
      code('WORK_OPERATION_CHANGED'),
    );
    await assert.rejects(
      actions.publish._handler(s.ctx, { ...input, ...changed }),
      code('WORK_OPERATION_CHANGED'),
    );
  }
  assert.equal(await actions.published._handler(s.ctx, { ...input, operationId: randomUUID() }), null);
});

test('publication receipts remain project-bound and require current active owner authority', async t => {
  const s = fixture(),
    { input } = await checkpoint(t, s);
  await actions.publish._handler(s.ctx, input);
  const request = digest(
    JSON.stringify([input.projectId, input.operationId, input.previous, input.digest, input.size]),
  );
  s.tables.hostedProjects.set('other', {
    ...s.tables.hostedProjects.get('project'),
    _id: 'other',
    currentBackup: null,
  });
  assert.equal(await actions.published._handler(s.ctx, { ...input, projectId: 'other' }), null);
  for (const actor of [undefined, 'stranger']) {
    s.caller(actor);
    await assert.rejects(actions.published._handler(s.ctx, input), code('PROJECT_UNAVAILABLE'));
    await assert.rejects(actions.publish._handler(s.ctx, input), code('PROJECT_UNAVAILABLE'));
  }
  await assert.rejects(
    modules.projectExchange.published._handler(s.ctx, {
      projectId: 'project',
      owner: 'stranger',
      operationId: input.operationId,
      request,
    }),
    code('PROJECT_UNAVAILABLE'),
  );
  s.caller('owner');
  for (const removal of ['trash', 'deleting', 'deleted']) {
    s.tables.hostedProjects.get('project').removal = removal;
    await assert.rejects(actions.published._handler(s.ctx, input), code('PROJECT_UNAVAILABLE'));
    await assert.rejects(actions.publish._handler(s.ctx, input), code('PROJECT_UNAVAILABLE'));
  }
  delete s.tables.hostedProjects.get('project').removal;
  await assert.rejects(
    actions.published._handler(s.ctx, { ...input, operationId: 'invalid' }),
    code('BAD_ARGUMENT'),
  );
});

test('fresh publication checks every content page with bounded overlap and settles failure before returning', async t => {
  const s = fixture(),
    { input, manifest } = await checkpoint(t, s, 505),
    run = s.ctx.runQuery;
  let active = 0,
    maximum = 0,
    failed = false;
  const checked = new Set();
  const source = new Set(manifest.files.filter(file => file.path !== 'work.json').map(file => file.sha256));
  s.ctx.runQuery = async (ref, args) => {
    if (getFunctionName(ref) !== 'projectObjects:resolve' || !args.digests.every(id => source.has(id)))
      return run(ref, args);
    active++;
    maximum = Math.max(maximum, active);
    try {
      await setImmediate();
      args.digests.forEach(id => checked.add(id));
      if (failed && args.digests.length === 100) throw new Error('one page failed');
      return await run(ref, args);
    } finally {
      active--;
    }
  };
  const id = await actions.publish._handler(s.ctx, input);
  assert.ok(id);
  assert.deepEqual(checked, source);
  assert.equal(maximum, 4);
  assert.equal(active, 0);
  failed = true;
  checked.clear();
  await assert.rejects(
    actions.publish._handler(s.ctx, { ...input, operationId: randomUUID() }),
    code('HOSTED_REQUEST_FAILED'),
  );
  assert.equal(active, 0);
  assert.equal(s.tables.projectBackups.size, 1);
});

test('fresh publication still rejects missing and corrupt content and rechecks authority at commit', async t => {
  const s = fixture(),
    { input, manifest } = await checkpoint(t, s),
    first = s.tables.projectObjects.values().next().value;
  first.removed = true;
  await assert.rejects(actions.publish._handler(s.ctx, input), code('INVALID_WORK_BACKUP'));
  first.removed = false;
  const root = [...s.tables.projectObjects.values()].find(row => row.digest === input.digest),
    saved = s.files.get(root.storageId).blob;
  // A different metadata read can warm the global memo before this fresh attempt.
  await actions.objectBytes(s.ctx, 'project', 'owner', { sha256: input.digest, size: input.size });
  s.files.get(root.storageId).blob = new Blob([Buffer.alloc(input.size)]);
  await assert.rejects(actions.publish._handler(s.ctx, input), code('INVALID_WORK_BACKUP'));
  s.files.get(root.storageId).blob = saved;
  assert.equal(s.tables.projectBackups.size, 0);
  const mutate = s.ctx.runMutation;
  s.ctx.runMutation = async (ref, args) => {
    if (getFunctionName(ref) === 'projectExchange:publish')
      s.tables.hostedProjects.get('project').removal = 'trash';
    return mutate(ref, args);
  };
  assert.ok(manifest.files.length);
  await assert.rejects(actions.publish._handler(s.ctx, input), code('PROJECT_UNAVAILABLE'));
  assert.equal(s.tables.projectBackups.size, 0);
});

test('two serialized publishes from the same previous checkpoint cannot silently fork', async t => {
  const s = fixture(),
    first = await checkpoint(t, s),
    second = await checkpoint(t, s);
  assert.notEqual(first.input.digest, second.input.digest);
  // Convex serializes the two mutations (OCC retries the loser against the winner's
  // commit), so the second observes a project whose currentBackup has moved.
  const outcomes = [];
  for (const input of [first.input, second.input])
    outcomes.push(
      await actions.publish._handler(s.ctx, input).then(
        value => ({ status: 'fulfilled', value }),
        reason => ({ status: 'rejected', reason }),
      ),
    );
  assert.deepEqual(
    outcomes.map(outcome => outcome.status),
    ['fulfilled', 'rejected'],
  );
  assert.equal(outcomes[1].reason.data.code, 'PROJECT_CHANGED');
  const project = s.tables.hostedProjects.get('project');
  assert.equal(project.currentBackup, outcomes[0].value);
  assert.equal(project.revision, 1);
  assert.equal(s.tables.projectBackups.size, 1);
  // Retrying the loser with the winner as its previous checkpoint succeeds and chains.
  const retry = { ...second.input, operationId: randomUUID(), previous: outcomes[0].value };
  const id = await actions.publish._handler(s.ctx, retry);
  assert.equal(s.tables.hostedProjects.get('project').currentBackup, id);
  assert.equal(s.tables.projectBackups.get(id).previous, outcomes[0].value);
  // A retry of the winner's original request still reconciles to its receipt.
  assert.equal(await actions.publish._handler(s.ctx, first.input), outcomes[0].value);
});

test('unknown-upload reconciliation stops at files older than the reserving row instead of scanning the deployment', async () => {
  const s = fixture(),
    bytes = Buffer.from('lost upload'),
    prepared = await modules.projectObjects.prepare._handler(s.ctx, {
      projectId: 'project',
      digest: digest(bytes),
      size: bytes.length,
    }),
    created = s.tables.projectObjects.get(prepared.id)._creationTime;
  const older = { _id: 'old-file', _creationTime: created - 10 * 60_000, size: 1, sha256: '0'.repeat(64) },
    newer = { _id: 'new-file', _creationTime: created + 1, size: 1, sha256: '0'.repeat(64) };
  let provider = [newer, older];
  s.ctx.db.system.query = () => ({
    order: () => ({
      paginate: async () => ({ page: provider, isDone: false, continueCursor: 'more-of-the-deployment' }),
    }),
  });
  const result = await modules.projectObjects.reconcile._handler(s.ctx, { id: prepared.id, cursor: null });
  assert.equal(result.stored, false);
  assert.equal(result.isDone, true);
  provider = [newer];
  assert.equal(
    (await modules.projectObjects.reconcile._handler(s.ctx, { id: prepared.id, cursor: null })).isDone,
    false,
  );
});

test('the CLI transport reports a stale publish as PROJECT_CHANGED with pull-and-reconcile guidance', async () => {
  const { ConvexError } = await import('convex/values'),
    { ConvexExchange } = await import('../dist/exchange-client.js'),
    transport = new ConvexExchange('https://fixture.invalid', 'token', 'project', randomUUID(), null);
  transport.client.action = async () => {
    throw new ConvexError({ code: 'PROJECT_CHANGED', message: 'server text' });
  };
  await assert.rejects(transport.publish({ sha256: 'a'.repeat(64), size: 1 }), error => {
    assert.equal(error.code, 'PROJECT_CHANGED');
    assert.match(error.message, /nothing was published.*[Pp]ull/s);
    return true;
  });
  transport.client.action = async () => {
    throw new Error('network');
  };
  await assert.rejects(
    transport.publish({ sha256: 'a'.repeat(64), size: 1 }),
    error => error.code === 'HOSTED_ACTION_FAILED',
  );
});

test('a fully validated prior closure resolves only changed content pins and never grants foreign project authority', async t => {
  const s = fixture(),
    first = await checkpoint(t, s, 1000);
  const id = await modules.projectExchangeActions.publish._handler(s.ctx, first.input);
  assert.equal(s.tables.projectBackups.get(id).validatedClosure, 1);
  const next = await preparedCheckpoint(s, first.store);
  // Retain all old source objects, plus a newly uploaded logical file.
  next.manifest.files.push(
    ...first.manifest.files.filter(file => !next.manifest.files.some(pin => pin.path === file.path)),
  );
  const changed = await upload(s, Buffer.from('one newly retained source blob'));
  next.manifest.files.push({ path: `objects/${changed.sha256}`, ...changed });
  const work = readFileSync(join(next.store.directory, `exchange-${next.input.operationId}`, 'work.json'));
  const tree = buildExchangeRoot(Buffer.from(JSON.stringify(next.manifest)), work);
  for (const bytes of tree.objects.values()) await upload(s, bytes);
  const pin = await upload(s, tree.bytes);
  next.input = { ...next.input, previous: id, digest: pin.sha256, size: pin.size };
  const query = s.ctx.runQuery;
  const retained = new Set(
    first.manifest.files.filter(file => file.path.startsWith('objects/')).map(file => file.sha256),
  );
  let retainedResolutions = 0;
  s.ctx.runQuery = (ref, args) => {
    if (getFunctionName(ref) === 'projectObjects:resolve')
      retainedResolutions += args.digests.filter(id => retained.has(id)).length;
    return query(ref, args);
  };
  const second = await modules.projectExchangeActions.publish._handler(s.ctx, next.input);
  assert.ok(second);
  assert.equal(retainedResolutions, 0, 'unchanged logical content uses the complete immutable closure proof');
  s.caller('stranger');
  await assert.rejects(
    modules.projectExchangeActions.publish._handler(s.ctx, next.input),
    error => error.data?.code === 'PROJECT_UNAVAILABLE',
  );
});

test('a prior logical Work digest is not a stored source-object binding proof', async t => {
  const s = fixture(),
    seed = await checkpoint(t, s);
  const data = seed.store.load();
  data.futureExtension = 'retained chunked Work '.repeat(10000);
  data.revision++;
  seed.store.save(data);
  const first = await preparedCheckpoint(s, seed.store);
  const work = first.manifest.files.find(file => file.path === 'work.json');
  assert.ok(first.tree.root.work.tree.height > 0);
  const removeRawWork = () => {
    for (const row of s.tables.projectObjects.values())
      if (row.digest === work.sha256) {
        s.tables.projectObjects.delete(row._id);
        s.files.delete(row.storageId);
      }
  };
  // Match real metadata-tree uploads: the full logical Work file is not stored
  // as a standalone raw object. Its verified chunks still reconstruct exactly.
  removeRawWork();
  const previous = await actions.publish._handler(s.ctx, first.input);
  const next = await preparedCheckpoint(s, seed.store);
  removeRawWork();
  next.manifest.files.push({ ...work, path: `objects/${work.sha256}` });
  const tree = buildExchangeRoot(
    Buffer.from(JSON.stringify(next.manifest)),
    readFileSync(join(seed.store.directory, `exchange-${next.input.operationId}`, 'work.json')),
  );
  for (const bytes of tree.objects.values()) await upload(s, bytes);
  const pin = await upload(s, tree.bytes);
  await assert.rejects(
    actions.publish._handler(s.ctx, { ...next.input, previous, digest: pin.sha256, size: pin.size }),
    code('INVALID_WORK_BACKUP'),
  );
  assert.equal(s.tables.hostedProjects.get('project').currentBackup, previous);
});

test('manifest duplicate digests with inconsistent logical sizes are rejected before deduplication', async t => {
  const s = fixture(),
    next = await checkpoint(t, s);
  const source = next.manifest.files.find(file => file.path.startsWith('objects/'));
  next.manifest.files.unshift({
    path: `check-${randomUUID()}/stdout.log`,
    sha256: source.sha256,
    size: source.size + 1,
  });
  const work = readFileSync(join(next.store.directory, `exchange-${next.input.operationId}`, 'work.json'));
  const tree = buildExchangeRoot(Buffer.from(JSON.stringify(next.manifest)), work);
  for (const bytes of tree.objects.values()) await upload(s, bytes);
  const pin = await upload(s, tree.bytes);
  await assert.rejects(
    actions.publish._handler(s.ctx, { ...next.input, digest: pin.sha256, size: pin.size }),
    code('INVALID_WORK_BACKUP'),
  );
  assert.equal(s.tables.projectBackups.size, 0);
});
