// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { landingFixture } from './hosted-landing-fixture.mjs';
import { moduleUrl } from './convex-module.mjs';
import { feedEventId, feedEventView, feedKinds } from '../dist/feed-event.js';

const { page } = await import(moduleUrl('../convex/projectFeed.ts'));
const { recordFeedEvent } = await import(moduleUrl('../convex/projectFeedStore.ts'));
const { trackHostedOverlapLane } = await import(moduleUrl('../convex/projectHostedOverlapStore.ts'));
const { postSystemLaneNote } = await import(moduleUrl('../convex/projectBoardSystem.ts'));
const board = await import(moduleUrl('../convex/projectBoard.ts'));
const code = expected => error => error.data?.code === expected;
const since = 1;

test('feed access tracks current project membership, including revocation during a subscription', async () => {
  const f = await landingFixture();
  const input = { projectId: f.projectId, since, project: true };
  const read = (actor, args = input) => f.call('observerBudgetPage', page, args, actor);
  f.insert('projectReaders', { projectId: f.projectId, reader: 'reader' });
  const membership = f.insert('projectContributors', { projectId: f.projectId, contributor: 'writer' });
  await assert.rejects(read(null), code('PROJECT_UNAVAILABLE'));
  await assert.rejects(read('outsider'), code('PROJECT_UNAVAILABLE'));
  await assert.rejects(read('reader'), code('PROJECT_UNAVAILABLE'));
  assert.deepEqual(await read('writer'), { events: [], more: false, cursor: null });
  const unchanged = f.readSet();
  assert(unchanged(), 'a quiet subscription has no changed dependency');
  f.tables.projectContributors.delete(membership);
  assert(!unchanged(), 'membership removal invalidates the live query');
  await assert.rejects(read('writer'), code('PROJECT_UNAVAILABLE'));
  await assert.rejects(read('owner', { ...input, lanes: [randomUUID()] }), code('BAD_ARGUMENT'));
  await assert.rejects(
    read('owner', { ...input, project: undefined, lanes: Array.from({ length: 33 }, randomUUID) }),
    code('BAD_ARGUMENT'),
  );
  await assert.rejects(read('owner', { ...input, since: 1.1 }), code('BAD_ARGUMENT'));
  await assert.rejects(read('owner', { ...input, cursor: 'not an opaque token' }), code('BAD_ARGUMENT'));
  f.patch('hostedProjects', f.projectId, { removal: 'deleting' });
  await assert.rejects(read('owner'), code('PROJECT_UNAVAILABLE'));
});

test('feed pagination crosses unmatched rows at a shared instant and keeps Lane dependencies separate', async t => {
  const f = await landingFixture();
  const laneId = randomUUID(),
    peer = randomUUID(),
    match = randomUUID();
  for (let i = 1; i <= 70; i++)
    f.insert('projectFeedEvents', {
      projectId: f.projectId,
      laneId: peer,
      actor: 'peer',
      at: 2,
      id: `lane.attention:${String(i).padStart(3, '0')}`,
      noteId: String(i),
      kind: 'lane.attention',
      reason: 'note',
    });
  f.insert('projectFeedEvents', {
    projectId: f.projectId,
    laneId: match,
    actor: 'owner',
    at: 2,
    id: `lane.closed:${match}`,
    kind: 'lane.closed',
  });
  const input = { projectId: f.projectId, since, project: true, mine: true, kinds: ['lane.closed'] };
  const read = options => f.call('observerBudgetPage', page, options);
  const first = await read(input);
  assert(first.more && first.cursor);
  assert.deepEqual(first.events, []);
  assert(f.counts.at(-1).documents <= 36);
  const middle = await read({ ...input, cursor: first.cursor });
  assert(middle.more && middle.cursor);
  assert.deepEqual(middle.events, []);
  const last = await read({ ...input, cursor: middle.cursor });
  assert.equal(last.more, false);
  assert.deepEqual(
    last.events.map(event => event.laneId),
    [match],
  );
  const scoped = { projectId: f.projectId, since, lanes: [laneId] };
  await read(scoped);
  const unchanged = f.readSet();
  const write = target =>
    f.run('recordFeedEvent', recordFeedEvent, {
      projectId: f.projectId,
      laneId: target,
      actor: 'owner',
      kind: 'lane.closed',
    });
  await write(randomUUID());
  assert(unchanged(), 'another Lane does not rerun this subscription');
  await write(laneId);
  assert(!unchanged(), 'an in-scope insert wakes the previously empty subscription');
  const started = performance.now();
  const scale = await read({
    ...scoped,
    lanes: [peer, match, laneId, ...Array.from({ length: 29 }, randomUUID)],
  });
  const cost = f.counts.at(-1);
  assert.equal(scale.events.length, 33);
  assert.equal(scale.more, true);
  t.diagnostic(
    JSON.stringify({
      scopeLanes: 32,
      documents: cost.documents,
      readBytes: cost.readBytes,
      fixtureMs: performance.now() - started,
    }),
  );
});

