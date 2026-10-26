import { historicalArchiveActions } from './historical-archive-fixture.mjs';
// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { getFunctionName } from 'convex/server';
import { moduleUrl } from './convex-module.mjs';
import { state } from './hosted-fixture.mjs';
import { policyPreset } from '../dist/autonomy-policy.js';
const modules = {};
for (const name of [
  'projectBackups',
  'projectWork',
  'projectContributors',
  'projectProposals',
  'projectLifecycle',
])
  modules[name] = await import(moduleUrl(`../convex/${name}.ts`));
const backups = historicalArchiveActions(await import(moduleUrl('../convex/projectBackupActions.ts')));
const proposals = historicalArchiveActions(await import(moduleUrl('../convex/projectProposalActions.ts')));
const sha = b => createHash('sha256').update(b).digest('hex'),
  bytes = Buffer.from('synthetic retained native source and Work');
const page = { paginationOpts: { cursor: null, numItems: 20 } },
  unavailable = e => e.data?.code === 'PROJECT_UNAVAILABLE';
function fixture() {
  const s = state([]),
    native = s.ctx.runQuery;
  s.ctx.runQuery = s.ctx.runMutation = (ref, input) => {
    const [m, n] = getFunctionName(ref).split(':');
    return modules[m]?.[n] ? modules[m][n]._handler(s.ctx, input) : native(ref, input);
  };
  s.ctx.storage.generateUploadUrl = async () => 'https://synthetic.invalid/upload';
  s.ctx.db.system.query = () => ({
    order: () => ({
      paginate: async ({ cursor, numItems }) => {
        const rows = [...s.files]
          .filter(([, f]) => f.metadata)
          .map(([id, f]) => ({ _id: id, ...f.metadata }))
          .sort((a, b) => b._id.localeCompare(a._id))
          .filter(r => cursor === null || r._id.localeCompare(cursor) < 0);
        const page = rows.slice(0, numItems);
        return { page, isDone: rows.length <= numItems, continueCursor: page.at(-1)?._id ?? '' };
      },
    }),
  });
  const preview = {
    manifestDigest: 'a'.repeat(64),
    head: 'b'.repeat(64),
    format: 'native',
    revision: 0,
    intents: 0,
    lanes: 0,
    views: 0,
    runs: 0,
    files: 1,
    unavailable: 0,
    channels: [],
  };
  s.tables.hostedProjects.set('project', {
    _id: 'project',
    _creationTime: 1,
    owner: 'owner',
    key: randomUUID(),
    name: 'Synthetic Forge',
    currentBackup: 'backup',
    revision: 1,
    work: { backupId: 'backup', operationId: randomUUID(), initialRevision: 0, revision: 0 },
  });
  s.tables.projectBackups.set('backup', {
    _id: 'backup',
    _creationTime: 1,
    projectId: 'project',
    operationId: randomUUID(),
    request: 'r',
    nonce: 'original-backup',
    previous: null,
    digest: sha(bytes),
    size: bytes.length,
    preview,
    status: 'stored',
    storageId: 'original',
  });
  s.tables.projectContributors.set('grant', {
    _id: 'grant',
    _creationTime: 1,
    projectId: 'project',
    contributor: 'contributor',
  });
  s.put = (id, type, b = bytes) =>
    s.files.set(id, {
      blob: new Blob([b], { type }),
      metadata: { contentType: type, size: b.length, sha256: sha(b) },
    });
  s.put('original', 'application/x-forge-backup-original-backup');
  s.operation = () => ({
    projectId: 'project',
    operationId: randomUUID(),
    expectedRevision: s.tables.hostedProjects.get('project').revision,
  });
  s.drain = async () => {
    for (let count = 0; s.tables.hostedProjects.get('project').removal === 'deleting'; count++) {
      assert.ok(count < 250, 'cleanup converges');
      await modules.projectLifecycle.purge._handler(s.ctx, { projectId: 'project' });
    }
  };
  return s;
}
test('optional project Trash stops contributor access and all source/Work changes, preserves owner download, and Restore retains original pins', async () => {
  const s = fixture(),
    original = structuredClone(s.tables.hostedProjects.get('project')),
    op = s.operation();
  await modules.projectLifecycle.trash._handler(s.ctx, op);
  await modules.projectLifecycle.trash._handler(s.ctx, op);
  assert.equal(s.tables.hostedProjects.get('project').revision, 2);
  s.caller('contributor');
  assert.deepEqual((await modules.projectContributors.shared._handler(s.ctx, page)).page, []);
  for (const run of [
    () => modules.projectWork.state._handler(s.ctx, { projectId: 'project' }),
    () => modules.projectBackups.history._handler(s.ctx, { projectId: 'project', ...page }),
    () => backups.downloadPart._handler(s.ctx, { id: 'backup', offset: 0, digest: sha(bytes) }),
  ])
    await assert.rejects(run(), unavailable);
  s.caller('owner');
  const download = await backups.downloadPart._handler(s.ctx, {
    id: 'backup',
    offset: 0,
    digest: sha(bytes),
  });
  assert.deepEqual(Buffer.from(download.data), bytes);
  await assert.rejects(
    modules.projectWork.append._handler(s.ctx, {
      projectId: 'project',
      owner: 'owner',
      operationId: randomUUID(),
      request: 'r',
      previousRevision: 0,
      command: '{}',
    }),
    unavailable,
  );
  await assert.rejects(
    modules.projectWork.returnSource._handler(s.ctx, {
      projectId: 'project',
      owner: 'owner',
      operationId: randomUUID(),
      request: 'r',
      command: '{}',
      backupId: 'backup',
      expectedBackupId: 'backup',
      expectedRevision: 0,
      localRevision: 0,
    }),
    unavailable,
  );
  await assert.rejects(
    modules.projectBackups.uploadUrl._handler(s.ctx, { id: 'backup', owner: 'owner' }),
    unavailable,
  );
  await modules.projectLifecycle.restore._handler(s.ctx, s.operation());
  assert.equal(s.tables.hostedProjects.get('project').currentBackup, original.currentBackup);
  assert.deepEqual(s.tables.hostedProjects.get('project').work, original.work);
  await assert.rejects(modules.projectLifecycle.trash._handler(s.ctx, op), e => e.data.code === 'WORK_STALE');
  s.caller('contributor');
  assert.equal((await modules.projectWork.state._handler(s.ctx, { projectId: 'project' }))._id, 'project');
  assert.deepEqual(s.scheduled, []);
});
test('permanent project removal batches journals/grants/archives, resumes failure, preserves shared objects and leaves no downloadable project', async () => {
  const s = fixture();
  for (let i = 0; i < 121; i++) {
    s.tables.projectContributors.set(`grant-${i}`, {
      _id: `grant-${i}`,
      projectId: 'project',
      contributor: `member-${i}`,
    });
    s.tables.projectWorkEvents.set(`event-${i}`, { _id: `event-${i}`, projectId: 'project', revision: i });
  }
  for (let i = 0; i < 121; i++) {
    s.tables.projectWorkRecords.set(`indexed-${i}`, { _id: `indexed-${i}`, projectId: 'project' });
    s.tables.projectWorkGenerations.set(`generation-${i}`, { _id: `generation-${i}`, projectId: 'project' });
  }
  for (let i = 0; i < 105; i++) s.put(`unrelated-${i}`, 'application/gzip');
  s.put('duplicate', 'application/x-forge-backup-original-backup');
  const shared = {
    ...s.tables.projectBackups.get('backup'),
    _id: 'foreign-backup',
    projectId: 'foreign-project',
  };
  s.tables.hostedProjects.set('foreign-project', {
    _id: 'foreign-project',
    owner: 'other',
    key: randomUUID(),
    name: 'Other project',
    currentBackup: 'foreign-backup',
    revision: 0,
  });
  s.tables.projectBackups.set(shared._id, shared);
  const proposal = {
    ...s.tables.projectBackups.get('backup'),
    _id: 'proposal',
    actor: 'contributor',
    nonce: 'original-proposal',
    storageId: 'proposal-file',
    intentId: 'intent',
    baseBackupId: 'backup',
    baseArchiveSha256: sha(bytes),
    baseState: 'a'.repeat(64),
    head: 'b'.repeat(64),
    viewId: 'view',
  };
  s.tables.projectProposals.set(proposal._id, proposal);
  s.put('proposal-file', 'application/x-forge-proposal-original-proposal');
  const op = s.operation();
  await modules.projectLifecycle.permanentlyDelete._handler(s.ctx, op);
  assert.equal(s.tables.hostedProjects.get('project').removal, 'deleting');
  await assert.rejects(
    backups.downloadPart._handler(s.ctx, { id: 'backup', offset: 0, digest: sha(bytes) }),
    unavailable,
  );
  const firstTask = s.tables.hostedProjects.get('project').task;
  s.tasks.set(firstTask, { state: { kind: 'failed' } });
  await modules.projectLifecycle.permanentlyDelete._handler(s.ctx, op);
  assert.notEqual(s.tables.hostedProjects.get('project').task, firstTask);
  const remove = s.ctx.storage.delete;
  let fail = true;
  s.ctx.storage.delete = async id => {
    if (id === 'proposal-file' && fail) {
      fail = false;
      throw Error('provider interruption');
    }
    return remove(id);
  };
  await assert.rejects(s.drain(), /provider interruption/);
  await s.drain();
  assert.equal(s.tables.hostedProjects.get('project').removal, 'deleted');
  assert.equal(s.tables.hostedProjects.get('project').name, '');
  assert.equal(s.tables.hostedProjects.get('project').work, undefined);
  assert.equal(s.tables.projectWorkRecords.size, 0);
  assert.equal(s.tables.projectWorkGenerations.size, 0);
  assert.equal(s.tables.projectContributors.size, 0);
  assert.equal(s.tables.projectWorkEvents.size, 0);
  assert.equal(s.tables.projectProposals.size, 0);
  assert.equal(s.tables.projectBackups.size, 1);
  assert.ok(s.files.has('original'), 'another project retains the shared object');
  assert.ok(!s.files.has('duplicate'));
  assert.ok(!s.files.has('proposal-file'));
  assert.equal([...s.files.keys()].filter(x => x.startsWith('unrelated-')).length, 105);
  assert.equal(s.tables.projectUploadCleanup.size, 2);
  await modules.projectLifecycle.permanentlyDelete._handler(s.ctx, op);
  await assert.rejects(modules.projectLifecycle.restore._handler(s.ctx, s.operation()), unavailable);
  await assert.rejects(
    modules.projectWork.initialize._handler(s.ctx, {
      projectId: 'project',
      owner: 'owner',
      backupId: 'backup',
      operationId: randomUUID(),
      revision: 0,
    }),
    unavailable,
  );
  assert.equal(s.reads(), 0, 'cleanup reads metadata rather than source bodies');
});
test('permanent removal prevents original initial prepare resurrection and validates known late completion before exclusive cleanup', async () => {
  const s = fixture(),
    project = s.tables.hostedProjects.get('project'),
    request = {
      key: project.key,
      name: project.name,
      operationId: randomUUID(),
      previous: null,
      digest: sha(bytes),
      size: bytes.length,
      preview: s.tables.projectBackups.get('backup').preview,
    };
  const original = s.tables.projectBackups.get('backup');
  await modules.projectLifecycle.permanentlyDelete._handler(s.ctx, s.operation());
  await s.drain();
  await assert.rejects(backups.prepare._handler(s.ctx, request), unavailable);
  assert.equal(s.tables.hostedProjects.size, 1);
  s.put('late', `application/x-forge-backup-${original.nonce}`);
  await assert.rejects(backups.complete._handler(s.ctx, { id: 'backup', storageId: 'late' }), unavailable);
  assert.ok(!s.files.has('late'));
  s.put('foreign', 'application/gzip');
  await assert.rejects(backups.complete._handler(s.ctx, { id: 'backup', storageId: 'foreign' }), unavailable);
  assert.ok(s.files.has('foreign'));
  s.put('mismatch', `application/x-forge-backup-${original.nonce}`, Buffer.from('different'));
  await assert.rejects(
    backups.complete._handler(s.ctx, { id: 'backup', storageId: 'mismatch' }),
    unavailable,
  );
  assert.ok(s.files.has('mismatch'));
  s.put('actor-denied', `application/x-forge-backup-${original.nonce}`);
  s.caller('unrelated');
  await assert.rejects(
    backups.complete._handler(s.ctx, { id: 'backup', storageId: 'actor-denied' }),
    unavailable,
  );
  assert.ok(s.files.has('actor-denied'));
  s.caller('owner');
  let cursor = null;
  do {
    const r = await modules.projectLifecycle.reconcile._handler(s.ctx, { projectId: 'project', cursor });
    cursor = r.cursor;
    if (r.isDone) break;
  } while (true);
  assert.ok(!s.files.has('actor-denied'));
  assert.ok(s.files.has('foreign'));
  assert.ok(s.files.has('mismatch'));
});
test('same-operation duplicate backup completion and lost-ID reconciliation delete only exact exclusively bound objects', async () => {
  const s = fixture(),
    type = 'application/x-forge-backup-original-backup';
  s.put('first-extra', type);
  await backups.complete._handler(s.ctx, { id: 'backup', storageId: 'first-extra' });
  assert.ok(!s.files.has('first-extra'));
  await backups.complete._handler(s.ctx, { id: 'backup', storageId: 'first-extra' });
  s.put('foreign', 'application/gzip');
  await assert.rejects(
    backups.complete._handler(s.ctx, { id: 'backup', storageId: 'foreign' }),
    e => e.data.code === 'INVALID_WORK_BACKUP',
  );
  assert.ok(s.files.has('foreign'));
  s.put('shared-extra', type);
  s.tables.projectProposals.set('foreign-proposal', {
    _id: 'foreign-proposal',
    projectId: 'foreign-project',
    storageId: 'shared-extra',
  });
  await backups.complete._handler(s.ctx, { id: 'backup', storageId: 'shared-extra' });
  assert.ok(s.files.has('shared-extra'));
  for (let i = 0; i < 130; i++) s.put(`unrelated-${i}`, 'application/gzip');
  s.put('unknown-extra', type);
  const observed = await backups.reconcileUpload._handler(s.ctx, { id: 'backup' });
  assert.equal(observed.id, 'backup');
  assert.ok(!s.files.has('unknown-extra'));
  assert.ok(s.files.has('original'));
  s.caller('contributor');
  s.put('denied-extra', type);
  await assert.rejects(
    backups.complete._handler(s.ctx, { id: 'backup', storageId: 'denied-extra' }),
    unavailable,
  );
  assert.ok(s.files.has('denied-extra'));
});
test('two issued URLs for the same initial backup retain one archive and clean the second successful upload without rewinding history', async () => {
  const s = fixture(),
    request = {
      key: randomUUID(),
      name: 'Second synthetic project',
      operationId: randomUUID(),
      previous: null,
      digest: sha(bytes),
      size: bytes.length,
      preview: s.tables.projectBackups.get('backup').preview,
    };
  const first = await backups.prepare._handler(s.ctx, request),
    second = await backups.prepare._handler(s.ctx, request);
  assert.equal(first.backup.id, second.backup.id);
  assert.equal(first.contentType, second.contentType);
  assert.ok(first.uploadUrl && second.uploadUrl);
  s.put('url-one', first.contentType);
  s.put('url-two', second.contentType);
  await backups.complete._handler(s.ctx, { id: first.backup.id, storageId: 'url-one' });
  const winner = await backups.complete._handler(s.ctx, { id: first.backup.id, storageId: 'url-two' });
  assert.equal(winner.current, true);
  assert.ok(s.files.has('url-one'));
  assert.ok(!s.files.has('url-two'));
  const row = s.tables.projectBackups.get(first.backup.id);
  assert.equal(row.storageId, 'url-one');
  assert.equal(s.tables.hostedProjects.get(winner.projectId).revision, 1);
  assert.ok(s.files.has('original'));
  s.ctx.db.system.query = () => {
    throw Error('Unrelated storage enumeration unavailable');
  };
  assert.equal(
    (await backups.prepare._handler(s.ctx, request)).backup.id,
    first.backup.id,
    'A known stored operation replay does not require enumerating unrelated files.',
  );
});
test('stored proposal duplicate outcomes recheck current grant; removal receipts reconcile original uploader late bytes without source access', async () => {
  const s = fixture(),
    original = {
      ...s.tables.projectBackups.get('backup'),
      _id: 'proposal',
      actor: 'contributor',
      nonce: 'original-proposal',
      storageId: 'proposal-original',
    };
  s.tables.projectProposals.set('proposal', original);
  s.put('proposal-original', 'application/x-forge-proposal-original-proposal');
  s.put('proposal-extra', 'application/x-forge-proposal-original-proposal');
  s.caller('contributor');
  await proposals.complete._handler(s.ctx, { id: 'proposal', storageId: 'proposal-extra' });
  assert.ok(!s.files.has('proposal-extra'));
  s.put('lost-id-extra', 'application/x-forge-proposal-original-proposal');
  await proposals.reconcileUpload._handler(s.ctx, { id: 'proposal' });
  assert.ok(!s.files.has('lost-id-extra'));
  s.tables.projectContributors.clear();
  s.put('revoked-extra', 'application/x-forge-proposal-original-proposal');
  await assert.rejects(
    proposals.complete._handler(s.ctx, { id: 'proposal', storageId: 'revoked-extra' }),
    unavailable,
  );
  assert.ok(s.files.has('revoked-extra'));
  s.caller('owner');
  await modules.projectLifecycle.permanentlyDelete._handler(s.ctx, s.operation());
  await s.drain();
  s.put('late-proposal', 'application/x-forge-proposal-original-proposal');
  s.caller('contributor');
  await assert.rejects(
    proposals.complete._handler(s.ctx, { id: 'proposal', storageId: 'late-proposal' }),
    unavailable,
  );
  assert.ok(!s.files.has('late-proposal'));
  await assert.rejects(
    proposals.downloadPart._handler(s.ctx, { id: 'proposal', offset: 0, digest: sha(bytes) }),
    unavailable,
  );
});
test('lifecycle ownership/CAS/reused request denials do not reveal or mutate another project', async () => {
  const s = fixture(),
    before = structuredClone(s.tables.hostedProjects.get('project')),
    op = s.operation();
  for (const actor of [undefined, 'other', 'contributor']) {
    s.caller(actor);
    await assert.rejects(modules.projectLifecycle.trash._handler(s.ctx, op), unavailable);
    if (actor) await modules.projectLifecycle.permanentlyDelete._handler(s.ctx, op);
  }
  assert.deepEqual(s.tables.hostedProjects.get('project'), before);
  s.caller('owner');
  await modules.projectLifecycle.trash._handler(s.ctx, op);
  await assert.rejects(
    modules.projectLifecycle.restore._handler(s.ctx, op),
    e => e.data.code === 'WORK_OPERATION_CHANGED',
  );
});
test('Trash during a contributor byte transfer rejects the final response without disturbing retained owner source', async t => {
  const s = fixture(),
    fetch = globalThis.fetch;
  s.caller('contributor');
  t.after(() => {
    globalThis.fetch = fetch;
  });
  globalThis.fetch = async (...args) => {
    const response = await fetch(...args);
    s.caller('owner');
    await modules.projectLifecycle.trash._handler(s.ctx, s.operation());
    s.caller('contributor');
    return response;
  };
  await assert.rejects(
    backups.downloadPart._handler(s.ctx, { id: 'backup', offset: 0, digest: sha(bytes) }),
    unavailable,
  );
  assert.ok(s.files.has('original'));
  assert.equal(s.tables.hostedProjects.get('project').currentBackup, 'backup');
  assert.equal(s.tables.projectContributors.size, 1);
});
test('individual proposal removal retains late cleanup facts and retries a failed original scheduled sweep without recreating source', async () => {
  const s = fixture(),
    original = {
      ...s.tables.projectBackups.get('backup'),
      _id: 'proposal',
      actor: 'contributor',
      nonce: 'original-proposal',
      storageId: 'proposal-original',
    };
  s.tables.projectProposals.set('proposal', original);
  s.put('proposal-original', 'application/x-forge-proposal-original-proposal');
  s.put('unknown-extra', 'application/x-forge-proposal-original-proposal');
  await modules.projectProposals.remove._handler(s.ctx, { id: 'proposal' });
  const receipt = [...s.tables.projectUploadCleanup.values()][0],
    first = receipt.task;
  s.tasks.set(first, { state: { kind: 'failed' } });
  await modules.projectProposals.remove._handler(s.ctx, { id: 'proposal' });
  assert.notEqual(receipt.task, first);
  await modules.projectLifecycle.sweepUpload._handler(s.ctx, { id: receipt._id });
  assert.ok(!s.files.has('unknown-extra'));
  assert.equal(receipt.pending, false);
  assert.equal(s.tables.projectProposals.size, 0);
  assert.ok(s.files.has('original'));
  assert.equal(s.tables.hostedProjects.get('project').removal, undefined);
  s.put('late-extra', 'application/x-forge-proposal-original-proposal');
  s.caller('contributor');
  await assert.rejects(
    proposals.complete._handler(s.ctx, { id: 'proposal', storageId: 'late-extra' }),
    unavailable,
  );
  assert.ok(!s.files.has('late-extra'));
});
test('removed upload reconciliation uses one provider pagination per transaction across storage pages, old cursors, failure and original retries', async () => {
  const s = fixture(),
    original = s.tables.projectBackups.get('backup');
  const proposal = {
    ...original,
    _id: 'proposal',
    actor: 'contributor',
    nonce: 'proposal-nonce',
    storageId: 'proposal-file',
  };
  s.tables.projectProposals.set('proposal', proposal);
  s.put('proposal-file', 'application/x-forge-proposal-proposal-nonce');
  await modules.projectLifecycle.permanentlyDelete._handler(s.ctx, s.operation());
  await s.drain();
  const projectBefore = structuredClone(s.tables.hostedProjects.get('project'));
  const receiptsBefore = [...s.tables.projectUploadCleanup.values()].map(
    ({ cursor, pending, ...receipt }) => receipt,
  );
  // Equal creation timestamps must not omit a receipt; original upload IDs provide total order.
  for (const receipt of s.tables.projectUploadCleanup.values()) receipt._creationTime = 1;
  for (const id of ['late-a', 'late-b']) s.put(id, `application/x-forge-backup-${original.nonce}`);
  s.put('late-proposal', 'application/x-forge-proposal-proposal-nonce');
  s.put('unrelated', 'application/gzip');
  s.put('wrong-digest', `application/x-forge-backup-${original.nonce}`, Buffer.from('changed source'));
  s.put('shared', `application/x-forge-backup-${original.nonce}`);
  s.tables.projectBackups.set('other-binding', {
    ...original,
    _id: 'other-binding',
    projectId: 'other-project',
    storageId: 'shared',
  });
  let paginations = 0,
    storagePages = 0;
  const counted = () => {
    assert.ok(++paginations <= 1, 'Convex permits only one paginated query per transaction');
  };
  const query = s.ctx.db.query;
  s.ctx.db.query = table => {
    const q = query(table),
      paginate = q.paginate,
      take = q.take,
      withIndex = q.withIndex;
    let selected;
    q.withIndex = (index, build) => {
      selected = index;
      return withIndex(index, build);
    };
    q.take = async n =>
      selected === 'by_project_and_upload'
        ? (await take(Number.MAX_SAFE_INTEGER))
            .sort((a, b) => a.uploadId.localeCompare(b.uploadId))
            .slice(0, n)
        : take(n);
    q.paginate = async args => {
      counted();
      return paginate(args);
    };
    return q;
  };
  const system = s.ctx.db.system.query;
  s.ctx.db.system.query = table => {
    const ordered = system(table).order('desc');
    return {
      order: () => ({
        paginate: async args => {
          counted();
          storagePages++;
          return ordered.paginate({ ...args, numItems: 2 });
        },
      }),
    };
  };
  const transact = async input => {
    paginations = 0;
    return modules.projectLifecycle.reconcile._handler(s.ctx, input);
  };
  // Legacy receipt pagination uses its sole query only to validate progress, then restarts idempotently.
  const old = await transact({ projectId: 'project', cursor: '0' });
  assert.deepEqual(old, { cursor: null, isDone: false });
  assert.equal(storagePages, 0);
  const remove = s.ctx.storage.delete;
  let interrupted = true;
  s.ctx.storage.delete = async id => {
    if (id === 'late-b' && interrupted) {
      interrupted = false;
      throw Error('provider interruption');
    }
    return remove(id);
  };
  let cursor = old.cursor,
    failed = false,
    iterations = 0;
  while (true) {
    assert.ok(++iterations < 20, 'bounded original receipt traversal converges');
    let page;
    try {
      page = await transact({ projectId: 'project', cursor });
    } catch (error) {
      assert.equal(error.data.code, 'HOSTED_REQUEST_FAILED');
      failed = true;
      continue;
    }
    assert.equal(s.tables.hostedProjects.get('project').revision, projectBefore.revision);
    if (page.isDone) break;
    cursor = page.cursor;
  }
  assert.equal(failed, true);
  assert.ok(storagePages > 2, 'storage metadata crossed multiple pages');
  for (const id of ['late-a', 'late-b', 'late-proposal']) assert.equal(s.files.has(id), false);
  for (const id of ['unrelated', 'wrong-digest', 'shared']) assert.equal(s.files.has(id), true);
  assert.deepEqual(s.tables.hostedProjects.get('project'), projectBefore);
  assert.deepEqual(
    [...s.tables.projectUploadCleanup.values()].map(({ cursor, pending, ...receipt }) => receipt),
    receiptsBefore.map(x => ({ ...x, _creationTime: 1 })),
  );
  // A lost successful reply can repeat its original cursor without rewriting pins or losing late bytes.
  s.put('late-after-reply', `application/x-forge-backup-${original.nonce}`);
  cursor = null;
  for (let n = 0; n < 20; n++) {
    const page = await transact({ projectId: 'project', cursor });
    if (page.isDone) break;
    const retry = await transact({ projectId: 'project', cursor });
    cursor = retry.cursor;
    assert.ok(n < 19);
  }
  assert.equal(s.files.has('late-after-reply'), false);
  assert.deepEqual(s.tables.hostedProjects.get('project'), projectBefore);
  s.caller('other');
  paginations = 0;
  await assert.rejects(transact({ projectId: 'project', cursor: null }), unavailable);
  assert.equal(paginations, 0);
});

