// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { getFunctionName } from 'convex/server';
import { modules } from './project-exchange-fixture.mjs';
import { setup, client } from './r2-harness.mjs';
import { digest } from '../dist/hash.js';
import { initNative } from '../dist/native-work.js';
import { WorkStore } from '../dist/work-store.js';
import { pushNativeExchange, pullNativeExchange } from '../dist/native-exchange.js';
import { PUBLICATION_PAGE_BYTES, publicationHash, publicationPages } from '../dist/publication-metadata.js';
const code = expected => e => e.data?.code === expected || e.code === expected;
async function local(t, harnessOptions, count = 2) {
  const h = await setup(t, harnessOptions),
    dir = mkdtempSync(join(tmpdir(), 'forge-r3a-')),
    root = join(dir, 'owner');
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  mkdirSync(root);
  for (let i = 0; i < count; i++) writeFileSync(join(root, `file-${i}.txt`), `retained ${i}\n`);
  initNative(root);
  return { ...h, dir, root, store: new WorkStore(root), sender: client(h.s) };
}
function observePublish(f) {
  const invoke = f.sender.client.action,
    get = f.s.ctx.storage.get;
  let reads = 0;
  f.s.ctx.storage.get = (...args) => {
    reads++;
    return get(...args);
  };
  const observations = [];
  f.sender.client.action = async (ref, args) => {
    if (getFunctionName(ref) !== 'projectExchangeActions:publish') return invoke(ref, args);
    const before = reads,
      gets = f.fake.requests.filter(r => r.method === 'GET').length;
    try {
      return await invoke(ref, args);
    } finally {
      observations.push({
        metadataOnly: args.metadataOnly,
        reads: reads - before,
        gets: f.fake.requests.filter(r => r.method === 'GET').length - gets,
      });
    }
  };
  return observations;
}
const push = f => pushNativeExchange(f.store, f.store.revision(), f.sender.operationId, f.sender);
function transform(f, change) {
  const send = f.sender.publishMetadata.bind(f.sender);
  f.sender.publishMetadata = (pin, build) =>
    send(pin, () => {
      const value = build();
      change(value);
      return value;
    });
}

test('R3a: opted-in publish reads zero storage bytes; retry and pull retain exact bytes', async t => {
  const f = await local(t),
    observations = observePublish(f),
    snapshotOperation = randomUUID(),
    pushSnapshot = () => pushNativeExchange(f.store, f.store.revision(), snapshotOperation, f.sender),
    result = await pushSnapshot();
  assert.deepEqual(observations, [{ metadataOnly: 1, reads: 0, gets: 0 }]);
  const backup = f.s.tables.projectBackups.get(result.backupId);
  assert.notEqual(snapshotOperation, f.sender.operationId);
  assert.ok(backup.metadataPublication);
  assert.equal(backup.validatedWorkRecords, undefined, 'owner metadata is not server-verified Work');
  const session = f.s.tables.projectPublications.get(backup.metadataPublication);
  assert.equal(session.cursor, session.pages);
  assert.equal(session.validated, true);
  const count = f.s.tables.projectPublicationPages.size;
  assert.equal((await pushSnapshot()).backupId, result.backupId);
  assert.equal(f.s.tables.projectPublicationPages.size, count);
  assert.equal(f.s.tables.projectBackups.size, 1);
  const pin = { sha256: result.digest, size: backup.size };
  assert.equal(await f.sender.publish(pin, true), result.backupId);
  assert.deepEqual(observations.at(-1), { metadataOnly: 1, reads: 0, gets: 0 });
  await pullNativeExchange(result.backupId, join(f.dir, 'pulled'), client(f.s));
  for (let i = 0; i < 2; i++)
    assert.deepEqual(
      readFileSync(join(f.dir, 'pulled', `file-${i}.txt`)),
      readFileSync(join(f.root, `file-${i}.txt`)),
    );
});

