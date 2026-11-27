// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Ferdinando Valsecchi
import { testDeploymentOrigin } from './trusted-origin.mjs';
import { historicalArchiveActions } from './historical-archive-fixture.mjs';
import test from 'node:test';
import { setup as r2Setup } from './r2-harness.mjs';
import assert from 'node:assert/strict';
import { putR2 } from '../dist/exchange-blobs.js';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { getFunctionName } from 'convex/server';
import { convexToJson, jsonToConvex } from 'convex/values';
import { LegacyWorkService as WorkService } from './autonomy-fixture.mjs';
import { initLegacyNative as initNative } from './autonomy-fixture.mjs';
import { restoreNativeWork } from '../dist/native-backup.js';
import { digest } from '../dist/hash.js';
import { state, providers } from './hosted-fixture.mjs';
import { moduleUrl } from './convex-module.mjs';
import { readHosted } from './hosted-read.mjs';
const modules = {};
for (const name of [
  'projectWork',
  'projectHostedSeedWorkStore',
  'r2ArchiveSource',
  'projectBackups',
  'projectContributors',
  'projectProposals',
  'projectObjects',
  'projectObjectDownloads',
  'projectObjectCommit',
  'projectProposalObjects',
  'projectExchangeActions',
  'projectExchange',
  'projectBackupObjects',
])
  modules[name] = await import(moduleUrl(`../convex/${name}.ts`));
