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
  const request = [...f.tables.projectHostedLandingRequests.values()].find(
    row => row.submissionId === state.id,
  );
  request.agentRun = 'amber-fox';
  request.agentClient = 'codex:gpt-example';
  const presence = [...f.tables.projectHostedPresence.values()].find(row => row.laneId === f.lane.laneId);
  presence.actor = 'user_otherHolder1234';
  const shell = await f.tx('lineRead', line.read, { projectId: f.projectId });
  const review = await read(f);
  t.diagnostic(JSON.stringify({ needsMeHeldRead: f.counts.at(-1) }));
  assert.equal(review.held.length, shell.lanes.filter(lane => lane.held).length, 'same set as the top bar');
  assert.equal(review.held[0].laneId, f.lane.laneId);
  assert.equal(review.held[0].why, 'review');
  assert.equal(review.held[0].submissionId, state.id);
  assert.equal(
    review.held[0].actor,
    request.actor,
    'the held review names the submitter, not the current holder',
  );
  assert.equal(typeof review.canDecide, 'boolean');
  const { agent, agentClient, agentAuthored, ...priorHeld } = review.held[0];
  assert.deepEqual(
    { agent, agentClient, agentAuthored },
    {
      agent: 'amber-fox',
      agentClient: 'codex:gpt-example',
      agentAuthored: true,
    },
  );
  t.diagnostic(
    `One held Lane: ${Buffer.byteLength(JSON.stringify({ ...review, held: [{ ...priorHeld, agent: null }] }))} → ${Buffer.byteLength(JSON.stringify(review))} reply bytes`,
  );

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
  // Owner dogfood 2026-11-17: an overlapping Lane whose admission check failed read as "Conflict". The recorded
  // cause names what stops it; the overlap mark is only the fallback.
  const [mark] = [...f.tables.projectLiveLineLanes.entries()].find(([, row]) => row.laneId === f.lane.laneId);
  f.patch('projectLiveLineLanes', mark, { overlap: true });
  assert.equal((await read(f)).held[0].why, 'check-failed', 'the failed check, not the overlap');
  f.patch('projectLiveLineLanes', mark, { overlap: false });
  await read(f);

  const unchanged = f.readSet();
  f.advanceClock(30 * 60_000);
  assert.equal(unchanged(), true, 'thirty idle minutes change nothing this read depends on');
});

test('a held landing uses the recorded person stamp even on the agent submission path', async t => {
  const f = await finishFixture(t);
  const state = await f.enqueue(f.request({ authorship: { kind: 'person' }, agent: true }));
  await observe(f, state.id, before => ({
    observation: { ...before.observation, pendingReason: 'waiting-for-review' },
  }));
  const person = (await read(f)).held[0];
  assert.equal(person.agent, null);
  assert.equal(person.agentClient, undefined);
  assert.equal(person.agentAuthored, undefined);
});

test('a Lane held for a dependency names the Lane it lands after; other rows carry no field (9e748e41)', async t => {
  const f = await finishFixture(t);
  const parent = await f.enqueue(f.request());
  await f.drain();
  const child = await f.enqueue(
    f.request({ finish: { composeOperationId: f.selection.request.operationId, after: parent.id } }),
  );
  await f.drain();
  assert.equal((await f.current(child.id)).submission.observation.pendingReason, 'waiting-for-dependency');
  const shell = await f.tx('lineRead', line.read, { projectId: f.projectId });
  const view = await read(f);
  t.diagnostic(JSON.stringify({ needsMeDependencyRead: f.counts.at(-1) }));
  assert.equal(view.held.length, shell.lanes.filter(lane => lane.held).length, 'same set as the top bar');
  const row = view.held.find(r => r.submissionId === child.id);
  assert.ok(row, JSON.stringify(view.held));
  assert.equal(row.why, 'dependency');
  // The fixture stacks both landings on one Lane: the parent's Lane and its title come from its own records.
  assert.deepEqual(row.dependsOn, { laneId: f.lane.laneId, title: row.title });

  await observe(f, child.id, before => ({
    observation: { ...before.observation, pendingReason: 'waiting-for-review' },
  }));
  const review = await read(f);
  assert.equal(review.held[0].why, 'review');
  assert.equal(review.held[0].dependsOn, undefined, 'only a dependency hold carries the field');
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

test('an approval granted anywhere (web, CLI or agent) leaves Needs me in the same read', async t => {
  const f = await finishFixture(t);
  const state = await f.enqueue(f.request());
  await observe(f, state.id, before => ({
    observation: { ...before.observation, pendingReason: 'waiting-for-review' },
  }));
  assert.equal((await read(f)).held.length, 1, 'a protected landing waits for the owner');
  // The CLI's approve and the web's Approve both settle the landing past review; the page reads only that state.
  await observe(f, state.id, before => ({
    observation: { ...before.observation, pendingReason: 'queued' },
  }));
  const after = await read(f);
  const shell = await f.tx('lineRead', line.read, { projectId: f.projectId });
  assert.deepEqual(after.held, [], 'nothing left to approve');
  assert.equal(shell.lanes.filter(lane => lane.held).length, 0, 'and the top bar agrees');
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