test('R3a: bounded pages resume after a lost append reply, reject a changed page and changed begin', async t => {
  const f = await local(t, undefined, 150),
    observations = observePublish(f),
    mutate = f.sender.client.mutation;
  let lost = false,
    first;
  f.sender.client.mutation = async (ref, args) => {
    const result = await mutate(ref, args);
    if (getFunctionName(ref) === 'projectPublicationStore:append') {
      first ??= { ...args };
      assert.ok(Buffer.byteLength(JSON.stringify(args)) <= PUBLICATION_PAGE_BYTES);
      if (!lost) {
        lost = true;
        throw Error('lost append reply');
      }
    }
    return result;
  };
  const result = await push(f),
    backup = f.s.tables.projectBackups.get(result.backupId),
    session = f.s.tables.projectPublications.get(backup.metadataPublication);
  assert.ok(lost);
  assert.ok(session.pages > 1);
  assert.equal(f.s.tables.projectPublicationPages.size, session.pages);
  assert.deepEqual(observations, [{ metadataOnly: 1, reads: 0, gets: 0 }]);
  await assert.rejects(
    modules.projectPublicationStore.append._handler(f.s.ctx, { ...first, body: first.body + ' ' }),
    code('WORK_OPERATION_CHANGED'),
  );
  await assert.rejects(
    modules.projectPublicationStore.begin._handler(f.s.ctx, {
      projectId: session.projectId,
      operationId: session.operationId,
      request: session.request,
      digest: session.digest,
      size: session.size,
      pages: session.pages,
      metadataDigest: 'f'.repeat(64),
    }),
    code('WORK_OPERATION_CHANGED'),
  );
});

test('R3a: missing or uncommitted object row returns PUBLISH_PIN_MISSING without byte reads', async t => {
  const f = await local(t),
    observations = observePublish(f);
  transform(f, data => {
    const id = data.edges[0].blobs[0];
    const row = [...f.s.tables.projectObjects.values()].find(r => r.digest === id);
    row.r2Committed = false;
  });
  await assert.rejects(push(f), code('PUBLISH_PIN_MISSING'));
  await assert.rejects(
    modules.projectPublicationStore.pins._handler(f.s.ctx, {
      projectId: 'project',
      owner: 'owner',
      pins: [{ sha256: 'e'.repeat(64), size: 1 }],
    }),
    error => error.data?.code === 'PUBLISH_PIN_MISSING',
    'typed error survives an internal RPC boundary',
  );
  assert.equal(f.s.tables.projectBackups.size, 0);
  assert.deepEqual(observations, Array(observations.length).fill({ metadataOnly: 1, reads: 0, gets: 0 }));
});

test('R3a: out-of-closure derived rows return DERIVED_ROW_UNPINNED', async t => {
  const f = await local(t),
    observations = observePublish(f);
  transform(f, data => {
    data.ownerDerived.trees[0][1][0].blob = 'f'.repeat(64);
  });
  await assert.rejects(push(f), code('DERIVED_ROW_UNPINNED'));
  assert.equal(f.s.tables.projectBackups.size, 0);
  assert.ok(observations.length > 0);
  assert.equal(observations[0].reads + observations[0].gets, 0);
});

test('R3a: mixed committed Convex and R2 pins publish without fetching either location', async t => {
  const f = await local(t, { flag: '', optIn: false }),
    observations = observePublish(f);
  const bytes = readFileSync(join(f.root, 'file-0.txt'));
  await f.sender.upload({ sha256: digest(bytes), size: bytes.length }, bytes);
  process.env.FORGE_BLOBS = 'r2';
  f.s.tables.hostedProjects.get('project').r2Writes = true;
  const result = await push(f);
  assert.ok([...f.s.tables.projectObjects.values()].some(r => r.storageId));
  assert.ok([...f.s.tables.projectObjects.values()].some(r => r.r2Committed));
  assert.deepEqual(observations, [{ metadataOnly: 1, reads: 0, gets: 0 }]);
  await pullNativeExchange(result.backupId, join(f.dir, 'pulled'), client(f.s));
  assert.deepEqual(readFileSync(join(f.dir, 'pulled', 'file-0.txt')), bytes);
});

