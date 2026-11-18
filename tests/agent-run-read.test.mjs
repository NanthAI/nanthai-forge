// SPDX-License-Identifier: Apache-2.0
// One agent run's page (Item 6a251b23): its saves (save records on its Lanes), its comments (the count the day close
// made, the list from the person's Work change rows, only this run's) and who may read them: the project's owner and
// write members; a reader, a stranger and a signed-out caller are refused, as for the rest of the page.
import test from 'node:test';
import assert from 'node:assert/strict';
import { moduleUrl } from './convex-module.mjs';
import { fixture, NOW } from './public-discovery-fixture.mjs';

const agentRun = await import(moduleUrl('../convex/projectAgentRun.ts'));

const HOUR = 3_600_000;
const table = (s, name) => (s.tables[name] ??= new Map());
function world() {
  const s = fixture({ projectVisibility: 'private' });
  table(s, 'projectContributors').set('mate', {
    _id: 'mate',
    projectId: 'project',
    contributor: 'acct-mate',
  });
  table(s, 'projectReaders').set('reader', { _id: 'reader', projectId: 'project', reader: 'acct-reader' });
  const lane = (laneId, agent, created) => ({
    _id: laneId,
    _creationTime: created,
    projectId: 'project',
    laneId,
    intentId: `${laneId}-intent`,
    actor: 'owner',
    agent,
    intent: `Lane ${laneId}`,
    open: false,
    lastActivityAt: created + HOUR,
  });
  table(s, 'projectHostedOverlapLanes').set('lane-a', lane('lane-a', 'amber-fox', NOW - 5 * HOUR));
  table(s, 'projectHostedOverlapLanes').set('lane-b', lane('lane-b', 'copper-moth', NOW - 5 * HOUR));
  const save = (n, laneId) => ({
    _id: `save-${n}`,
    _creationTime: NOW - 4 * HOUR,
    projectId: 'project',
    kind: 'save',
    key: `save-${n}`,
    parent: laneId,
    status: 'saved',
    version: 0,
  });
  for (const [n, laneId] of [
    [1, 'lane-a'],
    [2, 'lane-a'],
    [3, 'lane-a'],
    [4, 'lane-b'],
  ])
    table(s, 'projectHostedRecords').set(`save-${n}`, save(n, laneId));
  const day = new Date(NOW - 5 * HOUR).toISOString().slice(0, 10);
  table(s, 'personDays').set('day', {
    _id: 'day',
    person: 'owner',
    day,
    value: JSON.stringify({
      p: {
        project: {
          l: 0,
          la: 0,
          n: 2,
          na: 2,
          v: 0,
          t: [NOW - 5 * HOUR, NOW - 4 * HOUR],
          r: {},
          m: 3,
          rc: { 'amber-fox': 2, 'copper-moth': 1 },
        },
      },
    }),
  });
  const change = (op, hour) => ({
    _id: `change-${op}`,
    _creationTime: NOW - hour * HOUR,
    projectId: 'project',
    actor: 'owner',
    operationId: `work:${op}`,
    at: NOW - hour * HOUR,
    command: { kind: 'change', source: 'work', action: 'comment-planning-item' },
    kind: 'change',
  });
  const event = (op, agent, text) => ({
    _id: `event-${op}`,
    projectId: 'project',
    operationId: op,
    command: JSON.stringify({ action: 'comment-planning-item', itemId: 'item-1', text, agent }),
  });
  for (const [op, agent, text, hour] of [
    ['o1', 'amber-fox', 'First from amber-fox', 4],
    ['o2', 'amber-fox', 'Second from amber-fox', 3],
    ['o3', 'copper-moth', 'From copper-moth', 3],
  ]) {
    table(s, 'projectCoordinationEvents').set(op, change(op, hour));
    table(s, 'projectWorkEvents').set(op, event(op, agent, text));
  }
  return s;
}
const read = async (s, caller, person = 'ada') => {
  s.caller(caller);
  return JSON.parse(
    await agentRun.read._handler(s.ctx, {
      projectId: 'project',
      person,
      run: 'amber-fox',
      cursor: null,
    }),
  );
};

test('the owner and a write member see the run’s saves and its own comments only', async () => {
  for (const caller of ['owner', 'acct-mate']) {
    const s = world();
    const data = await read(s, caller);
    assert.equal(data.schema, 1, JSON.stringify(data));
    assert.deepEqual(
      data.lanes.map(lane => [lane.laneId, lane.saves]),
      [['lane-a', 3]],
      'only this run’s Lane, with its own save records',
    );
    assert.equal(data.comments.count, 2, 'the close’s count for this run in this project');
    assert.deepEqual(
      data.comments.rows.map(row => row.text),
      ['Second from amber-fox', 'First from amber-fox'],
    );
    assert.doesNotMatch(JSON.stringify(data), /copper-moth/);
  }
});

test('the page finds its person by the account id the people wrapper passes, not only by handle', async () => {
  // On main before this, the wrapper's account id was looked up as a handle and the page was always empty.
  const data = await read(world(), 'owner', 'owner');
  assert.deepEqual(
    data.lanes.map(lane => [lane.laneId, lane.saves]),
    [['lane-a', 3]],
  );
  assert.equal(data.comments.count, 2);
  // An unknown id or handle finds no one: an empty page, nothing of anyone else's.
  const nobody = await read(world(), 'owner', 'acct-nobody');
  assert.deepEqual(nobody.lanes, []);
  assert.doesNotMatch(JSON.stringify(nobody), /amber-fox from|First from|Second from|lane-a/);
});

test('a reader, a stranger and a signed-out caller get nothing of the run', async () => {
  for (const caller of ['acct-reader', 'acct-stranger', null]) {
    const s = world();
    await assert.rejects(read(s, caller), error => {
      const body = JSON.parse(error.message);
      assert.match(body.code, /^(AUTH_REQUIRED|PROJECT_UNAVAILABLE)$/);
      assert.doesNotMatch(error.message, /amber-fox|save-|Second from/);
      return true;
    });
  }
});
