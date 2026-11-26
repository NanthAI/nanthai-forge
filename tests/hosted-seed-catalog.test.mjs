// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Ferdinando Valsecchi
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { getFunctionName, makeFunctionReference } from 'convex/server';
import { defaultR2Objects, interceptDefaultR2 } from './default-r2.mjs';
import { moduleUrl } from './convex-module.mjs';
import { fixture, modules } from './project-exchange-fixture.mjs';
import { testDeploymentOrigin } from './trusted-origin.mjs';
import { temporaryDirectory } from '../scripts/test-temp.mjs';
import { ConvexExchange } from '../dist/exchange-client.js';
import { prepareHostedSeed, seedHostedProject } from '../dist/hosted-seed.js';
import { NativeSource, nativeMarker } from '../dist/native-source.js';
import { createWork } from '../dist/work-create.js';
import { WorkStore } from '../dist/work-store.js';
import { digest } from '../dist/hash.js';
import { SEED_EMPTY } from '../dist/hosted-seed-protocol.js';
import { buildUploadPack } from '../dist/object-pack-upload.js';

for (const name of [
  'projectHostedSeed',
  'projectHostedSeedActions',
  'projectCode',
  'projectCodeBrowse',
  'projectWorkIndexActions',
])
  modules[name] = await import(moduleUrl(`../convex/${name}.ts`));
const { findObject, findStoredObject } = await import(moduleUrl('../convex/projectObjectFind.ts'));
const { sourceKeyReferenced } = await import(moduleUrl('../convex/projectSourceKeyProtection.ts'));

function setup(t, count, r2 = (input, init, serve) => serve(input, init)) {
  const root = temporaryDirectory(t, 'forge-seed-catalog-');
  nativeMarker(root);
  const source = new NativeSource(root);
  mkdirSync(source.directory, { recursive: true });
  const file = (path, bytes) => {
    const blob = digest(bytes);
    writeFileSync(join(source.directory, blob), bytes);
    return { path, blob, mode: 'file' };
  };
  const files = Array.from({ length: count }, (_, i) =>
    file(`files-${Math.floor(i / 100)}/file-${i}.ts`, `export const value = ${i};\n`),
  );
  const large = Buffer.alloc(3 * 1024 * 1024, 'forge seed recipe fixture\n');
  files.push(file('large.txt', large), file('empty.txt', ''));
  const head = source.writeState(files, [], 'Synthetic native seed', '2020-01-01T00:00:00.000Z');
  const store = new WorkStore(root);
  store.locked(() => store.save(createWork(head)));
  const s = fixture();
  const projectId = `seed-${randomUUID()}`;
  const project = { ...s.tables.hostedProjects.get('project'), _id: projectId, hostingRequest: 'reserved' };
  s.tables.hostedProjects.set(projectId, project);
  t.after(() => {
    for (const key of defaultR2Objects.keys()) if (key.includes(projectId)) defaultR2Objects.delete(key);
  });
  const stats = { calls: 0, reads: 0, writes: 0, put: 0, get: 0, head: 0, putBytes: 0, getBytes: 0 };
  const db = s.ctx.db;
  for (const method of ['insert', 'patch', 'replace', 'delete']) {
    const run = db[method];
    db[method] = (...args) => {
      stats.writes++;
      return run(...args);
    };
  }
  const get = db.get;
  db.get = async id => {
    const row = await get(id);
    stats.reads += Number(!!row);
    return row;
  };
  const query = db.query;
  db.query = table => {
    const q = query(table);
    for (const method of ['unique', 'take', 'collect', 'paginate']) {
      const run = q[method];
      q[method] = async (...args) => {
        const result = await run(...args);
        stats.reads += Array.isArray(result) ? result.length : (result?.page?.length ?? Number(!!result));
        return result;
      };
    }
    return q;
  };
  const restoreR2 = interceptDefaultR2(async (input, init, serve) => {
    const method = (init?.method ?? 'GET').toLowerCase();
    const response = await r2(input, init, serve);
    if (method in stats) stats[method]++;
    if (method === 'put') stats.putBytes += init.body.byteLength;
    if (method === 'get') stats.getBytes += Number(response.headers.get('content-length') ?? 0);
    return response;
  });
  t.after(restoreR2);
  const client = {};
  for (const [kind, method] of [
    ['query', 'runQuery'],
    ['action', 'runAction'],
    ['mutation', 'runMutation'],
  ]) {
    const run = s.ctx[method];
    s.ctx[method] = (...args) => {
      stats.calls++;
      return kind === 'mutation' ? s.transaction(() => run(...args)) : run(...args);
    };
    client[kind] = (...args) => s.ctx[method](...args);
  }
  const input = { projectId, revision: store.revision(), operationId: randomUUID(), serverAuthority: true };
  const exchange = new ConvexExchange(
    testDeploymentOrigin('https://fixture.convex.cloud'),
    'fixture',
    projectId,
    input.operationId,
    null,
  );
  exchange.client = client;
  exchange.uploadBatchSize = 100;
  return { input, exchange, client, store, s, large, stats };
}