for (const mode of ['opt-out', 'older CLI', 'older server'])
  test(`R3a: ${mode} preserves legacy schema-1 byte-reading publication`, async t => {
    const f = await local(t, { optIn: mode !== 'opt-out' }),
      observations = observePublish(f);
    // Fresh records checkpoints use the paged seed; this covers legacy publication.
    f.sender.workRecords = false;
    if (mode === 'older CLI') f.sender.publishMetadata = undefined;
    if (mode === 'older server') {
      const query = f.sender.client.query;
      f.sender.client.query = (ref, args) => {
        if (getFunctionName(ref) === 'projectPublicationStore:capabilities')
          throw Error('Could not find public function for projectPublicationStore:capabilities');
        return query(ref, args);
      };
    }
    const result = await push(f);
    assert.equal(f.s.tables.projectBackups.get(result.backupId).metadataPublication, undefined);
    assert.equal(observations[0].metadataOnly, undefined);
    assert.ok(observations[0].reads + observations[0].gets > 0);
  });

test('R3a: unauthorized callers cannot advertise, stage, read or publish owner metadata', async t => {
  const f = await local(t);
  const result = await push(f),
    backup = f.s.tables.projectBackups.get(result.backupId);
  f.s.caller('stranger');
  await assert.rejects(
    modules.projectPublicationStore.capabilities._handler(f.s.ctx, { projectId: 'project' }),
    code('PROJECT_UNAVAILABLE'),
  );
  await assert.rejects(
    modules.projectPublicationStore.append._handler(f.s.ctx, {
      id: backup.metadataPublication,
      position: 0,
      previous: '',
      body: '{}',
    }),
    code('PROJECT_UNAVAILABLE'),
  );
  await assert.rejects(
    modules.projectPublicationStore.read._handler(f.s.ctx, {
      id: backup.metadataPublication,
      owner: 'stranger',
      position: 0,
    }),
    code('PROJECT_UNAVAILABLE'),
  );
  await assert.rejects(
    f.sender.publish({ sha256: result.digest, size: backup.size }, true),
    code('PROJECT_UNAVAILABLE'),
  );
});

test('R3a: Unicode and control-character pages stay bounded and reconstruct their exact digest', () => {
  const value = { text: '😀\u0000漢'.repeat(20000) },
    { pages, digest } = publicationPages(value);
  assert.ok(pages.length > 1);
  for (const body of pages) assert.ok(Buffer.byteLength(JSON.stringify({ body })) < PUBLICATION_PAGE_BYTES);
  assert.deepEqual(JSON.parse(pages.join('')), value);
  assert.equal(publicationHash(pages.join('')), digest);
});

test('R3a: source checkpoint CAS and opt-out are rechecked at final publication', async t => {
  const f = await local(t),
    invoke = f.sender.client.action;
  f.sender.client.action = (ref, args) => {
    if (getFunctionName(ref) === 'projectExchangeActions:publish')
      f.s.tables.hostedProjects.get('project').currentBackup = 'changed';
    return invoke(ref, args);
  };
  await assert.rejects(push(f), code('PROJECT_CHANGED'));
  assert.equal(f.s.tables.projectBackups.size, 0);
  f.s.tables.hostedProjects.get('project').currentBackup = null;
  f.sender.client.action = (ref, args) => {
    if (getFunctionName(ref) === 'projectExchangeActions:publish')
      f.s.tables.hostedProjects.get('project').r2Writes = false;
    return invoke(ref, args);
  };
  await assert.rejects(push(f), code('WORK_OPERATION_CHANGED'));
  assert.equal(f.s.tables.projectBackups.size, 0);
});