test('project rename preserves source and Work and reconciles retries without overwriting concurrent edits', async () => {
  const s = fixture(),
    before = structuredClone(s.tables.hostedProjects.get('project'));
  const input = { ...s.operation(), name: 'Renamed project' };
  s.caller('other');
  await assert.rejects(modules.projectLifecycle.rename._handler(s.ctx, input), unavailable);
  s.caller('owner');
  await modules.projectLifecycle.rename._handler(s.ctx, input);
  const renamed = structuredClone(s.tables.hostedProjects.get('project'));
  assert.equal(renamed.name, input.name);
  assert.deepEqual(renamed.work, before.work);
  assert.equal(renamed.currentBackup, before.currentBackup);
  await modules.projectLifecycle.rename._handler(s.ctx, input);
  assert.deepEqual(s.tables.hostedProjects.get('project'), renamed);
  await assert.rejects(
    modules.projectLifecycle.rename._handler(s.ctx, { ...input, name: 'Changed retry' }),
    e => e.data.code === 'WORK_OPERATION_CHANGED',
  );
  await assert.rejects(
    modules.projectLifecycle.rename._handler(s.ctx, { ...input, operationId: randomUUID() }),
    e => e.data.code === 'WORK_STALE',
  );
  await modules.projectLifecycle.trash._handler(s.ctx, s.operation());
  await assert.rejects(
    modules.projectLifecycle.rename._handler(s.ctx, { ...s.operation(), name: 'Unavailable' }),
    unavailable,
  );
});
test('permanent removal purges project briefing/guidance/policy in resumable batches while preserving personal and foreign data', async () => {
  const s = fixture(),
    project = s.tables.hostedProjects.get('project'),
    policy = policyPreset('trusted');
  project.agentGuidance = 'Private project instructions';
  project.autonomyPolicy = policy;
  project.hostingRequest = JSON.stringify(['Private project name', 'private']);
  const originalKey = project.key;
  const values = {
    projectBriefingSources: { backupId: 'backup', head: 'head', part: 0, value: 'private/file.ts' },
    agentGuidanceOperations: { actor: 'owner', scope: 'project', agentGuidance: 'Private guidance' },
    agentGuidanceMaintainerOperations: { owner: 'owner', actor: 'contributor', maintainer: true },
    projectPolicyChanges: { actor: 'owner', request: 'private policy', at: 'now', previous: policy, policy },
  };
  const foreign = new Map();
  for (const [table, value] of Object.entries(values)) {
    for (let i = 0; i < 121; i++) {
      const id = `${table}-${i}`;
      s.tables[table].set(id, { _id: id, projectId: 'project', operationId: id, ...value });
    }
    const id = `${table}-foreign`,
      row = { _id: id, projectId: 'foreign-project', operationId: id, ...value };
    s.tables[table].set(id, row);
    foreign.set(table, structuredClone(row));
  }
  const personal = {
      _id: 'personal-operation',
      actor: 'owner',
      operationId: 'personal',
      scope: 'personal',
      agentGuidance: 'Personal instructions',
    },
    settings = { _id: 'personal-settings', actor: 'owner', agentGuidance: personal.agentGuidance };
  s.tables.agentGuidanceOperations.set(personal._id, structuredClone(personal));
  s.tables.agentUserSettings.set(settings._id, structuredClone(settings));
  const personalWithProject = {
    ...personal,
    _id: 'personal-with-project',
    operationId: 'personal-with-project',
    projectId: 'project',
  };
  s.tables.agentGuidanceOperations.set(personalWithProject._id, structuredClone(personalWithProject));
  const nativeQuery = s.ctx.db.query;
  s.ctx.db.query = table => {
    const query = nativeQuery(table);
    if (table in values) {
      const take = query.take;
      query.take = n => {
        assert.equal(n, 50, `${table} purge is bounded`);
        return take(n);
      };
    }
    return query;
  };
  const op = s.operation();
  await modules.projectLifecycle.permanentlyDelete._handler(s.ctx, op);
  await modules.projectLifecycle.purge._handler(s.ctx, { projectId: 'project' });
  assert.equal(s.tables.projectBriefingSources.size, 72, 'first batch removes only 50 project rows');
  assert.equal(project.removal, 'deleting');
  const task = project.task;
  s.tasks.set(task, { state: { kind: 'failed' } });
  await modules.projectLifecycle.permanentlyDelete._handler(s.ctx, op);
  assert.notEqual(project.task, task, 'original operation resumes an interrupted purge');
  await s.drain();
  for (const [table, row] of foreign) {
    assert.deepEqual(s.tables[table].get(row._id), row);
    assert.equal(s.tables[table].size, table === 'agentGuidanceOperations' ? 3 : 1);
  }
  assert.deepEqual(s.tables.agentGuidanceOperations.get(personal._id), personal);
  assert.deepEqual(s.tables.agentGuidanceOperations.get(personalWithProject._id), personalWithProject);
  assert.deepEqual(s.tables.agentUserSettings.get(settings._id), settings);
  for (const field of ['agentGuidance', 'autonomyPolicy', 'hostingRequest', 'nameChange', 'work', 'task'])
    assert.equal(Object.hasOwn(project, field), false, `tombstone clears ${field}`);
  assert.equal(project.name, '');
  assert.equal(project.currentBackup, null);
  assert.equal(project.key, originalKey);
  assert.deepEqual(project.lifecycle, {
    operationId: op.operationId,
    action: 'delete',
    expectedRevision: op.expectedRevision,
  });
  assert.equal(s.tables.projectUploadCleanup.size, 1, 'minimal original upload receipt survives');
  const tombstone = structuredClone(project),
    receipts = structuredClone([...s.tables.projectUploadCleanup]);
  await modules.projectLifecycle.purge._handler(s.ctx, { projectId: 'project' });
  await modules.projectLifecycle.permanentlyDelete._handler(s.ctx, op);
  assert.deepEqual(project, tombstone, 'completed purge replay is a no-op');
  assert.deepEqual([...s.tables.projectUploadCleanup], receipts);
});

