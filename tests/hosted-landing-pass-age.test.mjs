// SPDX-License-Identifier: Apache-2.0
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { batchesFixture, synthetic } from './hosted-landing-batches-fixture.mjs';
import { patchTicketState, ticketState } from './landing-ticket-fixture.mjs';
import { moduleUrl } from './convex-module.mjs';
import { storageClock } from './storage-clock.mjs';
import { drive, overlapBase, overlapEdits } from './queue-sim/overtake-drive.mjs';
import { retireSpentHolder, retrySpentSingleton } from './queue-sim/pass-age-repin.mjs';

const { claimReadyLanding } = await import(moduleUrl('../convex/projectHostedLandingControl.ts'));
const { landingObservation } = await import('../dist/hosted-landing.js');
const environment = { ...synthetic, FORGE_HOSTED_CHECK_KEY_SYNTHETIC: 'synthetic-pass-age' };
const prior = Object.fromEntries(Object.keys(environment).map(name => [name, process.env[name]]));
test.before(() => Object.assign(process.env, environment));
test.after(() => {
  for (const [name, value] of Object.entries(prior)) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
});

const epoch = Date.UTC(2026, 10, 10, 12);
const iso = time => new Date(time).toISOString();
const holderPath = 'src/holder.ts';
const followerPath = 'src/follower.ts';
const rowOf = (f, id) =>
  [...f.tables.projectHostedLandingRequests.values()].find(row => row.submissionId === id);

/** Retained receipt shapes on the same clock. Enqueue real Candidates, then restore the claim
 * boundary from a historical wait: check phase, original pass, and current generation pin.
 * A returned lease is a claim result. The replay does not stand in for the publish fence. */
async function claim(
  t,
  {
    reuse = true,
    paths = [holderPath, followerPath],
    phase = 'checking',
    pass = 'early',
    spent = true,
    singleton = false,
    combinedHolder = false,
    predecessor = false,
    parked = false,
    urgent = false,
  } = {},
) {
  storageClock(t);
  const f = await batchesFixture(t, {
    count: 0,
    batching: false,
    requestCheck: true,
    fileCount: 2,
    memberPaths: paths,
    startAt: epoch,
  });
  const { autonomyPolicy: policy } = f.tables.hostedProjects.get(f.projectId);
  f.patch('hostedProjects', f.projectId, {
    autonomyPolicy: { ...policy, acceptance: { ...policy.acceptance, hostedCrossHeadReuse: reuse } },
  });
  await f.add(0);
  await f.add(1);
  const [olderId, followerId] = f.entries.map(entry => entry.state.id);
  const older = rowOf(f, olderId),
    follower = rowOf(f, followerId);
  const generation = epoch + 20;
  const olderState = ticketState(f, older);
  if (combinedHolder) {
    await f.add(2);
    const other = rowOf(f, f.entries[2].state.id);
    olderState.batchId = insertBatch(f, older, [older, other]);
  }
  patchTicketState(f, older, {
    ...olderState,
    phase,
    observation: landingObservation(phase === 'checking' ? 'checking' : 'queued'),
    timing: { submittedAt: olderState.at, composeStartedAt: iso(generation) },
  });
  f.patch('projectHostedLandingRequests', older._id, {
    phase,
    orderLive: true,
    ...(phase === 'queued' ? { runnable: false } : {}),
    unsealed: 'not-eligible',
    ...(spent ? { overtaken: 'older:run' } : {}),
    ...(parked ? { orderWait: randomUUID() } : {}),
    ...(urgent ? { priority: 'urgent' } : {}),
  });
  const followerState = ticketState(f, follower);
  if (singleton) followerState.batchId = insertBatch(f, follower, [follower], predecessor && olderId);
  patchTicketState(f, follower, {
    ...followerState,
    phase: 'ready',
    observation: landingObservation('queued'),
  });
  f.patch('projectHostedLandingRequests', follower._id, {
    phase: 'ready',
    orderLive: true,
    passedAt: pass === 'early' ? epoch + 10 : pass === 'late' ? epoch + 30 : 0,
  });
  f.advanceClock(40);
  const result = await f.transaction(
    'claim-pass-age',
    { _handler: claimReadyLanding },
    {
      projectId: f.projectId,
      channel: 'main',
      submissionId: followerId,
      attemptId: follower.attemptId,
      owner: 'pass-age-claim',
    },
  );
  return {
    claimed: result !== null && 'token' in result,
    orderWait: rowOf(f, followerId).orderWaits?.at(-1)?.held,
    footprints: rowOf(f, followerId).orderWaits?.at(-1)?.footprints,
    mark: rowOf(f, olderId).overtaken,
  };
}

