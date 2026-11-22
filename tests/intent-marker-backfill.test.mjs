// SPDX-License-Identifier: Apache-2.0
// Item fc1831eb: the one-time marker pass for open legacy Intents, so the no-Item note fallback of 7e5f0ad3 can go.
import test from 'node:test';
import assert from 'node:assert/strict';
import { moduleUrl } from './convex-module.mjs';
import { projectRow, state } from './hosted-fixture.mjs';

const backfill = await import(moduleUrl('../convex/projectIntentMarkerBackfill.ts'));

let seq = 0;
const head = (s, projectId, kind, key, extra = {}) =>
  s.tables.projectHostedRecordHeads.set(`h${++seq}`, {
    _id: `h${seq}`,
    _creationTime: seq,
    projectId,
    kind,
    key,
    status: 'active',
    recordId: `r${seq}`,
    version: 1,
    parent: '',
    ...extra,
  });
const planning = (s, key) =>
  [...s.tables.projectHostedRecordHeads.values()].find(r => r.key === key && r.kind === 'intent')
    .planningItemId;
const drain = async s => {
  const runs = [];
  let args = {};
  for (let guard = 0; guard < 60; guard++) {
    runs.push(await s.transaction(() => backfill.mark._handler(s.ctx, args)));
    if (!s.scheduled.length) break;
    args = s.scheduled.shift().args;
  }
  return runs;
};

test('fails without: open unmarked Intents with a same-id Issue get that Issue id once; others stay untouched and counted', async () => {
  const s = state([]);
  s.tables.hostedProjects.set('p1', projectRow({ _id: 'p1' }));
  s.tables.hostedProjects.set('gone', projectRow({ _id: 'gone', removal: 'trash' }));
  head(s, 'p1', 'intent', 'linked');
  head(s, 'p1', 'issue', 'linked');
  head(s, 'p1', 'intent', 'ready-linked', { status: 'ready' });
  head(s, 'p1', 'issue', 'ready-linked');
  head(s, 'p1', 'intent', 'loner');
  head(s, 'p1', 'intent', 'planned', { planningItemId: 'item-9' });
  head(s, 'p1', 'intent', 'independent', { planningItemId: '' });
  head(s, 'gone', 'intent', 'removed-project');
  head(s, 'gone', 'issue', 'removed-project');
  head(s, 'p1', 'intent', 'done', { status: 'completed' });
  head(s, 'p1', 'issue', 'done');
  await drain(s);
  assert.equal(planning(s, 'linked'), 'linked');
  assert.equal(planning(s, 'ready-linked'), 'ready-linked');
  assert.equal(planning(s, 'loner'), undefined, 'no same-id Issue: nothing is guessed');
  assert.equal(planning(s, 'planned'), 'item-9');
  assert.equal(planning(s, 'independent'), '');
  assert.equal(planning(s, 'removed-project'), undefined, 'removed projects are skipped');
  assert.equal(planning(s, 'done'), undefined, 'only open Intents are marked');
  const again = await drain(s);
  assert.equal(
    again.reduce((n, r) => n + r.marked, 0),
    0,
    'a rerun writes nothing',
  );
  assert.equal(
    again.reduce((n, r) => n + r.noIssue, 0),
    1,
    'the unlinked unmarked Intent is counted',
  );
});

test('pages of 100 heads continue from their cursor, and dryRun counts without writing or scheduling', async () => {
  const s = state([]);
  s.tables.hostedProjects.set('p1', projectRow({ _id: 'p1' }));
  for (let i = 0; i < 130; i++) {
    head(s, 'p1', 'intent', `i${i}`);
    head(s, 'p1', 'issue', `i${i}`);
  }
  const dry = await s.transaction(() => backfill.mark._handler(s.ctx, { projectId: 'p1', dryRun: true }));
  assert.deepEqual([dry.scanned, dry.unmarked, dry.marked, dry.noIssue, dry.isDone], [100, 100, 0, 0, false]);
  assert.equal(s.scheduled.length, 0);
  assert.equal(planning(s, 'i0'), undefined);
  const runs = await drain(s);
  assert.equal(runs.filter(r => r.scanned).length, 2, 'two pages of the active status');
  assert.equal(planning(s, 'i129'), 'i129');
});
