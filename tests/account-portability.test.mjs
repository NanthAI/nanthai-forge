import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { moduleUrl } from './convex-module.mjs';
import { state, job, providers } from './hosted-fixture.mjs';
const account = await import(moduleUrl('../convex/accountActions.ts'));
const plan = await import(moduleUrl('../convex/accountPlan.ts'));
const teams = await import(moduleUrl('../convex/teams.ts'));
const saved = await import(moduleUrl('../convex/savedViews.ts'));
const teamLife = await import(moduleUrl('../convex/teamLifecycle.ts'));
const lifecycle = await import(moduleUrl('../convex/lifecycle.ts'));
const sharing = await import(moduleUrl('../convex/sharing.ts'));
const page = { cursor: null, numItems: 1 };
test.beforeEach(t => t.after(providers()));
async function inventory(f, kind) {
  const rows = [];
  let cursor = null;
  for (;;) {
    const p = await account.inventory._handler(f.ctx, { kind, paginationOpts: { ...page, cursor } });
    rows.push(...p.page);
    if (p.isDone) return rows;
    cursor = p.continueCursor;
  }
}
async function begin(f, selection = [], leave = []) {
  const request = {
    operationId: randomUUID(),
    selection: selection.map(({ kind, id, pin }) => ({ kind, id, pin })),
    leave,
  };
  await account.begin._handler(f.ctx, request);
  return request;
}
async function advance(f, r) {
  let cursor = null;
  for (;;) {
    const p = await account.advance._handler(f.ctx, { operationId: r.operationId, cursor });
    if (p.isDone) return p;
    cursor = p.cursor;
  }
}
const row = (id, fields) => ({ _id: id, _creationTime: 1, ...fields });

test('full paged ownership inventory omits all other owners, credential/source bytes and hidden grants', async () => {
  const f = state([job(), { ...job('foreign'), owner: 'other' }]);
  for (let n = 0; n < 3; n++)
    f.tables.savedViews.set(
      'v' + n,
      row('v' + n, {
        owner: 'owner',
        name: 'view' + n,
        importId: 'own',
        operationId: randomUUID(),
        route: { file: 'a.ts' },
      }),
    );
  f.tables.savedViews.set(
    'other',
    row('other', { owner: 'other', name: 'foreign-name', importId: 'foreign', route: {} }),
  );
  f.tables.secretObjects.set(
    'secret',
    row('secret', {
      owner: 'owner',
      name: 'own-secret',
      repository: 'x/y',
      ref: 'main',
      version: 1,
      policyRevision: 1,
      disabled: false,
    }),
  );
  f.tables.secretObjects.set(
    'hidden',
    row('hidden', {
      owner: 'other',
      name: 'hidden-secret-name',
      repository: 'hidden/repo',
      ref: 'main',
      version: 1,
      policyRevision: 1,
      disabled: false,
    }),
  );
  f.tables.secretGrants.set(
    'grant',
    row('grant', {
      secretId: 'hidden',
      principal: 'owner',
      discover: false,
      capabilities: ['use'],
      activeUntil: 9999999999999,
    }),
  );
  f.tables.agentGrants.set(
    'agent',
    row('agent', {
      owner: 'owner',
      name: 'agent',
      importId: 'own',
      sourceId: 's',
      gitHead: 'a',
      files: [],
      tools: [],
      expiresAt: 99999,
      revoked: false,
      tokenHash: 'never-export',
    }),
  );
  const views = await inventory(f, 'view');
  assert.equal(views.length, 3);
  const all = [];
  for (const k of ['project', 'import', 'secret', 'agent', 'team', 'view', 'interest'])
    all.push(...(await inventory(f, k)));
  const text = JSON.stringify(all);
  for (const forbidden of [
    'foreign-name',
    'hidden-secret-name',
    'hidden/repo',
    'never-export',
    'sealed',
    'artifactKey',
  ])
    assert.ok(!text.includes(forbidden));
  f.caller(null);
  await assert.rejects(
    () => account.inventory._handler(f.ctx, { kind: 'view', paginationOpts: page }),
    /ACCOUNT_UNAVAILABLE/,
  );
});

