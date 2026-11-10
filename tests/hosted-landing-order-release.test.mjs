// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { batchesFixture, states, synthetic } from './hosted-landing-batches-fixture.mjs';
import { landingApi } from './hosted-finish-fixture.mjs';
import { moduleUrl } from './convex-module.mjs';
const wake = await import(moduleUrl('../convex/projectHostedFinishWake.ts'));
const store = await import(moduleUrl('../convex/projectHostedFinishStore.ts'));
const prior = Object.fromEntries(Object.keys(synthetic).map(key => [key, process.env[key]]));
test.before(() => Object.assign(process.env, synthetic));
test.after(() => {
  for (const [key, value] of Object.entries(prior)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});
async function drainDue(f) {
  for (let steps = 0; ; steps++) {
    const task = f.pending().find(task => task.scheduledTime <= Date.now());
    if (!task) return;
    assert(steps < 500, 'release settles through bounded event-driven work');
    await f.execute(task);
  }
}

for (const ending of ['failed', 'withdrawn'])
  test(`incident stucktrain: ending a reservation accepts a passed three-Lane cohort before its expiry timer (${ending})`, async t => {
    const f = await batchesFixture(t, {
      count: 3,
      memberPaths: ['member-0', 'member-1', 'member-2', 'member-0'],
    });
    await f.drain();
    const shared = f.runs()[0];
    const holder = await f.add(3);
    const holderRow = [...f.tables.projectHostedLandingRequests.values()].find(
      r => r.submissionId === holder.id,
    );
    const until = Date.now() + 30 * 60_000;
    f.patch('projectHostedLandingRequests', holderRow._id, { reservedUntil: until });
    await f.rawChecks.pass(await f.rawChecks.activate(shared.id));
    await drainDue(f);
    const members = states(f).filter(s => s.id !== holder.id);
    assert(
      members.every(s => s.phase === 'ready'),
      'all three share a passed exact check',
    );
    const leader = [...f.tables.projectHostedLandingRequests.values()].find(
      r => r.submissionId === members[0].id,
    );
    assert.equal(leader.orderWait, holder.id);
    const finish = [...f.tables.projectHostedFinishes.values()].find(
      r => r.submissionId === leader.submissionId,
    );
    assert.equal(finish.wake.at, until, 'the reservation bound owns a future fallback wake');
    if (ending === 'failed') {
      await f.transaction(
        'reservation-check-failed',
        {
          _handler: (ctx, input) =>
            store.failFinish(ctx, input, 'CHECK_FAILED', 'Synthetic holder check failed.'),
        },
        { projectId: f.projectId, submissionId: holder.id },
      );
    } else
      await f.transaction('reservation-ended', landingApi.cancel, {
        projectId: f.projectId,
        request: JSON.stringify({ operationId: randomUUID(), authorityEpoch: 1, submissionId: holder.id }),
      });
    const released = [...f.tables.projectHostedFinishes.values()].find(
      r => r.submissionId === leader.submissionId,
    );
    assert(released.wake.at < until, 'the end event replaces the obsolete expiry wake immediately');
    await drainDue(f);
    assert(
      states(f)
        .filter(s => s.id !== holder.id)
        .every(s => s.phase === 'landed'),
    );
    assert.equal(f.currentMain().head, shared.request.expectedHead);
    assert.equal(f.tables.projectHostedAcceptances.size, 3, 'one atomic cohort publication');
    assert(!f.pending().some(task => task._id === finish.wake.taskId), 'obsolete expiry task is cancelled');
    const before = f.tables.projectHostedAcceptances.size;
    await f.c.run('duplicate-order-release', wake.wakeLandingOrderWaiters, holderRow);
    await drainDue(f);
    assert.equal(f.tables.projectHostedAcceptances.size, before, 'duplicate release cannot republish');
    await f.add(4);
    await f.add(5);
    await drainDue(f);
    await f.passChecks();
    await drainDue(f);
    assert.equal(states(f).filter(s => s.phase === 'landed').length, 5, 'the two later Lanes move too');
  });
