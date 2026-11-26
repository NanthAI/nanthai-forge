// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Ferdinando Valsecchi
import { workRecordRows } from './hosted-fixture.mjs';
import test from 'node:test';
import { storedBytes } from './default-r2.mjs';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { getFunctionName } from 'convex/server';
import { ConvexError } from 'convex/values';
import { state } from './hosted-fixture.mjs';
import { establishedAccount } from './account-tier-fixture.mjs';
import { moduleUrl } from './convex-module.mjs';
import { emptyHostedProject } from '../dist/hosted-bootstrap.js';
import { policyPreset } from '../dist/autonomy-policy.js';
import { fakeSourceR2 } from './convex-source-r2-fixture.mjs';
const names = [
  'projectBootstrap',
  'projectBootstrapStore',
  'projectBackups',
  'projectHostedChannels',
  'projectObjectFind',
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
  // An Established owner: its daily new-project limit (50) and active total (100) sit above these fixtures.
  establishedAccount(s.tables, 'owner', ['project']);
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

test('browser creation publishes one R2 catalog page, initialized indexed Work and main', async () => {
  const s = setup(),
    args = input();
  const projectId = await s.create(args);
  const project = s.tables.hostedProjects.get(projectId);
  assert.equal(project.visibility, 'private');
  assert.deepEqual(project.autonomyPolicy, policyPreset('trusted'));
  assert.equal(s.tables.projectBackups.size, 1);
  assert.equal(s.tables.projectWorkGenerations.size, 1);
  assert.equal(s.tables.projectObjects.size, 0);
  assert.equal(s.tables.projectObjectCatalog.size, 1);
  assert.equal(s.files.size, 0);
  assert.deepEqual(s.scheduled, []);
  const snapshot = await modules.projectWorkActions.load(s.ctx, projectId, 'owner');
  assert.equal(snapshot.manifest.kind, 'forge-native-work-backup');
  assert.equal(snapshot.data.nativeHead, snapshot.manifest.head);
  assert.equal(snapshot.data.channelMoves[0].head, snapshot.manifest.head);
  assert.equal(snapshot.data.channelMoves[0].channel, 'main');
  assert.deepEqual(snapshot.data.lanes, []);
  assert.deepEqual(snapshot.data.intents, []);
  const main = await modules.projectHostedChannels.hostedStartMain(s.ctx, projectId);
  assert.equal(main.head, snapshot.manifest.head);
  assert.equal(main.receipt.id, `bootstrap:${main.head}`);
  assert.deepEqual(main.seed, { backupId: project.currentBackup, generationId: project.work.generationId });
  const expected = emptyHostedProject(args.operationId, new Date(project._creationTime).toISOString());
  for (const pin of expected.objects) {
    const object = await modules.projectObjectFind.findStoredObject(s.ctx, projectId, pin.sha256);
    assert.equal(object.size, pin.size);
    assert.equal(object.location, 'r2');
    assert.equal((await storedBytes(s, object)).toString(), pin.text);
  }
  const row = await modules.projectObjectFind.findStoredObject(s.ctx, projectId, main.head);
  const source = JSON.parse((await storedBytes(s, row)).toString());
  assert.deepEqual(source.files, []);
  assert.deepEqual(source.parents, []);
  assert.equal(row.stateGeneration, 1);
  assert.deepEqual(row.stateSize, { fileCount: 0, manifestBytes: row.size });
  const generation = s.tables.projectWorkGenerations.get(project.work.generationId);
  assert.equal(generation.status, 'ready');
  const tree = [...workRecordRows(s.tables)].find(row => row.collection === 'sourceTrees');
  assert.deepEqual(JSON.parse(tree.value), { head: snapshot.manifest.head, files: 0 });
});

// Item c0af6cfa F2: a new project is never born journal-only; its first Item lives in the record store.
test('a browser-created project starts in the record store and keeps its first Item there, not in the journal', async () => {
  const s = setup(),
    projectId = await s.create(input()),
    project = s.tables.hostedProjects.get(projectId);
  assert.equal(project.workStore, 'records');
  assert.deepEqual(project.workStoreWriters, ['note', 'intent', 'intent-status', 'planning']);
  assert.equal(project.workStoreCutoverRevision, 0);
  assert.deepEqual(project.workStoreEventWindows, [{ revision: 0, storeFirst: true }]);
  const receipt = JSON.parse([...s.tables.projectSourceCutovers.values()][0].receipt);
  assert.ok(receipt.changes.includes('Work kept in the record store'), 'the birth receipt says what it set');
  const { command } = await import(moduleUrl('../convex/projectWorkCommand.ts'));
  const { records } = await import(moduleUrl('../convex/projectWorkIndex.ts'));
  const itemId = randomUUID(),
    operationId = randomUUID();
  await s.transaction(() =>
    command._handler(s.ctx, {
      projectId,
      operationId,
      command: JSON.stringify({
        action: 'put-planning-item',
        operationId,
        itemId,
        expectedVersion: 0,
        kind: 'issue',
        title: 'First Item',
        body: '',
        status: 'open',
        intentIds: [],
      }),
    }),
  );
  assert.equal(s.tables.projectWorkEvents?.size ?? 0, 0, 'no journal event row');
  const retained = [...s.tables.projectHostedRecordBodies.values()].filter(row => row.operationId);
  assert.equal(retained.length, 1, 'the command retains its one primary version');
  const page = await records._handler(s.ctx, {
    projectId,
    collection: 'planningItems',
    paginationOpts: { cursor: null, numItems: 10 },
  });
  assert.deepEqual(
    page.page.map(row => [row.id, JSON.parse(row.value).title]),
    [[itemId, 'First Item']],
  );
});

test('a lost publication reply retries to the selected project without another R2 request', async t => {
  const r2 = fakeSourceR2(t),
    s = setup(),
    args = input(),
    run = s.ctx.runMutation;
  s.ctx.runMutation = async (ref, payload) => {
    const result = await run(ref, payload);
    if (getFunctionName(ref) === 'projectBootstrapStore:publish')
      throw new ConvexError({ code: 'INTERNAL_ERROR', message: 'lost publication reply' });
    return result;
  };
  await assert.rejects(s.create(args), code('HOSTED_ACTION_FAILED'));
  const [first] = s.tables.hostedProjects.keys();
  const before = structuredClone([...s.tables.hostedProjects.values()]);
  const requests = [...r2.requests];
  assert.equal(await s.create(args), first);
  assert.deepEqual(r2.requests, requests);
  assert.deepEqual([...s.tables.hostedProjects.values()], before);
  assert.equal(s.tables.hostedProjects.size, 1);
  assert.equal(s.tables.projectBackups.size, 1);
  assert.equal(s.tables.projectObjectCatalog.size, 1);
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

test("same-name creations retain existing slug collision rules within an Established account's project limits", async () => {
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

async function retainLegacyInput(s, args) {
  const at = '2026-01-01T00:00:00.000Z';
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
  return { ...args, at, objects };
}

test('a second prepared publisher reconciles the winner and reuses its content-addressed R2 bytes', async () => {
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
  assert.equal(s.files.size, 0, 'no Convex bytes');
  assert.equal(s.deleted.length, 0, 'both publishers wrote the same R2 keys');
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
    [...workRecordRows(s.tables)].find(
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
      const row = await modules.projectObjectFind.findStoredObject(s.ctx, projectId, pin.sha256);
      writeFileSync(path, await storedBytes(s, row));
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
  assert.equal(s.tables.projectObjectCatalog.size, 0);
  r2.hooks.mismatch = true;
  await assert.rejects(s.create(args), code('R2_VERIFY_FAILED'));
  assert.equal(s.tables.projectObjectCatalog.size, 0, 'unconfirmed R2 bytes are not cataloged');
  r2.hooks.mismatch = false;
  const id = await s.create(args);
  assert.equal(await s.create(args), id);
  assert.equal(s.tables.hostedProjects.size, 1);
  assert.equal(s.tables.projectObjects.size, 0);
  const [page] = s.tables.projectObjectCatalog.values();
  assert.equal(s.tables.projectObjectCatalog.size, 1);
  assert.equal(page.sizes.length, 3);
  assert.equal(r2.objects.size, 3);
});

// Item c0af6cfa F2 review 92eafa87 P1: in the record store an Intent's creation is a retained version, not a
// `projectWorkEvents` row. A contributor's proposal on the first Intent of a browser-born project must still
// register against the Intent's exact server-pinned base, in both Work modes, and keep its denials.
test('a contributor proposal on a browser-born Intent registers its exact base pins with no journal event', async () => {
  for (const records of [true, false]) {
    const s = setup(),
      projectId = await s.create(input()),
      project = s.tables.hostedProjects.get(projectId);
    if (!records)
      for (const field of [
        'workStore',
        'workStoreWriters',
        'workStoreCutoverRevision',
        'workStoreEventWindows',
      ])
        delete project[field];
    establishedAccount(s.tables, 'contributor', ['planning', 'start']);
    s.tables.projectContributors.set('grant', {
      _id: 'grant',
      _creationTime: 1,
      projectId,
      contributor: 'contributor',
    });
    const main = await modules.projectHostedChannels.hostedStartMain(s.ctx, projectId);
    const { command } = await import(moduleUrl('../convex/projectWorkCommand.ts'));
    const proposals = await import(moduleUrl('../convex/projectProposals.ts'));
    const intentId = randomUUID();
    s.caller('contributor');
    await s.transaction(() =>
      command._handler(s.ctx, {
        projectId,
        operationId: intentId,
        command: JSON.stringify({
          action: 'intent',
          outcome: 'First Intent',
          constraints: '',
          base: main.head,
        }),
      }),
    );
    assert.equal(s.tables.projectWorkEvents?.size ?? 0, records ? 0 : 1);
    const backup = s.tables.projectBackups.get(project.currentBackup);
    const register = (patch = {}) =>
      s.transaction(() =>
        proposals.register._handler(s.ctx, {
          projectId,
          operationId: randomUUID(),
          intentId,
          baseBackupId: backup._id,
          baseArchiveSha256: backup.digest,
          baseState: main.head,
          head: 'c'.repeat(64),
          viewId: 'view',
          digest: 'd'.repeat(64),
          size: 1,
          preview: backup.preview,
          transport: 'objects',
          actor: 'contributor',
          request: 'e'.repeat(64),
          nonce: randomUUID(),
          ...patch,
        }),
      );
    assert.ok(await register(), `registered with ${records ? 'record store' : 'journal'} provenance`);
    await assert.rejects(register({ baseState: 'f'.repeat(64) }), code('SOURCE_UNAVAILABLE'));
    s.tables.projectContributors.delete('grant');
    await assert.rejects(register(), code('PROJECT_UNAVAILABLE'));
  }
});
