// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { getFunctionName } from 'convex/server';
import { moduleUrl } from './convex-module.mjs';
import { upload, modules as exchangeModules } from './project-exchange-fixture.mjs';
import { buildExchangeRoot } from '../dist/native-exchange-tree.js';
import { setup } from './hosted-planning-fixture.mjs';
import { runFixture } from './work-detail-fixture.mjs';
import { dispatchHostedWork } from '../dist/hosted-work-client.js';
import { hydrateRun } from '../dist/work-record-details.js';
const names = [
  'projectWorkDetailMigration',
  'projectWorkDetailMigrationActions',
  'projectGithubImportObjects',
  'projectWorkRecordDetails',
  'projectObjects',
  'projectObjectRecipes',
  'projectWorkIndex',
  'projectWorkIndexActions',
];
const modules = Object.fromEntries(
  await Promise.all(names.map(async name => [name, await import(moduleUrl(`../convex/${name}.ts`))])),
);
const workLoad = await import(moduleUrl('../convex/projectWorkLoad.ts'));

async function fixture(t, mode = 'native-owner', records = false) {
  let original;
  const s = await setup(t, true, (_root, local) => {
    const data = local.store.load();
    original = runFixture(data.nativeHead);
    // The archive fixture emulates an old writer; no new save path can compact it.
    const { store } = local;
    data.runs = [original];
    data.schema = 21;
    // Write a legacy monolithic pointer so the export retains the original bytes.
    writeFileSync(join(store.directory, 'work.json'), JSON.stringify(data, null, 2));
  });
  s.tables.projectWorkDetailMigrations = new Map();
  const project = s.tables.hostedProjects.get(s.projectId);
  project.sourceAuthority = { mode, epoch: mode === 'server' ? 1 : 0 };
  const run = s.ctx.runQuery;
  for (const method of ['runQuery', 'runMutation', 'runAction'])
    s.ctx[method] = (ref, args) => {
      const [name, action] = getFunctionName(ref).split(':');
      return modules[name]?.[action] ? modules[name][action]._handler(s.ctx, args) : run(ref, args);
    };
  s.ctx.storage.generateUploadUrl = async () => 'https://fixture.invalid/upload';
  if (records) {
    Object.assign(modules, exchangeModules);
    const manifest = JSON.parse(s.exported.json);
    for (const pin of manifest.files) await upload(s, readFileSync(join(s.exported.path, pin.path)));
    const tree = buildExchangeRoot(
      Buffer.from(s.exported.json),
      readFileSync(join(s.exported.path, 'work.json')),
      { records: true },
    );
    for (const bytes of tree.objects.values()) await upload(s, bytes);
    const root = await upload(s, tree.bytes);
    Object.assign(s.tables.projectBackups.get(s.backupId), {
      transport: 'objects',
      objectManifest: { digest: root.sha256, size: root.size },
      digest: root.sha256,
      size: root.size,
    });
  }
  const client = {
    query: (ref, args) => s.ctx.runQuery(ref, args),
    mutation: (ref, args) => s.ctx.runMutation(ref, args),
    action: (ref, args) => s.ctx.runAction(ref, args),
  };
  const operationId = randomUUID();
  const step = () =>
    modules.projectWorkDetailMigrationActions.step._handler(s.ctx, { projectId: s.projectId, operationId });
  return { ...s, client, original, operationId, step };
}
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

for (const mode of ['native-owner', 'server'])
  test(`hosted ${mode} migration resumes pages and leaves source/receipts exact`, async t => {
    const s = await fixture(t, mode),
      before = structuredClone(s.tables.projectBackups.get(s.backupId));
    const first = JSON.parse(await s.step());
    assert.equal(first.complete, false);
    assert.equal(s.tables.hostedProjects.get(s.projectId).work.recordDetails, undefined);
    let result;
    do {
      result = JSON.parse(await s.step());
    } while (!result.complete);
    assert.equal(JSON.parse(await s.step()).root.sha256, result.root.sha256);
    const snapshot = await workLoad.load(s.ctx, s.projectId, 'owner');
    assert.equal(snapshot.data.schema, 23);
    const originalSnapshot = await workLoad.source(s.ctx, s.backupId, 'owner');
    assert.equal(originalSnapshot.data.schema, 21);
    assert.deepEqual(originalSnapshot.data.runs[0], s.original);
    assert.equal(snapshot.data.runs[0].backend.testVerdicts, undefined);
    const detail = snapshot.data.runs[0].detailRef;
    const rows = [...s.tables.projectObjects.values()];
    const row = rows.find(row => row.digest === detail.sha256);
    const bytes = new Uint8Array(await (await s.ctx.storage.get(row.storageId)).arrayBuffer());
    assert.deepEqual(
      hydrateRun(snapshot.data.runs[0], () => bytes),
      s.original,
    );
    assert.deepEqual(s.tables.projectBackups.get(s.backupId), before);
    assert.equal(snapshot.data.revision, before.preview.revision);
    assert.equal(snapshot.originalWorkDigest, before.preview.workDigest ?? snapshot.originalWorkDigest);
    const indexed = await dispatchHostedWork(s.client, s.projectId, {
      action: 'detail',
      collection: 'runs',
      id: s.original.id,
    });
    assert.deepEqual(indexed.value.backend.testVerdicts, s.original.backend.testVerdicts);
  });

test('hosted publication catches Work/authority races and rechecks current owner on replay', async t => {
  const s = await fixture(t);
  await s.step();
  s.tables.hostedProjects.get(s.projectId).work.revision++;
  await assert.rejects(s.step(), error => error.data?.code === 'WORK_STALE' || error.code === 'WORK_STALE');
  assert.equal(s.tables.hostedProjects.get(s.projectId).work.recordDetails, undefined);
  s.caller('outsider');
  await assert.rejects(
    s.step(),
    error => error.data?.code === 'PROJECT_UNAVAILABLE' || error.code === 'PROJECT_UNAVAILABLE',
  );
});

test('object-backed hosted migration pages the catalog and preserves journal replay across publication', async t => {
  const s = await fixture(t, 'native-owner', true);
  const id = randomUUID();
  await s.send({
    action: 'intent',
    base: s.original.head,
    outcome: 'Synthetic migrated journal',
    constraints: '',
    operationId: id,
  });
  const before = await workLoad.load(s.ctx, s.projectId, 'owner');
  let result;
  do {
    result = JSON.parse(await s.step());
  } while (!result.complete);
  await s.send({ action: 'note', intentId: id, text: 'After migration', kind: 'comment' });
  const after = await workLoad.load(s.ctx, s.projectId, 'owner');
  assert.equal(after.data.revision, before.data.revision + 1);
  assert.deepEqual(
    after.data.hostedEvents.slice(0, before.data.hostedEvents.length),
    before.data.hostedEvents,
  );
  assert.equal(after.data.intents.find(intent => intent.id === id).notes.at(-1).text, 'After migration');
  assert.ok(after.data.runs[0].detailRef);
});