test('original selection/retry is stable; personal deletion preserves changed and newly created preferences', async () => {
  const f = state();
  const creation = randomUUID();
  const id = await saved.put._handler(f.ctx, {
    importId: 'own',
    name: 'selected',
    operationId: creation,
    route: { view: 'map' },
  });
  const selected = await inventory(f, 'view'),
    r = await begin(f, selected);
  const same = await account.begin._handler(f.ctx, r);
  assert.equal(same.operationId, r.operationId);
  await assert.rejects(
    () => account.begin._handler(f.ctx, { ...r, leave: ['teams'] }),
    /ACCOUNT_OPERATION_CHANGED/,
  );
  const newId = await saved.put._handler(f.ctx, {
    importId: 'own',
    name: 'later',
    operationId: randomUUID(),
    route: { view: 'map' },
  });
  assert.equal((await advance(f, r)).stage, 'completed');
  assert.ok(!f.tables.savedViews.has(id));
  assert.ok(f.tables.savedViews.has(newId));
  assert.equal((await advance(f, r)).stage, 'completed');
  await assert.rejects(
    () =>
      saved.put._handler(f.ctx, {
        importId: 'own',
        name: 'selected',
        operationId: creation,
        route: { view: 'map' },
      }),
    e => e.code === 'ACCOUNT_UNAVAILABLE',
  );
  const r2 = await begin(f, await inventory(f, 'view'));
  await saved.rename._handler(f.ctx, { id: newId, name: 'changed-after-selection' });
  await advance(f, r2);
  assert.equal(f.tables.savedViews.get(newId).name, 'changed-after-selection');
  const progress = await plan.progress._handler(f.ctx, { operationId: r2.operationId, paginationOpts: page });
  assert.equal(progress.page[0].state, 'changed');
  f.caller('other');
  await assert.rejects(
    () => plan.read._handler(f.ctx, { operationId: r.operationId }),
    /ACCOUNT_UNAVAILABLE/,
  );
});

test('incoming self-leave keeps other grants/shared source and never exposes hidden identifiers/counts', async () => {
  const f = state([job(), { ...job('foreign'), owner: 'other' }]);
  f.tables.secretObjects.set(
    'hidden',
    row('hidden', {
      owner: 'other',
      name: 'invisible',
      repository: 'private/name',
      ref: 'main',
      version: 1,
      policyRevision: 1,
      disabled: false,
    }),
  );
  f.tables.secretGrants.set(
    'mine',
    row('mine', {
      secretId: 'hidden',
      principal: 'owner',
      discover: false,
      capabilities: ['use'],
      activeUntil: 9999999999999,
    }),
  );
  f.tables.secretGrants.set(
    'other-grant',
    row('other-grant', {
      secretId: 'hidden',
      principal: 'someone',
      discover: false,
      capabilities: ['use'],
      activeUntil: 9999999999999,
    }),
  );
  f.tables.importReaders.set('reader', row('reader', { importId: 'foreign', reader: 'owner' }));
  const r = await begin(f, [], ['secrets', 'readers']);
  const publicReceipt = await plan.read._handler(f.ctx, { operationId: r.operationId });
  assert.ok(!JSON.stringify(publicReceipt).includes('hidden'));
  assert.ok(!('pending' in publicReceipt));
  const publicPage = await plan.progress._handler(f.ctx, {
    operationId: r.operationId,
    paginationOpts: page,
  });
  assert.equal(publicPage.page.length, 0);
  assert.equal(publicPage.isDone, true);
  assert.equal((await advance(f, r)).stage, 'completed');
  assert.ok(!f.tables.secretGrants.has('mine'));
  assert.ok(f.tables.secretGrants.has('other-grant'));
  assert.ok(!f.tables.importReaders.has('reader'));
  assert.ok(f.tables.imports.has('foreign'));
  assert.equal(f.tables.secretObjects.get('hidden').policyRevision, 2);
  assert.equal([...f.tables.secretEvents.values()][0].principal, 'owner');
  f.tables.secretGrants.set(
    'later',
    row('later', {
      secretId: 'hidden',
      principal: 'owner',
      discover: false,
      capabilities: ['names'],
      activeUntil: 9999999999999,
    }),
  );
  await advance(f, r);
  assert.ok(f.tables.secretGrants.has('later'));
});

test('changed incoming grants are preserved; owned creator memberships never self-left', async () => {
  const f = state();
  f.tables.secretObjects.set(
    'hidden',
    row('hidden', {
      owner: 'other',
      name: 'invisible',
      repository: 'x/y',
      ref: 'main',
      version: 1,
      policyRevision: 1,
      disabled: false,
    }),
  );
  f.tables.secretGrants.set(
    'mine',
    row('mine', {
      secretId: 'hidden',
      principal: 'owner',
      discover: false,
      capabilities: ['use'],
      activeUntil: 9999999999999,
    }),
  );
  const own = await teams.create._handler(f.ctx, { name: 'my team', operationId: randomUUID() });
  const r = await begin(f, [], ['teams', 'secrets']);
  f.tables.secretGrants.get('mine').capabilities = ['names'];
  await advance(f, r);
  assert.ok(f.tables.secretGrants.has('mine'));
  assert.ok([...f.tables.teamMembers.values()].some(x => x.teamId === own));
});

