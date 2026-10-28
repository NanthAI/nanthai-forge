// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { getFunctionName } from 'convex/server';
import { digest } from '../dist/hash.js';
import { ownerDerivedPages, resolveOwnerDerived } from '../dist/owner-derived-pages.js';
import { computeOwnerDerived } from '../dist/owner-derived.js';
import { NativeSource } from '../dist/native-source.js';
import { buildExchangeRoot } from '../dist/native-exchange-tree.js';
import { fixture, checkpoint, preparedCheckpoint, upload, modules } from './project-exchange-fixture.mjs';
import { moduleUrl } from './convex-module.mjs';
const index = await import(moduleUrl('../convex/projectWorkIndexActions.ts'));
const { readOwnerDerived } = await import(moduleUrl('../convex/projectOwnerDerived.ts'));

test('owner display pages retain all bytes beyond the old cap and reject hash/size tampering', async () => {
  const value = { schema: 3, message: '😀'.repeat(1400000) },
    bytes = Buffer.from(JSON.stringify(value));
  const { root, objects } = ownerDerivedPages(bytes);
  assert.ok(root.length < 4 * 1024 * 1024);
  assert.ok(objects.size > 1);
  let maxBatch = 0,
    maxBytes = 0;
  const read = async pins => {
    maxBatch = Math.max(maxBatch, pins.length);
    maxBytes = Math.max(
      maxBytes,
      pins.reduce((sum, pin) => sum + pin.size, 0),
    );
    return pins.map(p => objects.get(p.sha256));
  };
  assert.deepEqual(await resolveOwnerDerived(root, read), value);
  assert.ok(maxBatch <= 16);
  assert.ok(maxBytes <= 2 * 1024 * 1024);
  const pin = { sha256: digest(root), size: root.length };
  await assert.rejects(
    readOwnerDerived(
      pin,
      async () => root,
      async pins => pins.map(() => Buffer.from('tampered')),
    ),
    e => e.code === 'INVALID_OWNER_DATA',
  );
  await assert.rejects(
    readOwnerDerived({ ...pin, size: pin.size + 1 }, async () => root, read),
    e => e.code === 'INVALID_OWNER_DATA',
  );
  const bad = JSON.parse(root);
  bad.pages[0].size = 128 * 1024 + 1;
  const corrupt = Buffer.from(JSON.stringify(bad));
  await assert.rejects(
    readOwnerDerived({ sha256: digest(corrupt), size: corrupt.length }, async () => corrupt, read),
    e => e.code === 'INVALID_OWNER_DATA',
  );
});

test('display page indexes paginate their own pins without a total document limit', async () => {
  const bytes = Buffer.alloc(501 * 128 * 1024, 32);
  bytes[0] = 91;
  bytes[bytes.length - 1] = 93;
  const { root, objects } = ownerDerivedPages(bytes);
  assert.equal(JSON.parse(root).level, 1);
  assert.ok(root.length < 128 * 1024);
  assert.ok([...objects.values()].every(page => page.length <= 128 * 1024));
  assert.deepEqual(
    await resolveOwnerDerived(root, async pins => pins.map(pin => objects.get(pin.sha256))),
    [],
  );
  const changed = JSON.parse(root);
  changed.level++;
  await assert.rejects(
    resolveOwnerDerived(Buffer.from(JSON.stringify(changed)), async pins =>
      pins.map(pin => objects.get(pin.sha256)),
    ),
    e => e.code === 'INVALID_OWNER_DATA',
  );
});

test('old CLI publication reports the typed upgrade command before object reads', async () => {
  const s = fixture();
  let reads = 0;
  s.ctx.storage.get = async () => {
    reads++;
    throw Error('must not read');
  };
  await assert.rejects(
    modules.projectExchangeActions.publish._handler(s.ctx, {
      projectId: 'project',
      operationId: randomUUID(),
      previous: null,
      digest: 'a'.repeat(64),
      size: 1,
    }),
    e =>
      e.data?.code === 'CLI_UPGRADE_REQUIRED' &&
      /nforge/.test(e.data.message) &&
      /npm install -g/.test(e.data.message),
  );
  assert.equal(reads, 0);
});