const actions = await import(moduleUrl('../convex/projectWorkActions.ts'));
const indexActions = await import(moduleUrl('../convex/projectWorkIndexActions.ts'));
const invitationAnswers = await import(moduleUrl('../convex/projectInvitationAnswers.ts'));
const grants = await import(moduleUrl('../convex/projectContributorActions.ts'));
const proposals = historicalArchiveActions(await import(moduleUrl('../convex/projectProposalActions.ts')));
const backups = historicalArchiveActions(await import(moduleUrl('../convex/projectBackupActions.ts')));
const { previewWorkArchive } = await import(moduleUrl('../web/src/work-archive.ts'));
const unavailable = e => e.data?.code === 'PROJECT_UNAVAILABLE';
async function acceptContributorInvitation(s) {
  const row = [...s.tables.projectInvites.values()].find(
    row => row.recipient === 'contributor' && row.state === 'pending',
  );
  const identity = s.ctx.auth.getUserIdentity;
  s.ctx.auth.getUserIdentity = async () => ({ subject: 'contributor' });
  try {
    await invitationAnswers.answer._handler(s.ctx, {
      invitationId: row._id,
      choice: 'accept',
      operationId: randomUUID(),
    });
  } finally {
    s.ctx.auth.getUserIdentity = identity;
  }
}
async function setup(t, { retained = false, r2Ready = false } = {}) {
  if (!r2Ready) await r2Setup(t);
  const dir = mkdtempSync(join(tmpdir(), 'forge-contributors-'));
  t.after(() => rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }));
  const root = join(dir, 'owner');
  mkdirSync(root);
  writeFileSync(join(root, 'a.ts'), 'export const a=1;\n');
  initNative(root);
  const w = new WorkService(root),
    call = c => w.dispatch(c, w.store.load().revision);
  const intent = (await call({ action: 'intent', outcome: 'Existing owner work' })).result,
    lane = (await call({ action: 'lane', intentId: intent.id, name: 'Original' })).result;
  const view = (
    await call({ action: 'compose', intentId: intent.id, inputs: [{ laneId: lane.id, head: lane.head }] })
  ).result;
  if (retained) {
    await call({
      action: 'accept-channel',
      operationId: randomUUID(),
      channel: 'main',
      viewId: view.id,
      expectedHead: view.head,
      expectedPrevious: null,
    });
    const check = (
      await call({
        action: 'define-check',
        name: 'Original exact evidence',
        executable: process.execPath,
        args: ['-e', 'console.log("original owner evidence")'],
      })
    ).result;
    const run = await call({
      action: 'run-check',
      operationId: randomUUID(),
      viewId: view.id,
      expectedHead: view.head,
      checkId: check.id,
      expectedDefinition: check.definition,
      expectedEnvironment: w.status().environment.fingerprint,
    });
    await finished(w, run.result.id);
  }
  const exported = (await call({ action: 'export-work', archive: true })).result,
    bytes = readFileSync(exported.archive.path),
    preview = await previewWorkArchive(new File([bytes], 'native.tar.gz'));
  const s = state([]),
    native = s.ctx.runQuery;
  for (const name of [
    'hostedProjects',
    'projectBackups',
    'projectHostedRecordBodies',
    'projectContributors',
    'projectProposals',
  ])
    s.tables[name] = new Map();
  s.ctx.runAction =
    s.ctx.runQuery =
    s.ctx.runMutation =
      (ref, args) => {
        const [m, n] = getFunctionName(ref).split(':');
        return modules[m]?.[n]?._handler(s.ctx, args) ?? native(ref, args);
      };
  s.ctx.storage.generateUploadUrl = async () => 'https://upload.invalid/fixture';
  s.ctx.db.system.query = () => ({
    order: () => ({
      paginate: async () => ({
        page: [...s.files].filter(([, f]) => f.metadata).map(([id, f]) => ({ _id: id, ...f.metadata })),
        isDone: true,
        continueCursor: '',
      }),
    }),
  });
  s.tables.hostedProjects.set('project', {
    _id: 'project',
    _creationTime: 1,
    owner: 'owner',
    key: randomUUID(),
    name: 'Native shared project',
    currentBackup: 'backup',
    revision: 1,
  });
  s.tables.projectBackups.set('backup', {
    _id: 'backup',
    _creationTime: 1,
    projectId: 'project',
    operationId: randomUUID(),
    request: digest('base'),
    nonce: randomUUID(),
    previous: null,
    digest: digest(bytes),
    size: bytes.length,
    preview,
    status: 'stored',
    location: 'r2',
    r2Committed: true,
    r2Key: `v1/p/project/o/${digest(bytes)}`,
  });
  {
    // The base archive is an R2 object, written like any upload.
    const { presignPut, r2Config } = await import(moduleUrl('../convex/r2.ts'));
    const target = await presignPut(r2Config(), `v1/p/project/o/${digest(bytes)}`, {
      digest: digest(bytes),
      size: bytes.length,
    });
    const put = await fetch(target.url, { method: 'PUT', headers: target.headers, body: bytes });
    assert.ok(put.ok || put.status === 412);
  }
  await actions.initialize._handler(s.ctx, {
    projectId: 'project',
    backupId: 'backup',
    operationId: randomUUID(),
  });
  await indexActions.ensure._handler(s.ctx, { projectId: 'project', rebuild: true });
  for (const person of ['owner', 'contributor', 'third']) {
    if (![...s.tables.forgeAccounts.values()].some(row => row.owner === person))
      s.tables.forgeAccounts.set(`account-${person}`, {
        _id: `account-${person}`,
        _creationTime: 1,
        owner: person,
        handle: person,
      });
  }
  s.tables.users.set('verified-owner', {
    _id: 'verified-owner',
    _creationTime: 1,
    accountKey: 'owner',
    email: 'owner@example.test',
    emailVerified: true,
  });
  const cleanup = providers();
  t.after(cleanup);
  await grants.add._handler(s.ctx, { projectId: 'project', contributor: 'contributor' });
  await acceptContributorInvitation(s);
  const read = async () => JSON.parse(await readHosted(s.ctx, { projectId: 'project' }));
  return {
    ...s,
    dir,
    root,
    w,
    intent,
    lane,
    view,
    bytes,
    preview,
    read,
    command: async command =>
      actions.command._handler(s.ctx, {
        projectId: 'project',
        operationId: randomUUID(),
        revision: (await read()).data.revision,
        command: JSON.stringify(command),
      }),
  };
}
async function finished(w, id) {
  for (
    let i = 0;
    i < 200 && ['preparing', 'running'].includes(w.store.load().runs.find(x => x.id === id).status);
    i++
  )
    await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal(w.store.load().runs.find(x => x.id === id).status, 'passed');
}
async function candidate(t, s) {
  s.caller('contributor');
  const created = await s.command({ action: 'intent', outcome: 'Contributor change', base: s.view.head });
  const journal = join(s.dir, 'journal.json');
  writeFileSync(journal, await actions.exportJournal._handler(s.ctx, { projectId: 'project' }));
  const archive = join(s.dir, 'base.tar.gz');
  writeFileSync(archive, s.bytes);
  const root = join(s.dir, 'contributor');
  await restoreNativeWork(archive, root, journal);
  const w = new WorkService(root),
    c = command => w.dispatch(command, w.store.load().revision);
  const lane = (await c({ action: 'lane', intentId: created.operationId, name: 'Proposed source' })).result;
  writeFileSync(join(w.store.path(lane.id), 'a.ts'), 'export const a=2;\n');
  const obs = w.status().lanes.find(x => x.id === lane.id),
    head = (
      await c({
        action: 'checkpoint',
        laneId: lane.id,
        expectedHead: lane.head,
        expectedTree: obs.indexTree,
        message: 'Contributor candidate',
      })
    ).result;
  const view = (
    await c({
      action: 'compose',
      intentId: created.operationId,
      inputs: [{ laneId: lane.id, head: head.head }],
    })
  ).result;
  const exported = (await c({ action: 'export-work', archive: true })).result,
    bytes = readFileSync(exported.archive.path),
    preview = await previewWorkArchive(new File([bytes], 'proposal.tar.gz'));
  const input = {
    projectId: 'project',
    operationId: randomUUID(),
    intentId: created.operationId,
    baseBackupId: 'backup',
    baseArchiveSha256: digest(s.bytes),
    baseState: s.view.head,
    head: view.head,
    viewId: view.id,
    digest: digest(bytes),
    size: bytes.length,
    preview,
  };
  return { input, bytes, view, created, w };
}
function upload(s, prepared, bytes, id = 'proposal-file') {
  s.files.set(id, {
    blob: new Blob([bytes], { type: prepared.contentType }),
    metadata: { size: bytes.length, sha256: digest(bytes), contentType: prepared.contentType },
  });
  return id;
}
// Historical shape (F6): a native proposal stored before the R2 cutover. Completing a native
// upload now refuses (R2_REQUIRED), so stored legacy rows are seeded as they exist.
function storedNative(s, prepared, storageId) {
  const row = s.tables.projectProposals.get(prepared.proposal._id);
  Object.assign(row, { status: 'stored', storageId });
  return structuredClone(row);
}
const r2Required = e => (e.code ?? e.data?.code) === 'R2_REQUIRED';
test('native contributor grant discovers full project and source without GitHub entitlement; server actor controls own Intent operations', async t => {
  const s = await setup(t),
    before = structuredClone(s.tables.hostedProjects.get('project'));
  s.caller('contributor');
  const shared = await modules.projectContributors.shared._handler(s.ctx, {
    paginationOpts: { cursor: null, numItems: 10 },
  });
  assert.equal(shared.page[0].id, 'project');
  const initial = await s.read();
  assert.equal(initial.actor, 'contributor');
  assert.equal(initial.capabilities.owner, false);
  assert.equal(initial.capabilities.sourceReturn, false);
  assert.deepEqual(initial.capabilities.editableIntentIds, []);
  const created = await s.command({ action: 'intent', outcome: 'Mine', base: s.view.head });
  assert.equal(created.actor, 'contributor');
  const current = await s.read();
  assert.deepEqual(current.capabilities.editableIntentIds, [created.operationId]);
  await s.command({ action: 'note', intentId: created.operationId, kind: 'comment', text: 'My comment' });
  await s.command({ action: 'intent-status', intentId: created.operationId, status: 'ready' });
  await assert.rejects(
    s.command({
      action: 'note',
      intentId: s.intent.id,
      kind: 'comment',
      text: 'Not my imported owner Intent',
    }),
    unavailable,
  );
  const part = await backups.downloadPart._handler(s.ctx, {
    id: 'backup',
    offset: 0,
    digest: digest(s.bytes),
  });
  assert.equal(part.direct, true, 'the base archive downloads straight from R2');
  assert.ok(part.url);

  assert.equal(s.tables.hostedProjects.get('project').currentBackup, before.currentBackup);
  s.caller('owner');
  await s.command({
    action: 'note',
    intentId: created.operationId,
    kind: 'decision',
    text: 'Owner still manages all Work',
  });
});
test('contributor retries are actor-bound, grant revocation during final append rejects without changing Work', async t => {
  const s = await setup(t);
  s.caller('contributor');
  const op = {
    projectId: 'project',
    operationId: randomUUID(),
    revision: (await s.read()).data.revision,
    command: JSON.stringify({ action: 'intent', outcome: 'Original request', base: s.view.head }),
  };
  const native = s.ctx.runMutation;
  let lost = false;
  s.ctx.runMutation = async (ref, args) => {
    const result = await native(ref, args);
    if (getFunctionName(ref) === 'projectWorkCommand:commandFromAction' && !lost) {
      lost = true;
      throw Error('lost reply');
    }
    return result;
  };
  await assert.rejects(actions.command._handler(s.ctx, op));
  s.ctx.runMutation = native;
  assert.equal((await actions.command._handler(s.ctx, op)).actor, 'contributor');
  s.caller('owner');
  await assert.rejects(actions.command._handler(s.ctx, op), e => e.data.code === 'WORK_OPERATION_CHANGED');
  s.caller('contributor');
  const before = structuredClone(s.tables.hostedProjects.get('project'));
  s.ctx.runMutation = async (ref, args) => {
    if (getFunctionName(ref) === 'projectWorkCommand:commandFromAction') s.tables.projectContributors.clear();
    return native(ref, args);
  };
  await assert.rejects(
    s.command({ action: 'note', intentId: op.operationId, kind: 'comment', text: 'Revoked while loading' }),
    unavailable,
  );
  assert.deepEqual(s.tables.hostedProjects.get('project'), before);
  for (const actor of [undefined, 'unrelated', 'contributor']) {
    s.caller(actor);
    await assert.rejects(s.read(), unavailable);
    await assert.rejects(
      backups.downloadPart._handler(s.ctx, { id: 'backup', offset: 0, digest: digest(s.bytes) }),
      unavailable,
    );
  }
});
test('grant add verifies existing Forge identity and current owner after the account lookup; contributor cannot manage grants', async t => {
  const s = await setup(t);
  await assert.rejects(
    grants.add._handler(s.ctx, { projectId: 'project', contributor: 'missing' }),
    e => e.data.code === 'BAD_ARGUMENT',
  );
  s.caller('contributor');
  await assert.rejects(
    grants.add._handler(s.ctx, { projectId: 'project', contributor: 'third' }),
    unavailable,
  );
  await assert.rejects(
    modules.projectContributors.remove._handler(s.ctx, { projectId: 'project', contributor: 'contributor' }),
    unavailable,
  );
  s.caller('owner');
  // The owner changes while the contributor's account is looked up; the grant still refuses.
  const route = s.ctx.runQuery;
  s.ctx.runQuery = async (ref, args) => {
    const result = await route(ref, args);
    if (getFunctionName(ref) === 'sharing:accountExists')
      s.tables.hostedProjects.get('project').owner = 'new-owner';
    return result;
  };
  try {
    await assert.rejects(
      grants.add._handler(s.ctx, { projectId: 'project', contributor: 'third' }),
      unavailable,
    );
  } finally {
    s.ctx.runQuery = route;
  }
  assert.equal(s.tables.hostedProjects.get('project').owner, 'new-owner', 'the lookup ran');
  assert.equal(
    [...s.tables.projectContributors.values()].some(x => x.contributor === 'third'),
    false,
  );
});
test('legacy email addition creates a private pending invitation without provider lookup and rechecks current ownership', async t => {
  const s = await setup(t),
    previous = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = previous;
  });
  let calls = 0;
  globalThis.fetch = async () => {
    calls++;
    throw new Error('No email directory probe');
  };
  s.caller('contributor');
  await assert.rejects(
    grants.addByEmail._handler(s.ctx, { projectId: 'project', email: 'person@example.test' }),
    unavailable,
  );
  s.caller('owner');
  await grants.addByEmail._handler(s.ctx, { projectId: 'project', email: ' Person@example.test ' });
  assert.equal(calls, 0);
  assert.ok(
    [...s.tables.projectInvites.values()].some(
      row => row.email === 'person@example.test' && row.state === 'pending',
    ),
  );
  assert.ok(![...s.tables.projectContributors.values()].some(row => row.contributor === 'third'));
  s.tables.hostedProjects.get('project').removal = 'trash';
  await assert.rejects(
    grants.addByEmail._handler(s.ctx, { projectId: 'project', email: 'other@example.test' }),
    unavailable,
  );
});

