// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Ferdinando Valsecchi
import assert from 'node:assert/strict';
import test from 'node:test';
import { runInNewContext } from 'node:vm';
import { censusLandingNoteCutover } from '../scripts/landing-note-cutover.mjs';
import { state } from './hosted-fixture.mjs';

test('cutover reports missing links past the first project and note pages, including removed projects', async () => {
  const fixture = state([]);
  for (let i = 0; i < 24; i++) {
    fixture.tables.hostedProjects.set(`active-${i}`, { _id: `active-${i}`, _creationTime: i });
  }
  const removals = ['deleted', 'deleting'];
  for (const [i, removal] of removals.entries()) {
    fixture.tables.hostedProjects.set(removal, { _id: removal, _creationTime: 24 + i, removal });
  }
  const notes = fixture.tables.projectIntentLandingNotes;
  for (let i = 0; i < 65; i++) {
    notes.set(`old-${i}`, { _id: `old-${i}`, _creationTime: i, projectId: 'deleted', at: i });
  }
  notes.set('purging-note', {
    _id: 'purging-note',
    projectId: 'deleting',
    at: 0,
    archived: { capsule: 'fixture' },
  });
  notes.set('bound-note', { _id: 'bound-note', projectId: 'deleting', at: 1, itemId: 'item' });

  const census = () =>
    censusLandingNoteCutover(source => runInNewContext(`(async () => {${source}})()`, { ctx: fixture.ctx }));
  assert.deepEqual(await census(), {
    projectsByState: { active: 24, deleted: 1, deleting: 1 },
    projectsWithMissingNotes: [
      { projectId: 'deleted', removal: 'deleted', missing: 65 },
      { projectId: 'deleting', removal: 'deleting', missing: 1 },
    ],
  });

  for (const [id, note] of notes) if (!note.itemId) notes.delete(id);
  assert.deepEqual((await census()).projectsWithMissingNotes, []);
});