function insertBatch(f, leader, rows, predecessor) {
  const batchId = randomUUID(),
    composeOperationId = randomUUID();
  const attempts = [...f.tables.projectHostedLandingAttempts.values()];
  const members = rows.map(row =>
    JSON.parse(attempts.find(attempt => attempt.attemptId === row.attemptId).value),
  );
  f.insert('projectHostedLandingBatches', {
    projectId: f.projectId,
    batchId,
    composeOperationId,
    value: JSON.stringify({
      id: batchId,
      at: iso(epoch),
      composeOperationId,
      checkOperationId: randomUUID(),
      phase: 'checking',
      leaderId: leader.submissionId,
      members,
      uploadIndex: 0,
      ...(predecessor
        ? { predecessor: { submissionId: predecessor, head: 'a'.repeat(64), receiptId: randomUUID() } }
        : {}),
    }),
  });
  return batchId;
}

test('9064e885: prior passes clear a spent hold and later passes keep the in-flight generation', async t => {
  for (const [name, settings, expected] of [
    ['earlier pass', {}, [true, undefined]],
    ['later pass', { pass: 'late' }, [false, 'overtaken']],
    ['held pass', { pass: 'held' }, [false, 'overtaken']],
    ['risk-only older side', { paths: ['convex/schema.ts', followerPath] }, [true, undefined]],
    ['overlap', { paths: [holderPath, holderPath] }, [false, 'overtaken']],
    ['urgent holder', { urgent: true }, [false, 'urgent']],
    ['Ready to publish', { phase: 'ready' }, [false, 'accepting']],
  ])
    await t.test(name, async cell => {
      const result = await claim(cell, settings);
      assert.deepEqual([result.claimed, result.orderWait], expected);
      assert.equal(result.mark, 'older:run');
    });
});

test('9064e885: a singleton passes outside its predecessor chain and keeps inherited overlap', async t => {
  for (const [name, settings, expected] of [
    ['d99ede51 outside chain', { singleton: true }, [true, undefined]],
    ['exact predecessor', { singleton: true, predecessor: true }, [false, 'combined']],
    [
      'inherited path',
      { singleton: true, paths: [holderPath, [holderPath, followerPath]] },
      [false, 'combined'],
    ],
    [
      'live multi-member holder',
      { singleton: true, combinedHolder: true, spent: false },
      [false, 'combined'],
    ],
  ])
    await t.test(name, async cell => {
      const result = await claim(cell, settings);
      assert.deepEqual([result.claimed, result.orderWait], expected);
    });
});

async function publishSingleton(t) {
  storageClock(t);
  const f = await batchesFixture(t, {
    count: 0,
    fileCount: 2,
    batchMaxSize: 1,
    memberPaths: ['src/outside.ts', 'src/predecessor.ts', 'src/singleton.ts'],
    startAt: epoch,
  });
  await f.add(0, { request: { agent: false } });
  await f.drain();
  const outsideId = f.entries[0].state.id;
  const outsideRun = f.runs()[0];
  // The older check is live outside the predicted train, as in the retained wait.
  const [queue] = f.tables.projectHostedLandingQueues.values();
  f.patch('projectHostedLandingQueues', queue._id, { train: [] });
  await f.add(1);
  await f.drain();
  const predecessorRun = f.runs().at(-1);
  await f.add(2);
  await f.drain();
  const [outside, predecessor, follower] = f.entries.map(entry => entry.state.id);
  const state = ticketState(f, rowOf(f, follower));
  const batchRow = [...f.tables.projectHostedLandingBatches.values()].find(
    row => row.batchId === state.batchId,
  );
  const batch = JSON.parse(batchRow.value);
  const followerRun = f.runs().find(run => run.id === batch.runId);
  assert.equal(batch.members.length, 1);
  assert.equal(batch.predecessor.submissionId, predecessor);
  await f.rawChecks.pass(await f.rawChecks.activate(predecessorRun.id));
  await f.drain();
  assert.equal(rowOf(f, predecessor).phase, 'landed');
  assert.equal(rowOf(f, outside).phase, 'checking');
  await f.rawChecks.pass(await f.rawChecks.activate(followerRun.id));
  const passedAt = f.now();
  await f.drain();
  assert.equal(rowOf(f, follower).phase, 'landed');
  const passToLandMs = f.now() - passedAt;
  assert(passToLandMs < 600_000);
  assert.equal(rowOf(f, outsideId).runId, outsideRun.id);
  assert.equal(f.runs().filter(run => run.gate?.mode !== 'audit').length, 3);
  t.diagnostic(JSON.stringify({ passToLandMs, starts: 3 }));
}

