// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Ferdinando Valsecchi
// Agent withdraw (Issue 78a97771): a builder ends its own known failing landing by Lane, keeps the
// Lane, confirms the terminal cancellation and lands a fix on the same Lane with a new operation.
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { finishFixture, landingApi, code, compose } from './hosted-finish-fixture.mjs';
import { unprunedOverlapQuery } from './hosted-overlap-buckets-fixture.mjs';
import { moduleUrl } from './convex-module.mjs';
import { withdrawReceipt } from '../dist/hosted-agent-withdraw.js';
import { lowerVerb, parseVerbForm } from '../dist/agent-verbs.js';
import { synthetic } from './hosted-landing-batches-fixture.mjs';
import { syncRequestSchema } from '../dist/hosted-sync.js';

const prior = Object.fromEntries(Object.keys(synthetic).map(key => [key, process.env[key]]));
test.before(() => Object.assign(process.env, synthetic));
test.after(() => {
  for (const [key, value] of Object.entries(prior)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});
const withdrawApi = await import(moduleUrl('../convex/projectHostedLandingWithdraw.ts'));
const laneFinish = await import(moduleUrl('../convex/projectHostedLaneFinish.ts'));
const lifecycle = await import(moduleUrl('../convex/projectHostedLifecycle.ts'));

async function begin(f, overrides = {}, metadata) {
  const request = f.request(overrides),
    state = await f.enqueue(request, metadata);
  await f.drain();
  return { request, state };
}
const withdraw = (f, request, actor = 'owner') =>
  f
    .tx(
      'withdraw',
      withdrawApi.withdraw,
      {
        projectId: f.projectId,
        request: JSON.stringify({ operationId: randomUUID(), authorityEpoch: 1, ...request }),
      },
      actor,
    )
    .then(JSON.parse);
const live = (f, laneId) =>
  f.tx(
    'liveLaneFinish',
    {
      _handler: ctx => laneFinish.liveLaneFinish(ctx, { projectId: f.projectId, laneId, headWrittenAt: '' }),
    },
    {},
  );
const pins = lane => ({
  head: lane.head,
  version: lane.version,
  sourceVersion: lane.sourceVersion,
  lifecycleVersion: lane.lifecycleVersion,
});

test('land --withdraw lowers to the hosted withdraw action', () => {
  const [form] = parseVerbForm('land', ['--withdraw', '{}']);
  assert.equal(lowerVerb(form, true), 'withdraw');
});

test('withdraw by Lane cancels the live landing, keeps the Lane and fences the late check', async t => {
  const f = await finishFixture(t),
    { state } = await begin(f, {}, { heldMs: 12_750 }),
    lane = await f.readLane(f.lane.laneId),
    main = f.currentMain(),
    run = (await f.status(state.id)).attempt.check.runId;
  const active = await f.rawChecks.activate(run);
  assert.equal((await live(f, f.lane.laneId)).submissionId, state.id, 'the Lane holds a live finish');
  const operationId = randomUUID();
  const before = f.counts.length;
  const withdrawn = await withdraw(f, { operationId, laneId: f.lane.laneId });
  const calls = f.counts.slice(before).filter(c => c.name === 'withdraw');
  assert.equal(calls.length, 1, 'one mutation per withdraw');
  assert(calls[0].documents <= 80, `bounded metadata reads: ${calls[0].documents}`);
  t.diagnostic(JSON.stringify({ calls: calls.length, reads: calls[0].documents, writes: calls[0].writes }));
  assert.equal(state.timing.heldMs, 12_750);
  assert.equal(withdrawn.timing.heldMs, undefined, 'legacy withdraw replies omit the submit duration');
  assert.equal(withdrawn.id, state.id);
  assert.equal(withdrawn.phase, 'terminal-failed');
  assert.equal(withdrawn.error.code, 'LANDING_CANCELLED');
  assert.match(withdrawn.error.message, /Withdrawn by its agent/);
  // The check stops (no other landing needs it), its record stays, and a late pass is refused.
  assert.equal((await f.rawChecks.status(run)).status, 'cancelled');
  await assert.rejects(f.rawChecks.pass(active), code('CHECK_CANCELLED'));
  await f.drain();
  assert.deepEqual(await f.readLane(f.lane.laneId), lane, 'the Lane, its head and saves stay');
  assert.deepEqual(f.currentMain(), main, 'main never moves');
  assert.equal(f.tables.projectHostedAcceptances.size, 0);
  assert.equal(f.pending().length, 0, 'zero idle work after withdraw');
  // The freeze is lifted: the Lane has no live finish, so a save may move its head.
  assert.equal(await live(f, f.lane.laneId), null);
  // Retry-safe: a replay of the same operation returns the first receipt with no write.
  const writes = f.counts.length;
  const replay = await withdraw(f, { operationId, laneId: f.lane.laneId });
  assert.deepEqual(replay, withdrawn);
  assert(
    f.counts.slice(writes).every(c => c.writes === 0),
    'replay writes nothing',
  );
  // The canonical wait on the original landing operation is terminal at once.
  const observed = await f.current(state.id);
  assert.equal(observed.submission.phase, 'terminal-failed');
  assert.equal(observed.submission.error.code, 'LANDING_CANCELLED');
  // The canonical wait ends on observation.state !== 'pending' (hosted-agent-submission-wait.ts).
  assert.equal(observed.submission.observation.state, 'terminal-failed');
  const receipt = withdrawReceipt('/tmp/forge-root', f.lane.laneId, withdrawn);
  assert.equal(receipt.withdrawn, true);
  assert.deepEqual(receipt.confirm.next, {
    action: 'wait',
    operationIds: [state.operationId],
    until: 'acceptance',
  });
  assert.match(receipt.recovery, /LANDING_CANCELLED.*resubmission guidance from that wait/);
  // Re-land the same Lane with a new operation: a fresh submission checks and lands.
  const again = await begin(f);
  assert.notEqual(again.state.id, state.id);
  await f.passChecks();
  await f.drain();
  assert.equal((await f.current(again.state.id)).submission.phase, 'landed');
  assert.equal((await f.current(state.id)).submission.error.code, 'LANDING_CANCELLED', 'evidence kept');
});

test('withdraw without a live landing refuses with no operation written', async t => {
  const f = await finishFixture(t);
  const operations = f.tables.projectHostedOperations?.size ?? 0;
  await assert.rejects(withdraw(f, { laneId: f.lane.laneId }), code('LANDING_NOT_LIVE'));
  assert.equal(f.tables.projectHostedOperations?.size ?? 0, operations);
});

test('only the Lane author or the project owner can withdraw; readers cannot', async t => {
  const f = await finishFixture(t),
    { state } = await begin(f);
  f.insert('projectContributors', { projectId: f.projectId, contributor: 'writer' });
  f.insert('projectReaders', { projectId: f.projectId, reader: 'reader' });
  await assert.rejects(withdraw(f, { laneId: f.lane.laneId }, 'writer'), code('PROJECT_UNAVAILABLE'));
  await assert.rejects(withdraw(f, { laneId: f.lane.laneId }, 'reader'), code('PROJECT_UNAVAILABLE'));
  assert.equal((await f.current(state.id)).submission.phase, 'checking', 'refusals change nothing');
  const withdrawn = await withdraw(f, { laneId: f.lane.laneId });
  assert.equal(withdrawn.error.code, 'LANDING_CANCELLED');
});

test('an already accepted landing is never undone by a late withdraw', async t => {
  const f = await finishFixture(t),
    { state } = await begin(f);
  await f.passChecks();
  await f.drain();
  const main = f.currentMain();
  assert.equal((await f.current(state.id)).submission.phase, 'landed');
  await assert.rejects(withdraw(f, { laneId: f.lane.laneId }), error => {
    assert.equal(error.data?.code ?? error.code, 'LANDING_NOT_LIVE');
    const message = error.data?.message ?? error.message;
    assert.match(message, /already landed/);
    assert.match(message, /start --reopen/);
    assert.doesNotMatch(message, /land --save/);
    return true;
  });
  assert.deepEqual(f.currentMain(), main);
});

test('f081111a: a reopened Lane already on main refuses a new landing before dispatching a check', async t => {
  const f = await finishFixture(t, { admission: true });
  const { state } = await begin(f);
  await f.passChecks();
  await f.drain();
  assert.equal((await f.current(state.id)).submission.phase, 'landed');
  const lane = await f.readLane(f.lane.laneId);
  assert.equal(lane.state, 'completed');
  const reopened = JSON.parse(
    await f.tx('reopen', lifecycle.transition, {
      projectId: f.projectId,
      request: JSON.stringify({
        operationId: randomUUID(),
        authorityEpoch: 1,
        action: 'reopen',
        target: { kind: 'lane', laneId: lane.id, expected: pins(lane) },
      }),
    }),
  );
  const main = f.currentMain();
  const expectedMain = { head: main.head, receiptId: main.receipt.id };
  const selection = f.c.selection(
    [
      {
        ...f.lane,
        version: reopened.lane.version,
        lifecycleVersion: reopened.lane.lifecycleVersion,
      },
    ],
    [],
    { expectedMain },
  );
  const candidate = await compose(f.c, selection);
  assert.equal(candidate.result.head, main.head);
  const runs = f.tables.projectHostedCheckRuns.size;
  const landings = f.tables.projectHostedLandingRequests.size;
  await assert.rejects(
    f.enqueue(
      f.request({
        candidateId: candidate.id,
        expectedHead: candidate.result.head,
        expectedMain,
        finish: { composeOperationId: selection.request.operationId, after: null },
        message: 'A different message for the same source',
      }),
    ),
    code('NOTHING_TO_LAND'),
  );
  assert.equal(f.tables.projectHostedCheckRuns.size, runs);
  assert.equal(f.tables.projectHostedLandingRequests.size, landings);
  assert.equal(f.pending().length, 0);
  assert.deepEqual(f.currentMain(), main);
});

// Friction a0faf3a9: the landing moved to a Lane the owner did not name (a resolution Lane shares its
// origin's Intent). The queue names the Lane the landing composed, and withdraw by submissionId reaches it.
const queueView = await import(moduleUrl('../convex/projectHostedQueueView.ts'));
test('queue names the landing’s own Lane when its Intent has several, and withdraw by Lane says how to reach it', async t => {
  const f = await finishFixture(t);
  // A second Lane on the same Intent, created after the first, carries the live landing.
  const sibling = await f.c.lane(f.lane.state.object);
  const selection = f.c.selection([sibling]);
  const candidate = await compose(f.c, selection);
  const state = await f.enqueue(
    f.request({
      candidateId: candidate.id,
      expectedHead: candidate.result.head,
      finish: { composeOperationId: selection.request.operationId, after: null },
    }),
  );
  await f.drain();
  const view = JSON.parse(await f.tx('queueView', queueView.read, { projectId: f.projectId }));
  const entry = view.entries.find(item => item.submissionId === state.id);
  assert.equal(entry.laneId, sibling.laneId, 'the composed Lane, not the Intent’s first Lane');
  assert.equal(entry.moreLanes, true);
  // The Intent's first Lane has no live landing: the refusal names the submissionId route.
  await assert.rejects(withdraw(f, { laneId: f.lane.laneId }), error => {
    assert.equal(error.data?.code ?? error.code, 'LANDING_NOT_LIVE');
    assert.match(error.data?.message ?? error.message, /submissionId the queue lists/);
    return true;
  });
  assert.notEqual((await f.current(state.id)).submission.phase, 'terminal-failed');
});

// f7539ebb item 5 (D1, 2026-11-09): after a sync and a new land, the old queued entry stayed
// queued beside the new one (STALE 41 min) until the lead withdrew it by submissionId.
test('D1 replay: the Lane’s new head supersedes its queued sync-required entry in the same transaction', async t => {
  const f = await finishFixture(t);
  const state = await f.enqueue(f.request());
  const row = () =>
    [...f.tables.projectHostedLandingRequests.values()].find(item => item.submissionId === state.id);
  assert.equal(row().phase, 'queued');
  const advice = extra =>
    JSON.stringify({
      paths: ['docs/agents/workflow.md'],
      more: 0,
      at: new Date().toISOString(),
      next: 'advice',
      ...extra,
    });
  const supersede = () =>
    f.tx(
      'supersede',
      {
        _handler: ctx =>
          laneFinish.supersedeLaneFinishes(ctx, {
            projectId: f.projectId,
            laneId: f.lane.laneId,
            head: 'f'.repeat(64),
          }),
      },
      {},
    );
  // A speculative predecessor conflict asks nothing of the agent: it is never superseded.
  f.patch('projectHostedLandingRequests', row()._id, {
    wouldConflict: advice({
      code: 'COMPOSITION_CONFLICT',
      predecessor: {
        groupId: randomUUID(),
        submissionId: randomUUID(),
        head: 'a'.repeat(64),
        receiptId: randomUUID(),
      },
    }),
  });
  assert.deepEqual(await supersede(), []);
  assert.equal(row().phase, 'queued');
  // Main took its file: the save or sync that moves the Lane head ends the entry at once.
  f.patch('projectHostedLandingRequests', row()._id, {
    wouldConflict: advice({ landedSubmissionId: randomUUID(), laneId: f.lane.laneId }),
  });
  const before = f.counts.length;
  assert.deepEqual(await supersede(), [state.id]);
  const call = f.counts.slice(before).find(c => c.name === 'supersede');
  assert(call.documents <= 80, `bounded metadata reads: ${call.documents}`);
  t.diagnostic(JSON.stringify({ reads: call.documents, writes: call.writes }));
  const ended = (await f.current(state.id)).submission;
  assert.equal(ended.phase, 'terminal-failed');
  assert.equal(ended.observation.state, 'superseded');
  assert.equal(ended.error.code, 'LANDING_SUPERSEDED');
  // Nothing is left for the lead to withdraw by hand.
  assert.equal(
    await f.tx(
      'liveQueued',
      {
        _handler: ctx =>
          laneFinish.liveLaneFinish(
            ctx,
            { projectId: f.projectId, laneId: f.lane.laneId, headWrittenAt: '' },
            { queuedConflicts: true },
          ),
      },
      {},
    ),
    null,
  );
  await assert.rejects(withdraw(f, { laneId: f.lane.laneId }), code('LANDING_NOT_LIVE'));
  // Retry-safe: a second head move finds nothing and writes nothing.
  const again = f.counts.length;
  assert.deepEqual(await supersede(), []);
  assert(
    f.counts.slice(again).every(c => c.writes === 0),
    'replay writes nothing',
  );
});

// Stack on a pending head (D2, Issue 1eb42254): a Lane that collides with a peer whose landing is
// live stacks on the peer's head with `sync {stackOn}`; its landing then waits for the peer, and
// when the peer fails the Lane's next sync re-pins it to main (the existing detach path).
{
  const syncApi = await import(moduleUrl('../convex/projectHostedSync.ts'));
  const peersApi = await import(moduleUrl('../convex/projectHostedOverlapPeers.ts'));
  const overlapApi = await import(moduleUrl('../convex/projectHostedOverlaps.ts'));
  const overlapStore = await import(moduleUrl('../convex/projectHostedOverlapStore.ts'));

  const outcome = value => {
    const parsed = typeof value === 'string' ? JSON.parse(value) : value;
    if (parsed?.error) throw Object.assign(new Error(parsed.error.message), { code: parsed.error.code });
    return parsed;
  };
  const syncRequest = (f, lane, extra = {}) => {
    const main = f.currentMain();
    return {
      kind: 'sync',
      operationId: randomUUID(),
      authorityEpoch: 1,
      message: 'Stack on the peer',
      laneId: lane.laneId,
      expected: pins(lane),
      target: { kind: 'main', head: main.head, receiptId: main.receipt.id },
      ...extra,
    };
  };
  const prepare = (f, request) =>
    f
      .tx(
        'syncPrepare',
        syncApi.prepare,
        { projectId: f.projectId, request: JSON.stringify(request) },
        'owner',
      )
      .then(outcome);
  const landings = (f, laneIds) =>
    f.tx('peerLandings', { _handler: ctx => peersApi.peerLandings(ctx, f.projectId, laneIds) }, {});

  test('ordinary receipts offer the same saved peer on its first ready read', async t => {
    const at = '2026-01-01T12:00:00.000Z';
    t.mock.timers.enable({ apis: ['Date'], now: Date.parse(at) });
    const f = await finishFixture(t);
    const { c } = f;
    const path = 'selected.txt';
    const file = c.file(path, 'my change\n');
    const mine = await c.lane(c.state([c.baseFile, c.hidden, file], [c.baseline.sha256]));
    const peer = await f.readLane(f.lane.laneId);
    const own = await f.readLane(mine.laneId);
    await f.tx(
      'trackOverlap',
      {
        _handler: async ctx => {
          for (const [lane, blob] of [
            [peer, c.file(path, 'selected\n').blob],
            [own, file.blob],
          ])
            await overlapStore.trackHostedOverlapLane(
              ctx,
              f.projectId,
              { ...lane, at },
              {
                baseSequence: 0,
                changes: [{ path, before: null, after: { blob, mode: 'file' } }],
              },
            );
        },
      },
      {},
    );
    const unpruned = await unprunedOverlapQuery();
    const read = async () => {
      const args = { projectId: f.projectId, laneId: own.id };
      const reply = await f.tx('overlaps', overlapApi.read, args, 'owner');
      assert.equal(reply, await f.tx('overlaps', unpruned, args, 'owner'));
      return outcome(reply);
    };
    const { state } = await begin(f);
    const checking = await read();
    assert.equal(checking.stackOffer, undefined);
    await f.passChecks();
    for (let step = 0; (await f.status(state.id)).request.phase !== 'ready'; step++) {
      assert(step < 20, 'the synthetic passed check makes the peer ready');
      await f.execute();
    }
    const { stackOffer: offer, ...ready } = await read();
    assert.equal(offer?.peerLaneId, peer.id);
    assert.equal(offer.submissionId, state.id);
    assert.deepEqual(ready, checking, 'all other receipt fields are stable across the ready transition');
  });

  test('sync stackOn is part of the wire request and refuses mixed targets', () => {
    const laneId = randomUUID(),
      stackOn = randomUUID();
    const parsed = syncRequestSchema.parse({
      kind: 'sync',
      operationId: randomUUID(),
      authorityEpoch: 1,
      message: 'm',
      laneId,
      expected: { head: 'a'.repeat(64), version: 0, sourceVersion: 0, lifecycleVersion: 0 },
      target: { kind: 'main', head: 'b'.repeat(64), receiptId: 'main-0' },
      stackOn,
    });
    assert.equal(parsed.stackOn, stackOn);
  });

  test('stack on a peer with a live landing: pinned to its head and entry; refused without one', async t => {
    const f = await finishFixture(t);
    const peer = await f.readLane(f.lane.laneId);
    const mine = await f.c.lane(f.c.baseline);
    // No live landing yet: the peer is only editing, so there is nothing to stack on.
    await assert.rejects(prepare(f, syncRequest(f, mine, { stackOn: peer.id })), error =>
      /STACK_PEER_NOT_LANDING/.test(error.code ?? error.data?.code ?? error.message),
    );
    const editing = await landings(f, [peer.id, mine.laneId]);
    assert.equal(editing.get(peer.id), null);
    const state = await f.enqueue(f.request());
    await f.drain();
    const live = (await landings(f, [peer.id])).get(peer.id);
    assert.equal(live.submissionId, state.id);
    assert(['queued', 'checking', 'ready', 'composing'].includes(live.phase), live.phase);
    assert(Number.isInteger(live.etaMinutes) && live.etaMinutes >= 1, `ETA ${live.etaMinutes}`);
    const before = f.counts.length;
    const prepared = await prepare(f, syncRequest(f, mine, { stackOn: peer.id }));
    const call = f.counts.slice(before).find(count => count.name === 'syncPrepare');
    t.diagnostic(JSON.stringify({ documents: call?.documents, writes: call?.writes }));
    assert.equal(prepared.terminal, null, 'a real merge runs; never settled as up to date');
    assert.deepEqual(prepared.state.work.stackAfter, { laneId: peer.id, head: peer.head, entryId: state.id });
    assert.equal(prepared.state.work.right.object.sha256, peer.head, 'merges the peer head, not main');
    assert.equal(prepared.state.work.stackBase, undefined, 'the merge base is the common ancestor');
    // Self, a Candidate target and an already stacked Lane are refused before any operation.
    await assert.rejects(prepare(f, syncRequest(f, mine, { stackOn: mine.laneId })), error =>
      /BAD_ARGUMENT/.test(error.code ?? error.message),
    );
    const stacked = await f.c.lane(f.c.baseline, {
      stack: { laneId: peer.id, head: peer.head, entryId: state.id },
    });
    await assert.rejects(prepare(f, syncRequest(f, stacked, { stackOn: peer.id })), error =>
      /STACK_ALREADY/.test(error.code ?? error.message),
    );
  });

  test('the peer fails: the stacked Lane re-pins to main at its next sync and keeps only its own delta', async t => {
    const f = await finishFixture(t);
    const peer = await f.readLane(f.lane.laneId);
    const state = await f.enqueue(f.request());
    await f.drain();
    const child = await f.c.lane(f.c.baseline, {
      stack: { laneId: peer.id, head: peer.head, entryId: state.id },
    });
    // While the peer's landing is live, a sync follows the peer (restack), not main.
    const following = await prepare(f, syncRequest(f, child));
    assert.equal(following.state.work.stackAfter.detached, undefined);
    assert.equal(following.state.work.right.object.sha256, peer.head);
    // The peer's landing ends without landing: the next sync detaches onto main.
    await f
      .tx(
        'withdraw',
        withdrawApi.withdraw,
        {
          projectId: f.projectId,
          request: JSON.stringify({ operationId: randomUUID(), authorityEpoch: 1, laneId: peer.id }),
        },
        'owner',
      )
      .then(JSON.parse)
      .then(withdrawn => assert.equal(withdrawn.phase, 'terminal-failed'));
    await f.drain();
    const repinned = await prepare(f, syncRequest(f, child));
    assert.equal(repinned.state.work.stackAfter.detached, true);
    assert.equal(repinned.state.work.right.object.sha256, f.currentMain().head, 'onto main');
    assert.equal(repinned.state.work.stackBase.object.sha256, peer.head, "the peer's changes are taken out");
  });

  test('land of a Lane whose stack parent failed is refused before queueing, with the one re-pin command', async () => {
    const { refuseFailedStackParent } = await import('../dist/hosted-agent-finish.js');
    const laneId = randomUUID(),
      entryId = randomUUID();
    const session = phase => ({
      root: '/lane',
      query: async (name, args) => {
        assert.equal(name, 'projectHostedLanding:status');
        assert.deepEqual(args, { submissionId: entryId });
        return { request: { phase, error: phase === 'terminal-failed' ? { code: 'CHECK_FAILED' } : null } };
      },
    });
    for (const phase of ['queued', 'checking', 'ready', 'landed'])
      await refuseFailedStackParent(session(phase), laneId, entryId);
    await assert.rejects(refuseFailedStackParent(session('terminal-failed'), laneId, entryId), error => {
      assert.equal(error.code, 'STACK_PARENT_FAILED');
      assert.match(error.message, /CHECK_FAILED/);
      assert.deepEqual(error.recovery.next, { action: 'sync', laneId });
      assert.equal(
        error.recovery.command,
        `nforge agent '/lane' save --sync '${JSON.stringify({ laneId })}'`,
      );
      return true;
    });
    // An unreadable status never blocks: the landing's own dependency wait decides.
    await refuseFailedStackParent(
      { root: '/lane', query: async () => Promise.reject(new Error('down')) },
      laneId,
      entryId,
    );
  });
}
