// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Ferdinando Valsecchi
// Item 43b51a5e, review 01a38b28 finding 1: a normal Ready entry's claim gave way to any urgent Ready
// entry, even one parked on it. The urgent one waited for the normal one to move, the normal one
// re-polled every 250 ms, and neither landed (stuck queue, ~4 mutations/s).
import test from 'node:test';
import assert from 'node:assert/strict';
import { synthetic } from './hosted-landing-batches-fixture.mjs';
import { patchTicketState, ticketState } from './landing-ticket-fixture.mjs';
import { drive } from './queue-sim/overtake-drive.mjs';
const env = {
  ...synthetic,
  FORGE_HOSTED_CHECK_KEY_ID: 'SYNTHETIC',
  FORGE_HOSTED_CHECK_KEY_SYNTHETIC: 'synthetic-urgent-yield',
};
const prior = Object.fromEntries(Object.keys(env).map(k => [k, process.env[k]]));
test.before(() => Object.assign(process.env, env));
test.after(() => {
  for (const [k, v] of Object.entries(prior)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});
const row = (f, id) => [...f.tables.projectHostedLandingRequests.values()].find(r => r.submissionId === id);
const queueShape = { admissionCheck: false, requestCheck: true, batching: false };
const LANE = 150,
  SLOW = 1000,
  BOUND = 4 * SLOW;
// One file, three edits on lines far apart: footprints overlap by path, the merges are clean.
const base = ['a', 'b', 'c'].map(n => `export const ${n} = 0;\n// gap\n// gap\n// gap\n`).join('');
const edit = n => base.replace(`export const ${n} = 0;`, `export const ${n} = 1;`);

/** H (slow), Q (normal) and F (younger), all on `src/h.ts`. `urgentH`: H and F are urgent, so H's
 * exit wake drives Q, the oldest waiter, and hands F to it. Otherwise F is made urgent once it has
 * parked (prioritize patches the row and wakes nothing), and H's exit wake hands it to Q the same way. */
async function urgentBehindNormal(t, { urgentH }) {
  let promoted = false;
  const r = await drive(t, {
    memberPaths: ['src/h.ts', 'src/h.ts', 'src/h.ts'],
    baselineFiles: [['src/h.ts', base]],
    memberContents: [edit('a'), edit('b'), edit('c')],
    ownerApprovalPaths: ['scripts/deploy*'],
    fixture: queueShape,
    duration: i => (i === 0 ? SLOW : LANE + i),
    prepare(f, [h, , last]) {
      if (urgentH)
        for (const id of [h, last])
          f.patch('projectHostedLandingRequests', row(f, id)._id, { priority: 'urgent' });
    },
    afterStep(f, tick) {
      const [, , last] = f.entries.map(e => e.state.id);
      const F = row(f, last);
      if (!urgentH && !promoted && F.phase === 'ready' && F.orderWait) {
        promoted = true;
        f.patch('projectHostedLandingRequests', F._id, { priority: 'urgent' });
      }
      assert(
        tick < BOUND,
        `stuck at tick ${tick}: ${JSON.stringify(
          f.entries.map(e => row(f, e.state.id)).map(r => [r.phase, r.priority, r.orderWait?.slice(0, 8)]),
        )}`,
      );
    },
  });
  if (!urgentH) assert(promoted, 'F was promoted while parked');
  return r;
}

test('43b51a5e 01a38b28 F1: a normal entry never gives way to an urgent one parked on it (urgent holder lands, or promoted while parked)', async t => {
  // Urgent H: H lands first, then Q and F take main within one check of it.
  const handed = await urgentBehindNormal(t, { urgentH: true });
  const [h, q, f] = handed.landedAt;
  assert(f > h && q > h && Math.max(q, f) < h + SLOW, `urgent H: Q and F follow H (${[h, q, f]})`);
  assert.equal(handed.idle, 0, 'the drained queue has no idle work');
  // Promoted F: it skips the normal H it waits for and takes main during H's check.
  const promoted = await urgentBehindNormal(t, { urgentH: false });
  const [ph, pq, pf] = promoted.landedAt;
  assert(pf < SLOW + LANE && pf < ph && pf < pq, `promoted F lands first (${[ph, pq, pf]})`);
  assert.equal(promoted.idle, 0, 'the drained queue has no idle work');
});

// Same rule, other half: two urgent landings, the younger parked on the older one's check. A normal
// Ready entry older than both gave way to the parked one and re-polled every 250 ms through the whole
// check; it can take main now (its file is its own, so neither urgent pass goes stale).
test('43b51a5e 01a38b28 F1: a normal entry does not wait out a check for an urgent one parked on another entry', async t => {
  const r = await drive(t, {
    memberPaths: ['src/q.ts', 'src/h.ts', 'src/h.ts'],
    baselineFiles: [['src/h.ts', base]],
    memberContents: [, edit('a'), edit('b')],
    ownerApprovalPaths: ['scripts/deploy*'],
    fixture: queueShape,
    duration: i => (i === 0 ? 2 * LANE : i === 1 ? SLOW : LANE),
    prepare(f, [, u0, u]) {
      for (const id of [u0, u])
        f.patch('projectHostedLandingRequests', row(f, id)._id, { priority: 'urgent' });
    },
  });
  const [q, u0, u] = r.landedAt;
  assert(q < SLOW && u0 < u, `Q takes main during U0's check (${[q, u0, u]})`);
  assert.equal(r.idle, 0, 'the drained queue has no idle work');
});

async function urgentHandoff(t, { manual = false } = {}) {
  let sawHandoff = false;
  let pauseNext = false;
  let detached;
  const r = await drive(t, {
    memberPaths: ['src/peer.ts', 'src/holder.ts', 'src/next.ts', 'src/urgent.ts'],
    ownerApprovalPaths: ['scripts/deploy*'],
    fixture: queueShape,
    duration: i => (i < 2 ? SLOW + (i === 0 ? LANE : 0) : LANE),
    prepare(f, [, holder, , urgent]) {
      for (const id of [holder, urgent])
        f.patch('projectHostedLandingRequests', row(f, id)._id, { priority: 'urgent' });
    },
    pick(tasks, [, , next]) {
      // The unrelated peer gets a claim before the holder's scheduled handoff recipient.
      return pauseNext ? (tasks.find(task => task.args[0]?.submissionId !== next) ?? null) : tasks[0];
    },
    afterStep(f, tick) {
      const [peer, , next, urgent] = f.entries.map(entry => entry.state.id);
      const waiter = row(f, urgent);
      if (!sawHandoff && waiter.orderWaitHanded === next) {
        sawHandoff = true;
        pauseNext = true;
        if (manual) {
          // A manually accepted request can park and be handed on without a finish controller.
          const finishes = f.tables.projectHostedFinishes;
          const finish = [...finishes.values()].find(entry => entry.submissionId === urgent);
          const state = ticketState(f, waiter);
          detached = { finish, request: state.request.finish };
          finishes.delete(finish._id);
          delete state.request.finish;
          patchTicketState(f, waiter, state);
        }
      }
      if (pauseNext && (row(f, peer).phase === 'landed' || waiter.phase === 'landed')) {
        pauseNext = false;
        if (detached) {
          assert.equal(waiter.orderWaitHanded, next, 'the manual waiter keeps its handoff');
          // Restore the simulation's finish driver so the replay can drain after the race.
          const { finish, request } = detached;
          f.tables.projectHostedFinishes.set(finish._id, finish);
          const state = ticketState(f, waiter);
          state.request.finish = request;
          patchTicketState(f, waiter, state);
        }
      }
      assert(tick < BOUND, 'an urgent handoff must not strand the queue');
    },
  });
  assert(sawHandoff, 'the holder handed the urgent waiter to next');
  assert.equal(r.idle, 0, 'the drained queue has no idle work');
  return r.landedAt;
}

test('43b51a5e 57ca898f F1: an urgent waiter handed to a normal entry keeps its place', async t => {
  const landedAt = await urgentHandoff(t);
  const [peer, holder, next, urgent] = landedAt;
  assert(holder < urgent && urgent < peer && urgent < next, `urgent follows holder (${landedAt})`);
});

test('43b51a5e 57ca898f F1: a manual urgent handoff lets an unrelated normal claim proceed', async t => {
  const landedAt = await urgentHandoff(t, { manual: true });
  const [peer, holder, , urgent] = landedAt;
  assert(holder < peer && peer < urgent, `the normal claim proceeds after the holder (${landedAt})`);
});