test('owned team cleanup closes team access, preserves linked imports, and reconciles original operation', async () => {
  const f = state();
  const creation = randomUUID(),
    id = await teams.create._handler(f.ctx, { name: 'owned', operationId: creation });
  for (let n = 0; n < 53; n++)
    f.tables.teamMembers.set('m' + n, row('m' + n, { teamId: id, member: 'reader' + n }));
  await teams.link._handler(f.ctx, { id, importId: 'own', shared: true });
  assert.equal(await sharing.readerAllowed(f.ctx, 'own', 'reader0'), true);
  const r = await begin(f, await inventory(f, 'team'));
  await advance(f, r);
  assert.equal(await sharing.readerAllowed(f.ctx, 'own', 'reader0'), false);
  for (let n = 0; n < 5; n++) await teamLife.purge._handler(f.ctx, { id });
  assert.equal((await advance(f, r)).stage, 'completed');
  assert.ok(f.tables.imports.has('own'));
  assert.equal(f.tables.teamMembers.size, 0);
  assert.equal(f.tables.teamImports.size, 0);
  await assert.rejects(
    () => teams.create._handler(f.ctx, { name: 'owned', operationId: creation }),
    /GITHUB_UNAVAILABLE/,
  );
  assert.ok(await teams.create._handler(f.ctx, { name: 'new team', operationId: randomUUID() }));
});

test('selected import cleanup keeps another owner shared artifact and original operation after lost reply', async () => {
  const f = state([job(), { ...job('foreign'), owner: 'other' }]);
  f.file('saved', new Blob(['synthetic-source']));
  f.tables.importArtifacts.set('a', row('a', { importId: 'foreign', artifactKey: 'saved' }));
  const r = await begin(f, await inventory(f, 'import'));
  await advance(f, r);
  assert.equal(f.tables.imports.get('own').removal, 'deleting');
  for (let n = 0; n < 5; n++) await lifecycle.purge._handler(f.ctx, { id: 'own' });
  assert.equal((await advance(f, r)).stage, 'completed');
  assert.ok(f.tables.imports.has('foreign'));
  assert.ok(f.files.has('saved'));
  assert.equal(f.deleted.length, 0);
  assert.equal((await account.begin._handler(f.ctx, r)).stage, 'completed');
});

test('selected native project and SecretObject retain exact child receipts through lost committed replies', async () => {
  const f = state();
  f.tables.hostedProjects.set(
    'project',
    row('project', { owner: 'owner', name: 'synthetic', key: 'synthetic', revision: 1 }),
  );
  f.tables.secretObjects.set(
    'secret',
    row('secret', {
      owner: 'owner',
      operationId: randomUUID(),
      name: 'synthetic',
      repository: 'example/synthetic',
      ref: 'main',
      version: 1,
      policyRevision: 1,
      disabled: false,
    }),
  );
  f.tables.secretVersions.set('version', row('version', { secretId: 'secret', version: 1 }));
  const selected = [...(await inventory(f, 'project')), ...(await inventory(f, 'secret'))],
    r = await begin(f, selected);
  const original = f.ctx.runMutation;
  let discarded = false;
  const { getFunctionName } = await import('convex/server');
  f.ctx.runMutation = async (fn, args) => {
    const result = await original(fn, args);
    if (!discarded && getFunctionName(fn) === 'accountExecute:step') {
      discarded = true;
      throw Error('lost committed reply');
    }
    return result;
  };
  await assert.rejects(() => advance(f, r));
  f.ctx.runMutation = original;
  await advance(f, r);
  const children = [...f.tables.accountItems.values()].map(x => x.operationId);
  assert.equal(new Set(children).size, 2);
  const { purge: projectPurge } = await import(moduleUrl('../convex/projectLifecycle.ts')),
    { purge: secretPurge } = await import(moduleUrl('../convex/secretLifecycle.ts'));
  for (let n = 0; n < 5; n++) {
    await projectPurge._handler(f.ctx, { projectId: 'project' });
    const deletion = [...f.tables.secretDeletions.values()][0];
    await secretPurge._handler(f.ctx, { deletionId: deletion._id });
  }
  assert.equal((await advance(f, r)).stage, 'completed');
  assert.equal(f.tables.hostedProjects.get('project').removal, 'deleted');
  assert.ok(!f.tables.secretObjects.has('secret'));
  const deletion = [...f.tables.secretDeletions.values()][0];
  assert.ok(children.includes(deletion.operationId));
  assert.ok(children.includes(f.tables.hostedProjects.get('project').lifecycle.operationId));
  assert.equal((await advance(f, r)).stage, 'completed');
  assert.equal(f.tables.secretDeletions.size, 1);
});