test('a 28,905-file hosted seed retains catalog pages within the metadata budget and reads exact mixed objects', async t => {
  const count = 28_905;
  const f = setup(t, count - 2);
  const started = performance.now();
  const result = await seedHostedProject(f.store, f.input, f.client, f.exchange);
  const ready = await f.client.action(makeFunctionReference('projectWorkActions:initialize'), {
    projectId: f.input.projectId,
    backupId: result.backupId,
    operationId: randomUUID(),
  });
  assert(ready.work.generationId, 'Work selects the initial Code and Plan generation');
  const seedMillis = performance.now() - started;
  const retainedByTable = Object.fromEntries(
    Object.entries(f.s.tables)
      .map(([table, rows]) => [
        table,
        [...rows.values()].filter(
          row =>
            row.projectId === f.input.projectId ||
            (table === 'hostedProjects' && row._id === f.input.projectId) ||
            (table === 'accountStorageUsage' && row.account === 'owner'),
        ).length,
      ])
      .filter(([, size]) => size),
  );
  const retained = Object.values(retainedByTable).reduce((total, size) => total + size, 0);
  const bytesRetained = [...defaultR2Objects.entries()]
    .filter(([key]) => key.includes(f.input.projectId))
    .reduce((total, [, bytes]) => total + bytes.length, 0);
  t.diagnostic(
    JSON.stringify({
      ...f.stats,
      retained,
      bytesRetained,
      seedMillis: Math.round(seedMillis),
      peakRssKiB: process.resourceUsage().maxRSS,
      retainedByTable,
    }),
  );
  assert(
    retained <= Math.ceil(count / 100),
    `${retained} retained documents: ${JSON.stringify(retainedByTable)}`,
  );
  assert.equal(f.s.tables.projectObjects.size, 0);
  assert(retainedByTable.projectWorkDataRecords <= 8, 'seed writes at most eight work-data rows');
  assert.equal(f.s.scheduled.length, 0);
  const selected = JSON.parse([...f.s.tables.projectHostedChannels.values()][0].selection);
  assert.equal(selected.head, result.mainDigest);
  assert.equal(selected.authority.mode, 'server');
  const head = await findObject(f.s.ctx, f.input.projectId, selected.head);
  assert.equal(head.stateGeneration, 1);
  assert.equal(head.stateSize.fileCount, count);
  const large = { sha256: digest(f.large), size: f.large.length };
  assert((await findObject(f.s.ctx, f.input.projectId, large.sha256)).recipe);
  assert.deepEqual(await f.exchange.download(large), f.large);
  const ordinary = Buffer.from('export const value = 1;\n');
  const pin = { sha256: digest(ordinary), size: ordinary.length };
  const packed = await findObject(f.s.ctx, f.input.projectId, pin.sha256);
  assert(packed.pack);
  assert((await findObject(f.s.ctx, f.input.projectId, packed.pack.digest)).sourceReferenced);
  assert.deepEqual(await f.exchange.download(pin), ordinary);
});

