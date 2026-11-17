// SPDX-License-Identifier: Apache-2.0
// projectNeedsMe:read (Items 9e748e41, 12fde646): the held Lanes it lists are exactly the live line's held marks, each
// with the reason the bound landing recorded (a hold Forge cannot explain is "unknown", never guessed), its open
// approval requests come from the same bounded reads as projectHostedApprovals:list, and an idle view re-runs nothing.
import test from 'node:test';
import assert from 'node:assert/strict';
import { synthetic } from './hosted-landing-batches-fixture.mjs';
import { finishFixture } from './hosted-finish-fixture.mjs';
import { moduleUrl } from './convex-module.mjs';
const needs = await import(moduleUrl('../convex/projectNeedsMe.ts'));
const line = await import(moduleUrl('../convex/projectLiveLine.ts'));
const approvals = await import(moduleUrl('../convex/projectHostedApprovals.ts'));
const landing = await import(moduleUrl('../convex/projectHostedLandingStore.ts'));
const previousEnvironment = Object.fromEntries(Object.keys(synthetic).map(key => [key, process.env[key]]));
test.before(() => Object.assign(process.env, synthetic));
test.after(() => {
  for (const [key, value] of Object.entries(previousEnvironment)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});
// The fixture keeps the read set of a transaction with this name, so an idle re-run can be checked.
const read = f => f.tx('observerBudgetPage', needs.read, { projectId: f.projectId });
const observe = (f, submissionId, patch) =>
  f.tx(
    'needsMeObservation',
    {
      _handler: async ctx => {
        const { row, state } = await landing.loadLanding(ctx, { projectId: f.projectId, submissionId });
        await landing.writeLanding(
          ctx,
          row,
          { ...state, ...patch(state), version: state.version + 1 },
          false,
        );
      },
    },
    {},
  );

test('Needs me lists the line’s held Lanes with the recorded reason, and an idle view re-runs nothing', async t => {
  const f = await finishFixture(t);
  const state = await f.enqueue(f.request());
  const empty = await read(f);
  assert.deepEqual(empty.held, [], 'a Lane on its way is not held');
  assert.equal(empty.more, 0);

  await observe(f, state.id, before => ({
    observation: { ...before.observation, pendingReason: 'waiting-for-review' },
  }));
  const shell = await f.tx('lineRead', line.read, { projectId: f.projectId });
  const review = await read(f);
  t.diagnostic(JSON.stringify({ needsMeHeldRead: f.counts.at(-1) }));
  assert.equal(review.held.length, shell.lanes.filter(lane => lane.held).length, 'same set as the top bar');
  assert.equal(review.held[0].laneId, f.lane.laneId);
  assert.equal(review.held[0].why, 'review');
  assert.equal(review.held[0].submissionId, state.id);
  assert.equal(typeof review.canDecide, 'boolean');

  await observe(f, state.id, before => ({
    phase: 'terminal-failed',
    observation: {
      ...before.observation,
      state: 'terminal-failed',
      pendingReason: null,
      cause: 'check-failed',
    },
  }));
  const failed = await read(f);
  assert.equal(failed.held[0].why, 'check-failed');

  const unchanged = f.readSet();
  f.advanceClock(30 * 60_000);
  assert.equal(unchanged(), true, 'thirty idle minutes change nothing this read depends on');
});

test('open approval requests are the same payload projectHostedApprovals:list returns', async t => {
  const f = await finishFixture(t);
  const [mine, list] = [
    await read(f),
    await f.tx('approvalsList', approvals.list, { projectId: f.projectId }),
  ];
  assert.equal(mine.approvals, list);
  assert.deepEqual(JSON.parse(mine.approvals).requests, []);
});
