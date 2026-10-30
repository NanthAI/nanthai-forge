// SPDX-License-Identifier: AGPL-3.0-only
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { getFunctionName } from 'convex/server';
import { state } from './hosted-fixture.mjs';
import { moduleUrl } from './convex-module.mjs';
import { emptyHostedProject } from '../dist/hosted-bootstrap.js';
import { policyPreset } from '../dist/autonomy-policy.js';
import { fakeSourceR2 } from './convex-source-r2-fixture.mjs';
const names = [
  'projectBootstrap',
  'projectBootstrapStore',
  'projectBackups',
  'projectObjects',
  'projectWork',
  'projectWorkIndex',
  'projectWorkIndexStore',
  'projectWorkActions',
];
const modules = Object.fromEntries(
  await Promise.all(names.map(async name => [name, await import(moduleUrl(`../convex/${name}.ts`))])),
);
function setup() {
  const s = state([]),
    original = s.ctx.runQuery;
  s.ctx.runQuery =
    s.ctx.runMutation =
    s.ctx.runAction =
      (ref, args) => {
        const [name, method] = getFunctionName(ref).split(':');
        const fn = modules[name]?.[method];
        return fn
          ? fn.isMutation
            ? s.transaction(() => fn._handler(s.ctx, args))
            : fn._handler(s.ctx, args)
          : original(ref, args);
      };
  s.create = input => modules.projectBootstrap.create._handler(s.ctx, input);
  return s;
}
const input = (name = 'Empty project') => ({ operationId: randomUUID(), name });
const code = expected => error => error.data?.code === expected || error.code === expected;

test('browser creation publishes an empty retained State, initialized indexed Work and main', async () => {
  const s = setup(),
    args = input();
  const projectId = await s.create(args);
  const project = s.tables.hostedProjects.get(projectId);
  assert.equal(project.visibility, 'private');
  assert.deepEqual(project.autonomyPolicy, policyPreset('supervised'));
  assert.equal(s.tables.projectBackups.size, 1);
  assert.equal(s.tables.projectWorkGenerations.size, 1);
  const snapshot = await modules.projectWorkActions.load(s.ctx, projectId, 'owner');
  assert.equal(snapshot.manifest.kind, 'forge-native-work-backup');
  assert.equal(snapshot.data.nativeHead, snapshot.manifest.head);
  assert.equal(snapshot.data.channelMoves[0].head, snapshot.manifest.head);
  assert.equal(snapshot.data.channelMoves[0].channel, 'main');
  assert.deepEqual(snapshot.data.lanes, []);
  assert.deepEqual(snapshot.data.intents, []);
  const row = [...s.tables.projectObjects.values()].find(row => row.digest === snapshot.manifest.head);
  const source = JSON.parse(await s.files.get(row.storageId).blob.text());
  assert.deepEqual(source.files, []);
  assert.deepEqual(source.parents, []);
  const generation = s.tables.projectWorkGenerations.get(project.work.generationId);
  assert.equal(generation.status, 'ready');
  const tree = [...s.tables.projectWorkRecords.values()].find(row => row.collection === 'sourceTrees');
  assert.deepEqual(JSON.parse(tree.value), { head: snapshot.manifest.head, files: 0 });
});

test('a lost creation response retries to one project with identical source and no extra storage', async () => {
  const s = setup(),
    args = input();
  const first = await s.create(args),
    before = structuredClone([...s.tables.hostedProjects.values()]);
  const files = s.files.size;
  assert.equal(await s.create(args), first);
  assert.equal(s.files.size, files);
  assert.deepEqual([...s.tables.hostedProjects.values()], before);
  assert.equal(s.tables.hostedProjects.size, 1);
  assert.equal(s.tables.projectBackups.size, 1);
});

test('reusing an operation with a different payload is refused without changing accepted source', async () => {
  const s = setup(),
    args = input();
  await s.create(args);
  const before = structuredClone([...s.tables.hostedProjects.values()]);
  await assert.rejects(s.create({ ...args, name: 'Changed name' }), code('WORK_OPERATION_CHANGED'));
  assert.deepEqual([...s.tables.hostedProjects.values()], before);
});

test('signed-out creation and retries cannot access projects or allocate source', async () => {
  const s = setup(),
    args = input();
  s.caller(null);
  await assert.rejects(s.create(args), code('AUTH_REQUIRED'));
  assert.equal(s.files.size, 0);
  s.caller('owner');
  await s.create(args);
  s.caller(null);
  await assert.rejects(s.create(args), code('AUTH_REQUIRED'));
  assert.equal(s.tables.hostedProjects.size, 1);
});

test('same-name creations retain existing slug collision rules and do not introduce a project quota', async () => {
  const s = setup();
  for (let n = 0; n < 25; n++) await s.create(input('Same name'));
  assert.equal(s.tables.hostedProjects.size, 25);
  assert.equal(new Set([...s.tables.hostedProjects.values()].map(p => p.slug)).size, 25);
  assert.ok([...s.tables.hostedProjects.values()].every(p => p.name === 'Same name'));
});

test('operation identity is owner-scoped and never grants another account the original project', async () => {
  const s = setup(),
    args = input();
  const first = await s.create(args);
  s.caller('other-owner');
  const second = await s.create(args);
  assert.notEqual(first, second);
  assert.equal(s.tables.hostedProjects.get(first).owner, 'owner');
  assert.equal(s.tables.hostedProjects.get(second).owner, 'other-owner');
});

