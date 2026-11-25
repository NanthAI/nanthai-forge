// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Ferdinando Valsecchi
import test from 'node:test';
import assert from 'node:assert/strict';
import { state } from './hosted-fixture.mjs';
import { moduleUrl } from './convex-module.mjs';
import { backupFields } from './project-backup-fixture.mjs';
const retire = await import(moduleUrl('../convex/legacyFieldRetire.ts'));
const markers = { r2ConvexPurged: true, r2BackfilledAt: 5, r2BackfillOperationId: 'old-op' };
const row = (id, fields) => ({ _id: id, _creationTime: 1, projectId: 'project', ...fields });
const object = (id, fields) => row(id, { digest: id, size: 1, nonce: id, removed: false, ...fields });

test('F6 leftovers: the converter clears backfill markers, moves a committed convex location to r2 and blocks one with no R2 copy', async () => {
  const s = state([]);
  const objects = s.tables.projectObjects;
  objects.set('marked', object('marked', { location: 'r2', r2Key: 'k1', r2Committed: true, ...markers }));
  objects.set('convex', object('convex', { location: 'convex', r2Key: 'k2', r2Committed: true, ...markers }));
  objects.set('stuck', object('stuck', { location: 'convex', ...markers }));
  objects.set('clean', object('clean', { location: 'r2', r2Key: 'k3', r2Committed: true }));
  const before = structuredClone([...objects.values()]);

  const dry = await retire.objectsPage._handler(s.ctx, { cursor: null, apply: false });
  assert.deepEqual([dry.rows, dry.changed, dry.blocked], [4, 2, 1]);
  assert.deepEqual([...objects.values()], before, 'a dry run writes nothing');

  await retire.objectsPage._handler(s.ctx, { cursor: null, apply: true });
  assert.deepEqual(
    objects.get('marked'),
    object('marked', { location: 'r2', r2Key: 'k1', r2Committed: true }),
  );
  assert.equal(objects.get('convex').location, 'r2');
  assert.equal(objects.get('convex').r2BackfilledAt, undefined);
  assert.deepEqual(objects.get('stuck'), before[2], 'a convex location without an R2 copy is left alone');
  assert.deepEqual(objects.get('clean'), before[3]);

  const replay = await retire.objectsPage._handler(s.ctx, { cursor: null, apply: true });
  assert.deepEqual([replay.changed, replay.blocked], [0, 1]);
});

test('F6 leftovers: a backup receipt loses its markers and the project cursor fields go', async () => {
  const s = state([]);
  s.tables.projectBackups.set(
    'backup',
    row('backup', {
      ...backupFields(),
      ...markers,
      location: 'r2',
      r2Key: 'k',
      r2Committed: true,
      archiveReceipt: {
        digest: 'd',
        size: 1,
        location: 'r2',
        r2Key: 'k',
        r2Committed: true,
        operationId: 'op',
        at: 1,
        ...markers,
      },
    }),
  );
  s.tables.hostedProjects.set('project', {
    _id: 'project',
    _creationTime: 1,
    owner: 'owner',
    key: 'key',
    name: 'Project',
    currentBackup: null,
    revision: 0,
    exchangeCleanupDone: true,
    exchangeCleanupCursor: 'c',
    r2BackfillRevision: 2,
  });
  const backups = await retire.smallPage._handler(s.ctx, {
    table: 'projectBackups',
    cursor: null,
    apply: true,
  });
  assert.equal(backups.changed, 1);
  const stored = s.tables.projectBackups.get('backup');
  assert.equal(stored.r2BackfilledAt, undefined);
  assert.equal(stored.archiveReceipt.r2ConvexPurged, undefined);
  assert.equal(stored.archiveReceipt.r2Key, 'k');
  const projects = await retire.projectsPage._handler(s.ctx, { cursor: null, apply: true });
  assert.equal(projects.changed, 1);
  const project = s.tables.hostedProjects.get('project');
  assert.deepEqual(
    [project.exchangeCleanupDone, project.exchangeCleanupCursor, project.r2BackfillRevision],
    [undefined, undefined, undefined],
  );
});
