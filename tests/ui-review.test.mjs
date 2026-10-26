// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { moduleUrl } from './convex-module.mjs';
const { reviewGroups, reviewViewLabel } = await import(moduleUrl('../web/src/lane/review-model.ts'));
const save = (head, saveIndex, at, actor = null) => ({ head, saveIndex, at, message: `Save ${head}`, actor });
const file = (path, laneId, saves) => ({ path, contributors: [{ laneId, saves }] });
test('review cohorts combine files from the same save without combining different Lanes or losing older saves', () => {
  const first = save('a', 0, '2026-10-14T10:00:00Z', { name: 'Maya' });
  const second = save('b', 1, '2026-10-14T10:01:00Z');
  const groups = reviewGroups([
    file('b.ts', 'lane-a', [first, second]),
    file('a.ts', 'lane-a', [first]),
    file('c.ts', 'lane-b', [first]),
  ]);
  assert.equal(groups.length, 3);
  assert.deepEqual(
    groups.map(group => [group.laneId, group.saveIndex]),
    [
      ['lane-a', 0],
      ['lane-b', 0],
      ['lane-a', 1],
    ],
  );
  assert.deepEqual(groups[0].paths, ['b.ts', 'a.ts']);
  assert.equal(groups[0].actor, 'Maya');
  assert.equal(groups[2].actor, '—');
});
test('missing provenance stays empty and duplicate paths do not inflate file counts', () => {
  assert.deepEqual(reviewGroups([]), []);
  const entry = file('a.ts', 'lane-a', [save('a', 0, '2026-10-14')]);
  assert.deepEqual(reviewGroups([entry, entry])[0].paths, ['a.ts']);
});

test('review labels number Candidates within their Intent in build order', () => {
  const views = [
    { id: 'later', intentId: 'i', at: '2026-10-02' },
    { id: 'other', intentId: 'j', at: '2026-09-01' },
    { id: 'first', intentId: 'i', at: '2026-10-01' },
  ];
  assert.equal(reviewViewLabel(views, 'later'), 'Candidate 2');
  assert.equal(reviewViewLabel(views, 'first'), 'Candidate 1');
  assert.equal(reviewViewLabel(views, 'missing'), 'Candidate');
});
test('historical Review replaces decision controls with its recorded disposition', async () => {
  const { createElement: h } = await import('react');
  const { renderToStaticMarkup } = await import('react-dom/server');
  const { ReviewDisposition } = await import(moduleUrl('../web/src/lane/ReviewDisposition.tsx'));
  const accepted = renderToStaticMarkup(
    h(ReviewDisposition, { acceptance: { at: '2026-10-15T10:00:00Z', actor: { name: 'Maya' } } }),
  );
  assert.match(accepted, /Landed on main/);
  assert.match(accepted, /by Maya/);
  assert.doesNotMatch(accepted, /<button/);
  const superseded = renderToStaticMarkup(
    h(ReviewDisposition, { replacement: { href: '/review/new', label: 'Candidate 16', check: 'passed' } }),
  );
  assert.match(superseded, /Superseded by Candidate 16/);
  assert.match(superseded, / · passed/);
  assert.match(superseded, /href="\/review\/new"/);
  assert.doesNotMatch(superseded, /<button/);
});

test('main ancestry gate follows current hosted main and never stale green evidence', async () => {
  const { mainAncestryGate } = await import(moduleUrl('../web/src/lane/landing-model.ts'));
  assert.equal(mainAncestryGate({ included: true, indexedMain: 'm1', currentMain: 'm1' }).ok, true);
  assert.equal(mainAncestryGate({ included: true, indexedMain: 'm1', currentMain: 'm2' }).ok, false);
  assert.equal(mainAncestryGate({ included: null }).ok, false);
  assert.equal(mainAncestryGate({ included: true }).ok, false);
  assert.match(mainAncestryGate({ included: false }).title, /Needs an update/);
});
