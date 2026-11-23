// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Ferdinando Valsecchi
// Core-claim incident 43b51a5e, case 3 (dogfood 2026-11-19 17:54-18:24Z): a reservation holder
// parked on an older entry whose wait chain led back to a waiter on its own reservation.
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { moduleUrl } from './convex-module.mjs';
import { synthetic } from './hosted-landing-batches-fixture.mjs';
import { drive } from './queue-sim/overtake-drive.mjs';
import {
  LANE,
  cycleBase,
  reservationBudget,
  reservationCycle,
  reservationHanded,
} from './queue-sim/reservation-cycle.mjs';
const env = {
  ...synthetic,
  FORGE_HOSTED_CHECK_KEY_ID: 'SYNTHETIC',
  FORGE_HOSTED_CHECK_KEY_SYNTHETIC: 'synthetic-reservation-cycle',
};
const prior = Object.fromEntries(Object.keys(env).map(k => [k, process.env[k]]));
test.before(() => Object.assign(process.env, env));
test.after(() => {
  for (const [k, v] of Object.entries(prior)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});
const W = 0,
  X = 1,
  H = 2;

const holderGoesAhead = variant => async t => {
  const r = await reservationCycle(t, { variant });
  assert(!r.expired, 'no landing waited for the reservation to end');
  assert(r.landedAt[H] < r.landedAt[W], 'the reservation holds: H publishes on its passed check first');
  assert.equal(r.runs[H], 1, 'H lands on its own pass');
  assert(r.runs[W] <= 2, `W re-checks once, for H's change to its file (${r.runs[W]} runs)`);
  const followers = r.landedAt.slice(3);
  // With X's bounded step spent, followers keep strict order behind X (it holds order again), and
  // their receipts say so: `overtaken`, not a dependency (review 8c3f272f finding 3).
  if (variant === 'spent')
    for (const waits of r.orderWaits.slice(3))
      assert(
        waits.some(w => w.submissionId === r.ids[X] && w.held === 'overtaken' && w.footprints === 'disjoint'),
        JSON.stringify(waits),
      );
  if (variant === 'live')
    assert(
      Math.max(...followers) < r.landedAt[H] + LANE + 20,
      `followers reached main by tick ${followers} (H landed ${r.landedAt[H]})`,
    );
  for (const [i, runs] of r.runs.slice(3).entries())
    assert.equal(runs, 1, `follower ${i} ran its own check only`);
  assert(
    !r.orderWaits[H].some(w => w.submissionId === r.ids[X]),
    `H never waited for X: ${JSON.stringify(r.orderWaits[H])}`,
  );
  assert.equal(r.idle, 0, 'the drained queue has no idle work');
};
test(
  'incident replay 43b51a5e case 3 (live): the reservation holder goes ahead of a disjoint entry that waits for its own waiter',
  holderGoesAhead('live'),
);
test(
  'incident replay 43b51a5e case 3 (spent): the reservation holder goes ahead of a disjoint entry that waits for its own waiter',
  holderGoesAhead('spent'),
);

test('43b51a5e case 3 (overlap): a holder that may not go ahead of the entry waiting for its waiter ends its reservation', async t => {
  const r = await reservationCycle(t, { variant: 'overlap' });
  assert(!r.expired, 'the reservation ends at once, not at its time bound');
  assert(
    r.landedAt[W] < r.landedAt[X] && r.landedAt[X] < r.landedAt[H],
    `submission order once the reservation ends: ${r.landedAt.slice(0, 3)}`,
  );
  assert(
    r.orderWaits[H].some(w => w.submissionId === r.ids[X]),
    'H waited for X: it never goes ahead of a change linked to its own',
  );
  assert.equal(r.idle, 0, 'the drained queue has no idle work');
});

test('43b51a5e case 3 (budget): sealed parked entries ahead of the cycle entry spend none of the walk', async t => {
  const r = await reservationBudget(t);
  const h = r.ids.length - 1;
  assert(!r.expired, 'no landing waited for the reservation to end');
  assert(r.landedAt[h] < r.landedAt[0], 'the holder publishes first on its own pass');
  assert.equal(r.runs[h], 1);
});

test('43b51a5e case 3 (handed): the walk follows a handed link to the waiter on the reservation', async t => {
  const r = await reservationHanded(t);
  assert(!r.expired, 'no landing waited for the reservation to end');
  assert(r.landedAt[3] < r.landedAt[1], 'the holder publishes before the waiter on its reservation');
  assert.equal(r.runs[3], 1);
  assert(
    !r.orderWaits[3].some(w => w.submissionId === r.ids[2]),
    `R never parked on the handed entry: ${JSON.stringify(r.orderWaits[3])}`,
  );
});

/** Review 120fcc09 finding 3: only a solo holder that may overtake goes ahead of the entry in the
 * cycle. A combined group compares only one member's paths (a batch-mate may overlap the entry) and a
 * pipelined successor was checked on its predicted predecessor's head: both keep order, so the claim
 * ends the reservation instead (`cycle`). Probed on the live shape at the moment H is Ready with W
 * parked on it and X parked on W: the same production decision, with H's state as a combined member
 * and as a pipelined successor of X. */
test('43b51a5e case 3 (combined, pipelined): a holder that may not overtake ends its reservation instead', async t => {
  const { olderLandingAhead } = await import(moduleUrl('../convex/projectHostedLandingOrder.ts'));
  const { ticketState } = await import('./landing-ticket-fixture.mjs');
  const found = {};
  await reservationCycle(t, {
    variant: 'live',
    afterStep: async f => {
      if (found.solo) return;
      const rows = [...f.tables.projectHostedLandingRequests.values()];
      const [w, x, h] = f.entries.slice(0, 3).map(e => rows.find(r => r.submissionId === e.state.id));
      if (h.phase !== 'ready' || w.orderWait !== h.submissionId || x.orderWait !== w.submissionId) return;
      const attempt = [...f.tables.projectHostedLandingAttempts.values()].find(
        a => a.submissionId === h.submissionId,
      );
      const decide = (shape, batch) =>
        f.runAcceptance(
          `probe-${shape}`,
          async ctx => {
            const id = batch && (await ctx.db.insert('projectHostedLandingBatches', batch));
            const readonly = { db: { get: ctx.db.get.bind(ctx.db), query: ctx.db.query.bind(ctx.db) } };
            const state = ticketState(f, h);
            const ahead = await olderLandingAhead(
              readonly,
              h,
              shape === 'solo'
                ? state
                : { ...state, batchId: batch?.batchId ?? randomUUID(), batchSolo: shape !== 'combined' },
              Date.now(),
              [],
            );
            if (id) await ctx.db.delete(id);
            return ahead ? { id: ahead.row.submissionId, cycle: Boolean(ahead.cycle) } : null;
          },
          {},
        );
      const batchId = randomUUID(),
        composeOperationId = randomUUID();
      found.combined = await decide('combined');
      found.pipelined = await decide('pipelined', {
        projectId: f.projectId,
        batchId,
        composeOperationId,
        value: JSON.stringify({
          id: batchId,
          at: new Date().toISOString(),
          composeOperationId,
          checkOperationId: randomUUID(),
          phase: 'checking',
          predecessor: { submissionId: x.submissionId, head: '0'.repeat(64), receiptId: randomUUID() },
          members: [JSON.parse(attempt.value)],
          uploadIndex: 0,
        }),
      });
      found.solo = await decide('solo');
      found.x = x.submissionId;
    },
  });
  assert.equal(found.solo, null, 'a solo holder goes ahead of the disjoint entry in the cycle');
  for (const shape of ['combined', 'pipelined'])
    assert.deepEqual(found[shape], { id: found.x, cycle: true }, `${shape}: ${JSON.stringify(found[shape])}`);
});

/** Review 012bd638: a reservation holder with its own global-risk file (`ownGlobalRisk`). R holds a
 * live reservation and changes src/shared.ts and the database schema; X, older, also changes
 * src/shared.ts. Both pass and park on a slow strict-order head E. E lands: its exit wake drives X
 * and hands R to it; X parks on R's reservation and passes R on (baton). Without the reservation
 * exception R's own risk kept it from being driven: X and R waited for each other until the
 * reservation's time bound. Now R starts the re-check E's landing forces (its schema change never
 * carries) while the reservation still holds, and X waits for that one check. The replay has no
 * clock, so it asserts the order of events: R's re-check starts before any task at the bound runs. */
test('43b51a5e case 3 (own risk): a reservation holder with its own global risk is driven, not held', async t => {
  const strict = { overtaken: 'earlier:generation', unsealed: 'not-eligible' };
  const rowOf = (f, id) =>
    [...f.tables.projectHostedLandingRequests.values()].find(r => r.submissionId === id);
  let ids = [],
    until = Infinity,
    expired = false,
    handed = false,
    rechecked = false;
  const r = await drive(t, {
    memberPaths: ['src/e.ts', 'src/shared.ts', ['src/shared.ts', 'convex/schema.ts'], 'src/f0.ts'],
    baselineFiles: [
      ['src/shared.ts', cycleBase],
      ['convex/schema.ts', cycleBase],
    ],
    memberContents: [, cycleBase.replace('w = 0', 'w = 1'), cycleBase.replace('h = 0', 'h = 1')],
    ownerApprovalPaths: ['scripts/deploy*'],
    fixture: { admissionCheck: false, requestCheck: true, batching: false },
    duration: (i, nth) => (nth > 1 ? LANE : i === 0 ? 1000 : LANE + i),
    prepare(f, all) {
      ids = all;
      f.patch('projectHostedLandingRequests', rowOf(f, ids[0])._id, strict);
    },
    afterStep(f, _tick, task) {
      // R's reservation starts once X waits on the head (a superseded R kept its grant).
      const x = rowOf(f, ids[1]),
        holder = rowOf(f, ids[2]);
      if (until === Infinity && x.phase === 'ready' && x.orderWait === ids[0]) {
        until = Date.now() + 30 * 60_000;
        f.patch('projectHostedLandingRequests', holder._id, { reservedUntil: until });
      }
      if (task.scheduledTime >= until) expired = true;
      if (holder.orderWait === ids[1]) handed = true;
      if (handed && !expired && holder.phase !== 'ready' && holder.phase !== 'landed') rechecked = true;
    },
  });
  assert(handed, 'the head hands R on to X (the shape under test)');
  assert(rechecked, "R starts its forced re-check before the reservation's time bound");
  assert(r.runs[2] >= 2, `R re-checks for its schema change (${r.runs[2]} runs)`);
  assert.equal(r.idle, 0, 'the drained queue has no idle work');
});
