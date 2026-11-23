// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Ferdinando Valsecchi
// L1 source-mutant scenarios (Item 687d1eda, review e7137e30 finding 4). Each one drives a reviewed
// chain hand-off through the real production code and returns the follower that is stranded when
// that code regresses. The parent test asserts L1 stays silent on current code; the mutant child
// (chain-mutant-runner.mjs, with that scenario's CHAIN_MUTANTS entry applied) asserts L1 names
// the stranded follower.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { batchesFixture } from '../hosted-landing-batches-fixture.mjs';
import { moduleUrl } from '../convex-module.mjs';
import { hostedLandingStall } from '../../dist/hosted-landing-stall.js';
import { inspectQueue } from './invariants.mjs';
import { ticketState } from '../landing-ticket-fixture.mjs';
const wake = await import(moduleUrl('../convex/projectHostedFinishWake.ts'));
const gate = await import(moduleUrl('../convex/projectHostedGate.ts'));
const store = await import(moduleUrl('../convex/projectHostedLandingStore.ts'));
const control = await import(moduleUrl('../convex/projectHostedLandingControl.ts'));

/** Per scenario, the source mutant that restores its reviewed bug exactly as it was before the fix.
 * Each scenario runs alone on its own mutant, so no other regression can be what strands it. */
export const CHAIN_MUTANTS = {
  // 4a: only a ready woken waiter got its stall alarm.
  queuedWaiterLosesWake: [
    {
      file: 'convex/projectHostedFinishWake.ts',
      find: "        (drive || early || (!finish && waiter.phase === 'ready')) && !waiter.alarm\n",
      replace: "        drive && !waiter.alarm && waiter.phase === 'ready'\n",
    },
  ],
  // 4a: followers were handed to a woken waiter nothing drives. Since review e49ffe91 F2 that
  // manual waiter's own stall alarm would release them 15 minutes later (a delay, not a strand;
  // the chain-liveness replay guards the handoff itself), so the mutant drops that alarm too, as
  // the code was when 4a was found.
  handoffToUndrivenWaiter: [
    {
      file: 'convex/projectHostedFinishWake.ts',
      find: '      if (waiter.orderLive && (drive || early)) next = waiter;',
      replace: '      if (waiter.orderLive) next = waiter;',
    },
    {
      file: 'convex/projectHostedFinishWake.ts',
      find: "        (drive || early || (!finish && waiter.phase === 'ready')) && !waiter.alarm\n",
      replace: '        (drive || early) && !waiter.alarm\n',
    },
  ],
  // 4b: a landing held for red main kept its reservation, and a held holder still reserved.
  reservationOnHeldHead: [
    { file: 'convex/projectHostedGate.ts', find: '    reservedUntil: undefined,\n', replace: '' },
    { file: 'convex/projectHostedLandingReservation.ts', find: '      holder.hold ||\n', replace: '' },
  ],
  // 4c: an admission kept its waiters parked after it stalled.
  stalledAdmission: [
    {
      file: 'convex/projectHostedLandingStore.ts',
      find: '    orderWaited: orderLive || reserving || admissionHolds ? row.orderWaited : undefined,',
      replace: '    orderWaited: orderLive || reserving || admitting ? row.orderWaited : undefined,',
    },
    {
      file: 'convex/projectHostedLandingStore.ts',
      find: '(!orderLive && !reserving && !admissionHolds)',
      replace: '(!orderLive && !reserving && !admitting)',
    },
  ],
};

const rows = f => [...f.tables.projectHostedLandingRequests.values()];
const row = (f, id) => rows(f).find(r => r.submissionId === id);
const finish = (f, id) => [...f.tables.projectHostedFinishes.values()].find(r => r.submissionId === id);
const owner = (f, run) =>
  [...f.tables.projectHostedLandingAttempts.values()].find(r => JSON.parse(r.value).check?.runId === run.id)
    ?.submissionId;
const work = f => f.pending().find(task => !/MainAudit:start|LandingStall/.test(task.name));
/** Main is red: the project's audit row records a red episode (red-main holds count as live). */
export function setMainRed(f, red = { since: new Date().toISOString(), head: 'red-head', runId: 'red-run' }) {
  const audit = [...f.tables.projectHostedMainAudits.values()].find(r => r.projectId === f.projectId);
  if (audit) f.patch('projectHostedMainAudits', audit._id, { red });
  else f.tables.projectHostedMainAudits.set('l1-audit', { _id: 'l1-audit', projectId: f.projectId, red });
}
const cancel = (f, id) => id && f.patch('_scheduled_functions', id, { state: { kind: 'canceled' } });

