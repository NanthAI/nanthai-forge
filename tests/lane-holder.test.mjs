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

test('SI-04: a holder change writes only its kind to the activity feed that readers and signed-in visitors read, and its reason is capped', async () => {
  const f = await setup();
  f.insert('projectContributors', { projectId: f.projectId, contributor: 'writer' });
  f.insert('forgeAccounts', { owner: 'writer', handle: 'synthetic-writer' });
  const lane = await f.addLane({ actor: 'writer' });
  await f.take(f.request(sessionA, { laneId: lane.id }), 'writer');
  const reason = 'Owner continues tokReasonx';
  await f.take(f.request(sessionB, { laneId: lane.id, takeover: true, reason }));
  const offered = await f.take(
    f.request(sessionB, {
      laneId: lane.id,
      reason: 'Hand over tokOfferx',
      handoff: { sessionId: sessionA.sessionId, agent: sessionA.name },
    }),
  );
  await f.take(f.request(sessionA, { laneId: lane.id, acceptHandoff: offered.result.offerId }));
  const feed = [...f.tables.projectCoordinationEvents.values()]
    .map(e => e.command.action ?? '')
    .filter(action => action.startsWith('holder '));
  assert.deepEqual(
    [...new Set(feed.map(action => action.split(':')[0]))],
    ['holder takeover', 'holder handoff offered', 'holder handoff'],
  );
  for (const action of feed)
    assert.match(action, /^holder (resume|takeover|take-back|handoff offered|handoff): v\d+$/, 'kind only');
  for (const leak of ['synthetic-writer', 'tokReasonx', 'tokOfferx', sessionA.name, sessionB.name])
    assert(!JSON.stringify(feed).includes(leak), `feed names ${leak}`);
  // The detail stays in the protected Lane record, for those who may read the holder.
  assert.equal((await f.read(lane.id)).holder.change.previous.actor, 'owner');
  const long = 'x'.repeat(281);
  await assert.rejects(
    f.take(f.request(sessionA, { laneId: lane.id, takeover: true, reason: long })),
    error => code('BAD_ARGUMENT')(error) && /reason/.test(error.data?.message ?? error.message),
  );
  await f.take(f.request(sessionB, { laneId: lane.id, takeover: true, reason: 'y'.repeat(280) }));
  assert.equal((await f.read(lane.id)).holder.change.reason.length, 280);
});