test('new contributor proposals transfer objects, preserve old archives, pull directly for native import and recheck access', async t => {
  const s = await setup(t),
    c = await candidate(t, s);
  const { uploadArchiveObjects } = await import(moduleUrl('../web/src/archive-object-upload.ts'));
  const { ConvexExchange } = await import('../dist/exchange-client.js');
  const { pullNativeExchange } = await import('../dist/native-exchange.js');
  const { NativeSource } = await import('../dist/native-source.js');
  const nativeFetch = globalThis.fetch;
  s.ctx.storage.generateUploadUrl = () => assert.fail('proposal objects upload to R2 only');
  let posts = 0;
  globalThis.fetch = async (url, init) => {
    if (String(url).startsWith('https://fixture.convex.cloud/api/')) {
      const request = JSON.parse(init.body),
        [name, method] = request.path.split(':');
      const value = await modules[name][method]._handler(s.ctx, jsonToConvex(request.args[0]));
      return Response.json({ status: 'success', value: convexToJson(value) });
    }
    if (init?.method === 'PUT') posts++;
    return nativeFetch(url, init);
  };
  t.after(() => {
    globalThis.fetch = nativeFetch;
  });
  const client = {
    mutation: (ref, args) => s.ctx.runMutation(ref, args),
    action: (ref, args) => s.ctx.runAction(ref, args),
  };
  const pin = await uploadArchiveObjects(client, 'project', new File([c.bytes], 'proposal.tar.gz'));
  assert.notEqual(pin.digest, c.input.digest, 'source manifest, not compressed transport bytes');
  const input = { ...c.input, ...pin };
  const row = await modules.projectProposalObjects.publish._handler(s.ctx, input);
  assert.equal(row.transport, 'objects');
  assert.equal(row.status, 'stored');
  assert.equal(row.storageId, undefined);
  assert.ok(posts > 0);
  const count = posts;
  assert.deepEqual(
    await uploadArchiveObjects(client, 'project', new File([c.bytes], 'proposal.tar.gz')),
    pin,
  );
  assert.equal(posts, count, 'all existing logical content reused');
  assert.equal((await modules.projectProposalObjects.publish._handler(s.ctx, input))._id, row._id);
  const originalMutation = s.ctx.runMutation,
    grantsBefore = [...s.tables.projectContributors.entries()];
  const pendingInput = { ...input, operationId: randomUUID() };
  s.ctx.runMutation = (ref, args) => {
    if (getFunctionName(ref) === 'projectProposals:completeObjects') s.tables.projectContributors.clear();
    return originalMutation(ref, args);
  };
  await assert.rejects(modules.projectProposalObjects.publish._handler(s.ctx, pendingInput), unavailable);
  const pending = [...s.tables.projectProposals.values()].find(
    item => item.operationId === pendingInput.operationId,
  );
  assert.equal(pending.status, 'uploading');
  s.ctx.runMutation = originalMutation;
  for (const [id, grant] of grantsBefore) s.tables.projectContributors.set(id, grant);
  assert.equal((await modules.projectProposalObjects.publish._handler(s.ctx, pendingInput))._id, pending._id);
  assert.equal(pending.status, 'stored', 'an original object proposal resumes after grant restoration');

  assert.equal(s.tables.projectBackups.get('backup').transport, undefined, 'legacy source remains readable');
  const transport = new ConvexExchange(
    testDeploymentOrigin('https://fixture.convex.cloud'),
    'synthetic',
    'project',
    '',
    null,
    false,
    row._id,
  );
  transport.client = {
    action: (ref, args) => s.ctx.runAction(ref, args),
    query: (ref, args) => s.ctx.runQuery(ref, args),
    mutation: (ref, args) => s.ctx.runMutation(ref, args),
  };
  const target = join(s.dir, 'object-proposal');
  await pullNativeExchange(row._id, target, transport, { exportOnly: true });
  assert.equal(existsSync(join(target, 'manifest.json')), true);
  assert.equal(
    existsSync(join(target, '.forge')),
    false,
    'the result is an unpacked export for direct import',
  );
  const data = s.w.store.load();
  data.intents.push(c.w.store.load().intents.find(item => item.id === c.input.intentId));
  data.revision++;
  s.w.store.save(data);
  const imported = await s.w.dispatch(
    {
      action: 'import-native-contribution',
      operationId: randomUUID(),
      intentId: c.input.intentId,
      expectedBase: c.input.baseState,
      expectedHead: c.input.head,
      archivePath: target,
      archiveSha256: pin.digest,
      name: 'Object proposal',
      claim: {
        actor: 'contributor',
        projectKey: s.tables.hostedProjects.get('project').key,
        proposalId: row._id,
        viewId: c.input.viewId,
      },
    },
    data.revision,
  );
  assert.equal(imported.result.head, c.input.head);
  assert.equal(new NativeSource(s.w.store.root).state(imported.result.head).files.length > 0, true);
  const { receiveProposal } = await import('../dist/exchange-proposal.js');
  const previousToken = process.env.FORGE_AUTH_TOKEN;
  process.env.FORGE_AUTH_TOKEN = 'synthetic-receive-only';
  t.after(() => {
    if (previousToken === undefined) delete process.env.FORGE_AUTH_TOKEN;
    else process.env.FORGE_AUTH_TOKEN = previousToken;
  });
  s.caller('owner');
  const receiveRequest = {
    url: 'https://fixture.convex.cloud',
    projectId: 'project',
    proposalId: row._id,
    operationId: randomUUID(),
  };
  const received = await receiveProposal(s.w.store.root, receiveRequest);
  assert.equal(received.result.head, c.input.head);
  const retry = await receiveProposal(s.w.store.root, receiveRequest);
  assert.equal(retry.result.id, received.result.id);

  for (const actor of ['stranger', 'reader']) {
    s.caller(actor);
    if (actor === 'reader')
      s.tables.projectReaders.set('reader-grant', {
        _id: 'reader-grant',
        projectId: 'project',
        reader: actor,
      });
    await assert.rejects(
      modules.projectObjects.prepare._handler(s.ctx, {
        projectId: 'project',
        digest: 'f'.repeat(64),
        size: 1,
      }),
      unavailable,
    );
  }
  s.caller('contributor');
  const legacyProposalActions = await import(moduleUrl('../convex/projectProposalActions.ts'));
  await assert.rejects(
    legacyProposalActions.prepare._handler(s.ctx, { ...c.input, operationId: randomUUID() }),
    error => error.data?.code === 'ARCHIVE_TRANSPORT_RETIRED',
  );
  s.tables.projectContributors.clear();
  await assert.rejects(modules.projectProposalObjects.publish._handler(s.ctx, input), unavailable);
  s.caller('owner');
  const key = randomUUID();
  const projectId = await modules.projectBackupObjects.open._handler(s.ctx, {
    key,
    name: 'Object backup import',
    serverAuthority: true,
  });
  for (const name of ['projectHostedSeed', 'projectHostedSeedActions'])
    modules[name] = await import(moduleUrl(`../convex/${name}.ts`));
  for (const table of ['projectHostedSeeds', 'projectHostedSeedPages', 'projectHostedChannels'])
    s.tables[table] ??= new Map();
  client.action = (ref, args) => s.ctx.runAction(ref, args);
  const importedBackup = await uploadArchiveObjects(client, projectId, new File([c.bytes], 'backup.tar.gz'), {
    operationId: randomUUID(),
    preview: c.input.preview,
    serverAuthority: true,
  });
  const backupId = importedBackup.backupId;
  assert.equal(s.tables.projectBackups.get(backupId).transport, 'objects');
  const legacyBackupActions = await import(moduleUrl('../convex/projectBackupActions.ts'));
  await assert.rejects(
    legacyBackupActions.prepare._handler(s.ctx, {
      key,
      name: 'Object backup import',
      operationId: randomUUID(),
      previous: backupId,
      digest: c.input.digest,
      size: c.input.size,
      preview: c.input.preview,
    }),
    error => error.data?.code === 'ARCHIVE_TRANSPORT_RETIRED',
  );
});