/** Three requests on one file: the oldest keeps checking while the two newer ones pass and park
 * behind it (the 5e3c3a3c shape). */
export async function parkedBehindHead(t) {
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
  return { f, head, followers };
}
const exitWake = (f, head) =>
  f.runAcceptance(
    'chainExitWake',
    async ctx => wake.wakeLandingOrderWaiters(ctx, await ctx.db.get(row(f, head)._id)),
    {},
  );

export const scenarios = {
  /** 4a: a queued waiter (a speculative-conflict member) takes the chain when the head exits,
   * and its one settle wake is lost (c329d191). Its alarm is then the chain's only driver. */
  async queuedWaiterLosesWake(t) {
    const { f, head, followers } = await parkedBehindHead(t);
    const [waiter, behind] = followers;
    f.patch('projectHostedLandingRequests', row(f, waiter)._id, {
      phase: 'queued',
      alarm: null,
      orderLive: true,
    });
    f.patch('projectHostedLandingRequests', row(f, behind)._id, { orderWait: head });
    await exitWake(f, head);
    assert.equal(row(f, behind).orderWait, waiter, 'the younger follower is handed to the woken waiter');
    f.patch('_scheduled_functions', finish(f, waiter).wake.taskId, {
      state: { kind: 'failed', error: 'synthetic OCC exhaustion (incident c329d191)' },
    });
    return { f, stranded: [behind] };
  },
  /** 4a: a checked manual request (no finish controller) is the oldest waiter when the head exits. */
  async handoffToUndrivenWaiter(t) {
    const { f, head, followers } = await parkedBehindHead(t);
    const [manual, behind] = followers;
    f.tables.projectHostedFinishes.delete(finish(f, manual)._id);
    f.patch('projectHostedLandingRequests', row(f, manual)._id, { orderLive: true, alarm: null });
    f.patch('projectHostedLandingRequests', row(f, behind)._id, { orderWait: head });
    await exitWake(f, head);
    return { f, stranded: [behind] };
  },
  /** 4b: the head, holding a reservation on the shared file, is held for red main; a later landing
   * of that file then claims through the real claim. */
  async reservationOnHeldHead(t) {
    const { f, head, followers } = await parkedBehindHead(t);
    const behind = followers[1];
    // A landing is held only while main is red (Fix D); the red audit keeps that hold itself live.
    setMainRed(f);
    f.patch('projectHostedLandingRequests', row(f, head)._id, { reservedUntil: Date.now() + 30 * 60_000 });
    await f.runAcceptance(
      'chainHoldMainRed',
      async ctx => {
        const current = await ctx.db.get(row(f, head)._id);
        await gate.holdMainRed(ctx, current, ticketState(f, current));
      },
      {},
    );
    await f.runAcceptance(
      'chainClaim',
      async ctx => {
        const current = await ctx.db.get(row(f, behind)._id);
        return control.claimReadyLanding(ctx, {
          projectId: current.projectId,
          channel: current.channel,
          submissionId: behind,
          attemptId: current.attemptId,
          owner: randomUUID(),
        });
      },
      {},
    );
    return { f, stranded: [behind] };
  },
  /** 4c: the admitting head stalls; its fired stall alarm is consumed by the stall write. */
  async stalledAdmission(t) {
    const { f, head, followers } = await parkedBehindHead(t);
    const runId = row(f, head).runId;
    f.patch('projectHostedLandingRequests', row(f, head)._id, {
      admission: { runId, status: 'checking', full: true },
    });
    const fired = row(f, head).alarm?.taskId;
    cancel(f, fired);
    await f.runAcceptance(
      'chainStalledAdmission',
      async ctx => {
        const current = await ctx.db.get(row(f, head)._id);
        const state = ticketState(f, current);
        const stall = hostedLandingStall(state, Date.now() + 20 * 60_000);
        await store.writeLanding(
          ctx,
          current,
          { ...state, version: state.version + 1, observation: { ...state.observation, stall } },
          current.runnable,
          false,
          fired,
        );
      },
      {},
    );
    return { f, stranded: followers };
  },
};
/** Every L1 issue on the queue, by submission. */
export async function allL1(f) {
  return (await inspectQueue(f)).filter(issue => issue.id === 'L1').map(issue => issue.submission);
}
/** L1 issues for the scenario's stranded followers, sorted. */
export async function strandedL1(f, stranded) {
  return (await inspectQueue(f))
    .filter(issue => issue.id === 'L1' && stranded.includes(issue.submission))
    .map(issue => issue.submission)
    .sort();
}
