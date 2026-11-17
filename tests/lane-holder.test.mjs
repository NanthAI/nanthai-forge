// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { policyPreset } from '../dist/autonomy-policy.js';
import { sessionAgentIdentity, agentSlug } from '../dist/agent-slug-session.js';
import { lifecycleFixture, code } from './hosted-lane-lifecycle-fixture.mjs';
import { moduleUrl } from './convex-module.mjs';
const api = await import(moduleUrl('../convex/projectHostedHolders.ts'));
const sessionA = sessionAgentIdentity(undefined, { CODEX_THREAD_ID: 'synthetic-thread-a' });
const sessionB = sessionAgentIdentity(undefined, { CODEX_THREAD_ID: 'synthetic-thread-b' });
async function setup() {
  const f = await lifecycleFixture();
  f.patch('hostedProjects', f.projectId, {
    autonomyPolicy: { ...policyPreset('trusted'), accessIdentities: { laneHolders: true } },
  });
  const request = (session = sessionA, fields = {}) => ({
    operationId: randomUUID(),
    laneId: f.laneId,
    authorityEpoch: 1,
    sessionId: session.sessionId,
    agent: session.name,
    ...fields,
  });
  const take = (r, actor = 'owner') =>
    f
      .lifeCall('holderTake', api.take, { projectId: f.projectId, request: JSON.stringify(r) }, actor)
      .then(JSON.parse);
  return { ...f, request, take };
}

test('holder changes require explicit takeover and a live-holder reason, preserve every saved byte, and replay without another transition', async () => {
  const f = await setup();
  const source = await f.read(f.laneId);
  const first = await f.take(f.request());
  await assert.rejects(f.take(f.request(sessionB)), code('WORK_STALE'));
  await assert.rejects(f.take(f.request(sessionB, { takeover: true })), code('BAD_ARGUMENT'));
  const request = f.request(sessionB, { takeover: true, reason: 'Continue the saved change' });
  const result = await f.take(request);
  const lane = await f.read(f.laneId);
  assert.equal(lane.head, source.head);
  assert.equal(lane.sourceVersion, source.sourceVersion);
  assert.equal(lane.lifecycleVersion, source.lifecycleVersion);
  assert.deepEqual(lane.holder.change.previous, {
    actor: first.result.holder.actor,
    agent: first.result.holder.agent,
    sessionId: first.result.holder.sessionId,
    since: first.result.holder.since,
    lastSeen: first.result.holder.lastSeen,
  });
  assert.equal(lane.holder.change.reason, request.reason);
  assert.equal(lane.holder.change.savedHead, source.head);
  assert.equal(lane.holder.sessionId, sessionB.sessionId);
  const events = f.tables.projectCoordinationEvents.size;
  assert.deepEqual((await f.take(request)).result, result.result);
  assert.equal(f.tables.projectCoordinationEvents.size, events);
  await assert.rejects(f.take({ ...request, reason: 'Changed retry' }), code('WORK_OPERATION_CHANGED'));
  assert(
    [...f.tables.projectCoordinationEvents.values()].some(e =>
      e.command.action?.startsWith('holder takeover:'),
    ),
  );
});

test('a resumed thread keeps its name and since-time; an inactive holder needs no reason; stale viewed pins never replace newer work', async () => {
  const f = await setup();
  const first = await f.take(f.request());
  const resumed = await f.take(f.request());
  assert.equal(resumed.result.kind, 'resume');
  assert.equal(resumed.result.holder.agent, first.result.holder.agent);
  assert.equal(resumed.result.holder.since, first.result.holder.since);
  assert(
    [...f.tables.projectCoordinationEvents.values()].some(e =>
      e.command.action?.startsWith('holder resume:'),
    ),
  );
  const old = await f.read(f.laneId);
  await f.changeLane(f.laneId, { holder: { ...old.holder, lastSeen: 0 } });
  const taken = await f.take(f.request(sessionB, { takeover: true }));
  assert.equal(taken.result.kind, 'take-back');
  await assert.rejects(
    f.take(
      f.request(sessionA, {
        takeover: true,
        reason: 'Continue',
        expected: { head: old.head, version: old.version },
      }),
    ),
    code('WORK_STALE'),
  );
  assert.equal((await f.read(f.laneId)).holder.sessionId, sessionB.sessionId);
});

