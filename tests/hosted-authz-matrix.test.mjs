// SPDX-License-Identifier: Apache-2.0
// Negative authorization matrix for hosted project reads and writes (S4 inventory).
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { getFunctionName } from 'convex/server';
import { state, providers } from './hosted-fixture.mjs';
import { moduleUrl } from './convex-module.mjs';
import { fakeR2Config } from './fake-r2.mjs';
import { HOSTED_WORK_INDEX_FORMAT } from '../dist/work-hosted-summary.js';
const modules = {};
for (const name of [
  'agentGuidance',
  'coordinationCounts',
  'ownerAcceptance',
  'projectAutonomy',
  'projectBackupActions',
  'projectBackups',
  'projectCheckRequests',
  'projectCoordination',
  'projectCoordinationReads',
  'projectExchangeActions',
  'projectObjects',
  'projectObjectDownloads',
  'projectPeopleActions',
  'projectProposalActions',
  'projectProposalObjects',
  'projectProposals',
  'projectSourceReview',
  'projectViewActions',
  'projectViewReads',
  'projectWork',
  'projectWorkActions',
  'projectWorkCommand',
  'projectWorkIndex',
  'projectWorkIndexActions',
])
  modules[name] = await import(moduleUrl(`../convex/${name}.ts`));
const denied = e => e.data?.code === 'PROJECT_UNAVAILABLE';
const paginationOpts = { cursor: null, numItems: 10 },
  digest = 'a'.repeat(64);
function project(s, id, owner, backup) {
  s.tables.hostedProjects.set(id, {
    _id: id,
    _creationTime: 1,
    owner,
    key: `${id}-key`,
    name: id,
    visibility: 'private',
    currentBackup: backup,
    revision: 1,
    work: { generationId: `${id}-generation`, backupId: backup, initialRevision: 1, revision: 1 },
  });
  s.tables.projectBackups.set(backup, {
    _id: backup,
    projectId: id,
    status: 'stored',
    digest,
    size: 1,
    transport: 'objects',
    preview: { format: 'native', head: digest, manifestDigest: digest, revision: 1 },
  });
  s.tables.projectWorkGenerations.set(`${id}-generation`, {
    _id: `${id}-generation`,
    projectId: id,
    format: HOSTED_WORK_INDEX_FORMAT,
    status: 'ready',
    backupId: backup,
    revision: 1,
    initialRevision: 1,
    metadata: JSON.stringify({ sourceHead: digest, counts: { intents: 0 } }),
  });
  s.tables.projectProposals.set(`${id}-proposal`, {
    _id: `${id}-proposal`,
    projectId: id,
    actor: 'former',
    status: 'stored',
    transport: 'objects',
    digest,
    size: 1,
  });
}
function setup() {
  const s = state([]);
  const native = s.ctx.runQuery;
  s.ctx.runQuery =
    s.ctx.runMutation =
    s.ctx.runAction =
      (ref, args) => {
        const [module, name] = getFunctionName(ref).split(':');
        return modules[module]?.[name]?._handler(s.ctx, args) ?? native(ref, args);
      };
  project(s, 'project', 'owner', 'backup');
  project(s, 'other', 'stranger', 'other-backup');
  s.tables.projectReaders.set('grant', { _id: 'grant', projectId: 'project', reader: 'reader' });
  s.tables.projectContributors.set('member', { _id: 'member', projectId: 'project', contributor: 'former' });
  return s;
}
const call = (s, module, name, args) => modules[module][name]._handler(s.ctx, args);
// Every row stops at the access check before any read or write.
const reads = [
  ['projectProposalActions', 'downloadPart', { id: 'project-proposal', offset: 0, digest }, false],
  ['projectProposalObjects', 'checkpoint', { proposalId: 'project-proposal' }, false],
  ['projectWork', 'state', {}],
  ['projectWork', 'sourceTransport', { backupId: 'backup' }],
  ['projectWorkIndex', 'workspace', {}],
  ['projectWorkIndex', 'records', { collection: 'intents', paginationOpts }],
  ['projectWorkIndex', 'detail', { collection: 'intents', id: 'intent' }],
  ['projectViewReads', 'read', { action: 'views', laneId: 'lane', paginationOpts }],
  ['projectBackups', 'history', { paginationOpts }],
  ['projectProposals', 'list', { paginationOpts }],
  ['projectCheckRequests', 'runners', { paginationOpts }],
  ['projectCheckRequests', 'list', { viewId: 'view', paginationOpts }],
  ['projectAutonomy', 'read', {}],
  ['agentGuidance', 'read', {}],
  ['ownerAcceptance', 'status', { viewId: 'view' }],
  ['projectCoordination', 'sessions', { paginationOpts }],
  ['projectCoordination', 'feed', { paginationOpts }],
  ['projectCoordination', 'recent', { paginationOpts }],
  ['projectCoordinationReads', 'inbox', { paginationOpts }],
  ['projectCoordinationReads', 'unacked', { limit: 10 }],
  ['projectCoordinationReads', 'claims', {}],
  ['projectCoordinationReads', 'overlaps', { paths: ['src/a.ts'] }],
  ['projectCoordinationReads', 'related', { paginationOpts }],
  ['coordinationCounts', 'counts', {}],
  ['projectExchangeActions', 'downloadBatch', { digests: [digest] }],
  ['projectExchangeActions', 'downloadPart', { digest, offset: 0 }],
  ['projectExchangeActions', 'checkpoint', { backupId: 'backup' }, false],
  ['projectSourceReview', 'read', { backupId: 'backup', base: digest, head: digest }],
  ['projectObjectDownloads', 'source', { backupId: 'backup', digests: [digest] }],
  ['projectObjectDownloads', 'describe', { digests: [digest] }],
  ['projectObjectDownloads', 'signDownloads', { digests: [digest] }],
  [
    'projectViewActions',
    'log',
    { generationId: 'project-generation', runId: 'run', stream: 'stdout', offset: 0 },
  ],
  ['projectWorkActions', 'exportJournal', {}],
  ['projectWorkIndexActions', 'checksum', {}],
  ['projectPeopleActions', 'labels', { actors: ['owner'] }],
  ['projectBackupActions', 'downloadPart', { id: 'backup', offset: 0, digest }, false],
];
// Writes continue to refuse current readers; proposal reads follow project visibility.
const writes = [
  [
    'projectWorkCommand',
    'command',
    { operationId: randomUUID(), command: JSON.stringify({ action: 'intent', outcome: 'x' }) },
  ],
  ['projectObjects', 'missing', { objects: [{ digest, size: 1 }] }],
  ['projectObjects', 'prepareBatch', { objects: [{ digest, size: 1 }] }],
  [
    'projectCoordination',
    'publish',
    { operationId: randomUUID(), command: { kind: 'message', text: 'not permitted' } },
  ],
  ['projectCheckRequests', 'connect', { runnerId: 'runner', name: 'runner', listening: true }],
  ['projectCheckRequests', 'cancel', { operationId: randomUUID() }],
];
const withProject = (args, scoped = true) => (scoped ? { projectId: 'project', ...args } : args);

