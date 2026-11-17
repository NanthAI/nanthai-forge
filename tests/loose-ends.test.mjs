// SPDX-License-Identifier: Apache-2.0
// Item fc1831eb: one compact read of loose ends. Dormant Lanes and Lanes quiet for over 90 minutes are listed oldest
// first from presence rows (no per-Lane reads); groups with no data yet say "not reported" with the reason; only the
// owner gets the authority to set Lanes aside; another account cannot read it. The page words each set-aside result,
// and only a failed call is retried.
import test from 'node:test';
import assert from 'node:assert/strict';
import { moduleUrl } from './convex-module.mjs';
import { projectRow, state } from './hosted-fixture.mjs';

const loose = await import(moduleUrl('../convex/projectLooseEnds.ts'));
const { looseEndsView, setAsideWord } = await import(moduleUrl('../web/src/app/needs/loose-ends.ts'));
const day = 24 * 60 * 60 * 1000;

function fixture() {
  const s = state([]);
  s.tables.hostedProjects.set('project', projectRow({ _id: 'project' }));
  const now = Date.now();
  const lanes = [
    ['dormant-old', now - 9 * day, 'Try streaming decoder'],
    ['dormant', now - 3 * day, 'Fix flaky retry timer'],
    ['quiet', now - 3 * 60 * 60 * 1000, 'Docs: migration guide'],
    ['busy', now - 5 * 60 * 1000, 'Working right now'],
  ];
  for (const [laneId, at, goal] of lanes)
    s.tables.projectHostedPresence.set(`presence-${laneId}`, {
      _id: `presence-${laneId}`,
      _creationTime: 1,
      projectId: 'project',
      laneId,
      intentId: `intent-${laneId}`,
      actor: 'owner',
      agent: 'quiet-otter',
      goal,
      paths: ['src/a.ts'],
      pathCount: 1,
      at,
    });
  return s;
}
const read = async (s, subject) => {
  s.ctx.auth.getUserIdentity = async () => ({ subject });
  return JSON.parse(await loose.read._handler(s.ctx, { projectId: 'project' }));
};

test('one read lists dormant and quiet Lanes oldest first and names the groups it cannot report yet', async () => {
  const s = fixture();
  const result = await read(s, 'owner');
  assert.deepEqual(
    result.groups.idle.rows.map(row => row.laneId),
    ['dormant-old', 'dormant'],
  );
  assert.deepEqual(
    result.groups.stopped.rows.map(row => row.laneId),
    ['quiet'],
  );
  for (const key of ['checked', 'projects', 'dated']) {
    assert.equal(result.groups[key].reported, false);
    assert.ok(result.groups[key].why.length > 10, `${key} says why`);
  }
  assert.equal(typeof result.setAside.authorityEpoch, 'number', 'the owner may set Lanes aside');
  const view = looseEndsView(result, result.at);
  assert.equal(view.listed, 3);
  assert.match(view.sentence.rest, /Nothing here is deleted\. 3 of 5 groups are not reported yet/);
  assert.equal(view.groups[0].rows[0].who, 'owner/quiet-otter');
});

test('another account cannot read loose ends', async () => {
  const s = fixture();
  await assert.rejects(read(s, 'stranger'), error => error.data?.code === 'PROJECT_UNAVAILABLE');
});

test('a Lane that changed meanwhile is skipped and named; only a failed call is retried', () => {
  assert.equal(setAsideWord('abandoned').done, true);
  assert.equal(setAsideWord('not-dormant').word, 'Skipped: it was saved meanwhile');
  assert.equal(setAsideWord('has-saved-work').retry, false);
  assert.equal(setAsideWord('failed').retry, true);
});

test('d9e1ac62: a quiet Lane whose Item has a live Lane says what replaced it and how its agent abandons it', async () => {
  const s = fixture();
  const now = Date.now();
  // 'quiet' and 'busy' are two open Lanes of one Item; 'busy' saved five minutes ago.
  s.tables.projectHostedPresence.get('presence-busy').intentId = 'intent-quiet';
  for (const laneId of ['quiet', 'busy', 'dormant'])
    s.tables.projectHostedRecordHeads.set(`head-${laneId}`, {
      _id: `head-${laneId}`,
      _creationTime: laneId === 'busy' ? 3 : 2,
      projectId: 'project',
      kind: 'lane',
      key: laneId,
      parent: `intent-${laneId === 'busy' ? 'quiet' : laneId}`,
      status: 'active',
      recordId: `record-${laneId}`,
      at: now,
    });
  const result = await read(s, 'owner');
  const [quiet] = result.groups.stopped.rows;
  assert.equal(quiet.replacedBy, 'busy');
  assert.equal(quiet.next, 'nforge x ROOT abandon {"laneId":"quiet","reason":"Replaced by Lane busy"}');
  // A Lane alone on its Item is never called replaced.
  assert.equal(result.groups.idle.rows.find(row => row.laneId === 'dormant').replacedBy, undefined);
});