test('feed writes prune at most two expired rows in their project without scheduling upkeep', async t => {
  const f = await landingFixture();
  t.mock.method(Date, 'now', () => 2_000_000_000);
  const input = { projectId: f.projectId, laneId: randomUUID(), actor: 'owner', kind: 'lane.closed' };
  const peerProject = 'another-project';
  for (let i = 1; i <= 4; i++)
    f.insert('projectFeedEvents', {
      ...input,
      id: String(i),
      at: i,
      ...(i === 4 ? { projectId: peerProject } : {}),
    });
  const pending = f.pendingTasks().length;
  await f.run('feedWrite', recordFeedEvent, input);
  assert.deepEqual(
    [...f.tables.projectFeedEvents.values()].map(row => row.id),
    ['3', '4', feedEventId(input)],
  );
  assert.equal(f.pendingTasks().length, pending);
});

test('actual Lane and inbox writers emit once, for the recipient holder and without board text', async t => {
  const f = await landingFixture();
  const now = 2_000_000_000;
  t.mock.method(Date, 'now', () => now);
  const projectId = f.projectId,
    laneId = randomUUID(),
    holder = 'recipient-holder';
  f.insert('projectContributors', { projectId, contributor: holder });
  const lane = {
    id: laneId,
    intentId: randomUUID(),
    actor: 'owner',
    holder: { actor: holder },
    head: 'a'.repeat(64),
    version: 0,
    sourceVersion: 0,
    lifecycleVersion: 0,
    at: new Date(now).toISOString(),
    state: 'active',
    base: { head: 'a'.repeat(64), receiptId: f.main.receipt.id },
  };
  const track = record => f.run('overlap', ctx => trackHostedOverlapLane(ctx, projectId, record), {});
  await track(lane);
  const moved = { ...lane, head: 'b'.repeat(64), version: 1, sourceVersion: 1 };
  await track(moved);
  await track(moved);
  const note = { projectId, operationId: randomUUID(), to: `lane:${laneId}`, text: 'synthetic member body' };
  await f.call('memberNote', board.post, note);
  await f.call('memberNote', board.post, note);
  const system = {
    projectId,
    id: randomUUID(),
    toLaneId: laneId,
    fromLaneId: laneId,
    author: 'another-person',
    text: 'synthetic system body',
    reason: 'approval',
  };
  await f.run('systemNote', postSystemLaneNote, system);
  await f.run('systemNote', postSystemLaneNote, system);
  await track({ ...moved, state: 'abandoned', version: 2, lifecycleVersion: 1 });
  await track({ ...moved, state: 'active', version: 3, lifecycleVersion: 2 });
  await track({ ...moved, state: 'abandoned', version: 4, lifecycleVersion: 3 });
  const result = await f.call('feed', page, { projectId, since, project: true, mine: true }, holder);
  assert.deepEqual(
    new Set(result.events.map(event => event.id)),
    new Set([
      `lane.saved:${laneId}:1`,
      `lane.closed:${laneId}:2`,
      `lane.closed:${laneId}:4`,
      `lane.attention:${system.id}`,
      `lane.attention:${note.operationId}`,
    ]),
  );
  assert.equal(result.events.find(event => event.noteId === system.id).reason, 'approval');
  assert(!JSON.stringify(result).includes('synthetic'));
  assert(!JSON.stringify(result).includes(holder));
});

test('all feed payloads stay below 1 KiB and keep the original resume identity', () => {
  const projectId = 'p'.repeat(32),
    laneId = randomUUID(),
    operationId = randomUUID(),
    submissionId = randomUUID(),
    runId = randomUUID();
  for (const kind of feedKinds) {
    const ids = kind.startsWith('landing.')
      ? { operationId, submissionId, runId, receiptId: randomUUID(), code: 'CHECK_FAILED' }
      : kind.startsWith('check.')
        ? { operationId, runId }
        : kind === 'lane.saved'
          ? { sourceVersion: 1 }
          : kind === 'lane.attention'
            ? { noteId: 'a'.repeat(64), reason: 'conflict' }
            : kind === 'queue.moved'
              ? { operationId, submissionId, position: 1 }
              : {};
    const event = { kind, projectId, laneId, ...ids };
    const id = feedEventId(event);
    const view = feedEventView({ ...event, at: 42, id, actor: 'hidden', log: 'hidden' });
    assert.equal(view.id, id);
    assert(Buffer.byteLength(JSON.stringify(view)) <= 1024, kind);
    assert(!JSON.stringify(view).includes('hidden'), kind);
    if (kind.startsWith('landing.') || kind === 'queue.moved')
      assert.deepEqual(view.resume, {
        action: 'wait',
        input: { operationIds: [operationId], until: 'acceptance' },
      });
    if (kind.startsWith('check.')) assert.deepEqual(view.resume, { action: 'wait', input: { runId } });
  }
});