// A row only counts if a current grant gets past the access check.
async function allowed(s, caller, rows) {
  s.caller(caller);
  for (const [module, name, args, scoped] of rows) {
    const snapshot = structuredClone(s.tables);
    try {
      await call(s, module, name, withProject(args, scoped));
    } catch (error) {
      assert.ok(!denied(error), `${caller} ${module}.${name}`);
    }
    for (const [table, saved] of Object.entries(snapshot)) s.tables[table] = saved;
  }
}

test('revoked readers, removed contributors, other accounts and signed-out callers get nothing from hosted project paths', async t => {
  const s = setup();
  t.after(providers());
  // Current grants get past the access check before revocation; readers still cannot write.
  await allowed(s, 'reader', reads);
  await allowed(s, 'former', [...reads, ...writes]);
  s.caller('reader');
  for (const [module, name, args, scoped] of writes)
    await assert.rejects(call(s, module, name, withProject(args, scoped)), denied, `${module}.${name}`);
  s.tables.projectReaders.delete('grant');
  s.tables.projectContributors.delete('member');
  const before = structuredClone(s.tables);
  for (const caller of ['reader', 'former', 'stranger', undefined]) {
    s.caller(caller);
    for (const [module, name, args, scoped] of [...reads, ...writes])
      await assert.rejects(
        call(s, module, name, withProject(args, scoped)),
        denied,
        `${String(caller)} ${module}.${name}`,
      );
  }
  assert.deepEqual(s.tables, before);
});

test('the owner of one project cannot read another project through its child ids', async t => {
  const s = setup();
  t.after(providers());
  // [module, function, args for the owner's own child ids, the same call with the other project's ids]
  const rows = [
    [
      'projectWork',
      'sourceTransport',
      { projectId: 'project', backupId: 'backup' },
      { backupId: 'other-backup' },
    ],
    [
      'projectSourceReview',
      'read',
      { projectId: 'project', backupId: 'backup', base: digest, head: digest },
      { backupId: 'other-backup' },
    ],
    [
      'projectObjectDownloads',
      'source',
      { projectId: 'project', backupId: 'backup', digests: [digest] },
      { backupId: 'other-backup' },
    ],
    ...['source', 'describe', 'signDownloads'].map(name => [
      'projectObjectDownloads',
      name,
      { projectId: 'project', ...(name === 'source' ? { backupId: 'backup' } : {}), digests: [digest] },
      { projectId: 'other', ...(name === 'source' ? { backupId: 'other-backup' } : {}) },
    ]),
    ['projectExchangeActions', 'checkpoint', { backupId: 'backup' }, { backupId: 'other-backup' }],
    ['projectBackupActions', 'downloadPart', { id: 'backup', offset: 0, digest }, { id: 'other-backup' }],
    [
      'projectProposalObjects',
      'checkpoint',
      { proposalId: 'project-proposal' },
      { proposalId: 'other-proposal' },
    ],
    [
      'projectProposalActions',
      'downloadPart',
      { id: 'project-proposal', offset: 0, digest },
      { id: 'other-proposal' },
    ],
    [
      'projectExchangeActions',
      'downloadBatch',
      { projectId: 'project', digests: [digest] },
      { projectId: 'other' },
    ],
  ];
  await allowed(
    s,
    'owner',
    rows.map(([module, name, args]) => [module, name, args, false]),
  );
  const before = structuredClone(s.tables);
  for (const [module, name, args, other] of rows)
    await assert.rejects(call(s, module, name, { ...args, ...other }), denied, `${module}.${name}`);
  assert.deepEqual(s.tables, before);
});

