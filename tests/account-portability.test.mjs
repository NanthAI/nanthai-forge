// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Ferdinando Valsecchi
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { getFunctionName } from 'convex/server';
import { moduleUrl } from './convex-module.mjs';
import { state, job, providers } from './hosted-fixture.mjs';
import { settleR2Purge } from './default-r2.mjs';
const account = await import(moduleUrl('../convex/accountActions.ts'));
const plan = await import(moduleUrl('../convex/accountPlan.ts'));
const data = await import(moduleUrl('../convex/accountData.ts'));
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
/** The review's token over what is shared with the caller, read as the page reads it (accountData.shared). */
async function reviewed(f, leave) {
  const kinds = ['projects', 'projectReaders', 'readers', 'teams', 'zones'].filter(kind =>
    leave.includes(kind),
  );
  if (!kinds.length) return null;
  let token;
  for (const kind of kinds)
    for (let cursor = null; ;) {
      const p = await data.shared._handler(f.ctx, { kind, cursor, token });
      token = p.token;
      if (p.isDone) break;
      cursor = p.continueCursor;
    }
  return token;
}
async function begin(f, selection = [], leave = []) {
  const request = {
    operationId: randomUUID(),
    selection: selection.map(({ kind, id, pin }) => ({ kind, id, pin })),
    leave,
    incoming: await reviewed(f, leave),
  };
  await account.begin._handler(f.ctx, request);
  return request;
}
async function pass(f, r) {
  let cursor = null;
  for (;;) {
    const p = await account.advance._handler(f.ctx, { operationId: r.operationId, cursor });
    if (p.isDone) return p;
    cursor = p.cursor;
  }
}
const advance = pass;
// Distinct creation times, as Convex gives: index-key cursors order ties by id, which the fixture does not model.
let clock = 1;
const row = (id, fields) => ({ _id: id, _creationTime: clock++, ...fields });

test('full paged ownership inventory omits all other owners and credential/source bytes', async () => {
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
  for (const k of ['project', 'import', 'agent', 'team', 'view', 'interest'])
    all.push(...(await inventory(f, k)));
  const text = JSON.stringify(all);
  for (const forbidden of ['foreign-name', 'never-export', 'sealed', 'artifactKey'])
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
    route: { view: 'map', state: 'synthetic', file: '', line: 0 },
  });
  const selected = await inventory(f, 'view'),
    r = await begin(f, selected);
  const same = await account.begin._handler(f.ctx, r);
  assert.equal(same.operationId, r.operationId);
  await assert.rejects(
    () => account.begin._handler(f.ctx, { ...r, leave: ['teams'], incoming: 'a'.repeat(64) }),
    /ACCOUNT_OPERATION_CHANGED/,
  );
  const newId = await saved.put._handler(f.ctx, {
    importId: 'own',
    name: 'later',
    operationId: randomUUID(),
    route: { view: 'map', state: 'synthetic', file: '', line: 0 },
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
        route: { view: 'map', state: 'synthetic', file: '', line: 0 },
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

test('incoming self-leave removes only the person own reader row and keeps the shared source', async () => {
  const f = state([job(), { ...job('foreign'), owner: 'other' }]);
  f.tables.importReaders.set('reader', row('reader', { importId: 'foreign', reader: 'owner' }));
  f.tables.importReaders.set('their', row('their', { importId: 'foreign', reader: 'someone' }));
  const r = await begin(f, [], ['readers']);
  const publicReceipt = await plan.read._handler(f.ctx, { operationId: r.operationId });
  assert.ok(!('pending' in publicReceipt));
  assert.equal((await advance(f, r)).stage, 'completed');
  assert.ok(!f.tables.importReaders.has('reader'));
  assert.ok(f.tables.importReaders.has('their'), 'another person keeps their access');
  assert.ok(f.tables.imports.has('foreign'));
});

test('changed incoming grants are preserved; owned creator memberships never self-left', async () => {
  const f = state();
  f.tables.teams.set(
    'their-team',
    row('their-team', { owner: 'other', name: 'theirs', operationId: randomUUID() }),
  );
  f.tables.teamMembers.set('tm', row('tm', { teamId: 'their-team', member: 'owner' }));
  const own = await teams.create._handler(f.ctx, { name: 'my team', operationId: randomUUID() });
  const r = await begin(f, [], ['teams']);
  // A listed grant replaced after the deletion started (removed, then given again) is kept.
  f.tables.teamMembers.delete('tm');
  f.tables.teamMembers.set('tm-again', row('tm-again', { teamId: 'their-team', member: 'owner' }));
  await advance(f, r);
  assert.ok(f.tables.teamMembers.has('tm-again'));
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

test('selected native project and team retain exact child receipts through lost committed replies', async () => {
  const f = state();
  f.tables.hostedProjects.set(
    'project',
    row('project', { owner: 'owner', name: 'synthetic', key: 'synthetic', currentBackup: null, revision: 1 }),
  );
  const team = await teams.create._handler(f.ctx, { name: 'synthetic', operationId: randomUUID() });
  const selected = [...(await inventory(f, 'project')), ...(await inventory(f, 'team'))],
    r = await begin(f, selected);
  const original = f.ctx.runMutation;
  let discarded = false;
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
  const { purgeSettleMs } = await import(moduleUrl('../convex/projectRetention.ts'));
  const { purge: projectPurge } = await import(moduleUrl('../convex/projectLifecycle.ts'));
  // Time passes beyond the project purge's upload-expiry settle wait.
  f.tables.hostedProjects.get('project').removedAt -= purgeSettleMs;
  for (let n = 0; n < 5; n++) {
    settleR2Purge(f.tables.hostedProjects.get('project'));
    await projectPurge._handler(f.ctx, { projectId: 'project' });
    await teamLife.purge._handler(f.ctx, { id: team });
  }
  assert.equal((await advance(f, r)).stage, 'completed');
  assert.equal(f.tables.hostedProjects.get('project').removal, 'deleted');
  assert.equal(f.tables.teams.get(team).removal, 'deleted');
  assert.ok(children.includes(f.tables.teams.get(team).removalOperation));
  assert.ok(children.includes(f.tables.hostedProjects.get('project').lifecycle.operationId));
  assert.equal((await advance(f, r)).stage, 'completed');
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
  f.tables.sourceZones.set(
    'zone',
    row('zone', {
      owner: 'other',
      importId: 'foreign',
      revision: 2,
      name: 'Shared Zone',
      operationId: randomUUID(),
      request: 'synthetic',
      artifactKey: 'saved',
      sourceId: 'synthetic',
      gitHead: 'synthetic',
      files: [],
      enabled: true,
    }),
  );
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
    row('foreign-project', {
      owner: 'other',
      name: 'shared',
      key: 'shared',
      currentBackup: null,
      revision: 2,
    }),
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
  f.tables.teams.set('team', row('team', { owner: 'owner', name: 'synthetic', operationId: randomUUID() }));
  const { digest } = await import('../dist/hash.js');
  const forged = {
    kind: 'view',
    id: 'team',
    pin: digest(JSON.stringify({ id: 'team', name: 'synthetic' })),
  };
  await assert.rejects(() => begin(f, [forged]), /ACCOUNT_CHANGED/);
  assert.equal(f.tables.teams.get('team').removal, undefined);
});

test('account metadata, planner, executor and team lifecycle bundle without Node imports in Convex mutation/query runtime', async () => {
  const { build } = await import('esbuild');
  for (const file of ['accountResources', 'accountData', 'accountPlan', 'accountExecute', 'teamLifecycle']) {
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