test('contributor proposals publish and read committed R2 roots while retaining old archive rows', async t => {
  const { fake } = await r2Setup(t);
  const s = await setup(t, { r2Ready: true }),
    c = await candidate(t, s);
  const { workArchiveMetadata } = await import('../dist/work-archive-metadata.js');
  const { storeProjectArtifact } = await import(moduleUrl('../convex/projectArtifactActions.ts'));
  s.ctx.storage.store = () => assert.fail('R2 proposal must not store Convex bytes');
  s.ctx.storage.generateUploadUrl = () => assert.fail('R2 proposal must not create Convex upload URLs');
  const store = bytes => storeProjectArtifact(s.ctx, 'project', 'contributor', Buffer.from(bytes));
  const metadata = await workArchiveMetadata(new File([c.bytes], 'proposal.tar.gz'), {
    select: () => true,
    read: async (_name, bytes) => store(bytes),
  });
  await store(metadata.work);
  await store(metadata.manifest);
  const pin = { digest: digest(metadata.manifest), size: metadata.manifest.length };
  const row = await modules.projectProposalObjects.publish._handler(s.ctx, { ...c.input, ...pin });
  assert.equal(row.status, 'stored');
  assert.equal(row.transport, 'objects');
  assert.equal(row.storageId, undefined);
  assert.ok(fake.objects.size > 0);
  const checkpoint = await modules.projectProposalObjects.checkpoint._handler(s.ctx, { proposalId: row._id });
  assert.equal(checkpoint.digest, pin.digest);
  const count = fake.objects.size;
  assert.equal(
    (await modules.projectProposalObjects.publish._handler(s.ctx, { ...c.input, ...pin }))._id,
    row._id,
  );
  assert.equal(fake.objects.size, count);
});