test('R3a: existing explicit project deletion purges publication metadata in bounded pages', async t => {
  const f = await local(t);
  await push(f);
  // Exercise more than one existing 50-row purge transaction without source data.
  const [sample] = f.s.tables.projectPublicationPages.values();
  for (let i = 0; i < 55; i++)
    f.s.tables.projectPublicationPages.set(`extra-${i}`, {
      ...sample,
      _id: `extra-${i}`,
      position: 1000 + i,
    });
  const { moduleUrl } = await import('./convex-module.mjs'),
    lifecycle = await import(moduleUrl('../convex/projectLifecycle.ts')),
    maintenance = await import(moduleUrl('../convex/projectR2Maintenance.ts')),
    cleanup = { projectLifecycle: lifecycle, projectR2Maintenance: maintenance };
  const previous = process.env.FORGE_R2_MAINTENANCE;
  process.env.FORGE_R2_MAINTENANCE = '1';
  t.after(() => {
    if (previous === undefined) delete process.env.FORGE_R2_MAINTENANCE;
    else process.env.FORGE_R2_MAINTENANCE = previous;
  });
  const invoke = (ref, args) => {
    const [module, name] = getFunctionName(ref).split(':');
    return cleanup[module][name]._handler(f.s.ctx, args);
  };
  for (const kind of ['runQuery', 'runMutation', 'runAction']) {
    const run = f.s.ctx[kind];
    f.s.ctx[kind] = (ref, args) =>
      cleanup[getFunctionName(ref).split(':')[0]] ? invoke(ref, args) : run(ref, args);
  }
  let next = 0;
  const drainOne = async () => {
    const task = f.s.scheduled[next++];
    assert.ok(task, 'deletion retains scheduled work until completion');
    f.s.tasks.set(task.id, { state: { kind: 'inProgress' } });
    await invoke(task.fn, task.args);
    f.s.tasks.set(task.id, { state: { kind: 'success' } });
  };
  await lifecycle.permanentlyDelete._handler(f.s.ctx, {
    projectId: 'project',
    operationId: randomUUID(),
    expectedRevision: f.s.tables.hostedProjects.get('project').revision,
  });
  await drainOne();
  assert.ok(f.s.tables.projectPublicationPages.size > 0, 'first transaction stops at 50');
  assert.equal(f.s.tables.projectPublicationPages.size, 55 + 1 - 50);
  for (let i = 0; i < 50 && f.s.tables.hostedProjects.get('project').removal === 'deleting'; i++)
    await drainOne();
  assert.equal(f.s.tables.projectPublicationPages.size, 0);
  assert.equal(f.s.tables.projectPublications.size, 0);
  assert.equal(f.s.tables.hostedProjects.get('project').r2PrefixPurged, true);
  assert.equal(f.fake.objects.size, 0);
  assert.equal(f.s.tables.hostedProjects.get('project').removal, 'deleted');
});

test('R3a: reduced State edges preserve the full closure through merges and reintroduced blobs', async () => {
  const { publicationClosure } = await import('../dist/native-publication.js');
  const graph = new Map([
    ['root', { parents: [], files: ['a', 'b'] }],
    ['left', { parents: ['root'], files: ['b', 'c'] }],
    ['right', { parents: ['root'], files: ['a'] }],
    ['merge', { parents: ['left', 'right'], files: ['a', 'c'] }],
    ['reintroduce', { parents: ['left'], files: ['a', 'c'] }],
  ]);
  const reduced = new Map(
    publicationClosure([...graph.keys()], head => {
      const node = graph.get(head);
      return { parents: node.parents, files: node.files.map(blob => ({ blob })) };
    }).map(row => [row.head, row]),
  );
  const closure = (head, nodes, field) => {
    const found = new Set(),
      pending = [head];
    while (pending.length) {
      const id = pending.pop();
      if (found.has(id)) continue;
      found.add(id);
      const row = nodes.get(id);
      if (row) pending.push(...row.parents, ...row[field]);
    }
    return [...found].sort();
  };
  for (const head of graph.keys())
    assert.deepEqual(closure(head, reduced, 'blobs'), closure(head, graph, 'files'));
  assert.deepEqual(reduced.get('merge').blobs, []);
  assert.deepEqual(reduced.get('reintroduce').blobs, ['a']);
  assert.ok(
    [...reduced.values()].reduce((sum, row) => sum + row.blobs.length, 0) <
      [...graph.values()].reduce((sum, row) => sum + row.files.length, 0),
  );
});
