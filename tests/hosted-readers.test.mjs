// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { getFunctionName } from 'convex/server';
import { backupRow, state, providers } from './hosted-fixture.mjs';
import { moduleUrl } from './convex-module.mjs';
import { HOSTED_WORK_INDEX_FORMAT } from '../dist/work-hosted-summary.js';
const modules = {};
for (const name of [
  'projectReaders',
  'projectReaderActions',
  'projectWork',
  'projectWorkActions',
  'projectWorkIndex',
  'projectAutonomy',
  'projectCoordination',
  'projectCheckRequests',
  'projectContributors',
  'projectProposals',
  'agentGuidance',
])
  modules[name] = await import(moduleUrl(`../convex/${name}.ts`));
const denied = e => e.data?.code === 'PROJECT_UNAVAILABLE';
function setup(t) {
  const s = state([]);
  const native = s.ctx.runQuery;
  s.ctx.runQuery = s.ctx.runMutation = (ref, args) => {
    const [module, name] = getFunctionName(ref).split(':');
    return modules[module]?.[name]?._handler(s.ctx, args) ?? native(ref, args);
  };
  s.tables.hostedProjects.set('project', {
    _id: 'project',
    _creationTime: 1,
    owner: 'owner',
    key: 'synthetic',
    name: 'Private project',
    visibility: 'private',
    currentBackup: 'backup',
    revision: 1,
    work: {
      generationId: 'generation',
      backupId: 'backup',
      operationId: 'work-operation',
      initialRevision: 1,
      revision: 1,
    },
  });
  s.tables.projectBackups.set(
    'backup',
    backupRow({ _id: 'backup', projectId: 'project', digest: 'a'.repeat(64) }),
  );
  s.tables.projectWorkGenerations.set('generation', {
    _id: 'generation',
    projectId: 'project',
    format: HOSTED_WORK_INDEX_FORMAT,
    status: 'ready',
    backupId: 'backup',
    revision: 1,
    initialRevision: 1,
    metadata: JSON.stringify({ sourceHead: 'a'.repeat(64), counts: { intents: 1 } }),
  });
  s.tables.projectWorkRecords.set('intent-row', {
    _id: 'intent-row',
    projectId: 'project',
    generationId: 'generation',
    collection: 'intents',
    key: 'intent',
    position: 0,
    value: JSON.stringify({ id: 'intent', outcome: 'Visible Work' }),
  });
  // A former contributor's own Intent must not become editable through a reader grant.
  s.tables.projectWorkEvents.set('intent-event', {
    _id: 'intent-event',
    projectId: 'project',
    operationId: 'intent',
    actor: 'reader',
    command: JSON.stringify({ action: 'intent', base: 'a'.repeat(64) }),
  });
  t.after(providers());
  const set = input =>
    modules.projectReaderActions.set._handler(s.ctx, {
      projectId: 'project',
      reader: 'reader',
      present: true,
      operationId: randomUUID(),
      ...input,
    });
  return { ...s, set };
}

test('owner grants retry-safe reader access; reader sees real Work with no write capabilities', async t => {
  const s = setup(t),
    operationId = randomUUID();
  await s.set({ operationId, reader: ' reader ' });
  await s.set({ operationId });
  assert.equal(s.tables.projectReaders.size, 1);
  assert.equal(s.tables.projectReaderOperations.size, 1);
  assert.equal(s.tables.projectContributors.size, 0);
  s.caller('reader');
  assert.equal(
    (await modules.projectWork.state._handler(s.ctx, { projectId: 'project' })).name,
    'Private project',
  );
  const workspace = JSON.parse(
    await modules.projectWorkIndex.workspace._handler(s.ctx, { projectId: 'project' }),
  );
  for (const key of ['owner', 'intent', 'note', 'intentStatus', 'hostedChannels', 'planning'])
    assert.equal(workspace.capabilities[key], false, key);
  assert.equal(Object.hasOwn(workspace.capabilities, 'sourceReturn'), false);
  const detail = await modules.projectWorkIndex.detail._handler(s.ctx, {
    projectId: 'project',
    collection: 'intents',
    id: 'intent',
  });
  assert.equal(JSON.parse(detail.value).outcome, 'Visible Work');
  assert.equal(detail.editable, false);
  assert.equal(detail.intentPin, null);
  assert.ok(await modules.projectAutonomy.read._handler(s.ctx, { projectId: 'project' }));
  assert.deepEqual(
    (
      await modules.projectCoordination.sessions._handler(s.ctx, {
        projectId: 'project',
        paginationOpts: { cursor: null, numItems: 10 },
      })
    ).page,
    [],
  );
  const before = structuredClone(s.tables);

  const attempts = [
    () => modules.projectWork.append._handler(s.ctx, { projectId: 'project', owner: 'reader' }),
    () => modules.projectAutonomy.set._handler(s.ctx, { projectId: 'project', command: '{}' }),
    () =>
      modules.projectCoordination.publish._handler(s.ctx, {
        projectId: 'project',
        operationId: randomUUID(),
        command: { kind: 'message', text: 'not permitted' },
      }),
    () =>
      modules.projectCheckRequests.connect._handler(s.ctx, {
        projectId: 'project',
        runnerId: 'bot',
        name: 'bot',
        listening: true,
      }),
    () => modules.projectProposals.register._handler(s.ctx, { projectId: 'project', actor: 'reader' }),
    () =>
      modules.agentGuidance.set._handler(s.ctx, {
        projectId: 'project',
        operationId: randomUUID(),
        scope: 'project',
        agentGuidance: 'not permitted',
      }),
    () => s.set({ reader: 'third' }),
    () =>
      modules.projectReaders.list._handler(s.ctx, {
        projectId: 'project',
        paginationOpts: { cursor: null, numItems: 10 },
      }),
  ];
  for (const attempt of attempts) await assert.rejects(attempt(), denied);
  assert.deepEqual(s.tables, before);
});