test('archive metadata sidecars use R2 and preserve exact Work bytes', async t => {
  const { fake } = await r2Setup(t);
  const s = await setup(t, { r2Ready: true });
  const { blobStore } = await import(moduleUrl('../convex/blobStore.ts'));
  const original = await blobStore(s.ctx).store(new Blob([s.bytes], { type: 'application/gzip' }), {
    r2Namespace: 'v1/p/project/archives/sidecar-original',
  });
  s.ctx.storage.store = () => assert.fail('opted-in metadata sidecars must not write Convex bytes');
  const { projectArchiveMetadata } = await import(moduleUrl('../convex/projectArchiveMetadata.ts'));
  const load = () =>
    projectArchiveMetadata(s.ctx, original, s.bytes.length, digest(s.bytes), async () => {}, true, true);
  const first = await load(),
    objects = fake.objects.size;
  const second = await load();
  assert.deepEqual(Buffer.from(second.work), Buffer.from(first.work));
  assert.deepEqual(Buffer.from(second.manifest), Buffer.from(first.manifest));
  assert.equal(fake.objects.size, objects);
  assert.ok(
    [...s.tables.derivedArtifacts.values()].some(
      row => row.original === original && row.storageId?.startsWith('r2blob:'),
    ),
  );
});

test('resumed archive proposals upload directly to R2 and retain exact View and grant validation', async t => {
  const s = await setup(t),
    c = await candidate(t, s),
    prepared = await proposals.prepare._handler(s.ctx, c.input);
  const id = prepared.proposal._id,
    target = await modules.projectProposals.uploadUrl._handler(s.ctx, { id, actor: 'contributor' });
  s.ctx.storage.store = () => assert.fail('R2 archive proposals must not write Convex bytes');
  await putR2(target, c.bytes);
  const stored = await proposals.complete._handler(s.ctx, { id });
  assert.equal(stored.status, 'stored');
  assert.equal(stored.r2Committed, true);
  assert.equal(stored.storageId, undefined);
  assert.equal(stored.head, c.view.head);
  const part = await proposals.downloadPart._handler(s.ctx, { id, offset: 0, digest: stored.digest });
  assert.equal(part.direct, true);
  assert.deepEqual(Buffer.from(await (await fetch(part.url)).arrayBuffer()), c.bytes);
  assert.equal(s.tables.hostedProjects.get('project').currentBackup, 'backup');
});

test('an R2-only resumed backup restores source and Work metadata without a legacy storage ID', async t => {
  const s = await setup(t),
    row = s.tables.projectBackups.get('backup');
  s.caller('owner');
  row.status = 'uploading';
  delete row.storageId;
  const target = await modules.projectBackups.uploadUrl._handler(s.ctx, { id: 'backup', owner: 'owner' });
  await putR2(target, s.bytes);
  await backups.complete._handler(s.ctx, { id: 'backup' });
  const { source } = await import(moduleUrl('../convex/projectWorkLoad.ts'));
  const restored = await source(s.ctx, 'backup', 'owner');
  assert.equal(restored.backup.storageId, undefined);
  assert.equal(restored.backup.r2Committed, true);
  assert.equal(restored.manifest.head, s.preview.head);
  assert.equal(restored.data.nativeHead, s.preview.head);
  assert.equal(
    restored.originalWorkDigest,
    restored.manifest.files.find(file => file.path === 'work.json').sha256,
  );
});
