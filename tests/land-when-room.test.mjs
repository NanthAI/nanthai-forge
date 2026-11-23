// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Ferdinando Valsecchi
// Issue ad80e037 line "land when the queue has room": `land {maxChecks:N}` is judged by the
// server inside the submitting mutation (switch FORGE_QUEUE_LAND_WHEN_ROOM, off by default), and a
// land without room waits on a live query instead of a builder's 240 s polling loop.
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { ConvexError } from 'convex/values';
import { getFunctionName } from 'convex/server';
import { finishFixture, desired, landingApi, code } from './hosted-finish-fixture.mjs';
import { agentFixture } from './hosted-agent-fixture.mjs';
import { observationWaitHooks } from '../dist/hosted-agent-observe.js';
import { queueRoomCount } from '../dist/hosted-queue-status.js';
import { hostedAgentCommandSchemas } from '../dist/hosted-agent-contract.js';
import { hostedAgentDirectory } from '../dist/hosted-agent-journal.js';
import { moduleUrl } from './convex-module.mjs';

const room = await import(moduleUrl('../convex/projectHostedQueueRoom.ts'));
const SWITCH = 'FORGE_QUEUE_LAND_WHEN_ROOM';
const synthetic = {
  FORGE_HOSTED_CHECK_KEY_ID: 'SYNTHETIC',
  FORGE_SOURCE_PROVIDER: 'convex',
  FORGE_SOURCE_WORKER: 'fixed-worker',
  FORGE_SOURCE_RUNTIME: 'a'.repeat(64),
  FORGE_SOURCE_KEY_ID: 'SYNTHETIC',
  R2_ACCOUNT_ID: 'synthetic',
  R2_BUCKET: 'synthetic',
  R2_ACCESS_KEY_ID: 'synthetic',
  R2_SECRET_ACCESS_KEY: 'synthetic',
};
const prior = Object.fromEntries([...Object.keys(synthetic), SWITCH].map(k => [k, process.env[k]]));
test.before(() => Object.assign(process.env, synthetic));
test.after(() => {
  for (const [key, value] of Object.entries(prior)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});
const switched = (t, on) => {
  if (on) process.env[SWITCH] = '1';
  else delete process.env[SWITCH];
  t.after(() => delete process.env[SWITCH]);
};
const desiredRequest = f => ({
  operationId: randomUUID(),
  authorityEpoch: 1,
  composeOperationId: f.selection.request.operationId,
  after: null,
  check: f.request().check,
});
const submit = (f, command, maxChecks) =>
  f
    .tx('desiredSubmit', desired.submit, {
      projectId: f.projectId,
      request: JSON.stringify(command),
      ...(maxChecks === undefined ? {} : { maxChecks }),
    })
    .then(JSON.parse);
/** The queue directory as the queue writes it: compact keys, one page per 128 sequence numbers. */
function queueHolds(f, keys, page = 7) {
  const id = `projectHostedLandingQueueStatus-room-${randomUUID()}`;
  f.tables.projectHostedLandingQueueStatus.set(id, {
    _id: id,
    _creationTime: Date.now(),
    projectId: f.projectId,
    page,
    value: JSON.stringify(keys),
  });
}
const key = (id, extra = {}) => ({
  id,
  sequence: 900 + id.length,
  actor: 'peer',
  priority: 'normal',
  ...extra,
});

test('ad80e037: room counts check groups, not entries; held entries are out and preparing landings in', () => {
  const keys = [
    key('a', { phase: 'checking' }),
    key('b', { phase: 'checking', batchId: 'x' }),
    key('c', { phase: 'checking', batchId: 'x' }),
    key('d', { phase: 'queued', held: 'review' }),
    key('e', { phase: 'queued' }),
  ];
  assert.deepEqual(queueRoomCount(keys, 2), { checks: 5, groups: 3, preparing: 2 });
});

test('ad80e037: with the switch off a submission naming maxChecks is refused and nothing is written', async t => {
  switched(t, false);
  const f = await finishFixture(t);
  await assert.rejects(submit(f, desiredRequest(f), 4), error => {
    assert(code('HOSTED_ACTION_UNSUPPORTED')(error));
    assert.match(error.data?.message ?? error.message, /FORGE_QUEUE_LAND_WHEN_ROOM.*Nothing was submitted/);
    return true;
  });
  assert.equal(f.tables.projectHostedLandingDesired.size, 0);
  // Without the field the submit is today's, switch or not.
  assert.equal((await submit(f, desiredRequest(f))).phase, 'composing');
});

test('ad80e037: no room refuses before anything is written; the same operation is admitted once there is room', async t => {
  switched(t, true);
  const f = await finishFixture(t);
  queueHolds(f, [
    key('a', { phase: 'checking' }),
    key('b', { phase: 'checking', batchId: 'x' }),
    key('c', { phase: 'queued', batchId: 'x' }),
    key('d', { phase: 'queued', held: 'review' }),
  ]);
  const command = desiredRequest(f);
  const before = JSON.stringify(Object.entries(f.tables).map(([name, rows]) => [name, rows.size]));
  await assert.rejects(submit(f, command, 2), error => {
    assert(code('WORK_BUSY')(error));
    assert.match(
      error.data?.message ?? error.message,
      /2 checks are running or waiting.*Nothing was submitted/,
    );
    return true;
  });
  assert.equal(
    JSON.stringify(Object.entries(f.tables).map(([name, rows]) => [name, rows.size])),
    before,
    'a refusal writes nothing and charges nothing',
  );
  const admitted = await submit(f, command, 3);
  assert.equal(admitted.phase, 'composing');
  // A replay of the admitted operation returns it unjudged, whatever the queue holds now.
  assert.equal((await submit(f, command, 1)).id, admitted.id);
  const read = JSON.parse(await f.tx('room', room.room, { projectId: f.projectId, limit: 3 }));
  assert.deepEqual(
    read,
    { checks: 3, groups: 2, preparing: 1 },
    'the room query counts what the submit judged',
  );
});

// Review aeec44a8: held entries keep newer pages alive while a released entry keeps its old
// sequence, so a checking entry can sit past the 8 newest pages. The count must not fail open.
test('ad80e037: past 8 directory pages the queue row decides, and an unknown count is full', async t => {
  switched(t, true);
  const f = await finishFixture(t);
  queueHolds(f, [key('old', { phase: 'checking' })], 1);
  for (let page = 2; page <= 10; page++)
    queueHolds(f, [key(`held${page}`, { phase: 'queued', held: 'review' })], page);
  // No queue row (or no status): counted as full, refused.
  const rows = f.tables.projectHostedLandingQueues;
  const saved = [...rows.entries()];
  rows.clear();
  await assert.rejects(submit(f, desiredRequest(f), 2), code('WORK_BUSY'));
  // The queue row's exact group count (held entries out) is 1 check: under 2, admitted; at 1, not.
  for (const [id, row] of saved) rows.set(id, row);
  const status = { total: 1, held: 9, groups: 1, horizon: [], lastProgressAt: new Date().toISOString() };
  const current = [...rows.values()].find(row => row.projectId === f.projectId && row.channel === 'main');
  if (current) rows.set(current._id, { ...current, status });
  else
    rows.set('projectHostedLandingQueues-room', {
      _id: 'projectHostedLandingQueues-room',
      _creationTime: Date.now(),
      projectId: f.projectId,
      channel: 'main',
      sequence: 0,
      fence: 0,
      wake: null,
      status,
    });
  await assert.rejects(submit(f, desiredRequest(f), 1), code('WORK_BUSY'));
  assert.equal((await submit(f, desiredRequest(f), 2)).phase, 'composing');
});

// Incident replay ad80e037 (friction from Item 593fc2d7): two builders each read the queue, saw
// room under the cap, and both submitted, so the cap was passed. The server now judges the second
// submit with the first one counted (it is still preparing), inside the submitting transaction.
test('incident replay ad80e037: two submits that both saw room cannot both pass the cap', async t => {
  switched(t, true);
  const f = await finishFixture(t);
  queueHolds(f, [key('a', { phase: 'checking' })]);
  const first = await submit(f, desiredRequest(f), 2);
  assert.equal(first.phase, 'composing');
  // The second builder read the same queue (1 check, room under 2) before the first submit landed.
  const agent = f.request({ agent: true });
  await assert.rejects(
    f.tx('finishEnqueue', landingApi.enqueue, {
      projectId: f.projectId,
      request: JSON.stringify(agent),
      maxChecks: 2,
    }),
    code('WORK_BUSY'),
  );
  assert.equal(f.tables.projectHostedLandingRequests.size, 0, 'the second landing was not queued');
});

/** A live room query the test drives: each `push` is one server re-run of the subscribed query. */
function roomFeed(t) {
  const feed = { subscribed: [], closed: 0, unsubscribed: 0, push: () => {} };
  observationWaitHooks.subscribe = () => ({
    onUpdate(reference, args, update) {
      feed.subscribed.push({ name: getFunctionName(reference), args });
      feed.push = value => update(JSON.stringify(value));
      feed.onSubscribe?.();
      return () => feed.unsubscribed++;
    },
    close: async () => {
      feed.closed++;
    },
  });
  t.after(() => {
    observationWaitHooks.subscribe = undefined;
  });
  return feed;
}
const busy = () =>
  new ConvexError({
    code: 'WORK_BUSY',
    message: 'No queue room: 2 checks are running or waiting. Nothing was submitted.',
  });

test('ad80e037: a land without room waits on the live room query and submits once a check ends', async t => {
  const s = agentFixture(t);
  s.caps.features = ['land-when-room'];
  const feed = roomFeed(t);
  const inner = s.exchange.client.mutation;
  const submits = [];
  let full = true;
  s.exchange.client.mutation = (ref, args) => {
    if (getFunctionName(ref) !== 'projectHostedLanding:enqueue') return inner(ref, args);
    submits.push(args.maxChecks);
    return full ? Promise.reject(busy()) : inner(ref, args);
  };
  // The first answer still shows no room; the next re-run (a check ended) shows room.
  feed.onSubscribe = () => {
    feed.push({ checks: 2, groups: 2, preparing: 0 });
    full = false;
    feed.push({ checks: 1, groups: 1, preparing: 0 });
  };
  await s.transport().dispatch('open', { laneId: s.lane.laneId });
  const reply = await s.transport().dispatch('finish', { laneId: s.lane.laneId, maxChecks: 2 });
  assert.equal(reply.result.submission.phase, 'queued');
  assert.deepEqual(submits, [2, 2], 'refused once, then admitted on room; no other submit');
  assert.deepEqual(feed.subscribed, [
    { name: 'projectHostedQueueRoom:room', args: { projectId: s.address.projectId, limit: 2 } },
  ]);
  assert.equal(feed.unsubscribed, 1);
  assert.equal(feed.closed, 1, 'the live client is closed once the land has room');
});

test('ad80e037: main movement while waiting for room leaves the normal main pin attempts available', async t => {
  const s = agentFixture(t);
  s.caps.features = ['land-when-room'];
  const feed = roomFeed(t);
  const inner = s.exchange.client.mutation;
  s.pinMain(true);
  let waits = 0;
  let retrying = false;
  s.exchange.client.mutation = (ref, args) => {
    const name = getFunctionName(ref);
    if (name !== 'projectHostedLanding:enqueue') return inner(ref, args);
    if (retrying) {
      retrying = false;
      return inner(ref, args);
    }
    if (waits === 3) return inner(ref, args);
    return Promise.reject(busy());
  };
  feed.onSubscribe = () => {
    feed.push({ checks: 2, groups: 2, preparing: 0 });
    s.moveMainBefore('projectHostedLanding:enqueue');
    waits++;
    retrying = true;
    feed.push({ checks: 1, groups: 1, preparing: 0 });
  };

  const operationId = randomUUID();
  const reply = await s.transport().dispatch('finish', { laneId: s.lane.laneId, maxChecks: 2, operationId });
  assert.equal(reply.operationId, operationId);
  assert.equal(reply.result.submission.phase, 'queued');
  assert.equal(feed.subscribed.length, 3);
  assert.equal(feed.closed, 3);
  assert.equal(reply.result.submission.request.expectedMain.head, s.main.head);
});

test('ad80e037: a capped replay does not recompose after its room wait budget', async t => {
  const s = agentFixture(t);
  s.caps.features = ['land-when-room'];
  s.pinMain(true);
  const feed = roomFeed(t);
  const inner = s.exchange.client.mutation;
  let full = true;
  s.exchange.client.mutation = (ref, args) =>
    full && getFunctionName(ref) === 'projectHostedLanding:enqueue'
      ? Promise.reject(busy())
      : inner(ref, args);
  const command = { laneId: s.lane.laneId, maxChecks: 2, operationId: randomUUID() };
  const spent = Object.assign(s.transport(), { waitUntil: Date.now() - 1 });
  await assert.rejects(spent.dispatch('finish', command), code('WORK_BUSY'));

  let now = Date.now();
  const deadline = now + 10_000;
  t.mock.method(Date, 'now', () => now);
  feed.onSubscribe = () => {
    feed.push({ checks: 2, groups: 2, preparing: 0 });
    s.moveMainBefore('projectHostedLanding:enqueue');
    full = false;
    feed.push({ checks: 1, groups: 1, preparing: 0 });
    now = deadline;
  };
  const replay = Object.assign(s.transport(), { waitUntil: deadline });
  const before = s.calls.length;
  await assert.rejects(
    replay.dispatch('finish', command),
    error => error.code === 'CHANNEL_CHANGED' && /Replay the same operation/.test(error.message),
  );
  assert(!s.calls.slice(before).some(call => call.name === 'projectHostedCompose:prepare'));

  const resumed = await s.transport().dispatch('finish', command);
  assert.equal(resumed.operationId, command.operationId);
  assert.equal(resumed.result.submission.request.expectedMain.head, s.main.head);
});

test('ad80e037: the land refuses maxChecks itself when the server does not take it', async t => {
  const s = agentFixture(t);
  s.caps.features = [];
  await s.transport().dispatch('open', { laneId: s.lane.laneId });
  const before = s.calls.length;
  await assert.rejects(
    s.transport().dispatch('finish', { laneId: s.lane.laneId, maxChecks: 2 }),
    error => error.code === 'HOSTED_ACTION_UNSUPPORTED' && /Nothing was submitted/.test(error.message),
  );
  assert(
    !s.calls.slice(before).some(call => call.name === 'projectHostedLanding:enqueue'),
    'nothing was submitted',
  );
});

test('ad80e037: past its wait budget a land without room names the replay; another WORK_BUSY is not taken for room', async t => {
  const s = agentFixture(t);
  s.caps.features = ['land-when-room'];
  const feed = roomFeed(t);
  const inner = s.exchange.client.mutation;
  let submits = 0;
  s.exchange.client.mutation = (ref, args) => {
    if (getFunctionName(ref) !== 'projectHostedLanding:enqueue') return inner(ref, args);
    submits++;
    return Promise.reject(busy());
  };
  await s.transport().dispatch('open', { laneId: s.lane.laneId });
  const spent = Object.assign(s.transport(), { waitUntil: Date.now() - 1 });
  await assert.rejects(
    spent.dispatch('finish', { laneId: s.lane.laneId, maxChecks: 2, operationId: randomUUID() }),
    error =>
      error.code === 'WORK_BUSY' &&
      /Nothing was submitted\. Replay the same land command \(same operationId\) to keep waiting/.test(
        error.message,
      ),
  );
  assert.equal(submits, 1);
  assert.equal(feed.subscribed.length, 0, 'no live client when the budget is spent');
  // The server keeps refusing while the room query shows room: not a room refusal, reported as it came.
  submits = 0;
  feed.onSubscribe = () => feed.push({ checks: 0, groups: 0, preparing: 0 });
  await assert.rejects(
    s.transport().dispatch('finish', { laneId: s.lane.laneId, maxChecks: 2, operationId: randomUUID() }),
    error => error.code === 'WORK_BUSY' && /No queue room: 2 checks/.test(error.message),
  );
  assert.equal(submits, 2, 'room showed at once after each refusal: one retry, then the refusal is reported');
  assert.equal(feed.subscribed.length, 2);
  assert.equal(feed.closed, feed.subscribed.length, 'every live client is closed');
});

// Review 6335d75e finding 1: a land refused over maxChecks before it submitted anything ended that
// operation for any other maxChecks, so "land without it" is new work, not a replay of the refusal.
test('ad80e037: after maxChecks is refused as unsupported, the same land without it submits', async t => {
  const s = agentFixture(t);
  s.caps.features = [];
  await s.transport().dispatch('open', { laneId: s.lane.laneId });
  await assert.rejects(
    s.transport().dispatch('finish', { laneId: s.lane.laneId, maxChecks: 2 }),
    code('HOSTED_ACTION_UNSUPPORTED'),
  );
  const before = s.calls.length;
  const reply = await s.transport().dispatch('finish', { laneId: s.lane.laneId });
  assert.equal(reply.result.submission.phase, 'queued');
  const enqueued = s.calls.slice(before).filter(call => call.name === 'projectHostedLanding:enqueue');
  assert.equal(enqueued.length, 1);
  assert.equal(enqueued[0].args.maxChecks, undefined, 'the new land carries no maxChecks');
});

test('ad80e037: past the budget the same land keeps its operation; dropping maxChecks is new work', async t => {
  const s = agentFixture(t);
  s.caps.features = ['land-when-room'];
  roomFeed(t);
  const inner = s.exchange.client.mutation;
  const submits = [];
  let full = true;
  s.exchange.client.mutation = (ref, args) => {
    if (getFunctionName(ref) !== 'projectHostedLanding:enqueue') return inner(ref, args);
    submits.push({ maxChecks: args.maxChecks, request: JSON.parse(args.request).operationId });
    return full ? Promise.reject(busy()) : inner(ref, args);
  };
  await s.transport().dispatch('open', { laneId: s.lane.laneId });
  const spent = () => Object.assign(s.transport(), { waitUntil: Date.now() - 1 });
  await assert.rejects(
    spent().dispatch('finish', { laneId: s.lane.laneId, maxChecks: 2 }),
    code('WORK_BUSY'),
  );
  await assert.rejects(
    spent().dispatch('finish', { laneId: s.lane.laneId, maxChecks: 2 }),
    code('WORK_BUSY'),
  );
  assert.equal(submits.length, 2);
  assert.equal(
    submits[1].request,
    submits[0].request,
    'the same land replays its operation and keeps waiting',
  );
  full = false;
  const reply = await s.transport().dispatch('finish', { laneId: s.lane.laneId });
  assert.equal(reply.result.submission.phase, 'queued');
  assert.equal(submits.length, 3);
  assert.equal(
    submits[2].maxChecks,
    undefined,
    'without maxChecks the land is new work, not the refused replay',
  );
  assert.notEqual(submits[2].request, submits[0].request);
});

// Review 6335d75e finding 2: SIGINT/SIGTERM or an MCP cancel stops the wait, closes the live client
// and never submits afterwards.
test('ad80e037: a cancel stops a land waiting for room; nothing more is submitted', async t => {
  const s = agentFixture(t);
  s.caps.features = ['land-when-room'];
  const feed = roomFeed(t);
  const inner = s.exchange.client.mutation;
  let submits = 0;
  s.exchange.client.mutation = (ref, args) => {
    if (getFunctionName(ref) !== 'projectHostedLanding:enqueue') return inner(ref, args);
    submits++;
    return Promise.reject(busy());
  };
  const controller = new AbortController();
  feed.onSubscribe = () => {
    feed.push({ checks: 2, groups: 2, preparing: 0 });
    controller.abort();
    feed.push({ checks: 0, groups: 0, preparing: 0 });
  };
  await s.transport().dispatch('open', { laneId: s.lane.laneId });
  await assert.rejects(
    s.transport().dispatch('finish', { laneId: s.lane.laneId, maxChecks: 2 }, controller.signal),
    error => error.code === 'CANCELLED' && /Nothing was submitted/.test(error.message),
  );
  assert.equal(submits, 1, 'no submit after the cancel');
  assert.equal(feed.unsubscribed, 1);
  assert.equal(feed.closed, 1, 'the live client is closed on cancel');
});

test('ad80e037: maxChecks on a check-only run is refused, not ignored', () => {
  const parsed = hostedAgentCommandSchemas.finish.safeParse({ accept: false, maxChecks: 2 });
  assert.equal(parsed.success, false);
  assert.match(parsed.error.issues.map(issue => issue.message).join(' '), /check-only run/);
  assert.equal(hostedAgentCommandSchemas.finish.safeParse({ maxChecks: 2 }).success, true);
});

// Review ec591e14 finding 1: a refusal mark lives only while the server's refusal stands. An
// admitted replay (room came, or the switch went on) clears it, so a later land on new source is
// never a second landing of the same Lane; new source after a refusal that stands is new work.
const refusedMark = (s, operationId) =>
  JSON.parse(readFileSync(join(hostedAgentDirectory(s.root), `${operationId}.json`), 'utf8')).values[
    'finish-refused'
  ];
test('ad80e037: an admitted replay clears the refusal mark, after no room and after the switch was off', async t => {
  for (const refusal of [
    busy,
    () => new ConvexError({ code: 'HOSTED_ACTION_UNSUPPORTED', message: 'maxChecks is off.' }),
  ]) {
    const s = agentFixture(t);
    s.caps.features = ['land-when-room'];
    roomFeed(t);
    const inner = s.exchange.client.mutation;
    let refuse = true;
    s.exchange.client.mutation = (ref, args) => {
      if (getFunctionName(ref) !== 'projectHostedLanding:enqueue') return inner(ref, args);
      return refuse ? Promise.reject(refusal()) : inner(ref, args);
    };
    await s.transport().dispatch('open', { laneId: s.lane.laneId });
    const operationId = randomUUID();
    const land = { laneId: s.lane.laneId, maxChecks: 2, operationId };
    await assert.rejects(
      Object.assign(s.transport(), { waitUntil: Date.now() - 1 }).dispatch('finish', land),
    );
    assert.match(refusedMark(s, operationId), /^(NO_QUEUE_ROOM|MAX_CHECKS_UNSUPPORTED)$/);
    refuse = false;
    assert.equal((await s.transport().dispatch('finish', land)).result.submission.phase, 'queued');
    assert.equal(refusedMark(s, operationId), undefined, 'a submitted landing is never marked refused');
  }
});

test('ad80e037: after a no-room refusal, a land on edited source never replays the refused operation', async t => {
  const s = agentFixture(t);
  s.caps.features = ['land-when-room'];
  roomFeed(t);
  const inner = s.exchange.client.mutation;
  const submits = [];
  s.exchange.client.mutation = (ref, args) => {
    if (getFunctionName(ref) !== 'projectHostedLanding:enqueue') return inner(ref, args);
    submits.push(JSON.parse(args.request).operationId);
    return Promise.reject(busy());
  };
  await s.transport().dispatch('open', { laneId: s.lane.laneId });
  await assert.rejects(
    Object.assign(s.transport(), { waitUntil: Date.now() - 1 }).dispatch('finish', {
      laneId: s.lane.laneId,
      maxChecks: 2,
    }),
    code('WORK_BUSY'),
  );
  assert.equal(submits.length, 1);
  writeFileSync(join(s.root, 'lane-edit.txt'), 'Edited after the refusal\n');
  const error = await Object.assign(s.transport(), { waitUntil: Date.now() - 1 })
    .dispatch('finish', { laneId: s.lane.laneId, maxChecks: 2 })
    .then(
      () => null,
      e => e,
    );
  assert(
    !submits.slice(1).includes(submits[0]),
    'the refused operation and its stale source were not replayed',
  );
  assert.notEqual(error?.code, undefined);
});