test('bounded operation pages finish >40 preferences without touching another owner', async () => {
  const f = state();
  for (let n = 0; n < 83; n++)
    f.tables.savedViews.set(
      'v' + n,
      row('v' + n, {
        owner: 'owner',
        name: 'view' + n,
        importId: 'own',
        operationId: randomUUID(),
        route: {},
      }),
    );
  f.tables.savedViews.set(
    'foreign',
    row('foreign', { owner: 'other', name: 'other', importId: 'own', operationId: randomUUID(), route: {} }),
  );
  const r = await begin(f, await inventory(f, 'view'));
  const p = await account.advance._handler(f.ctx, { operationId: r.operationId, cursor: null });
  assert.equal(p.isDone, false);
  assert.equal(p.stage, 'running');
  assert.equal(f.tables.savedViews.size, 44);
  assert.equal((await advance(f, r)).stage, 'completed');
  assert.equal(f.tables.savedViews.size, 1);
  assert.ok(f.tables.savedViews.has('foreign'));
});

test('self-leave covers Zone, team and native project relationships without erasing other Work or access', async () => {
  const f = state([job(), { ...job('foreign'), owner: 'other' }]);
  f.tables.sourceZones.set('zone', row('zone', { owner: 'other', importId: 'foreign', revision: 2 }));
  f.tables.zoneReaders.set('zr', row('zr', { zoneId: 'zone', reader: 'owner' }));
  f.tables.zoneReaders.set('zr-other', row('zr-other', { zoneId: 'zone', reader: 'someone' }));
  f.tables.teams.set(
    'foreign-team',
    row('foreign-team', { owner: 'other', name: 'shared', operationId: randomUUID() }),
  );
  f.tables.teamMembers.set('tm', row('tm', { teamId: 'foreign-team', member: 'owner' }));
  f.tables.teamMembers.set('tm-other', row('tm-other', { teamId: 'foreign-team', member: 'someone' }));
  f.tables.hostedProjects.set(
    'foreign-project',
    row('foreign-project', { owner: 'other', name: 'shared', key: 'shared', revision: 2 }),
  );
  f.tables.projectContributors.set('pc', row('pc', { projectId: 'foreign-project', contributor: 'owner' }));
  f.tables.projectContributors.set(
    'pc-other',
    row('pc-other', { projectId: 'foreign-project', contributor: 'someone' }),
  );
  f.tables.projectWorkEvents.set(
    'work',
    row('work', { projectId: 'foreign-project', actor: 'owner', command: 'create-intent' }),
  );
  f.tables.projectProposals.set(
    'proposal',
    row('proposal', { projectId: 'foreign-project', actor: 'owner', digest: 'original', status: 'complete' }),
  );
  const preserved = JSON.stringify([
    ...f.tables.projectWorkEvents.values(),
    ...f.tables.projectProposals.values(),
  ]);
  const r = await begin(f, [], ['zones', 'teams', 'projects']);
  await advance(f, r);
  assert.ok(!f.tables.zoneReaders.has('zr'));
  assert.ok(f.tables.zoneReaders.has('zr-other'));
  assert.equal(f.tables.sourceZones.get('zone').revision, 3);
  assert.ok(!f.tables.teamMembers.has('tm'));
  assert.ok(f.tables.teamMembers.has('tm-other'));
  assert.ok(f.tables.teams.has('foreign-team'));
  assert.ok(!f.tables.projectContributors.has('pc'));
  assert.ok(f.tables.projectContributors.has('pc-other'));
  assert.equal(f.tables.hostedProjects.get('foreign-project').revision, 2);
  assert.equal(
    JSON.stringify([...f.tables.projectWorkEvents.values(), ...f.tables.projectProposals.values()]),
    preserved,
  );
});

test('a caller cannot turn a cross-table ID into personal deletion or bypass its lifecycle owner', async () => {
  const f = state();
  f.tables.secretObjects.set(
    'secret',
    row('secret', {
      owner: 'owner',
      name: 'synthetic',
      repository: 'x/y',
      ref: 'main',
      version: 1,
      policyRevision: 1,
      disabled: false,
    }),
  );
  const { digest } = await import('../dist/hash.js');
  const forged = {
    kind: 'view',
    id: 'secret',
    pin: digest(JSON.stringify({ id: 'secret', name: 'synthetic' })),
  };
  await assert.rejects(() => begin(f, [forged]), /ACCOUNT_CHANGED/);
  assert.ok(f.tables.secretObjects.has('secret'));
  assert.equal(f.tables.secretDeletions.size, 0);
});

test('account metadata, planner, executor and team lifecycle bundle without Node imports in Convex mutation/query runtime', async () => {
  const { build } = await import('esbuild');
  for (const file of ['accountResources', 'accountPlan', 'accountExecute', 'teamLifecycle']) {
    const result = await build({
      entryPoints: [new URL(`../convex/${file}.ts`, import.meta.url).pathname],
      bundle: true,
      platform: 'browser',
      format: 'esm',
      write: false,
      logLevel: 'silent',
    });
    assert.equal(result.errors.length, 0);
    assert.ok(result.outputFiles[0].text.length > 0);
  }
});