test('a journal write moves the Work head row: only the live revision query reads it, not the project state or workspace every tab holds', async t => {
  // Each query that reads the head row re-runs for every open tab on every journal write (review E75).
  const s = setup(t);
  s.tables.projectWorkHeads.set('head', {
    _id: 'head',
    _creationTime: 1,
    projectId: 'project',
    backupId: 'backup',
    revision: 7,
  });
  s.caller('owner');
  const read = new Set(),
    query = s.ctx.db.query;
  s.ctx.db.query = table => (read.add(table), query(table));
  const tablesRead = async run => (read.clear(), await run(), [...read]);
  const projectState = await tablesRead(() =>
    modules.projectWork.state._handler(s.ctx, { projectId: 'project' }),
  );
  assert(!projectState.includes('projectWorkHeads'), `state reads ${projectState}`);
  let workspace;
  const workspaceTables = await tablesRead(async () => {
    workspace = JSON.parse(
      await modules.projectWorkIndex.workspace._handler(s.ctx, { projectId: 'project' }),
    );
  });
  // Flip 5 (Issue 0695ab24): the workspace no longer reads the head, so a write re-runs 2 queries per tab, not 3.
  assert(!workspaceTables.includes('projectWorkHeads'), `workspace reads ${workspaceTables}`);
  assert.equal(Object.hasOwn(workspace, 'revision'), false);
  let revision;
  const revisionTables = await tablesRead(async () => {
    revision = await modules.projectWorkIndex.revision._handler(s.ctx, { projectId: 'project' });
  });
  assert(revisionTables.includes('projectWorkHeads'), 'the live revision comes from the head row');
  assert.equal(revision, 7);
});

test('reader revocation is immediate; replaying an old grant cannot resurrect it', async t => {
  const s = setup(t),
    operationId = randomUUID();
  await s.set({ operationId });
  await assert.rejects(
    s.set({ operationId, present: false }),
    e => e.data?.code === 'WORK_OPERATION_CHANGED',
  );
  await s.set({ present: false });
  await s.set({ operationId });
  assert.equal(s.tables.projectReaders.size, 0);
  for (const actor of ['reader', 'stranger', undefined]) {
    s.caller(actor);
    await assert.rejects(modules.projectWork.state._handler(s.ctx, { projectId: 'project' }), denied);
    await assert.rejects(
      modules.projectWorkIndex.workspace._handler(s.ctx, { projectId: 'project' }),
      denied,
    );
  }
});

test('reader grants verify Clerk identity, recheck owner, and never alter contributors', async t => {
  const s = setup(t);
  await assert.rejects(s.set({ reader: 'missing' }), e => e.data?.code === 'BAD_ARGUMENT');
  s.tables.projectContributors.set('member', { _id: 'member', projectId: 'project', contributor: 'writer' });
  await assert.rejects(s.set({ reader: 'writer' }), e => e.data?.code === 'BAD_ARGUMENT');
  assert.equal(s.tables.projectContributors.get('member').contributor, 'writer');
  s.caller('writer');
  await assert.rejects(s.set({}), denied);
  // Existing contributors still write; a reader grant does not affect that path.
  const authority = await import(moduleUrl('../convex/projectAuthority.ts'));
  assert.equal((await authority.activeProject(s.ctx, 'project', 'writer'))._id, 'project');
  s.caller('owner');
  const native = globalThis.fetch;
  globalThis.fetch = async (...args) => {
    const response = await native(...args);
    s.tables.hostedProjects.get('project').owner = 'changed';
    return response;
  };
  try {
    await assert.rejects(s.set({}), denied);
  } finally {
    globalThis.fetch = native;
  }
  assert.equal(s.tables.projectReaders.size, 0);
});

test('Home discovers current reader grants and excludes other accounts, removals and revoked grants', async t => {
  const s = setup(t);
  await s.set({ reader: 'reader' });
  await s.set({ reader: 'another' });
  s.caller('reader');
  const list = () =>
    modules.projectReaders.shared._handler(s.ctx, { paginationOpts: { cursor: null, numItems: 20 } });
  assert.deepEqual((await list()).page, [{ id: 'project', name: 'Private project' }]);
  s.tables.hostedProjects.get('project').removal = 'trash';
  assert.deepEqual((await list()).page, []);
  delete s.tables.hostedProjects.get('project').removal;
  s.caller('owner');
  await s.set({ reader: 'reader', present: false });
  s.caller('reader');
  assert.deepEqual((await list()).page, []);
  s.caller(null);
  assert.deepEqual((await list()).page, []);
});

test('reader Home pagination keeps the grant cursor across a removed project page', async t => {
  const s = setup(t);
  s.tables.hostedProjects.set('removed', {
    ...s.tables.hostedProjects.get('project'),
    _id: 'removed',
    removal: 'trash',
  });
  s.tables.projectReaders.set('first', {
    _id: 'first',
    _creationTime: 1,
    projectId: 'project',
    reader: 'reader',
  });
  s.tables.projectReaders.set('last', {
    _id: 'last',
    _creationTime: 2,
    projectId: 'removed',
    reader: 'reader',
  });
  s.caller('reader');
  const page = cursor =>
    modules.projectReaders.shared._handler(s.ctx, { paginationOpts: { cursor, numItems: 1 } });
  const first = await page(null);
  assert.deepEqual(first.page, []);
  assert.equal(first.isDone, false);
  const second = await page(first.continueCursor);
  assert.deepEqual(second.page, [{ id: 'project', name: 'Private project' }]);
  assert.equal(second.isDone, true);
});