test('only the Lane person or project owner takes over; a handover records both sessions without changing checks or the queue', async () => {
  const f = await setup();
  f.insert('projectContributors', { projectId: f.projectId, contributor: 'writer' });
  f.insert('projectContributors', { projectId: f.projectId, contributor: 'peer' });
  f.insert('projectReaders', { projectId: f.projectId, reader: 'reader' });
  const lane = await f.addLane({ actor: 'writer' });
  const r = f.request(sessionA, { laneId: lane.id });
  await f.take(r, 'writer');
  await assert.rejects(
    f.take(f.request(sessionB, { laneId: lane.id, takeover: true, reason: 'Continue' }), 'peer'),
    code('PROJECT_UNAVAILABLE'),
  );
  await assert.rejects(
    f.take(f.request(sessionB, { laneId: lane.id, takeover: true, reason: 'Continue' }), 'reader'),
    code('PROJECT_UNAVAILABLE'),
  );
  const untouched = [
    'projectHostedCheckRuns',
    'projectHostedLandingRequests',
    'projectHostedLandingQueueStatus',
  ];
  const before = untouched.map(t => [...f.tables[t].values()]);
  const taken = await f.take(
    f.request(sessionB, { laneId: lane.id, takeover: true, reason: 'Owner continues the saved work' }),
  );
  assert.equal(taken.result.holder.actor, 'owner');
  const handed = await f.take(
    f.request(sessionB, {
      laneId: lane.id,
      reason: 'Hand the saved work to the other thread',
      handoff: { sessionId: sessionA.sessionId, agent: sessionA.name },
    }),
  );
  assert.equal(handed.result.kind, 'handoff-offered');
  assert.equal(handed.result.holder.sessionId, sessionB.sessionId, 'the first holder stays until acceptance');
  const accepted = await f.take(
    f.request(sessionA, { laneId: lane.id, acceptHandoff: handed.result.offerId }),
  );
  assert.equal(accepted.result.kind, 'handoff');
  assert.equal(accepted.result.holder.sessionId, sessionA.sessionId);
  assert.deepEqual(
    untouched.map(t => [...f.tables[t].values()]),
    before,
  );
});

test('a takeover during an upload refuses the old publication and retains the original captured delta', async () => {
  const f = await setup();
  await f.take(f.request());
  const lane = await f.read(f.laneId);
  const expected = {
    head: lane.head,
    version: lane.version,
    sourceVersion: lane.sourceVersion,
    lifecycleVersion: lane.lifecycleVersion,
  };
  const x = await f.prepare([f.change()], { expected, holderSessionId: sessionA.sessionId });
  await f.stage(x);
  await f.submit(x);
  const output = await f.work(x);
  await f.take(
    f.request(sessionB, { takeover: true, reason: 'Continue without replacing the first captured work' }),
  );
  const terminal = await f.publish(output);
  assert.equal(terminal.outcome.status, 'failed');
  assert.equal(terminal.outcome.error.code, 'WORK_STALE');
  assert.match(terminal.outcome.error.message, /held by/);
  assert.equal((await f.read(f.laneId)).head, lane.head);
  assert(f.objects.has(x.request.pages.sha256), 'the captured delta remains stored');
  assert.deepEqual(await f.publish(output), terminal);
  await assert.rejects(
    f.prepare([f.change()], { expected, holderSessionId: sessionA.sessionId }),
    code('WORK_STALE'),
  );
});

test('session references resume deterministically while native, declared and process values remain local', () => {
  const native = 'synthetic-native-thread-private';
  const a = sessionAgentIdentity(undefined, { CODEX_THREAD_ID: native });
  assert.deepEqual(a, sessionAgentIdentity(undefined, { CODEX_THREAD_ID: native }));
  assert.equal(a.name, agentSlug(native));
  assert.equal(a.derivation, 'app-thread');
  const declared = sessionAgentIdentity(undefined, { FORGE_AGENT_SESSION: native });
  assert.equal(declared.derivation, 'declared');
  const process = sessionAgentIdentity(native, {});
  assert.equal(process.derivation, 'process');
  assert.notEqual(a.sessionId, sessionB.sessionId);
  assert.doesNotMatch(
    JSON.stringify([a, declared, process]),
    /synthetic-native-thread-private|CODEX_THREAD_ID|FORGE_AGENT_SESSION/,
  );
});