test('publication validates all immutable bytes and rolls back a corrupt bootstrap', async () => {
  const s = setup(),
    args = input(),
    at = new Date().toISOString();
  const objects = [];
  for (const object of emptyHostedProject(args.operationId, at).objects) {
    const nonce = randomUUID();
    objects.push({
      nonce,
      storageId: await s.ctx.storage.store(
        new Blob([object.text], {
          type: `application/x-forge-object-${nonce}`,
        }),
      ),
    });
  }
  s.files.get(objects[1].storageId).metadata.size++;
  await assert.rejects(
    s.transaction(() => modules.projectBootstrapStore.publish._handler(s.ctx, { ...args, at, objects })),
    code('INVALID_WORK_BACKUP'),
  );
  assert.equal(s.tables.hostedProjects.size, 0);
  assert.equal(s.tables.projectBackups.size, 0);
  assert.equal(s.tables.projectObjects.size, 0);
});

test('a second prepared publisher reconciles the winner and removes only its unused bytes', async () => {
  const s = setup(),
    args = input(),
    run = s.ctx.runMutation;
  let intercepted = false;
  s.ctx.runMutation = async (ref, payload) => {
    if (!intercepted && getFunctionName(ref) === 'projectBootstrapStore:publish') {
      intercepted = true;
      await s.create(args);
    }
    return run(ref, payload);
  };
  const id = await s.create(args);
  assert.equal(s.tables.hostedProjects.size, 1);
  assert.equal(s.files.size, 3);
  assert.equal(s.deleted.length, 3);
  assert.equal(await s.create(args), id);
});

test('publication rechecks credential authority before creating the project', async () => {
  const s = setup(),
    args = input(),
    run = s.ctx.runMutation;
  s.ctx.runMutation = (ref, payload) => {
    s.caller(null);
    return run(ref, payload);
  };
  await assert.rejects(s.create(args), code('AUTH_REQUIRED'));
  assert.equal(s.tables.hostedProjects.size, 0);
  assert.equal(s.tables.projectBackups.size, 0);
});

test('creation never repurposes an operation already used by an uploaded project', async () => {
  const s = setup(),
    args = input();
  s.tables.hostedProjects.set('uploaded', {
    _id: 'uploaded',
    _creationTime: 1,
    owner: 'owner',
    key: args.operationId,
    name: args.name,
    currentBackup: null,
    revision: 0,
  });
  await assert.rejects(s.create(args), code('WORK_OPERATION_CHANGED'));
  assert.equal(s.tables.hostedProjects.size, 1);
  assert.equal(s.files.size, 0);
});

test('fresh hosted main checks out zero file blobs with a valid receipt and replay downloads nothing', async t => {
  if (!existsSync(new URL('../dist/hosted-main-checkout.js', import.meta.url)))
    return t.skip('Slice 1 hosted-main checkout has not landed in main yet.');
  const { checkoutHostedMain } = await import('../dist/hosted-main-checkout.js');
  const { hostedMainSchema } = await import('../dist/hosted-main.js');
  const s = setup(),
    args = input(),
    projectId = await s.create(args);
  const project = s.tables.hostedProjects.get(projectId);
  const move = JSON.parse(
    [...s.tables.projectWorkRecords.values()].find(
      row => row.projectId === projectId && row.collection === 'channelMoves',
    ).value,
  );
  const selection = hostedMainSchema.parse({
    schema: 1,
    projectId,
    generationId: project.work.generationId,
    backupId: project.work.backupId,
    channel: 'main',
    head: move.head,
    receipt: { id: move.id, kind: 'native', previousHead: null, previousReceiptId: null },
  });
  const downloaded = [];
  const transport = {
    current: async () => selection,
    objects: async digests =>
      (
        await modules.projectObjects.resolve._handler(s.ctx, {
          projectId,
          actor: 'owner',
          digests,
        })
      ).map(row => ({ sha256: row.digest, size: row.size })),
    downloadToFile: async (pin, path) => {
      downloaded.push(pin.sha256);
      const row = [...s.tables.projectObjects.values()].find(row => row.digest === pin.sha256);
      writeFileSync(path, Buffer.from(await s.files.get(row.storageId).blob.arrayBuffer()));
    },
  };
  const directory = mkdtempSync(join(tmpdir(), 'forge-empty-main-'));
  t.after(() => rmSync(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }));
  const root = join(directory, 'checkout');
  const request = {
    projectId,
    operationId: randomUUID(),
    url: 'https://synthetic.convex.cloud',
    expected: { head: selection.head, receiptId: selection.receipt.id },
  };
  const first = await checkoutHostedMain(root, request, transport);
  assert.deepEqual(readdirSync(root), ['.forge']);
  assert.deepEqual(JSON.parse(readFileSync(join(root, '.forge/hosted-main.json'))).selection, selection);
  assert.deepEqual(downloaded, [selection.head]); // One State manifest; zero source-file blobs.
  assert.equal(first.downloadedObjects, 1);
  assert.equal((await checkoutHostedMain(root, request, transport)).downloadedObjects, 0);
});

test('R2 bootstrap retries an incomplete reservation without any Convex byte store', async t => {
  const r2 = fakeSourceR2(t),
    s = setup(),
    args = input('R2 project');
  s.ctx.storage.store = () => {
    assert.fail('R2 bootstrap called Convex storage.store');
  };
  r2.hooks.lostPut = true;
  await assert.rejects(s.create(args));
  assert.equal(s.tables.hostedProjects.size, 1);
  assert.equal(s.tables.projectBackups.size, 0, 'reservation is not published completion');
  const id = await s.create(args);
  assert.equal(await s.create(args), id);
  assert.equal(s.tables.hostedProjects.size, 1);
  const rows = [...s.tables.projectObjects.values()];
  assert.equal(rows.length, 3);
  assert(rows.every(r => r.location === 'r2' && r.r2Committed && !r.storageId));
  assert.equal(s.tables.hostedProjects.get(id).r2StorageUsed, true);
  assert.equal(r2.objects.size, 3);
});