test('a missing hosted index requests complete local facts and publishes them without derivation', async t => {
  const s = fixture(),
    first = await checkpoint(t, s);
  const backupId = await modules.projectExchangeActions.publish._handler(s.ctx, first.input);
  await modules.projectWorkActions.initialize._handler(s.ctx, {
    projectId: 'project',
    backupId,
    operationId: randomUUID(),
  });
  const { client } = await import('./r2-harness.mjs');
  assert.equal(await client(s).ownerDisplayBaseline(), false);
  const { land } = await import('./source-landings-fixture.mjs');
  land(first.store, 2);
  const next = await preparedCheckpoint(s, first.store);
  next.input.previous = backupId;
  const candidate = await modules.projectExchangeActions.publish._handler(s.ctx, next.input);
  const run = s.ctx.runAction;
  let derivations = 0;
  s.ctx.runAction = (ref, args) => {
    if (
      [
        'projectDiffstats:compare',
        'projectWorkAncestry:changedStates',
        'projectWorkAncestry:stateBatch',
      ].includes(getFunctionName(ref))
    )
      derivations++;
    return run(ref, args);
  };
  const input = {
    projectId: 'project',
    backupId: candidate,
    expectedBackupId: backupId,
    revision: 0,
    operationId: randomUUID(),
    continuation: true,
  };
  let receipt;
  do {
    receipt = await modules.projectSourceReturn.returnSource._handler(s.ctx, input);
  } while (receipt.pending);
  assert.equal(derivations, 0);
  const generationId = s.tables.hostedProjects.get('project').work.generationId;
  assert.ok(generationId);
  assert.equal(await index.ensure._handler(s.ctx, { projectId: 'project' }), generationId);
  assert.equal(derivations, 0);
  assert.equal(
    [...s.tables.projectWorkRecords.values()].filter(
      r => r.generationId === generationId && r.collection === 'viewDetails',
    ).length,
    2,
  );
});

