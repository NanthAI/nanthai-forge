// SPDX-License-Identifier: Apache-2.0
// Issue f5c4d136 (dev, 2026-11-22): a Lane's landing ended in a composition conflict, so its live-line mark was held.
// A resolution Lane then landed its work and superseded it. The supersede deleted its presence row but kept the hold,
// so the project list said a Lane needed the owner and the top bar's F waited, with nothing to decide.
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { synthetic } from './hosted-landing-batches-fixture.mjs';
import { finishFixture } from './hosted-finish-fixture.mjs';
import { moduleUrl } from './convex-module.mjs';
const needs = await import(moduleUrl('../convex/projectNeedsMe.ts'));
const line = await import(moduleUrl('../convex/projectLiveLine.ts'));
const account = await import(moduleUrl('../convex/accountProjects.ts'));
const landing = await import(moduleUrl('../convex/projectHostedLandingStore.ts'));
const records = await import(moduleUrl('../convex/projectHostedRecords.ts'));
const superseded = await import(moduleUrl('../convex/projectHostedSuperseded.ts'));
const repair = await import(moduleUrl('../convex/projectLiveLineRepair.ts'));
const { needsCount } = await import(moduleUrl('../web/src/app/needs/count.ts'));
const { baseMark } = await import(moduleUrl('../web/src/app/mark.ts'));
const previousEnvironment = Object.fromEntries(Object.keys(synthetic).map(key => [key, process.env[key]]));
test.before(() => Object.assign(process.env, synthetic));
test.after(() => {
  for (const [key, value] of Object.entries(previousEnvironment)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

const run = (f, name, handler) => f.tx(name, { _handler: handler }, {}, 'owner');
const marks = f => [...f.tables.projectLiveLineLanes.values()];
const lineRead = f => f.tx('lineRead', line.read, { projectId: f.projectId, includeChecks: false });
const needsRead = f => f.tx('needsRead', needs.read, { projectId: f.projectId });
/** The project list's row (accountProjects:list), with the owner's order row seeded once when the fixture has none. */
async function projectRow(f) {
  if (![...f.tables.accountProjectOrder.values()].some(row => row.projectId === f.projectId))
    await run(f, 'seedOrder', ctx =>
      ctx.db.insert('accountProjectOrder', {
        person: 'owner',
        projectId: f.projectId,
        role: 'owner',
        activityHour: 1,
      }),
    );
  const list = await f.tx(
    'accountList',
    account.list,
    { paginationOpts: { cursor: null, numItems: 10 } },
    'owner',
  );
  return list.page.find(row => row.id === f.projectId);
}
/** Every surface that says a Lane is held or needs someone. */
async function surfaces(f) {
  const [feed, attention, project] = await Promise.all([lineRead(f), needsRead(f), projectRow(f)]);
  return {
    lineHeld: feed.lanes.filter(lane => lane.held).length,
    lineLanes: feed.lanes.length,
    topBarMark: baseMark(feed),
    needsHeld: attention.held.length,
    needsYou: needsCount(attention).n,
    projectListHeld: project.held.n,
    exit: feed.exit,
  };
}
/** The dev incident: the Lane's landing ends in a composition conflict while its saved files conflict. */
async function heldAtSave(f) {
  const state = await f.enqueue(f.request());
  await run(f, 'conflictEnd', async ctx => {
    const { row, state: before } = await landing.loadLanding(ctx, {
      projectId: f.projectId,
      submissionId: state.id,
    });
    await landing.writeLanding(
      ctx,
      row,
      {
        ...before,
        phase: 'terminal-failed',
        observation: {
          ...before.observation,
          state: 'terminal-failed',
          cause: 'conflict',
          pendingReason: null,
        },
        error: { code: 'COMPOSITION_CONFLICT', message: 'Candidate has retained source conflicts.' },
        version: before.version + 1,
      },
      false,
    );
    const overlap = [...f.tables.projectHostedOverlapLanes.values()].find(r => r.laneId === f.lane.laneId);
    await ctx.db.patch(overlap._id, { conflicted: true });
  });
  return state;
}
const supersede = f =>
  run(f, 'supersede', ctx =>
    superseded.supersedeLane(ctx, {
      projectId: f.projectId,
      laneId: f.lane.laneId,
      by: randomUUID(),
      receiptId: randomUUID(),
      at: new Date(f.now()).toISOString(),
    }),
  );
/** A record write of the Lane (an activity or name change keeps the head; a save moves it). */
const writeLane = (f, change = () => ({})) =>
  run(f, 'writeLane', async ctx => {
    const row = await records.readHostedRecord(ctx, {
      projectId: f.projectId,
      actor: 'owner',
      kind: 'lane',
      key: f.lane.laneId,
    });
    const lane = JSON.parse(row.value);
    await records.writeHostedRecord(ctx, {
      projectId: f.projectId,
      actor: 'owner',
      authorityEpoch: 1,
      expectedVersion: lane.version,
      record: { ...lane, ...change(lane), version: lane.version + 1, at: new Date(f.now()).toISOString() },
    });
  });

test('incident replay f5c4d136: a Lane held at save, then superseded, leaves no held or needs-you item on any surface', async t => {
  const f = await finishFixture(t);
  await heldAtSave(f);
  const held = await surfaces(f);
  assert.equal(held.lineHeld, 1, 'the conflict holds the Lane while it is live');
  assert.equal(held.needsHeld, 1, 'Needs me lists it, as the Lane holder’s to fix');
  assert.equal(held.needsYou, 0, 'a conflict is never the owner’s decision');
  assert.equal(held.projectListHeld, 1);
  assert.equal(held.topBarMark, 'waiting');

  assert.equal(await supersede(f), true);
  const after = await surfaces(f);
  assert.deepEqual(
    after,
    { ...held, lineHeld: 0, topBarMark: 'overlap', needsHeld: 0, projectListHeld: 0 },
    'the supersede lifts the hold in its own transaction; the open Lane stays on the line, unheld (its saved-file conflict is still real)',
  );
  assert.equal(marks(f)[0].retried, true, 'its failed submission still counts against a first try');

  // A later record write at the same head keeps it superseded and unheld.
  await writeLane(f);
  assert.equal(marks(f)[0].held, false, 'a same-head write never brings the stale hold back');
  // Saved again: live again at Saved, held by nothing.
  await writeLane(f, () => ({ head: 'cd'.repeat(32) }));
  assert.equal(marks(f)[0].held, false);
  assert.equal((await surfaces(f)).needsHeld, 0);
});

test('a supersede leaves the hold of a live submission (waiting for review) in place', async t => {
  const f = await finishFixture(t);
  const state = await f.enqueue(f.request());
  await run(f, 'reviewHold', async ctx => {
    const { row, state: before } = await landing.loadLanding(ctx, {
      projectId: f.projectId,
      submissionId: state.id,
    });
    await landing.writeLanding(
      ctx,
      row,
      {
        ...before,
        observation: { ...before.observation, pendingReason: 'waiting-for-review' },
        version: before.version + 1,
      },
      false,
    );
  });
  const [mark] = marks(f);
  assert.equal(mark.held, true);
  assert.notEqual(mark.stage, 'saved', 'its submission is still in the queue');
  await supersede(f);
  assert.equal(marks(f)[0].held, true, 'a decision still waits on that submission');
});

test('the repair lifts a hold a supersede left before the fix, and only that hold', async t => {
  const f = await finishFixture(t);
  await heldAtSave(f);
  await supersede(f);
  // The state dev was left in by a supersede from before the fix: the superseded Lane still held at Saved.
  await run(f, 'staleHold', ctx => ctx.db.patch(marks(f)[0]._id, { held: true }));
  assert.equal((await surfaces(f)).projectListHeld, 1);

  const repairRun = dryRun =>
    f.tx('repairHolds', repair.supersededHolds, { projectId: f.projectId, cursor: null, dryRun });
  const dry = await repairRun(true);
  assert.deepEqual(dry.lifted, [f.lane.laneId]);
  assert.equal(marks(f)[0].held, true, 'a dry run writes nothing');
  const applied = await repairRun(false);
  assert.deepEqual(applied.lifted, dry.lifted);
  assert.equal(applied.cursor, null);
  const after = await surfaces(f);
  assert.equal(after.lineHeld + after.projectListHeld + after.needsHeld, 0);
  assert.equal(marks(f)[0].retried, true);
  assert.deepEqual((await repairRun(false)).lifted, [], 'a replay finds nothing left');
});
