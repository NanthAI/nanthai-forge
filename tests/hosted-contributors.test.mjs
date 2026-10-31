import { historicalArchiveActions } from './historical-archive-fixture.mjs';
// SPDX-License-Identifier: Apache-2.0
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
const grants = await import(moduleUrl('../convex/projectContributorActions.ts'));
const proposals = historicalArchiveActions(await import(moduleUrl('../convex/projectProposalActions.ts')));
const backups = historicalArchiveActions(await import(moduleUrl('../convex/projectBackupActions.ts')));
const { previewWorkArchive } = await import(moduleUrl('../web/src/work-archive.ts'));
const unavailable = e => e.data?.code === 'PROJECT_UNAVAILABLE';
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
    'projectWorkEvents',
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
    storageId: 'base',
  });
  s.files.set('base', { blob: new Blob([bytes]) });
  await actions.initialize._handler(s.ctx, {
    projectId: 'project',
    backupId: 'backup',
    operationId: randomUUID(),
  });
  await indexActions.ensure._handler(s.ctx, { projectId: 'project', rebuild: true });
  const cleanup = providers();
  t.after(cleanup);
  await grants.add._handler(s.ctx, { projectId: 'project', contributor: 'contributor' });
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
  assert.deepEqual(Buffer.from(part.data), s.bytes);

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
    if (getFunctionName(ref) === 'projectWork:append' && !lost) {
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
    if (getFunctionName(ref) === 'projectWork:append') s.tables.projectContributors.clear();
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
test('immutable contributor proposal completion, exact upload retry and owner download preserve canonical backup and Channels', async t => {
  const s = await setup(t),
    c = await candidate(t, s),
    before = structuredClone(s.tables.hostedProjects.get('project'));
  const prepared = await proposals.prepare._handler(s.ctx, c.input);
  assert.equal(prepared.proposal.status, 'uploading');
  // A fresh upload has no stored bytes yet; reconciliation returns its original record.
  const nativeQuery = s.ctx.runQuery;
  s.ctx.runQuery = async (ref, args) =>
    getFunctionName(ref) === 'projectProposals:findUpload'
      ? { id: null, isDone: true, cursor: '' }
      : nativeQuery(ref, args);
  assert.equal(
    (await proposals.reconcileUpload._handler(s.ctx, { id: prepared.proposal._id })).status,
    'uploading',
  );
  s.ctx.runQuery = nativeQuery;
  const storageId = upload(s, prepared, c.bytes);
  const native = s.ctx.runMutation;
  let lost = false;
  s.ctx.runMutation = async (ref, args) => {
    const result = await native(ref, args);
    if (getFunctionName(ref) === 'projectProposals:complete' && !lost) {
      lost = true;
      throw Error('lost completion reply');
    }
    return result;
  };
  await assert.rejects(proposals.complete._handler(s.ctx, { id: prepared.proposal._id, storageId }));
  s.ctx.runMutation = native;
  const stored = await proposals.complete._handler(s.ctx, { id: prepared.proposal._id, storageId });
  assert.equal(stored.status, 'stored');
  assert.equal(stored.head, c.view.head);
  assert.equal(stored.actor, 'contributor');
  assert.deepEqual(s.tables.hostedProjects.get('project'), before);
  const old = await proposals.prepare._handler(s.ctx, c.input);
  assert.equal(old.proposal._id, stored._id);
  assert.equal(old.uploadUrl, undefined);
  await assert.rejects(
    proposals.prepare._handler(s.ctx, { ...c.input, head: 'f'.repeat(64) }),
    e => e.data.code === 'WORK_OPERATION_CHANGED',
  );
  s.caller('owner');
  await assert.rejects(
    proposals.prepare._handler(s.ctx, c.input),
    e => e.data.code === 'WORK_OPERATION_CHANGED',
  );
  await assert.rejects(proposals.complete._handler(s.ctx, { id: stored._id, storageId }), unavailable);
  const part = await proposals.downloadPart._handler(s.ctx, {
    id: stored._id,
    offset: 0,
    digest: stored.digest,
  });
  assert.deepEqual(Buffer.from(part.data), c.bytes);
  const listed = await modules.projectProposals.list._handler(s.ctx, {
    projectId: 'project',
    paginationOpts: { cursor: null, numItems: 10 },
  });
  assert.equal(listed.page[0]._id, stored._id);
  await modules.projectContributors.remove._handler(s.ctx, {
    projectId: 'project',
    contributor: 'contributor',
  });
  s.caller('contributor');
  await assert.rejects(
    proposals.downloadPart._handler(s.ctx, { id: stored._id, offset: 0, digest: stored.digest }),
    unavailable,
  );
  s.caller('owner');
  const derivativeIds = [...s.tables.derivedArtifacts.values()]
    .filter(row => row.original === storageId)
    .map(row => row.storageId)
    .filter(Boolean);
  await modules.projectProposals.remove._handler(s.ctx, { id: stored._id });
  assert.deepEqual(s.deleted, [storageId, ...derivativeIds.filter(id => !id.startsWith('r2blob:'))]);
  const { blobStore } = await import(moduleUrl('../convex/blobStore.ts'));
  const artifactStorage = await import(moduleUrl('../convex/artifactStorage.ts'));
  for (const ref of derivativeIds.filter(id => id.startsWith('r2blob:'))) {
    assert.equal(
      await blobStore(s.ctx).getMetadata(ref),
      null,
      'R2 derivative is tombstoned before byte cleanup',
    );
    await artifactStorage.deleteBytes._handler(s.ctx, { ref });
  }
  assert.ok(s.files.has('base'));
  assert.deepEqual(s.tables.hostedProjects.get('project'), before);
});
test('proposal final completion rechecks grant after asynchronous archive read; changed source pins never become canonical', async t => {
  const s = await setup(t),
    c = await candidate(t, s),
    prepared = await proposals.prepare._handler(s.ctx, c.input),
    storageId = upload(s, prepared, c.bytes),
    before = structuredClone(s.tables.hostedProjects.get('project'));
  const native = s.ctx.runMutation;
  s.ctx.runMutation = async (ref, args) => {
    if (getFunctionName(ref) === 'projectProposals:complete') s.tables.projectContributors.clear();
    return native(ref, args);
  };
  await assert.rejects(
    proposals.complete._handler(s.ctx, { id: prepared.proposal._id, storageId }),
    unavailable,
  );
  assert.equal(s.tables.projectProposals.get(prepared.proposal._id).status, 'uploading');
  assert.deepEqual(s.tables.hostedProjects.get('project'), before);
  s.ctx.runMutation = native;
  s.caller('owner');
  await grants.add._handler(s.ctx, { projectId: 'project', contributor: 'contributor' });
  s.caller('contributor');
  await assert.rejects(
    proposals.prepare._handler(s.ctx, { ...c.input, operationId: randomUUID(), baseState: 'f'.repeat(64) }),
    e => e.data.code === 'SOURCE_UNAVAILABLE',
  );
  const changed = await proposals.prepare._handler(s.ctx, {
      ...c.input,
      operationId: randomUUID(),
      head: 'f'.repeat(64),
    }),
    wrong = upload(s, changed, c.bytes, 'wrong-pins');
  await assert.rejects(
    proposals.complete._handler(s.ctx, { id: changed.proposal._id, storageId: wrong }),
    e => e.data.code === 'INVALID_WORK_BACKUP',
  );
  assert.deepEqual(s.tables.hostedProjects.get('project'), before);
});

test('grant add verifies existing Forge identity and current owner after provider round-trip; contributor cannot manage grants', async t => {
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
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (...args) => {
    const result = await originalFetch(...args);
    s.tables.hostedProjects.get('project').owner = 'new-owner';
    return result;
  };
  try {
    await assert.rejects(
      grants.add._handler(s.ctx, { projectId: 'project', contributor: 'third' }),
      unavailable,
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
  assert.equal(
    [...s.tables.projectContributors.values()].some(x => x.contributor === 'third'),
    false,
  );
});
test('archive and proposal transfers recheck grant after byte read, and unrelated upload IDs are rejected before storage reads', async t => {
  const s = await setup(t),
    c = await candidate(t, s),
    prepared = await proposals.prepare._handler(s.ctx, c.input),
    storageId = upload(s, prepared, c.bytes);
  const reads = s.reads();
  s.files.set('unrelated', {
    blob: new Blob([c.bytes]),
    metadata: { size: c.bytes.length, sha256: digest(c.bytes), contentType: 'application/gzip' },
  });
  await assert.rejects(
    proposals.complete._handler(s.ctx, { id: prepared.proposal._id, storageId: 'unrelated' }),
    e => e.data.code === 'INVALID_WORK_BACKUP',
  );
  assert.equal(s.reads(), reads);
  await proposals.complete._handler(s.ctx, { id: prepared.proposal._id, storageId });
  const originalFetch = globalThis.fetch;
  const revokedBody = async (input, init) => {
    const response = await originalFetch(input, init);
    if (!String(input).startsWith('data:')) return response;
    const reader = response.body.getReader();
    return new Response(
      new ReadableStream({
        async pull(controller) {
          const part = await reader.read();
          if (part.done) controller.close();
          else {
            s.tables.projectContributors.clear();
            controller.enqueue(part.value);
          }
        },
        cancel: () => reader.cancel(),
      }),
      { status: response.status, headers: response.headers },
    );
  };
  globalThis.fetch = revokedBody;
  try {
    await assert.rejects(
      proposals.downloadPart._handler(s.ctx, {
        id: prepared.proposal._id,
        offset: 0,
        digest: prepared.proposal.digest,
      }),
      unavailable,
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
  s.caller('owner');
  await grants.add._handler(s.ctx, { projectId: 'project', contributor: 'contributor' });
  s.caller('contributor');
  globalThis.fetch = revokedBody;
  try {
    await assert.rejects(
      backups.downloadPart._handler(s.ctx, { id: 'backup', offset: 0, digest: digest(s.bytes) }),
      unavailable,
    );
  } finally {
    globalThis.fetch = originalFetch;
  }

  s.caller('unrelated');
  await assert.rejects(
    modules.projectProposals.list._handler(s.ctx, {
      projectId: 'project',
      paginationOpts: { cursor: null, numItems: 10 },
    }),
    unavailable,
  );
  s.caller(undefined);
  const shared = await modules.projectContributors.shared._handler(s.ctx, {
    paginationOpts: { cursor: null, numItems: 10 },
  });
  assert.deepEqual(shared.page, []);
});

test('owner proposal cleanup preserves recorded shared files and foreign members cannot delete proposal storage', async t => {
  const s = await setup(t),
    c = await candidate(t, s),
    prepared = await proposals.prepare._handler(s.ctx, c.input),
    storageId = upload(s, prepared, c.bytes);
  const stored = await proposals.complete._handler(s.ctx, { id: prepared.proposal._id, storageId });
  await assert.rejects(modules.projectProposals.remove._handler(s.ctx, { id: stored._id }), unavailable);
  s.tables.projectProposals.set('second-reference', {
    ...stored,
    _id: 'second-reference',
    operationId: randomUUID(),
  });
  s.caller('owner');
  await modules.projectProposals.remove._handler(s.ctx, { id: stored._id });
  assert.deepEqual(s.deleted, []);
  assert.ok(s.files.has(storageId));
  const derivativeIds = [...s.tables.derivedArtifacts.values()]
    .filter(row => row.original === storageId)
    .map(row => row.storageId)
    .filter(Boolean);
  await modules.projectProposals.remove._handler(s.ctx, { id: 'second-reference' });
  assert.deepEqual(s.deleted, [storageId, ...derivativeIds.filter(id => !id.startsWith('r2blob:'))]);
  const { blobStore } = await import(moduleUrl('../convex/blobStore.ts'));
  const artifactStorage = await import(moduleUrl('../convex/artifactStorage.ts'));
  for (const ref of derivativeIds.filter(id => id.startsWith('r2blob:'))) {
    assert.equal(
      await blobStore(s.ctx).getMetadata(ref),
      null,
      'R2 derivative is tombstoned before byte cleanup',
    );
    await artifactStorage.deleteBytes._handler(s.ctx, { ref });
  }
  assert.ok(s.files.has('base'));
});

test('captured hosted journal identifies its exact source pair across a concurrent canonical return', async t => {
  const s = await setup(t);
  const journal = JSON.parse(await actions.exportJournal._handler(s.ctx, { projectId: 'project' }));
  assert.deepEqual(journal.source, { backupId: 'backup', head: s.preview.head, kind: 'native' });
  assert.equal(journal.base.archiveSha256, digest(s.bytes));
  // A subsequent independently accepted return can select a new immutable backup. The saved journal still selects its original bytes.
  s.tables.projectBackups.set('new-backup', {
    ...s.tables.projectBackups.get('backup'),
    _id: 'new-backup',
    digest: 'f'.repeat(64),
    storageId: 'new-source',
  });
  s.files.set('new-source', { blob: new Blob(['different future archive']) });
  s.tables.hostedProjects.get('project').work.backupId = 'new-backup';
  s.tables.hostedProjects.get('project').currentBackup = 'new-backup';
  const part = await backups.downloadPart._handler(s.ctx, {
    id: journal.source.backupId,
    offset: 0,
    digest: journal.base.archiveSha256,
  });
  assert.deepEqual(Buffer.from(part.data), s.bytes);
  assert.equal(s.tables.hostedProjects.get('project').currentBackup, 'new-backup');
});

test('email contributor lookup is exact, owner-bound and preserves the existing grant authority', async t => {
  const s = await setup(t),
    previous = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = previous;
  });
  const calls = [];
  globalThis.fetch = async input => {
    const url = new URL(String(input));
    calls.push(url);
    assert.equal(url.hostname, 'api.clerk.com');
    assert.equal(url.searchParams.get('email_address'), 'person@example.test');
    return Response.json([{ id: 'third', email_addresses: [{ email_address: 'Person@example.test' }] }]);
  };
  s.caller('contributor');
  await assert.rejects(
    grants.addByEmail._handler(s.ctx, { projectId: 'project', email: 'person@example.test' }),
    unavailable,
  );
  assert.equal(calls.length, 0);
  s.caller('owner');
  await grants.addByEmail._handler(s.ctx, { projectId: 'project', email: ' Person@example.test ' });
  assert.ok([...s.tables.projectContributors.values()].some(row => row.contributor === 'third'));
  globalThis.fetch = async () =>
    Response.json([{ id: 'wrong', email_addresses: [{ email_address: 'prefix-person@example.test' }] }]);
  await assert.rejects(
    grants.addByEmail._handler(s.ctx, { projectId: 'project', email: 'person@example.test' }),
    e => e.data.code === 'BAD_ARGUMENT',
  );
  assert.ok(![...s.tables.projectContributors.values()].some(row => row.contributor === 'wrong'));
  globalThis.fetch = async () => {
    s.tables.hostedProjects.get('project').removal = 'trash';
    return Response.json([{ id: 'fourth', email_addresses: [{ email_address: 'person@example.test' }] }]);
  };
  await assert.rejects(
    grants.addByEmail._handler(s.ctx, { projectId: 'project', email: 'person@example.test' }),
    unavailable,
  );
  assert.ok(![...s.tables.projectContributors.values()].some(row => row.contributor === 'fourth'));
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
    'https://fixture.convex.cloud',
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
  });
  for (const name of ['projectHostedSeed', 'projectHostedSeedActions'])
    modules[name] = await import(moduleUrl(`../convex/${name}.ts`));
  for (const table of ['projectHostedSeeds', 'projectHostedSeedPages', 'projectHostedChannels'])
    s.tables[table] ??= new Map();
  client.action = (ref, args) => s.ctx.runAction(ref, args);
  const importedBackup = await uploadArchiveObjects(client, projectId, new File([c.bytes], 'backup.tar.gz'), {
    operationId: randomUUID(),
    preview: c.input.preview,
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
  s.tables.hostedProjects.get('project').r2Writes = true;
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
  assert.ok(s.tables.projectBackups.get('backup').storageId, 'the legacy base archive remains readable');
});

test('opted-in legacy archive metadata sidecars use R2 and preserve exact Work bytes', async t => {
  const { fake } = await r2Setup(t);
  const s = await setup(t, { r2Ready: true });
  s.tables.hostedProjects.get('project').r2Writes = true;
  s.files.set('old-sidecar-original', {
    blob: new Blob([s.bytes], { type: 'application/gzip' }),
    metadata: { size: s.bytes.length, sha256: digest(s.bytes), contentType: 'application/gzip' },
  });
  s.ctx.storage.store = () => assert.fail('opted-in metadata sidecars must not write Convex bytes');
  const { projectArchiveMetadata } = await import(moduleUrl('../convex/projectArchiveMetadata.ts'));
  const load = () =>
    projectArchiveMetadata(
      s.ctx,
      'old-sidecar-original',
      s.bytes.length,
      digest(s.bytes),
      async () => {},
      true,
      true,
    );
  const first = await load(),
    objects = fake.objects.size;
  const second = await load();
  assert.deepEqual(Buffer.from(second.work), Buffer.from(first.work));
  assert.deepEqual(Buffer.from(second.manifest), Buffer.from(first.manifest));
  assert.equal(fake.objects.size, objects);
  assert.ok(
    [...s.tables.derivedArtifacts.values()].some(
      row => row.original === 'old-sidecar-original' && row.storageId?.startsWith('r2blob:'),
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
