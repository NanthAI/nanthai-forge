// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Ferdinando Valsecchi
// Account > Projects as words (Item 3d5d8839): projects with a held Lane come first (the page's one first stop), the
// rest by newest activity; the sentence's totals match the rows; every count has its own noun; a plan Forge has not
// counted is "not reported", never zero.
import test from 'node:test';
import assert from 'node:assert/strict';
import { moduleUrl } from './convex-module.mjs';

const { grouped, sentence, heldWords, laneWords, itemWords, metaWords, updatedWords } = await import(
  moduleUrl('../web/src/app/projects/model.ts')
);
const c = (n, atLeast = false) => ({ n, atLeast });
const row = (id, fields = {}) => ({
  id,
  name: id,
  handle: 'sample-owner',
  slug: id,
  role: 'owner',
  visibility: 'private',
  activityAt: 0,
  held: c(0),
  lanes: c(0),
  main: null,
  items: null,
  ...fields,
});

test('held projects come first, each group keeps the server activity order, and the sentence counts what is listed', () => {
  // Server order (newest activity first, convex/accountProjects.ts); the page never re-sorts a page it was handed.
  const rows = [
    row('new', { activityAt: 9 }),
    row('held-new', { activityAt: 8, held: c(2) }),
    row('held-old', { activityAt: 2, held: c(1) }),
    row('old', { activityAt: 1 }),
  ];
  const { needs, rest } = grouped(rows);
  assert.deepEqual(
    needs.map(r => r.id),
    ['held-new', 'held-old'],
  );
  assert.deepEqual(
    rest.map(r => r.id),
    ['new', 'old'],
  );
  assert.equal(
    sentence({ projects: rows, more: false }),
    '3 held Lanes need you, in 2 projects. 4 projects.',
  );
  assert.equal(sentence({ projects: [rows[0]], more: true }), 'Nothing needs you. At least 1 project.');
  assert.equal(
    sentence({ projects: [rows[2]], more: false }),
    '1 held Lane needs you, in held-old. 1 project.',
  );
  assert.equal(sentence({ projects: [], more: false }), 'No projects yet.');
});

test('each fact names its unit, says "at least" past the read bound, and an uncounted plan is not reported', () => {
  assert.equal(heldWords(row('a', { held: c(1) })), '1 Lane held');
  assert.equal(heldWords(row('a', { held: c(20, true) })), 'at least 20 Lanes held');
  assert.equal(laneWords(row('a')), 'No open Lanes');
  assert.equal(laneWords(row('a', { lanes: c(60, true) })), 'at least 60 Lanes open');
  assert.equal(itemWords(row('a')), 'Items not reported');
  assert.equal(itemWords(row('a', { items: { done: c(0), inProgress: c(0), left: c(0) } })), 'No Items yet');
  assert.equal(
    itemWords(row('a', { items: { done: c(31), inProgress: c(4), left: c(267) } })),
    'Items: 31 done, 4 in progress, 267 left',
  );
  const h = 3_600_000;
  const now = 100 * h + 5;
  assert.equal(
    metaWords(
      row('a', {
        role: 'read',
        visibility: 'public',
        activityAt: 98 * h,
        main: { at: 98 * h, passing: true },
      }),
      now,
    ),
    'Can read · Public · main passing · updated 2 h ago',
  );
  assert.equal(
    metaWords(row('a', { activityAt: 100 * h }), now),
    'Owner · Private · nothing landed yet · updated this hour',
  );
});

test('ages are whole hours, then whole days, like the server order', () => {
  const h = 3_600_000;
  assert.equal(updatedWords(10 * h, 10 * h + 59 * 60_000), 'updated this hour');
  assert.equal(updatedWords(0, 23 * h), 'updated 23 h ago');
  assert.equal(updatedWords(0, 24 * h), 'updated 1 day ago');
  assert.equal(updatedWords(0, 80 * h), 'updated 3 days ago');
  assert.equal(updatedWords(5 * h, 0), 'updated this hour');
});