for (const count of [4_000, 29_000]) {
  test(`catalog-backed fallback builds no per-file Work rows at ${count} files and opens exact source`, async t => {
    const f = setup(t, count - 2);
    // An interrupted legacy host keeps its original native-owner authority and
    // reaches the operator builder when it has no staged initial generation.
    delete f.input.serverAuthority;
    const seed = await seedHostedProject(f.store, f.input, f.client, f.exchange);
    const projectId = f.input.projectId;
    if (count === 29_000) {
      // Older object-backed checkpoints predate the closure marker.
      delete f.s.tables.projectBackups.get(seed.backupId).validatedClosure;
    }
    const ready = await f.client.action(makeFunctionReference('projectWorkActions:initialize'), {
      projectId,
      backupId: seed.backupId,
      operationId: randomUUID(),
    });
    assert.equal(ready.work.generationId, undefined);
    const started = performance.now();
    const before = { ...f.stats };
    const generationId = await f.client.action(makeFunctionReference('projectWorkIndexActions:ensure'), {
      projectId,
      rebuild: true,
    });
    assert.equal(typeof generationId, 'string');
    const rows = [...f.s.tables.projectWorkDataRecords.values()].filter(
      row => row.generationId === generationId,
    );
    const metrics = Object.fromEntries(
      Object.entries(f.stats).map(([key, value]) => [key, value - before[key]]),
    );
    t.diagnostic(
      JSON.stringify({
        ...metrics,
        rows: rows.length,
        rowBytes: Buffer.byteLength(JSON.stringify(rows)),
        rebuildMillis: Math.round(performance.now() - started),
        peakRssKiB: process.resourceUsage().maxRSS,
      }),
    );
    assert(rows.length <= 8, `${rows.length} work-data rows`);
    assert(!rows.some(row => ['sourceBlobs', 'sourceTreePaths'].includes(row.collection)));
    const state = seed.mainDigest;
    const code = JSON.parse(
      await f.client.action(makeFunctionReference('projectCodeBrowse:read'), {
        projectId,
        state,
        want: 'open',
        path: 'files-0/file-1.ts',
      }),
    );
    assert.equal(code.state, state);
    assert.equal(code.files, count);
    assert.equal(code.file.blob, digest('export const value = 1;\n'));
    const review = JSON.parse(
      await f.client.action(makeFunctionReference('projectSourceReview:read'), {
        projectId,
        backupId: seed.backupId,
        base: state,
        head: state,
        render: true,
      }),
    );
    assert.equal(review.available, true);
    assert.equal(
      review.timings.manifestMs,
      0,
      'review resolves both pins without loading the checkpoint manifest',
    );
  });
}

test('the catalog seed reconciles a lost upload reply and rejects a changed committed page', async t => {
  const f = setup(t, 220);
  const prepared = await prepareHostedSeed(f.store, f.input.revision, f.input.operationId, true);
  const run = f.client.action;
  let lost,
    lostFinish = false;
  f.client.action = async (ref, args) => {
    const result = await run(ref, args);
    if (!lost && getFunctionName(ref) === 'projectObjectCommit:commitBatch') {
      lost = args;
      throw new Error('lost catalog upload commit reply');
    }
    if (!lostFinish && getFunctionName(ref) === 'projectHostedSeedActions:finish') {
      lostFinish = true;
      throw new Error('lost catalog finish reply');
    }
    return result;
  };
  await assert.rejects(seedHostedProject(f.store, f.input, f.client, f.exchange), /lost catalog upload/);
  const commit = makeFunctionReference('projectObjectCommit:commitBatch');
  assert(lost.seed);
  assert.equal(await run(commit, lost), null);
  assert.equal(f.s.tables.projectHostedChannels.size, 0);
  await assert.rejects(seedHostedProject(f.store, f.input, f.client, f.exchange), /lost catalog finish/);
  const result = await seedHostedProject(f.store, f.input, f.client, f.exchange);
  assert.equal(result.mainDigest, prepared.request.head);
  assert.equal(result.uploadedObjects, 0);
  assert.equal(f.s.tables.projectObjects.size, 0);
  assert.equal(await run(commit, lost), null, 'upload replay remains available after final selection');
  const stage = makeFunctionReference('projectHostedSeedActions:stage');
  const args = {
    projectId: f.input.projectId,
    operationId: f.input.operationId,
    index: 0,
    previous: SEED_EMPTY,
    body: JSON.stringify(prepared.pages[0]),
  };
  const replay = JSON.parse(await run(stage, args));
  assert.equal(replay.backupId, result.backupId);
  await assert.rejects(
    run(stage, { ...args, previous: '0'.repeat(64) }),
    error => error.data?.code === 'WORK_OPERATION_CHANGED',
  );
  f.s.ctx.auth.getUserIdentity = async () => ({ subject: 'stranger' });
  await assert.rejects(run(commit, lost), error => error.data?.code === 'PROJECT_UNAVAILABLE');
});

test('seed upload commit rejects same-size corrupt bytes behind a checksum-less storage replay', async t => {
  const f = setup(t, 1, async (input, init, serve) => {
    const response = await serve(input, init);
    if (init?.method !== 'HEAD') return response;
    return new Response(null, {
      status: response.status,
      headers: { 'content-length': response.headers.get('content-length') },
    });
  });
  const prepared = await prepareHostedSeed(f.store, f.input.revision, f.input.operationId, true);
  const { projectId, operationId } = f.input;
  await f.client.mutation(makeFunctionReference('projectHostedSeed:begin'), {
    projectId,
    request: JSON.stringify(prepared.request),
  });
  const bytes = Buffer.from('original seed upload');
  const pin = { digest: digest(bytes), size: bytes.length };
  const [pending] = await f.client.mutation(makeFunctionReference('projectObjects:prepareBatch'), {
    projectId,
    seedOperationId: operationId,
    objects: [pin],
  });
  assert.equal(
    (
      await fetch(pending.target.url, {
        method: 'PUT',
        headers: pending.target.headers,
        body: Buffer.alloc(bytes.length, 'x'),
      })
    ).status,
    200,
  );
  await assert.rejects(
    f.client.action(makeFunctionReference('projectObjectCommit:commitBatch'), {
      objects: [{ id: pending.id, pin }],
      seed: { projectId, operationId },
    }),
    error => error.data?.code === 'R2_OBJECT_CHECKSUM_MISMATCH',
  );
  assert.equal(f.s.tables.projectObjectCatalog.size, 0);
  assert.equal(f.s.tables.projectObjects.get(pending.id).r2Committed, undefined);
  assert.equal(f.s.tables.projectHostedChannels.size, 0);
});

