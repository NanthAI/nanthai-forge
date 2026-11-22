// SPDX-License-Identifier: Apache-2.0
// Item b6588425 part (4): agent coordination is team-only on every project. A public project opens its source and
// Work reads to any signed-in account, never its coordination: an outsider gets the private project's refusal.
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { backupRow, projectRow, state } from './hosted-fixture.mjs';
import { moduleUrl } from './convex-module.mjs';
import { HOSTED_WORK_INDEX_FORMAT } from '../dist/work-hosted-summary.js';

const modules = {};
for (const name of [
  'coordinationCounts',
  'projectCoordination',
  'projectCoordinationReads',
  'projectWork',
  'projectWorkIndex',
])
  modules[name] = await import(moduleUrl(`../convex/${name}.ts`));
const denied = e => e.data?.code === 'PROJECT_UNAVAILABLE';
const paginationOpts = { cursor: null, numItems: 10 },
  digest = 'a'.repeat(64);
// Every coordination query, named one by one.
const coordination = [
  ['projectCoordination', 'sessions', { paginationOpts }],
  ['projectCoordination', 'feed', { paginationOpts }],
  ['projectCoordination', 'recent', { paginationOpts }],
  ['projectCoordinationReads', 'inbox', { paginationOpts }],
  ['projectCoordinationReads', 'unacked', { limit: 10 }],
  ['projectCoordinationReads', 'claims', {}],
  ['projectCoordinationReads', 'overlaps', { paths: ['src/a.ts'] }],
  ['projectCoordinationReads', 'related', { paginationOpts }],
  ['coordinationCounts', 'counts', {}],
];
const publicReads = [
  ['projectWork', 'state', {}],
  ['projectWorkIndex', 'workspace', {}],
  ['projectWorkIndex', 'records', { collection: 'intents', paginationOpts }],
];

function setup() {
  const s = state([]);
  s.tables.hostedProjects.set(
    'project',
    projectRow({
      _id: 'project',
      owner: 'owner',
      key: 'project-key',
      name: 'project',
      visibility: 'private',
      currentBackup: 'backup',
      revision: 1,
      work: {
        generationId: 'project-generation',
        backupId: 'backup',
        operationId: 'project-work',
        initialRevision: 1,
        revision: 1,
      },
    }),
  );
  s.tables.projectBackups.set(
    'backup',
    backupRow({
      _id: 'backup',
      projectId: 'project',
      digest,
      size: 1,
      transport: 'objects',
      preview: { format: 'native', head: digest, manifestDigest: digest, revision: 1 },
    }),
  );
  s.tables.projectWorkGenerations.set('project-generation', {
    _id: 'project-generation',
    _creationTime: 1,
    projectId: 'project',
    format: HOSTED_WORK_INDEX_FORMAT,
    status: 'ready',
    backupId: 'backup',
    revision: 1,
    initialRevision: 1,
    nextBatch: 0,
    metadata: JSON.stringify({ sourceHead: digest, counts: { intents: 0 } }),
  });
  s.tables.projectReaders.set('grant', { _id: 'grant', projectId: 'project', reader: 'reader' });
  s.tables.projectContributors.set('member', { _id: 'member', projectId: 'project', contributor: 'writer' });
  return s;
}
const call = (s, [module, name, args]) =>
  modules[module][name]._handler(s.ctx, { projectId: 'project', ...args });
async function refusal(s, caller, row) {
  s.caller(caller);
  const error = await call(s, row).then(
    () => assert.fail(`${caller} ${row[0]}.${row[1]} was not refused`),
    error => error,
  );
  assert.ok(denied(error), `${caller} ${row[0]}.${row[1]}: ${error.message}`);
  return error.data.message;
}
async function allowed(s, caller, rows) {
  s.caller(caller);
  for (const row of rows) {
    const snapshot = structuredClone(s.tables);
    try {
      await call(s, row);
    } catch (error) {
      assert.ok(!denied(error), `${caller} ${row[0]}.${row[1]}`);
    }
    for (const [table, saved] of Object.entries(snapshot)) s.tables[table] = saved;
  }
}

test('every coordination query is in the team-only list, so a new one cannot skip the gate unseen', () => {
  const queries = ['projectCoordination', 'projectCoordinationReads', 'coordinationCounts'].flatMap(module =>
    Object.entries(modules[module])
      .filter(([, fn]) => fn?.isQuery && fn.isPublic)
      .map(([name]) => `${module}.${name}`),
  );
  // `projectCoordination.counts` re-exports `coordinationCounts.counts`.
  const listed = new Set([...coordination.map(([m, n]) => `${m}.${n}`), 'projectCoordination.counts']);
  assert.deepEqual(
    queries.filter(name => !listed.has(name)),
    [],
  );
  assert.equal(modules.projectCoordination.publicCounts, undefined, 'no signed-out coordination aggregate');
});

test('a public project refuses a signed-in outsider on every coordination read, exactly as a private one', async () => {
  const s = setup();
  // The private project's answer to an account without a role is the reference refusal.
  const reference = [];
  for (const row of coordination) reference.push(await refusal(s, 'stranger', row));
  s.tables.hostedProjects.get('project').visibility = 'public';
  for (const [index, row] of coordination.entries())
    assert.equal(await refusal(s, 'stranger', row), reference[index], `${row[0]}.${row[1]}`);
  await refusal(s, 'stranger', [
    'projectCoordination',
    'publish',
    { operationId: randomUUID(), command: { kind: 'message', text: 'not permitted' } },
  ]);
  // A reader grant adds nothing to public visibility: it is not team on coordination.
  for (const row of coordination) await refusal(s, 'reader', row);
  // A removed contributor is an outsider again on the next read.
  await allowed(s, 'writer', coordination);
  s.tables.projectContributors.delete('member');
  for (const row of coordination) await refusal(s, 'writer', row);
});

test('the team keeps every coordination read, and public source and Work reads are unchanged', async () => {
  const s = setup();
  s.tables.hostedProjects.get('project').visibility = 'public';
  await allowed(s, 'owner', coordination);
  await allowed(s, 'writer', coordination);
  await allowed(s, 'stranger', publicReads);
  await allowed(s, 'reader', publicReads);
  // A private project's reader keeps coordination reads; an outsider there still gets nothing.
  s.tables.hostedProjects.get('project').visibility = 'private';
  await allowed(s, 'reader', coordination);
  for (const row of publicReads) await refusal(s, 'stranger', row);
});