test('browser review and object metadata return real plans and URLs only while access is current', async t => {
  const s = setup();
  const env = {
    R2_ACCOUNT_ID: fakeR2Config.accountId,
    R2_BUCKET: fakeR2Config.bucket,
    R2_ACCESS_KEY_ID: fakeR2Config.accessKeyId,
    R2_SECRET_ACCESS_KEY: fakeR2Config.secretAccessKey,
  };
  const saved = Object.fromEntries(Object.keys(env).map(name => [name, process.env[name]]));
  Object.assign(process.env, env);
  t.after(() => {
    for (const [name, value] of Object.entries(saved))
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
  });
  s.tables.projectObjects.set('object', {
    _id: 'object',
    projectId: 'project',
    digest,
    size: 1,
    removed: false,
    location: 'r2',
    r2Key: `v1/p/project/o/${digest}`,
    r2Committed: true,
  });
  const input = { projectId: 'project', backupId: 'backup', base: digest, head: digest };
  for (const caller of ['owner', 'reader', 'former']) {
    s.caller(caller);
    const plan = JSON.parse(await call(s, 'projectSourceReview', 'read', input));
    assert.equal(plan.backupId, 'backup');
    assert.deepEqual(plan.root, { sha256: digest, size: 1 });
    assert.deepEqual(
      JSON.parse(
        await call(s, 'projectObjectDownloads', 'source', {
          projectId: 'project',
          backupId: 'backup',
          digests: [digest],
        }),
      ),
      plan,
    );
    assert.deepEqual(
      await call(s, 'projectObjectDownloads', 'describe', {
        projectId: 'project',
        digests: [digest],
      }),
      [{ digest, size: 1, location: 'r2' }],
    );
    const signed = await call(s, 'projectObjectDownloads', 'signDownloads', {
      projectId: 'project',
      digests: [digest],
    });
    assert.equal(signed.length, 1);
    assert.equal(signed[0].digest, digest);
    assert.equal(new URL(signed[0].url).pathname, `/${fakeR2Config.bucket}/v1/p/project/o/${digest}`);
    for (const name of ['downloadBatch', 'downloadPart']) {
      const result = await call(s, 'projectExchangeActions', name, {
        projectId: 'project',
        ...(name === 'downloadBatch' ? { digests: [digest] } : { digest, offset: 0 }),
      });
      assert.deepEqual(name === 'downloadBatch' ? result : [result], [{ direct: true, digest, size: 1 }]);
    }
  }
  s.tables.projectReaders.delete('grant');
  s.tables.projectContributors.delete('member');
  for (const caller of ['reader', 'former', 'stranger', undefined]) {
    s.caller(caller);
    for (const [module, name, args, scoped] of reads.filter(([module]) =>
      ['projectSourceReview', 'projectObjectDownloads', 'projectExchangeActions'].includes(module),
    ))
      await assert.rejects(
        call(s, module, name, withProject(args, scoped)),
        denied,
        `${caller} ${module}.${name}`,
      );
  }
  // Existing public reads remain available without signing in.
  s.tables.hostedProjects.get('project').visibility = 'public';
  s.caller(undefined);
  assert.equal(JSON.parse(await call(s, 'projectSourceReview', 'read', input)).backupId, 'backup');
  assert.equal(
    (
      await call(s, 'projectObjectDownloads', 'describe', {
        projectId: 'project',
        digests: [digest],
      })
    ).length,
    1,
  );
  assert.equal(
    (
      await call(s, 'projectObjectDownloads', 'signDownloads', {
        projectId: 'project',
        digests: [digest],
      })
    ).length,
    1,
  );
  s.caller('owner');
  s.tables.hostedProjects.get('other').owner = 'owner';
  // Even access to both projects does not permit mixing their checkpoint ids.
  await assert.rejects(
    call(s, 'projectSourceReview', 'read', {
      ...input,
      backupId: 'other-backup',
    }),
    denied,
  );
  // An accessible project cannot use another project's checkpoint or object identity.
  await assert.rejects(
    call(s, 'projectObjectDownloads', 'source', {
      projectId: 'project',
      backupId: 'other-backup',
      digests: [digest],
    }),
    denied,
  );
  s.tables.projectObjects.get('object').projectId = 'other';
  assert.deepEqual(
    await call(s, 'projectObjectDownloads', 'signDownloads', {
      projectId: 'project',
      digests: [digest],
    }),
    [],
  );
  await assert.rejects(
    call(s, 'projectObjectDownloads', 'describe', {
      projectId: 'project',
      digests: [digest],
    }),
    error => error.data?.code === 'INVALID_WORK_BACKUP',
  );
});