test('9064e885: reuse off keeps spent, singleton and parked Ready decisions', async t => {
  for (const [name, settings, expected] of [
    ['spent generation', {}, 'overtaken'],
    ['one member group', { singleton: true }, 'combined'],
    ['parked Ready', { phase: 'ready', parked: true, spent: false }, 'no-proof'],
  ])
    await t.test(name, async cell => {
      const result = await claim(cell, { reuse: false, ...settings });
      assert.equal(result.claimed, false);
      assert.equal(result.orderWait, expected);
    });
});

test('9064e885: overlapping receipt edges retain their recorded order fence', async t => {
  for (const [receipt, shapes] of [
    ['14dfb14b', [['checking', false, 'dependent']]],
    [
      'f4d1a18d',
      [
        ['checking', false, 'dependent'],
        ['ready', false, 'accepting'],
      ],
    ],
    ['9a014f2f', [['checking', false, 'dependent']]],
    [
      'b4eb387c',
      [
        ['checking', true, 'overtaken'],
        ['ready', false, 'accepting'],
      ],
    ],
    ['c4863648', [['queued', false, 'composing']]],
    ['5a298835', [['checking', false, 'dependent']]],
    [
      'f2808028',
      [
        ['ready', false, 'accepting'],
        ['checking', false, 'dependent'],
      ],
    ],
  ])
    await t.test(receipt, async cell => {
      for (const [phase, spent, held] of shapes)
        await cell.test(held, async edge => {
          const result = await claim(edge, { phase, spent, paths: [holderPath, holderPath] });
          assert.deepEqual([result.claimed, result.orderWait, result.footprints], [false, held, 'overlap']);
        });
    });
});

async function parkedBeforeRepin(t, { spent, checkWall = 600, initialWait = 350, laterPasses = [] }) {
  const [blocker, holder, follower] = [0, 1, 2];
  const holdFile = 'src/shared.ts';
  const followerPass = 250;
  const durations = [followerPass + initialWait, 150, followerPass, ...laterPasses];
  let passedAt;
  const result = await drive(t, {
    memberPaths: [
      holdFile,
      holdFile,
      followerPath,
      ...laterPasses.map((_, index) => `src/later-${index}.ts`),
    ],
    memberContents: overlapEdits,
    baselineFiles: [[holdFile, overlapBase]],
    fixture: { admissionCheck: false, requestCheck: true, batching: false, startAt: epoch },
    duration: (index, nth) => (nth === 1 ? durations[index] : checkWall),
    prepare(f, ids) {
      f.patch('projectHostedLandingRequests', rowOf(f, ids[holder])._id, {
        unsealed: 'not-eligible',
        ...(spent ? { overtaken: 'earlier:run' } : {}),
      });
    },
    afterStep(f, tick) {
      const row = rowOf(f, f.entries[follower].state.id);
      if (row.passedAt > 0) passedAt ??= tick;
      f.advanceClock(10);
    },
  });
  assert(passedAt !== undefined);
  assert(result.landedAt[follower] < result.landedAt[spent ? holder : blocker]);
  const passToLand = result.landedAt[follower] - passedAt;
  assert(passToLand < checkWall, JSON.stringify({ checkWall, passToLand }));
  assert.deepEqual(result.runs, [1, 2, 1, ...laterPasses.map(() => 1)]);
  assert.equal(result.idle, 0);
  t.diagnostic(
    JSON.stringify({
      passToLand,
      starts: result.runs,
      transactions: result.calls,
      bytes: result.readBytes + result.writeBytes,
    }),
  );
}

test('incident 9064e885: passed independent followers publish within one check of their pass', async t => {
  await t.test('a stale-check retirement wakes the early pass at the re-pin', retireSpentHolder);
  await t.test(
    'd99ede51 checks a singleton on its predecessor and publishes ahead of the outside check',
    publishSingleton,
  );
  await t.test('1fa13fe5 publishes while a Ready holder waits on an overlap', cell =>
    parkedBeforeRepin(cell, { spent: false }),
  );
  // The first documented spent waits are retained. Subsequent unstamped links
  // in these receipts use the same synthetic overlapping mover and re-pin.
  for (const [receipt, initialWait] of [
    ['f5f408ff', 417],
    ['a517dc25', 169],
    ['5034ac20', 481],
    ['45cf797e', 148],
  ])
    await t.test(receipt, cell => parkedBeforeRepin(cell, { spent: true, initialWait }));
});

test('9064e885: the singleton replacement can bind before the older pass reclaims', retrySpentSingleton);

test('9064e885: steady disjoint passes do not start another replacement check on a spent holder', t =>
  parkedBeforeRepin(t, { spent: true, laterPasses: [320, 390, 465, 520, 570, 645, 710] }));
