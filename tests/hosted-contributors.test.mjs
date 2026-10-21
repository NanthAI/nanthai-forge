import { historicalArchiveActions } from './historical-archive-fixture.mjs';
// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
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
  'projectProposalObjects',
  'projectExchangeActions',
  'projectExchange',
  'projectBackupObjects',
])
  modules[name] = await import(moduleUrl(`../convex/${name}.ts`));
const actions = await import(moduleUrl('../convex/projectWorkActions.ts'));
const grants = await import(moduleUrl('../convex/projectContributorActions.ts'));
const proposals = historicalArchiveActions(await import(moduleUrl('../convex/projectProposalActions.ts')));
const returns = await import(moduleUrl('../convex/projectSourceReturn.ts'));
const backups = historicalArchiveActions(await import(moduleUrl('../convex/projectBackupActions.ts')));
const { previewWorkArchive } = await import(moduleUrl('../web/src/work-archive.ts'));
const unavailable = e => e.data?.code === 'PROJECT_UNAVAILABLE';
async function setup(t, { retained = false } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'forge-contributors-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
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
  await assert.rejects(
    actions.acceptChannel._handler(s.ctx, {
      projectId: 'project',
      operationId: randomUUID(),
      revision: 0,
      command: '{}',
    }),
    unavailable,
  );
  await assert.rejects(
    returns.returnSource._handler(s.ctx, {
      projectId: 'project',
      backupId: 'backup',
      expectedBackupId: 'backup',
      revision: 0,
      operationId: randomUUID(),
    }),
    unavailable,
  );
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
  assert.deepEqual(s.deleted, [storageId, ...derivativeIds]);
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
  assert.deepEqual(s.deleted, [storageId, ...derivativeIds]);
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

test('hosted contributor proposal reaches a new native owner Lane after journal reconciliation, preserving dirty source and exact evidence through Git-free format4 recovery', async t => {
  const s = await setup(t, { retained: true });
  const dirtyPath = join(s.w.store.path(s.lane.id), 'a.ts');
  writeFileSync(dirtyPath, 'export const a=1; // unfinished owner edit\n');
  const original = s.w.store.load(),
    originalBytes = readFileSync(dirtyPath),
    originalRun = original.runs[0],
    originalLogs = readFileSync(join(s.w.store.directory, `check-${originalRun.id}/stdout.log`));
  const c = await candidate(t, s),
    contributor = c.w,
    check = (
      await contributor.dispatch(
        {
          action: 'define-check',
          name: 'Contributor exact evidence',
          executable: process.execPath,
          args: ['-e', 'console.log("contributor result")'],
        },
        contributor.store.load().revision,
      )
    ).result;
  const run = (
    await contributor.dispatch(
      {
        action: 'run-check',
        operationId: randomUUID(),
        viewId: c.view.id,
        expectedHead: c.view.head,
        checkId: check.id,
        expectedDefinition: check.definition,
        expectedEnvironment: contributor.status().environment.fingerprint,
      },
      contributor.store.load().revision,
    )
  ).result;
  await finished(contributor, run.id);
  const exported = (
    await contributor.dispatch({ action: 'export-work', archive: true }, contributor.store.load().revision)
  ).result;
  c.bytes = readFileSync(exported.archive.path);
  c.input.digest = digest(c.bytes);
  c.input.size = c.bytes.length;
  c.input.preview = await previewWorkArchive(new File([c.bytes], 'proposal.tar.gz'));
  const prepared = await proposals.prepare._handler(s.ctx, c.input),
    storageId = upload(s, prepared, c.bytes);
  const stored = await proposals.complete._handler(s.ctx, { id: prepared.proposal._id, storageId });
  s.caller('owner');
  const journalBytes = await actions.exportJournal._handler(s.ctx, { projectId: 'project' }),
    journal = JSON.parse(journalBytes),
    journalPath = join(s.dir, 'owner-current-journal.json'),
    commonPath = join(s.dir, 'original-common.tar.gz');
  writeFileSync(journalPath, journalBytes);
  writeFileSync(commonPath, s.bytes);
  assert.equal(
    s.w.store.load().intents.some(x => x.id === stored.intentId),
    false,
    'Original local owner has not yet received the server-created Intent.',
  );
  const reconcile = {
    action: 'reconcile-hosted-work',
    operationId: randomUUID(),
    projectKey: s.tables.hostedProjects.get('project').key,
    archivePath: commonPath,
    archiveSha256: journal.base.archiveSha256,
    journalPath,
    journalSha256: digest(journalBytes),
  };
  await s.w.dispatch(reconcile, s.w.store.load().revision);
  const received = s.w.store.load();
  assert.equal(received.intents.find(x => x.id === stored.intentId).base, stored.baseState);
  assert.deepEqual(readFileSync(dirtyPath), originalBytes);
  assert.deepEqual(received.channelMoves, original.channelMoves);
  assert.deepEqual(received.runs, original.runs);
  const part = await proposals.downloadPart._handler(s.ctx, {
    id: stored._id,
    offset: 0,
    digest: stored.digest,
  });
  const proposalPath = join(s.dir, 'owner-proposal.tar.gz');
  writeFileSync(proposalPath, Buffer.from(part.data));
  assert.equal(digest(readFileSync(proposalPath)), stored.digest);
  const importing = {
    action: 'import-native-contribution',
    operationId: randomUUID(),
    intentId: stored.intentId,
    expectedBase: stored.baseState,
    expectedHead: stored.head,
    archivePath: proposalPath,
    archiveSha256: stored.digest,
    name: 'Received contributor source',
    claim: {
      actor: stored.actor,
      projectKey: s.tables.hostedProjects.get('project').key,
      proposalId: stored._id,
      viewId: stored.viewId,
    },
  };
  const result = (await s.w.dispatch(importing, s.w.store.load().revision)).result,
    after = s.w.store.load();
  assert.equal(after.schema, 4);
  assert.equal(after.lanes.length, received.lanes.length + 1);
  assert.equal(result.head, stored.head);
  assert.equal(result.id === s.lane.id, false);
  assert.equal(readFileSync(join(s.w.store.path(result.id), 'a.ts'), 'utf8'), 'export const a=2;\n');
  assert.deepEqual(readFileSync(dirtyPath), originalBytes);
  assert.deepEqual(after.channelMoves, received.channelMoves);
  assert.deepEqual(after.runs, received.runs);
  assert.deepEqual(after.checks, received.checks);
  assert.equal(
    after.runs.some(x => x.id === run.id),
    false,
  );
  assert.equal(
    after.views.some(x => x.id === stored.viewId),
    false,
  );
  assert.deepEqual(
    readFileSync(join(s.w.store.directory, `check-${originalRun.id}/stdout.log`)),
    originalLogs,
  );
  const receipt = after.nativeContributionReceipts.find(x => x.id === importing.operationId);
  assert.equal(receipt.provenance, 'unverified-native-archive');
  assert.deepEqual(receipt.claim, importing.claim);
  const retried = (
    await s.w.dispatch({ ...importing, archivePath: join(s.dir, 'missing-after-lost-reply.tar.gz') }, 0)
  ).result;
  assert.equal(retried.id, result.id);
  assert.equal(s.w.store.load().lanes.length, after.lanes.length);
  const backup = (await s.w.dispatch({ action: 'export-work', archive: true }, s.w.store.load().revision))
      .result,
    target = join(s.dir, 'independent-format4');
  const bin = join(s.dir, 'git-free-bin'),
    sentinel = join(s.dir, 'git-called');
  mkdirSync(bin);
  writeFileSync(join(bin, 'git'), '#!/bin/sh\nprintf called > "' + sentinel + '"\nexit 97\n', {
    mode: 0o755,
  });
  for (const executable of ['tar', 'gzip']) {
    const fs = await import('node:fs');
    fs.symlinkSync('/usr/bin/' + executable, join(bin, executable));
  }
  const restored = JSON.parse(
    execFileSync(process.execPath, ['dist/cli.js', 'restore-native', backup.archive.path, target], {
      encoding: 'utf8',
      env: { ...process.env, PATH: bin },
    }),
  );
  assert.equal(restored.restored, true);
  assert.equal(existsSync(sentinel), false);
  const recovered = new WorkService(target);
  assert.equal(recovered.store.load().schema, 4);
  assert.deepEqual(recovered.store.load().nativeContributionReceipts, after.nativeContributionReceipts);
  assert.equal(readFileSync(join(recovered.store.path(result.id), 'a.ts'), 'utf8'), 'export const a=2;\n');
  assert.deepEqual(recovered.store.load().channelMoves, after.channelMoves);
  assert.deepEqual(
    readFileSync(join(recovered.store.directory, `check-${originalRun.id}/stdout.log`)),
    originalLogs,
  );
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
  s.ctx.storage.generateUploadUrl = async () => 'https://fixture.invalid/object-upload';
  let posts = 0;
  globalThis.fetch = async (url, init) => {
    if (String(url).startsWith('https://fixture.convex.cloud/api/')) {
      const request = JSON.parse(init.body),
        [name, method] = request.path.split(':');
      const value = await modules[name][method]._handler(s.ctx, jsonToConvex(request.args[0]));
      return Response.json({ status: 'success', value: convexToJson(value) });
    }
    if (url !== 'https://fixture.invalid/object-upload') return nativeFetch(url, init);
    posts++;
    assert.match(init.headers['Content-Type'], /^application\/x-forge-object-/);
    const storageId = await s.ctx.storage.store(
      new Blob([init.body], { type: init.headers['Content-Type'] }),
    );
    return Response.json({ storageId });
  };
  t.after(() => {
    globalThis.fetch = nativeFetch;
  });
  const client = { mutation: (ref, args) => s.ctx.runMutation(ref, args) };
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
    mutation: async () => [], // no R2 objects
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
  const backupPin = await uploadArchiveObjects(client, projectId, new File([c.bytes], 'backup.tar.gz'));
  const backupId = await modules.projectExchangeActions.publish._handler(s.ctx, {
    displayProtocol: 3,
    projectId,
    operationId: randomUUID(),
    previous: null,
    ...backupPin,
  });
  assert.equal(s.tables.projectBackups.get(backupId).transport, 'objects');
  const retained = await modules.projectExchangeActions.publish._handler(s.ctx, {
    displayProtocol: 3,
    projectId,
    operationId: randomUUID(),
    previous: null,
    retainCandidate: true,
    ...backupPin,
  });
  assert.notEqual(retained, backupId);
  assert.equal(
    s.tables.hostedProjects.get(projectId).currentBackup,
    backupId,
    'a concurrently newer selection stays current while the backup candidate is retained',
  );

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