test('an earlier row-based seed can resume with a new client and retain its original pages', async t => {
  const f = setup(t, 220);
  const prepared = await prepareHostedSeed(f.store, f.input.revision, f.input.operationId, true);
  await f.client.mutation(makeFunctionReference('projectHostedSeed:begin'), {
    projectId: f.input.projectId,
    request: JSON.stringify(prepared.request),
  });
  const [seed] = f.s.tables.projectHostedSeeds.values();
  await f.s.ctx.db.patch(seed._id, { objectCatalog: undefined });
  const run = f.client.action;
  f.client.action = async (ref, args) => {
    const result = await run(ref, args);
    if (getFunctionName(ref) === 'projectHostedSeedActions:stage' && args.index === 0)
      throw new Error('lost legacy page reply');
    return result;
  };
  await assert.rejects(seedHostedProject(f.store, f.input, f.client, f.exchange), /lost legacy page reply/);
  assert.equal(f.s.tables.projectHostedSeeds.get(seed._id).nextPage, 1);
  f.client.action = run;
  const result = await seedHostedProject(f.store, f.input, f.client, f.exchange);
  assert.equal(result.mainDigest, prepared.request.head);
  assert.equal(f.s.tables.projectObjectCatalog.size, 0);
  assert.equal(f.s.tables.projectHostedSeedPages.size, prepared.pages.length);
});

test('a catalog seed pack can carry the bytes of a different pending pack without committing its members', async t => {
  const f = setup(t, 1);
  const prepared = await prepareHostedSeed(f.store, f.input.revision, f.input.operationId, true);
  const { projectId, operationId } = f.input;
  await f.client.mutation(makeFunctionReference('projectHostedSeed:begin'), {
    projectId,
    request: JSON.stringify(prepared.request),
  });
  const prepare = async parts => {
    const uploads = parts.map(bytes => ({
      pin: { sha256: digest(bytes), size: bytes.length },
      read: () => bytes,
    }));
    const built = await buildUploadPack(uploads, [0, 1]);
    const [row] = await f.client.mutation(makeFunctionReference('projectObjects:prepareBatch'), {
      projectId,
      seedOperationId: operationId,
      pack: built.proposal,
      objects: uploads.map(({ pin }) => ({ digest: pin.sha256, size: pin.size })),
    });
    assert(row.pack);
    assert.equal(
      (
        await fetch(row.target.url, {
          method: 'PUT',
          headers: row.target.headers,
          body: built.bytes,
        })
      ).status,
      200,
    );
    const { digest: sha256, size } = built.proposal;
    return {
      digest: sha256,
      key: decodeURIComponent(new URL(row.target.url).pathname).split('/').slice(2).join('/'),
      commit: () =>
        f.client.action(makeFunctionReference('projectObjectCommit:commitBatch'), {
          objects: [{ id: row.id, pin: { digest: sha256, size } }],
          seed: { projectId, operationId },
        }),
    };
  };
  const parts = [Buffer.from('first pack '), Buffer.from('member')];
  const carrier = Buffer.concat(parts);
  const a = await prepare(parts);
  const b = await prepare([carrier, Buffer.from(' second pack member')]);
  const first = { sha256: digest(parts[0]), size: parts[0].length };
  await b.commit();
  assert.equal((await findStoredObject(f.s.ctx, projectId, a.digest)).pack.digest, b.digest);
  assert.equal(await findStoredObject(f.s.ctx, projectId, first.sha256), null);
  assert.equal((await findObject(f.s.ctx, projectId, a.digest)).r2Committed, undefined);
  await a.commit();
  assert.equal(f.s.tables.projectObjects.size, 0);
  assert.equal((await findStoredObject(f.s.ctx, projectId, first.sha256)).pack.digest, a.digest);
  assert.equal(await sourceKeyReferenced(f.s.ctx, projectId, a.key), true);
  assert.deepEqual(await f.exchange.download(first), parts[0]);
  await a.commit();
});