test('whoami uses capability discovery and the existing Lane head read, without a new command or identity RPC', async t => {
  const { agentFixture } = await import('./hosted-agent-fixture.mjs');
  const f = agentFixture(t);
  f.caps.features = ['lane-holder-v1'];
  const root = await f.transport('synthetic-native-thread').dispatch('status', { whoami: true });
  assert.equal(root.result.identity.name, agentSlug('synthetic-native-thread'));
  assert.equal(root.result.lane, null);
  assert.equal(root.result.holds, false);
  assert.equal(root.result.whyNone, 'Outside a Lane checkout.');
  assert.equal(f.calls.filter(c => c.name === 'projectHostedAgent:capabilities').length, 1);
  assert.equal(
    f.calls.some(c => /identity|whoami/i.test(c.name)),
    false,
  );
});

test('changing the takeover policy changes source authority without granting administrative ownership of another person’s Lane', async () => {
  const { accessPolicy } = await import(moduleUrl('../convex/accessPolicy.ts'));
  const authority = await import(moduleUrl('../convex/projectLaneAuthority.ts'));
  const original = accessPolicy.laneTakeover;
  try {
    accessPolicy.laneTakeover = 'project-writers';
    authority.requireLaneSourceAuthority({ owner: 'owner' }, { actor: 'author', holder: {} }, 'writer');
    assert.throws(
      () => authority.requireMemberAuthority({ owner: 'owner' }, 'author', 'writer', 'Lane'),
      error => error.code === 'PROJECT_UNAVAILABLE',
    );
    assert.throws(
      () => authority.requireLaneSourceAuthority({ owner: 'owner' }, { actor: 'author' }, 'writer'),
      error => error.code === 'PROJECT_UNAVAILABLE',
    );
  } finally {
    accessPolicy.laneTakeover = original;
  }
});

test('an open that records a takeover then cannot download the checkout reports the committed holder operation and keeps saved work', async t => {
  const { agentFixture } = await import('./hosted-agent-fixture.mjs');
  const { getFunctionName } = await import('convex/server');
  const f = agentFixture(t, { lane: { 'unique.txt': randomUUID() } });
  f.caps.features = ['lane-holder-v1'];
  const original = f.exchange.client.mutation.bind(f.exchange.client);
  let changes = 0;
  f.exchange.client.mutation = async (ref, args) => {
    if (getFunctionName(ref) !== 'projectHostedHolders:take') return original(ref, args);
    changes++;
    return JSON.stringify({ status: 'completed', result: { lane: f.lane }, observedLane: f.lane });
  };
  const head = f.lane.head;
  f.objects.delete(head);
  await assert.rejects(
    f
      .transport('synthetic-download-failure')
      .dispatch('open', { laneId: f.lane.laneId, takeover: true, reason: 'Continue saved work' }),
    error => /holder operation was recorded.*Saved work remains/.test(error.message),
  );
  assert.equal(changes, 1);
  assert.equal(f.lane.head, head);
});

test('whoami holder metadata is opt-in and project members only, including on a public project', async () => {
  const f = await setup();
  await f.take(f.request());
  const lanes = await import(moduleUrl('../convex/projectHostedLanes.ts'));
  const read = (actor, includeHolder = true) =>
    f.transaction(
      'head',
      lanes.head,
      { projectId: f.projectId, laneId: f.laneId, ...(includeHolder ? { includeHolder: true } : {}) },
      actor,
    );
  assert.equal((await read('owner')).holder.name, sessionA.name);
  assert.equal((await read('owner', false)).holder, undefined);
  f.patch('hostedProjects', f.projectId, { visibility: 'public' });
  assert.equal((await read('public-guest')).holder, undefined);
  assert.equal((await read('owner')).holder.mine, true);
});