test('delete retries coalesce the tracked R2 chain and owner-only list exposes resumable blockage', async () => {
  const s = fixture(),
    op = s.operation();
  await s.ctx.db.patch('project', { r2Writes: true });
  await modules.projectLifecycle.permanentlyDelete._handler(s.ctx, op);
  for (let i = 0; !s.tables.hostedProjects.get('project').r2Purge; i++) {
    assert.ok(i < 10);
    await modules.projectLifecycle.purge._handler(s.ctx, { projectId: 'project' });
  }
  const original = structuredClone(s.tables.hostedProjects.get('project')),
    count = s.scheduled.length;
  for (const kind of ['pending', 'inProgress']) {
    s.tasks.set(original.task, { state: { kind } });
    for (let i = 0; i < 7; i++) {
      await modules.projectLifecycle.permanentlyDelete._handler(s.ctx, op);
      await modules.projectLifecycle.permanentlyDelete._handler(s.ctx, s.operation());
      await modules.projectLifecycle.purge._handler(s.ctx, { projectId: 'project' });
    }
    assert.equal(s.scheduled.length, count);
  }
  await s.ctx.db.patch('project', { task: undefined, purgeBlocked: 'R2_MAINTENANCE_DISABLED' });
  assert.equal(
    (await modules.projectBackups.list._handler(s.ctx, page)).page[0].purgeBlocked,
    'R2_MAINTENANCE_DISABLED',
  );
  s.caller('other');
  assert.deepEqual((await modules.projectBackups.list._handler(s.ctx, page)).page, []);
  await modules.projectLifecycle.permanentlyDelete._handler(s.ctx, op);
  assert.equal(s.scheduled.length, count);
  s.caller('owner');
  await modules.projectLifecycle.permanentlyDelete._handler(s.ctx, op);
  const resumed = structuredClone(s.tables.hostedProjects.get('project'));
  assert.equal(s.scheduled.length, count + 1);
  assert.equal(resumed.purgeBlocked, undefined);
  assert.equal(resumed.r2Purge.cursor, original.r2Purge.cursor);
  assert.ok(resumed.r2Purge.generation > original.r2Purge.generation);
  assert.equal(getFunctionName(s.scheduled.at(-1).fn), 'projectR2Maintenance:purgeDeletedProjectPage');
  assert.equal(resumed.removal, 'deleting');
  assert.equal(resumed.r2PrefixPurged, undefined);
  // A failed scheduler receipt resumes with another fence, rather than reusing an old page token.
  s.tasks.set(resumed.task, { state: { kind: 'failed' } });
  await modules.projectLifecycle.permanentlyDelete._handler(s.ctx, op);
  assert.equal(s.scheduled.length, count + 2);
  assert.ok(s.tables.hostedProjects.get('project').r2Purge.generation > resumed.r2Purge.generation);
});
