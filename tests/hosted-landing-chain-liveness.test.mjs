// SPDX-License-Identifier: Apache-2.0
// Item 687d1eda, review e7137e30 finding 4: parked chains that end at an entry nothing drives.
// A parked waiter holds no timer (idle costs nothing, L1 option B), so the entry its chain ends at
// must own progress. Each replay shapes the stored rows of the reviewed case on a real queue and
// runs the production function that hands the chain on; before its fix each one strands the chain.
import test from 'node:test';
import assert from 'node:assert/strict';
import { batchesFixture, synthetic } from './hosted-landing-batches-fixture.mjs';
import { moduleUrl } from './convex-module.mjs';
import { armed, pendingClaim } from './queue-sim/invariants.mjs';
import { hostedLandingStall } from '../dist/hosted-landing-stall.js';
const wake = await import(moduleUrl('../convex/projectHostedFinishWake.ts'));
const gate = await import(moduleUrl('../convex/projectHostedGate.ts'));
const reservation = await import(moduleUrl('../convex/projectHostedLandingReservation.ts'));
const store = await import(moduleUrl('../convex/projectHostedLandingStore.ts'));
const prior = Object.fromEntries(Object.keys(synthetic).map(k => [k, process.env[k]]));
test.before(() => Object.assign(process.env, synthetic));
test.after(() => {
  for (const [k, v] of Object.entries(prior)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});
const rows = f => [...f.tables.projectHostedLandingRequests.values()];
const row = (f, id) => rows(f).find(r => r.submissionId === id);
const owner = (f, run) =>
  [...f.tables.projectHostedLandingAttempts.values()].find(r => JSON.parse(r.value).check?.runId === run.id)
    ?.submissionId;
const work = f => f.pending().find(task => !/MainAudit:start|LandingStall/.test(task.name));

/** Three requests on one file; the oldest keeps checking while the two newer ones pass and park
 * behind it (the 5e3c3a3c shape). Returns their ids, oldest first. */
async function parkedBehindHead(t) {
  const f = await batchesFixture(t, {
    count: 3,
    fileCount: 2,
    batching: false,
    requestCheck: true,
    memberPaths: ['src/shared.ts', 'src/shared.ts', 'src/shared.ts'],
    baselineFiles: [
      ['src/shared.ts', 'export const a = 0;\n// gap\nexport const b = 0;\n// gap\nexport const c = 0;\n'],
    ],
    memberContents: [
      'export const a = 1;\n// gap\nexport const b = 0;\n// gap\nexport const c = 0;\n',
      'export const a = 0;\n// gap\nexport const b = 1;\n// gap\nexport const c = 0;\n',
      'export const a = 0;\n// gap\nexport const b = 0;\n// gap\nexport const c = 1;\n',
    ],
  });
  f.rawChecks.setPlanSelection(JSON.stringify({ scope: 'full', tests: [] }));
  const [head, ...followers] = f.entries.map(e => e.state.id);
  for (let tick = 0; tick < 250; tick++) {
    for (const run of f.runs().filter(r => r.status === 'queued' && r.gate?.mode !== 'audit'))
      if (owner(f, run) !== head) await f.rawChecks.pass(await f.rawChecks.activate(run.id));
    if (followers.every(id => row(f, id)?.orderWait)) break;
    const task = work(f);
    if (!task) break;
    await f.execute(task);
  }
  for (const id of followers) assert(row(f, id).orderWait, `${id} parked`);
  assert(row(f, head).orderWaited, 'the head records that entries wait on it');
  return { f, head, followers };
}
/** The head leaves the order (its exit wake), run in one production mutation. */
const exitWake = (f, head) =>
  f.runAcceptance(
    'chainExitWake',
    async ctx => wake.wakeLandingOrderWaiters(ctx, await ctx.db.get(row(f, head)._id)),
    {},
  );

test('4a replay: a woken queued waiter that takes the chain gets its stall alarm', async t => {
  // A speculative-conflict member (deferSpeculativeConflict) is parked while still queued, with
  // its alarm relinquished to the predecessor. When the predecessor exits, its one settle wake
  // drives it; that wake can be lost (c329d191), so the alarm must be armed as for a ready waiter.
  const { f, head, followers } = await parkedBehindHead(t);
  const [waiter, behind] = followers;
  f.patch('projectHostedLandingRequests', row(f, waiter)._id, {
    phase: 'queued',
    alarm: null,
    orderLive: true,
  });
  f.patch('projectHostedLandingRequests', row(f, behind)._id, { orderWait: head });
  await exitWake(f, head);
  assert.equal(row(f, waiter).orderWait, undefined);
  assert(pendingClaim(f, waiter), 'the exit wake drives the waiter');
  assert.equal(row(f, behind).orderWait, waiter, 'and hands the younger follower to it');
  assert(armed(f, row(f, waiter).alarm?.taskId), 'the waiter that now heads the chain has its stall alarm');
});

test('4a replay: an exit wake never hands followers to a waiter nothing drives', async t => {
  // A checked manual request (no finish controller) parked on the head: the exit wake can only
  // clear its wait. Handing younger finish-driven followers to it left them parked on a row
  // nothing writes again; they must be driven themselves.
  const { f, head, followers } = await parkedBehindHead(t);
  const [manual, behind] = followers;
  const finish = [...f.tables.projectHostedFinishes.values()].find(r => r.submissionId === manual);
  f.tables.projectHostedFinishes.delete(finish._id);
  f.patch('projectHostedLandingRequests', row(f, manual)._id, { orderLive: true, alarm: null });
  f.patch('projectHostedLandingRequests', row(f, behind)._id, { orderWait: head });
  await exitWake(f, head);
  assert.equal(row(f, manual).orderWait, undefined);
  assert.equal(row(f, behind).orderWait, undefined, 'not parked on the undriven manual request');
  assert(pendingClaim(f, behind), 'the next finish-driven follower is driven instead');
});

test('4b replay: a landing held for red main gives up its reservation', async t => {
  // holdMainRed cancels the entry's alarm and wake. A reservation it kept would park later
  // landings of the same files (the fix that turns main green among them) on that dead row.
  const { f, head } = await parkedBehindHead(t);
  const until = Date.now() + 30 * 60_000;
  f.patch('projectHostedLandingRequests', row(f, head)._id, { reservedUntil: until });
  await f.runAcceptance(
    'chainHoldMainRed',
    async ctx => {
      const current = await ctx.db.get(row(f, head)._id);
      await gate.holdMainRed(ctx, current, JSON.parse(current.value));
    },
    {},
  );
  assert.equal(row(f, head).hold, 'main-red');
  assert.equal(row(f, head).reservedUntil, undefined, 'the held entry reserves nothing');
});

test('4b replay: a held reservation holder parks no later landing', async t => {
  const { f, head, followers } = await parkedBehindHead(t);
  const waiter = followers[1];
  f.patch('projectHostedLandingRequests', row(f, head)._id, { reservedUntil: Date.now() + 30 * 60_000 });
  const ahead = () =>
    f.runAcceptance(
      'chainReservationAhead',
      async ctx => {
        const current = await ctx.db.get(row(f, waiter)._id);
        return (await reservation.reservationAhead(ctx, current, JSON.parse(current.value), Date.now()))?.row
          .submissionId;
      },
      {},
    );
  assert.equal(await ahead(), head, 'a live reservation on the same file holds the later landing');
  f.patch('projectHostedLandingRequests', row(f, head)._id, { hold: 'main-red' });
  assert.equal(await ahead(), undefined, 'a holder held for red main owns no progress and holds nothing');
});

test('4c replay: an admission that stalls releases the landings parked on it', async t => {
  // A pipelined successor parks on a full admission with no timer (until: null). When the
  // admitting entry stalls it gives up its place (holdsLandingOrder), so its exit wake must run
  // in that same write instead of keeping the followers until the admission run itself ends.
  const { f, head, followers } = await parkedBehindHead(t);
  const runId = row(f, head).runId;
  assert(runId, 'the head is checking its run');
  f.patch('projectHostedLandingRequests', row(f, head)._id, {
    admission: { runId, status: 'checking', full: true },
  });
  await f.runAcceptance(
    'chainStalledAdmission',
    async ctx => {
      const current = await ctx.db.get(row(f, head)._id);
      const state = JSON.parse(current.value);
      const stall = hostedLandingStall(state, Date.now() + 20 * 60_000);
      assert(stall, 'the replay stalls the admitting head');
      await store.writeLanding(
        ctx,
        current,
        { ...state, version: state.version + 1, observation: { ...state.observation, stall } },
        current.runnable,
        false,
      );
    },
    {},
  );
  assert(row(f, head).admitting, 'the admission run is still in flight');
  for (const id of followers)
    assert(
      row(f, id).orderWait !== head || pendingClaim(f, id),
      `${id} is released from the stalled admission`,
    );
  assert(pendingClaim(f, followers[0]), 'the oldest follower is driven');
});