test('1400 States, 1400 pairs and 800 heads return in bounded owner-only steps', async t => {
  const s = fixture(),
    first = await checkpoint(t, s);
  const backupId = await modules.projectExchangeActions.publish._handler(s.ctx, first.input);
  await modules.projectWorkActions.initialize._handler(s.ctx, {
    projectId: 'project',
    backupId,
    operationId: randomUUID(),
  });
  const generationId = await index.ensure._handler(s.ctx, { projectId: 'project' });
  const native = new NativeSource(first.store.root),
    original = first.store.load();
  const data = structuredClone(original),
    states = new Map(),
    objects = new Map();
  const object = bytes => {
    const sha256 = digest(bytes);
    objects.set(sha256, bytes);
    return sha256;
  };
  for (let n = 0; n < 800; n++) {
    const base = data.nativeHead,
      checkpoints = [],
      id = randomUUID();
    let head = base;
    for (let i = 0; i < (n < 600 ? 2 : 1); i++) {
      const files = [{ path: 'a.ts', blob: object(Buffer.from(`${n}/${i}\n`)), mode: 'file' }];
      const state = {
        schema: 1,
        kind: 'forge-source-state',
        parents: [head],
        files,
        message: 'Synthetic save '.repeat(150),
        at: '2026-01-01T00:00:00Z',
      };
      const next = object(Buffer.from(JSON.stringify(state)));
      states.set(next, state);
      checkpoints.push({ parent: head, head: next, at: state.at, message: state.message });
      head = next;
    }
    data.intents.push({
      id,
      outcome: 'Synthetic backlog '.repeat(25),
      constraints: '',
      base,
      status: 'completed',
      createdAt: '2026-01-01T00:00:00Z',
      notes: [],
    });
    data.lanes.push({
      id,
      intentId: id,
      name: 'Synthetic',
      base,
      head,
      assignment: '',
      target: '',
      state: 'completed',
      checkpoints,
    });
    data.views.push({
      id,
      intentId: id,
      base: n < 600 ? checkpoints[0].head : base,
      head,
      inputs: [{ laneId: id, head }],
      status: 'clean',
      details: '',
      at: '2026-01-01T00:00:00Z',
    });
    data.channelMoves.push({
      id,
      channel: 'main',
      viewId: id,
      head,
      previous: base,
      at: '2026-01-01T00:00:00Z',
      status: 'accepted',
      provenance: 'user-declared-local',
    });
    data.nativeHead = head;
  }
  data.revision++;
  const derived = computeOwnerDerived(
    data,
    { state: h => states.get(h) ?? native.state(h), object: h => objects.get(h) ?? native.object(h) },
    undefined,
    { data: original, states: new Set([original.nativeHead]) },
  );
  assert.equal(derived.parents.length, 1400);
  assert.equal(derived.stats.length, 1400);
  assert.equal(derived.views.length, 800);
  const display = Buffer.from(JSON.stringify(derived));
  assert.ok(display.length > 4 * 1024 * 1024);
  const work = Buffer.from(JSON.stringify(data, null, 2));
  const manifest = {
    ...first.manifest,
    id: randomUUID(),
    revision: data.revision,
    head: data.nativeHead,
    files: [
      ...first.manifest.files.filter(f => f.path !== 'work.json'),
      ...[...objects].map(([sha256, bytes]) => ({ path: `objects/${sha256}`, sha256, size: bytes.length })),
      { path: 'work.json', sha256: digest(work), size: work.length },
    ],
  };
  for (const bytes of objects.values()) await upload(s, bytes);
  const tree = buildExchangeRoot(Buffer.from(JSON.stringify(manifest)), work);
  for (const bytes of tree.objects.values()) await upload(s, bytes);
  const root = await upload(s, tree.bytes),
    pages = ownerDerivedPages(display);
  for (const bytes of pages.objects.values()) await upload(s, bytes);
  const ownerDerived = await upload(s, pages.root);
  const candidate = await modules.projectExchangeActions.publish._handler(s.ctx, {
    projectId: 'project',
    operationId: manifest.id,
    previous: backupId,
    digest: root.sha256,
    size: root.size,
    displayProtocol: 3,
    ownerDerived,
  });
  let steps = 0,
    derivations = 0,
    sourceReads = 0,
    calls = 0;
  const mutate = s.ctx.runMutation,
    action = s.ctx.runAction,
    get = s.ctx.storage.get;
  const sourceIds = new Set(
    [...s.tables.projectObjects.values()]
      .filter(r => manifest.files.some(f => f.path === `objects/${r.digest}`))
      .map(r => r.storageId),
  );
  s.ctx.storage.get = id => {
    if (sourceIds.has(id)) sourceReads++;
    return get(id);
  };
  s.ctx.runMutation = (ref, args) => {
    if (getFunctionName(ref) === 'projectReturnIndexStage:batch') steps++;
    return mutate(ref, args);
  };
  s.ctx.runAction = (ref, args) => {
    if (
      [
        'projectDiffstats:compare',
        'projectWorkAncestry:changedStates',
        'projectWorkAncestry:stateBatch',
      ].includes(getFunctionName(ref))
    )
      derivations++;
    return action(ref, args);
  };
  const input = {
    projectId: 'project',
    backupId: candidate,
    expectedBackupId: backupId,
    revision: 0,
    operationId: randomUUID(),
    continuation: true,
  };
  const started = performance.now();
  let receipt;
  do {
    assert.ok(calls++ < 5);
    receipt = await modules.projectSourceReturn.returnSource._handler(s.ctx, input);
  } while (receipt.pending);
  const elapsedMs = Math.round(performance.now() - started);
  assert.equal(derivations, 0);
  assert.equal(sourceReads, 0);
  assert.ok(steps <= 40, `bounded index commits: ${steps}`);
  const generation = s.tables.projectWorkGenerations.get(generationId),
    partition = generation.recordsGenerationId ?? generationId;
  const rows = [...s.tables.projectWorkRecords.values()].filter(r => r.generationId === partition);
  assert.equal(rows.filter(r => r.collection === 'diffstats').length, 1400);
  assert.equal(rows.filter(r => r.collection === 'viewDetails').length, 800);
  for (const [collection, count] of Object.entries(JSON.parse(generation.metadata).counts))
    assert.equal(rows.filter(r => r.collection === collection).length, count, collection);
  console.log(
    'R3C_BACKLOG',
    JSON.stringify({
      states: 1400,
      pairs: 1400,
      heads: 800,
      displayBytes: Buffer.byteLength(JSON.stringify(derived)),
      steps,
      calls,
      elapsedMs,
      sourceReads,
      derivations,
      accounting: receipt.accounting,
    }),
  );
});

test('an old stored publication stays readable but a new return requires the current CLI without source reads', async t => {
  const s = fixture(),
    first = await checkpoint(t, s);
  const backupId = await modules.projectExchangeActions.publish._handler(s.ctx, first.input);
  await modules.projectWorkActions.initialize._handler(s.ctx, {
    projectId: 'project',
    backupId,
    operationId: randomUUID(),
  });
  delete s.tables.projectBackups.get(backupId).displayProtocol;
  const loaded = await modules.projectWorkActions.load(s.ctx, 'project', 'owner');
  assert.equal(loaded.backup._id, backupId);
  let reads = 0;
  s.ctx.storage.get = async () => {
    reads++;
    throw Error('must not read');
  };
  await assert.rejects(
    modules.projectSourceReturn.returnSource._handler(s.ctx, {
      projectId: 'project',
      backupId,
      expectedBackupId: backupId,
      revision: loaded.data.revision,
      operationId: randomUUID(),
      continuation: true,
    }),
    e => e.data?.code === 'CLI_UPGRADE_REQUIRED' && /nforge/.test(e.data.message),
  );
  assert.equal(reads, 0);
});
