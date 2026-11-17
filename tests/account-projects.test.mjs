// SPDX-License-Identifier: Apache-2.0
// Incident 2026-11-17 (Item 3d5d8839): the owner of a project with 276 newer removed (test) projects saw "No projects
// yet": the owner list paged removed rows first and the screen filtered them out. Active projects must never sit
// behind removed ones, and member projects belong in the person's list with their role.
import test from 'node:test';
import assert from 'node:assert/strict';
import { moduleUrl } from './convex-module.mjs';
import { projectRow, state } from './hosted-fixture.mjs';

const projectBackups = await import(moduleUrl('../convex/projectBackups.ts'));
const accountProjects = await import(moduleUrl('../convex/accountProjects.ts'));
const page = { paginationOpts: { cursor: null, numItems: 20 } };

function owner() {
  const s = state([]);
  s.tables.hostedProjects.clear();
  s.tables.hostedProjects.set(
    'active',
    projectRow({ _id: 'active', _creationTime: 10, key: 'active', name: 'Active project' }),
  );
  for (let i = 0; i < 25; i++)
    s.tables.hostedProjects.set(
      `removed-${i}`,
      projectRow({
        _id: `removed-${i}`,
        _creationTime: 100 + i,
        key: `removed-${i}`,
        name: `Removed ${i}`,
        removal: i % 2 ? 'deleted' : 'trash',
      }),
    );
  s.caller('owner');
  return s;
}

test('an owner with 25 newer removed projects sees the older active one on the first page', async () => {
  const s = owner();
  const active = await projectBackups.list._handler(s.ctx, page);
  assert.deepEqual(
    active.page.map(row => row.id),
    ['active'],
  );
  const removed = await projectBackups.list._handler(s.ctx, { ...page, removed: true });
  assert.equal(removed.page.length, 20);
  assert.ok(removed.page.every(row => row.removal));
  const account = await accountProjects.list._handler(s.ctx, { limit: 1 });
  assert.deepEqual(
    account.projects.map(row => [row.id, row.role]),
    [['active', 'owner']],
  );
  assert.equal(account.more, false);
});

test('the account list includes member projects with their role and never a removed or foreign one', async () => {
  const s = owner();
  for (const [id, removal] of [
    ['shared-write', undefined],
    ['shared-read', undefined],
    ['shared-gone', 'trash'],
    ['foreign', undefined],
  ])
    s.tables.hostedProjects.set(
      id,
      projectRow({
        _id: id,
        _creationTime: 50,
        owner: 'other',
        key: id,
        name: id,
        ...(removal ? { removal } : {}),
      }),
    );
  s.tables.projectContributors.set('g1', {
    _id: 'g1',
    _creationTime: 1,
    projectId: 'shared-write',
    contributor: 'owner',
  });
  s.tables.projectContributors.set('g2', {
    _id: 'g2',
    _creationTime: 2,
    projectId: 'shared-gone',
    contributor: 'owner',
  });
  s.tables.projectReaders.set('r1', {
    _id: 'r1',
    _creationTime: 3,
    projectId: 'shared-read',
    reader: 'owner',
  });
  const { projects } = await accountProjects.list._handler(s.ctx, {});
  assert.deepEqual(Object.fromEntries(projects.map(row => [row.id, row.role])), {
    active: 'owner',
    'shared-write': 'write',
    'shared-read': 'read',
  });
  s.caller(undefined);
  assert.deepEqual(await accountProjects.list._handler(s.ctx, {}), { projects: [], more: false });
});
