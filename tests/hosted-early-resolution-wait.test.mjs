// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { conflictTrio, resolveEarly, drainReady } from './early-resolution-replay.mjs';
import { synthetic } from './hosted-landing-batches-fixture.mjs';
import { compose } from './hosted-finish-fixture.mjs';
import { moduleUrl } from './convex-module.mjs';
const store = await import(moduleUrl('../convex/projectHostedLandingStore.ts'));
const stall = await import(moduleUrl('../convex/projectHostedLandingStall.ts'));
const wake = await import(moduleUrl('../convex/projectHostedLandingWake.ts'));
const finishWake = await import(moduleUrl('../convex/projectHostedFinishWake.ts'));
const prior = Object.fromEntries(Object.keys(synthetic).map(k => [k, process.env[k]]));
test.before(() => Object.assign(process.env, synthetic));
test.after(() => {
  for (const [k, v] of Object.entries(prior)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

test('8c9b84fc: an early resolution behind a failed shared-check solo tail is claimed once per event and has a live owner', async t => {
  const trio = await conflictTrio(t);
  const { f } = trio;
  const resolved = await resolveEarly(trio, { submit: false });

  await f.add(3);
  await drainReady(f);
  const tailRun = f.runs().at(-1);
  await f.fail(tailRun.id);
  await drainReady(f);
  const selection = f.c.selection([resolved.lane]);
  selection.request.expectedMain = { head: f.currentMain().head, receiptId: f.currentMain().receipt.id };
  const candidate = await compose(f.c, selection);
  const state = await f.enqueue(
    f.request({
      candidateId: candidate.id,
      expectedHead: candidate.result.head,
      expectedMain: selection.request.expectedMain,
      governanceVersion: 1,
      finish: { composeOperationId: selection.request.operationId, after: null },
    }),
  );
  for (let n = 0; n < 60; n++) {
    const task = f.pending().find(task => !/LandingStall|CheckLease:expire/.test(task.name));
    if (!task) break;
    await f.execute(task);
  }
  const parked = [...f.tables.projectHostedLandingRequests.values()].find(r => r.submissionId === state.id);
  assert.equal(parked.runnable, false, 'a solo fallback tail must not cause a zero-delay claim/release loop');
  assert(parked.orderWait, 'the waiting resolution is bound to a train event');
  const owner = await f.transaction(
    'waiting-resolution-owner',
    {
      _handler: async ctx => {
        const current = await store.loadLanding(ctx, { projectId: f.projectId, submissionId: state.id });
        return stall.liveOwner(
          ctx,
          { projectId: f.projectId, submissionId: state.id },
          current.row,
          current.state,
        );
      },
    },
    {},
  );
  assert(owner, 'every live submission, including the parked early entry, has an owner');
  const claims = f.counts.filter(r => r.name === 'finishLandingAdvance').length;
  for (let n = 0; n < 3; n++)
    await f.transaction(
      'unrelated-queue-release',
      {
        _handler: async ctx => {
          await wake.releaseLandingQueue(
            ctx,
            await store.landingQueue(ctx, { projectId: f.projectId, channel: 'main' }),
          );
        },
      },
      {},
    );
  assert.equal(f.counts.filter(r => r.name === 'finishLandingAdvance').length, claims);
  await f.transaction(
    're-pin-wakes-exact-early-resolution',
    {
      _handler: async ctx => {
        const predecessor = [...f.tables.projectHostedLandingRequests.values()].find(
          row => row.submissionId === parked.orderWait,
        );
        await finishWake.wakeLandingOrderWaiters(ctx, predecessor, true);
      },
    },
    {},
  );
  const woken = [...f.tables.projectHostedLandingRequests.values()].find(r => r.submissionId === state.id);
  assert.equal(woken.orderWait, undefined, 'a re-pin reaches the exact early entry');
  assert.equal(woken.runnable, true, 'the queued early resolution returns to the queue');
  for (let n = 0; n < 30; n++) {
    const run = f.runs().find(r => r.status === 'queued' && !r.cancelRequested);
    if (!run) break;
    await f.rawChecks.pass(await f.rawChecks.activate(run.id));
    await drainReady(f);
  }
  assert.equal((await f.current(state.id)).submission.phase, 'landed');
  assert.equal(f.pending().length, 0);
});
