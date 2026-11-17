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

test('0cb9b064: a withdrawn landing stops holding its Lane; a hold from before reads withdrawn, titled in words', async t => {
  const { landingObservation } = await import('../dist/hosted-landing.js');
  const f = await finishFixture(t);
  const state = await f.enqueue(f.request());
  await observe(f, state.id, before => ({
    observation: { ...before.observation, pendingReason: 'waiting-for-review' },
  }));
  assert.equal((await read(f)).held.length, 1);
  await observe(f, state.id, () => ({
    phase: 'terminal-failed',
    observation: landingObservation('cancelled'),
    error: { code: 'LANDING_CANCELLED', message: 'Withdrawn to add a delta.' },
  }));
  const shell = await f.tx('lineRead', line.read, { projectId: f.projectId });
  assert.equal(shell.lanes.filter(lane => lane.held).length, 0, 'the top bar holds nothing for a person');
  assert.deepEqual((await read(f)).held, [], 'and Needs me lists nothing');
  // A mark held by a withdrawal before this change: Needs me names it withdrawn and titles it without the raw id.
  const presence = await f.tx(
    'legacyWithdrawnHold',
    {
      _handler: async ctx => {
        const lane = q => q.eq('projectId', f.projectId).eq('laneId', f.lane.laneId);
        const mark = await ctx.db
          .query('projectLiveLineLanes')
          .withIndex('by_project_and_lane', lane)
          .unique();
        await ctx.db.patch(mark._id, { held: true });
        const row = await ctx.db
          .query('projectHostedPresence')
          .withIndex('by_project_and_lane', lane)
          .unique();
        if (row) await ctx.db.patch(row._id, { goal: `${f.lane.laneId.slice(0, 13)}-…: site function` });
        return Boolean(row);
      },
    },
    {},
  );
  const legacy = await read(f);
  assert.equal(legacy.held[0].why, 'withdrawn');
  assert.equal(legacy.held[0].note, 'Withdrawn to add a delta.');
  assert.ok(presence, 'the fixture Lane has a presence row');
  assert.equal(legacy.held[0].title, 'site function');
  assert.equal(needs.withoutRawId('875a4b60-3aad-462c-9a03-e306ef5bf4be'), '');
  assert.equal(needs.withoutRawId('Public pages: share cards'), 'Public pages: share cards');
  assert.equal(
    needs.withoutRawId('abcdef12 fix the bug'),
    'abcdef12 fix the bug',
    'a word that looks like hex stays',
  );
});
