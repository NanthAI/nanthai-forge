// SPDX-License-Identifier: Apache-2.0
// Trash and Settings > Project as words (Items 8fba39a4, 966cb821, SPEC-01-trash): one row form per project phase from
// src/project-phase.ts, "1 day left" never "1 days", soonest to go first, finished tombstones not listed unless this
// visit deleted them, "by WHO" left out because the record does not store it, and the rename guard.
import test from 'node:test';
import assert from 'node:assert/strict';
import { moduleUrl } from './convex-module.mjs';

const t = await import(moduleUrl('../web/src/app/trash/trash-model.ts'));
const p = await import(moduleUrl('../web/src/app/project-settings/project-model.ts'));
const now = Date.parse('2026-11-22T12:00:00Z');
const day = 86_400_000;
const project = (id, fields = {}) => ({
  id,
  key: `${id}-key`,
  handle: 'sample-owner',
  slug: id,
  name: id,
  currentBackup: null,
  revision: 3,
  removal: 'trash',
  removedAt: now - 12 * day,
  retention: { purgeAt: now + 78 * day, retainedBytes: 1.2 * 1024 ** 3, retainedObjects: 40, measured: true },
  ...fields,
});

test('each phase has its own row form: keys, time-left cell and state word follow src/project-phase.ts', () => {
  const kinds = {
    restorable: project('a'),
    revoking: project('b', {
      retention: {
        purgeAt: now + 90 * day,
        revoking: true,
        retainedBytes: 1,
        retainedObjects: 1,
        measured: true,
      },
    }),
    ended: project('c', {
      retention: { purgeAt: now - day, retainedBytes: 1, retainedObjects: 1, measured: true },
    }),
    purging: project('d', { removal: 'deleting', retention: undefined }),
    stopped: project('e', {
      removal: 'deleting',
      purgeBlocked: 'R2_PURGE_RETRY_EXHAUSTED',
      retention: undefined,
    }),
    unconfirmed: project('f', { removal: 'deleted', retention: undefined }),
    deleted: project('g', { removal: 'deleted', retention: undefined, purge: { completedAt: now - day } }),
  };
  const forms = Object.fromEntries(Object.entries(kinds).map(([name, row]) => [name, t.trashForm(row, now)]));
  assert.deepEqual(Object.fromEntries(Object.entries(forms).map(([k, f]) => [k, f.kind])), {
    restorable: 'restorable',
    revoking: 'revoking',
    ended: 'ended',
    purging: 'purging',
    stopped: 'stopped',
    unconfirmed: 'unconfirmed',
    deleted: 'deleted',
  });
  assert.deepEqual(forms.restorable.keys, ['restore', 'forever']);
  assert.deepEqual(forms.restorable.left, { head: '78 days left', sub: 'deleted for good 8 Feb 2027' });
  assert.deepEqual(
    forms.revoking.keys,
    ['restore-wait', 'forever'],
    'restore waits while access is still being removed',
  );
  assert.match(forms.revoking.note, /restore is ready in a moment/);
  assert.deepEqual(forms.ended.keys, []);
  assert.equal(forms.ended.left.head, 'No time left');
  assert.equal(forms.purging.state.word, 'Deleting');
  assert.deepEqual(forms.stopped.keys, ['retry']);
  assert.equal(forms.stopped.state.word, 'Could not delete');
  assert.match(forms.stopped.state.reason, /storage errors/);
  assert.deepEqual(forms.unconfirmed.keys, ['ask']);
  assert.match(forms.unconfirmed.left.sub, /never confirmed/);
  assert.equal(forms.deleted.state.word, 'Deleted');
});

test('one day left is "1 day left", and the last second of a day still counts as a day', () => {
  const row = project('a', {
    retention: { purgeAt: now + 1000, retainedBytes: 0, retainedObjects: 0, measured: true },
  });
  assert.equal(t.trashForm(row, now).left.head, '1 day left');
  assert.equal(t.daysUntil(now - 5, now), 0);
});

test('the list is soonest first, hides finished tombstones except one this visit deleted, and says "not reported" for an unmeasured size', () => {
  const soon = project('soon', {
    retention: { purgeAt: now + 2 * day, retainedBytes: 48 * 1024 ** 2, retainedObjects: 1, measured: true },
  });
  const late = project('late');
  const done = project('done', { removal: 'deleted', retention: undefined, purge: { completedAt: now } });
  const unmeasured = project('un', {
    retention: { purgeAt: now + 90 * day, retainedBytes: 0, retainedObjects: 0, measured: false },
  });
  assert.deepEqual(
    t.soonest([late, soon, unmeasured]).map(r => r.id),
    ['soon', 'late', 'un'],
  );
  assert.deepEqual(
    t.listed([late, done], new Set(), now).map(r => r.id),
    ['late'],
  );
  assert.deepEqual(
    t.listed([late, done], new Set(['done']), now).map(r => r.id),
    ['late', 'done'],
  );
  assert.equal(t.sizeText(unmeasured), 'not reported');
  assert.equal(t.sizeText(soon), '48 MB');
  assert.equal(
    t.movedWords(late),
    'moved here 10 Nov 2026',
    'no "by WHO": the record does not store who moved it',
  );
});

test('the sentence names the count, the size and the project that goes first', () => {
  assert.deepEqual(t.trashSentence([], false, now), { bold: 'Nothing in the trash.', rest: '' });
  const rows = [
    project('soon', {
      retention: { purgeAt: now + 2 * day, retainedBytes: 1024 ** 3, retainedObjects: 1, measured: true },
    }),
    project('late'),
  ];
  const sentence = t.trashSentence(t.soonest(rows), false, now);
  assert.equal(sentence.bold, '2 projects in the trash, 2.2 GB.');
  assert.equal(sentence.rest, 'soon is deleted for good in 2 days.');
  assert.match(t.trashSentence(rows, true, now).bold, /^At least 2 projects in the trash, at least /);
});

test('move to trash says when it can be restored until: 90 days from now', () => {
  assert.equal(t.untilDay(now), '20 February 2027');
});

test('rename: a blank name, a bad address and no change are refused before any call', () => {
  const facts = {
    name: 'Docs',
    slug: 'docs',
    handle: 'sample-owner',
    visibility: 'private',
    createdAt: now,
    revision: 1,
    removal: undefined,
  };
  assert.equal(p.renameProblem('Docs', 'docs', facts), 'Nothing changed.');
  assert.match(p.renameProblem('  ', 'docs', facts), /project name/);
  assert.match(p.renameProblem('Docs', 'Docs Site', facts), /lowercase/);
  assert.match(p.renameProblem('Docs', 'a'.repeat(101), facts), /at most 100/);
  assert.equal(p.renameProblem('Docs 2', 'docs-2', facts), null);
  assert.match(p.sentence(facts, false), /Only the owner can rename/);
});