// Item 76be0714 (SI-04 follow-up): holder feed entries written before the kind-only rule named both holders and the
// reason. The one-time scrub rewrites each live one to exactly what the current writer records (kind + Lane version),
// leaves every other field and row alone, and leaves rows that may already be journaled counted but untouched.
test('76be0714: the holder feed scrub rewrites pre-SI-04 entries to kind + Lane version and changes nothing else', async () => {
  const scrub = await import(moduleUrl('../convex/holderFeedScrub.ts'));
  const f = await setup();
  f.insert('projectContributors', { projectId: f.projectId, contributor: 'writer' });
  f.insert('forgeAccounts', { owner: 'writer', handle: 'synthetic-writer' });
  const lane = await f.addLane({ actor: 'writer' });
  await f.take(f.request(sessionA, { laneId: lane.id }), 'writer');
  await f.take(
    f.request(sessionB, { laneId: lane.id, takeover: true, reason: 'Owner continues tokReasonx' }),
  );
  const offered = await f.take(
    f.request(sessionB, {
      laneId: lane.id,
      reason: 'Hand over tokOfferx',
      handoff: { sessionId: sessionA.sessionId, agent: sessionA.name },
    }),
  );
  await f.take(f.request(sessionA, { laneId: lane.id, acceptHandoff: offered.result.offerId }));
  const events = f.tables.projectCoordinationEvents;
  const holders = [...events.values()].filter(e => e.command.action?.startsWith('holder '));
  const current = new Map(holders.map(e => [e._id, e.command.action]));
  // The pre-SI-04 writer's text for the same changes.
  for (const event of holders) {
    const [, kind, version] = /^holder (.+): v(\d+)$/.exec(event.command.action);
    event.command = {
      ...event.command,
      action:
        kind === 'handoff offered'
          ? `holder handoff offered: @synthetic-writer/${sessionA.name} → ${sessionB.name} · Hand over tokOfferx`
          : `holder ${kind}: @synthetic-writer/${sessionA.name} → ${sessionB.name} (v${version}) · Owner (v9) · continues tokReasonx`,
    };
  }
  // One as old as the journal's capture window, an old offer whose receipt is gone (no version to recover), and one
  // change that is not a holder change.
  const offer = holders.find(e => e.command.action.startsWith('holder handoff offered'));
  events.set('journaled', { ...holders[0], _id: 'journaled', at: Date.now() - 14 * 86_400_000 });
  events.set('unreceipted', { ...offer, _id: 'unreceipted', operationId: randomUUID() });
  events.set('other', {
    ...holders[0],
    _id: 'other',
    command: { ...holders[0].command, action: 'save: tokOtherx' },
  });
  current.set('journaled', current.get(holders[0]._id));
  current.set('unreceipted', 'holder handoff offered');
  const before = structuredClone([...events.values()]);
  const dryRun = () => f.lifeCall('scrubDryRun', scrub.dryRun, { cursor: null });
  const shape = dry => ({
    toScrub: dry.toScrub,
    withoutVersion: dry.withoutVersion,
    journalBound: dry.journalBound,
    isDone: dry.isDone,
  });
  // While the journal writer runs, a row old enough to be captured is counted and left alone.
  const flag = process.env.FORGE_JOURNAL_SEGMENTS;
  process.env.FORGE_JOURNAL_SEGMENTS = '1';
  try {
    assert.deepEqual(shape(await dryRun()), {
      toScrub: holders.length + 1,
      withoutVersion: 1,
      journalBound: 1,
      isDone: true,
    });
  } finally {
    if (flag === undefined) delete process.env.FORGE_JOURNAL_SEGMENTS;
    else process.env.FORGE_JOURNAL_SEGMENTS = flag;
  }
  // With it off (the default), nothing is captured, so every old row is rewritten.
  const all = holders.length + 2;
  assert.deepEqual(shape(await dryRun()), { toScrub: all, withoutVersion: 1, journalBound: 0, isDone: true });
  assert.deepEqual(structuredClone([...events.values()]), before, 'a dry run writes nothing');
  const applied = await f.lifeCall('scrubApply', scrub.apply, { cursor: null });
  assert.deepEqual(applied, { touched: all, isDone: true });
  for (const row of before) {
    const after = events.get(row._id);
    const strip = event => ({ ...event, command: { ...event.command, action: undefined } });
    assert.deepEqual(strip(after), strip(row), `${row._id}: only the action changes`);
    if (current.has(row._id))
      assert.equal(after.command.action, current.get(row._id), `${row._id}: what the writer records today`);
    else assert.equal(after.command.action, row.command.action, `${row._id} untouched`);
  }
  for (const leak of ['synthetic-writer', 'tokReasonx', 'tokOfferx', sessionA.name, sessionB.name])
    assert(![...events.values()].some(e => JSON.stringify(e.command).includes(leak)), `feed names ${leak}`);
  // A second run finds nothing, and a re-applied run keeps every kind (an entry without a version included).
  const scrubbed = structuredClone([...events.values()]);
  assert.equal((await dryRun()).toScrub, 0, 'a second run finds nothing');
  assert.deepEqual(await f.lifeCall('scrubApply', scrub.apply, { cursor: null }), {
    touched: 0,
    isDone: true,
  });
  assert.deepEqual(structuredClone([...events.values()]), scrubbed, 'a re-run writes nothing');
  // Old forms without a reason, without a version, or of an unknown kind keep no name either.
  assert.equal(scrub.scrubbedAction('holder resume: person → codex (v4)', null), 'holder resume: v4');
  assert.equal(scrub.scrubbedAction('holder handoff offered: @a/x → y', null), 'holder handoff offered');
  assert.equal(scrub.scrubbedAction('holder renamed: @a/x → y', null), 'holder change');
  assert.equal(scrub.scrubbedAction('holder takeover: v3', null), null, 'a current entry is left alone');
  for (const written of ['holder handoff offered', 'holder resume', 'holder change'])
    assert.equal(scrub.scrubbedAction(written, null), null, `${written} is already scrubbed`);
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
