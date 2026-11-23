// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Ferdinando Valsecchi
// Explicit Lane holds (Item e1633718; owner decision ead78765): a builder parks its Lane on a named holder with a
// reason, or with no one named, and clears it. A named holder's Needs me lists the Lane at once and nobody else's
// does; a Lane parked with no one named is listed for the account that started it, with its last activity time, for
// the page to show once 4 h idle (count.ts parkShown, tests/app-needs-me.test.mjs). A holder must already hold a role
// on the project, and an unknown handle is refused alike. One index range per Needs me read (rows only for parked Lanes); idle re-runs nothing.
import test from 'node:test';
import assert from 'node:assert/strict';
import { synthetic } from './hosted-landing-batches-fixture.mjs';
import { finishFixture } from './hosted-finish-fixture.mjs';
import { moduleUrl } from './convex-module.mjs';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { resolutionFixture } from './hosted-agent-resolution-fixture.mjs';
import { readHostedLaneCheckout } from '../dist/hosted-lane-checkout-marker.js';
const needs = await import(moduleUrl('../convex/projectNeedsMe.ts'));
const park = await import(moduleUrl('../convex/projectHostedLanePark.ts'));
const lanes = await import(moduleUrl('../convex/projectHostedLiveLanes.ts'));
const review = await import(moduleUrl('../convex/projectLaneReview.ts'));
const records = await import(moduleUrl('../convex/projectHostedRecords.ts'));
const superseded = await import(moduleUrl('../convex/projectHostedSuperseded.ts'));
const overlapStore = await import(moduleUrl('../convex/projectHostedOverlapStore.ts'));
const previousEnvironment = Object.fromEntries(Object.keys(synthetic).map(key => [key, process.env[key]]));
test.before(() => Object.assign(process.env, synthetic));
test.after(() => {
  for (const [key, value] of Object.entries(previousEnvironment)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

const hour = 3_600_000;
const read = (f, actor = 'owner') =>
  f.tx('observerBudgetPage', needs.read, { projectId: f.projectId }, actor);
const set = async (f, value, actor = 'owner', extra = {}) =>
  JSON.parse(
    await f.tx(
      'lanePark',
      park.set,
      { projectId: f.projectId, authorityEpoch: 1, laneId: f.lane.laneId, park: value, ...extra },
      actor,
    ),
  );
const seed = (f, rows) =>
  f.tx(
    'seedPeople',
    {
      _handler: async ctx => {
        for (const [table, row] of rows) await ctx.db.insert(table, row);
      },
    },
    {},
  );
const routed = f =>
  [...(f.tables.projectHostedParks?.values() ?? [])].find(row => row.laneId === f.lane.laneId);
const routes = f =>
  [...(f.tables.projectHostedParks?.values() ?? [])].filter(row => row.laneId === f.lane.laneId);
/** One Lane record write as the server's own writers make it: the stored record with `change` applied. */
const writeLane = (f, change) =>
  f.tx(
    'writeLane',
    {
      _handler: async ctx => {
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
          record: { ...lane, ...change(lane), version: lane.version + 1, at: new Date().toISOString() },
        });
      },
    },
    {},
    'owner',
  );
const run = (f, name, handler) => f.tx(name, { _handler: handler }, {}, 'owner');
const refused = (code, words) => error =>
  (error.data?.code ?? error.code) === code && (!words || words.test(error.data?.message ?? error.message));

/** A reader with a handle, a contributor with a handle, and a handle with no role on the project. */
async function people(f) {
  await seed(f, [
    ['accountHandles', { owner: 'reader-account', handle: 'sample-reader' }],
    ['projectReaders', { projectId: f.projectId, reader: 'reader-account' }],
    ['accountHandles', { owner: 'outside-account', handle: 'sample-outside' }],
  ]);
}

test('a Lane parked on a named holder is in that holder’s Needs me at once and in nobody else’s', async t => {
  const f = await finishFixture(t);
  await people(f);
  const before = await read(f);
  assert.deepEqual(before.parked, [], 'nothing parked yet');
  const first = await set(f, { holder: '@sample-reader', reason: 'Waits for the bench window to end.' });
  assert.equal(first.changed, true);
  assert.equal(first.park.reason, 'Waits for the bench window to end.');
  assert.equal(routed(f).parkedFor, 'reader-account', 'routed to the holder’s account');

  const holder = await read(f, 'reader-account');
  t.diagnostic(JSON.stringify({ needsMeWithParkReads: f.counts.at(-1) }));
  assert.equal(holder.parked.length, 1);
  assert.equal(holder.parked[0].laneId, f.lane.laneId);
  assert.equal(holder.parked[0].park.named, true);
  assert.equal(holder.parked[0].park.reason, 'Waits for the bench window to end.');
  assert.deepEqual((await read(f)).parked, [], 'the starter is not the holder: not in their Needs me');

  // A repeat names the same holder and reason: nothing is written, and the park keeps its time.
  const records = f.tables.projectHostedRecords.size;
  const again = await set(f, { holder: 'sample-reader', reason: 'Waits for the bench window to end.' });
  assert.equal(again.changed, false);
  assert.equal(again.park.at, first.park.at);
  assert.equal(f.tables.projectHostedRecords.size, records, 'a repeat writes nothing');

  // The Lane page and the yard row read the park from the record (a real save carrying it forward: the CLI test below).
  const listed = JSON.parse(
    await f.tx('liveLanes', lanes.list, { projectId: f.projectId, cursor: null, limit: 10 }),
  ).page.find(lane => lane.laneId === f.lane.laneId);
  assert.equal(listed.park.reason, 'Waits for the bench window to end.');
  assert.equal(listed.park.named, true);
  const page = JSON.parse(
    await f.tx('laneReview', review.read, { projectId: f.projectId, laneId: f.lane.laneId, offset: 0 }),
  );
  assert.equal(page.lane.park.reason, 'Waits for the bench window to end.');

  // Cleared: out of the holder's Needs me and off the presence row.
  const cleared = await set(f, null);
  assert.equal(cleared.park, null);
  assert.equal(routed(f), undefined, 'a cleared park leaves no routing row');
  assert.deepEqual((await read(f, 'reader-account')).parked, []);
});

test('a Lane parked with no one named goes to its starter with its last activity, and idle re-runs nothing', async t => {
  const f = await finishFixture(t);
  await set(f, { reason: 'Parked until the lead decides.' });
  const mine = await read(f);
  assert.equal(mine.parked.length, 1, 'listed for the starter; the page shows it once 4 h idle');
  assert.equal(mine.parked[0].park.named, false);
  assert.equal(typeof mine.parked[0].at, 'number', 'the last activity the 4 h rule compares, read-time only');
  const unchanged = f.readSet();
  f.advanceClock(5 * hour);
  assert.equal(unchanged(), true, 'five idle hours change nothing this read depends on: no timer, no poll');

  // Closing the Lane ends the park: its routing row goes with its presence row, so nothing leaks.
  await writeLane(f, () => ({ state: 'abandoned' }));
  assert.equal(routed(f), undefined, 'a closed Lane leaves no routing row');
  assert.deepEqual((await read(f)).parked, []);
});

test('a park names only someone who can already read the project, and only the starter, holder or owner parks', async t => {
  const f = await finishFixture(t);
  await people(f);
  await assert.rejects(
    set(f, { holder: '@sample-outside', reason: 'No access.' }),
    refused('BAD_ARGUMENT', /can read this project/),
    'a handle with no role on the project is refused',
  );
  await assert.rejects(
    set(f, { holder: '@no-such-handle', reason: 'Unknown.' }),
    refused('BAD_ARGUMENT', /can read this project/),
    'an unknown handle reads exactly the same, so a park never probes accounts',
  );
  assert.equal(routed(f), undefined, 'nothing was parked');
  await assert.rejects(
    set(f, { reason: 'Not mine.' }, 'outside-account'),
    refused('PROJECT_UNAVAILABLE'),
    'someone without write access cannot park it',
  );
  await assert.rejects(read(f, 'outside-account'), 'nor read Needs me in a project they cannot read');
  await assert.rejects(
    set(f, { reason: 'x'.repeat(281) }),
    refused('BAD_ARGUMENT', /280 characters/),
    'a reason has at most 280 characters',
  );
});

// Review fcc0d8e1 / 1edbde56: a supersede or an Intent cascade deletes a parked Lane's presence row with no record
// write. Its routing row must go too, or an abandon leaks it (a slot in the holder's 31-row read) and a later save
// inserts a second row that makes every later park, clear, abandon or landing fail on the unique read.
test('a parked Lane that is superseded leaves Needs me; abandoned it leaks nothing, saved again it routes once', async t => {
  const f = await finishFixture(t);
  await people(f);
  const supersede = () =>
    run(f, 'supersede', ctx =>
      superseded.supersedeLane(ctx, {
        projectId: f.projectId,
        laneId: f.lane.laneId,
        by: crypto.randomUUID(),
        receiptId: crypto.randomUUID(),
        at: new Date().toISOString(),
      }),
    );
  await set(f, { holder: '@sample-reader', reason: 'Waits for the bench window.' });
  assert.equal(routes(f).length, 1);
  await supersede();
  assert.deepEqual(routes(f), [], 'superseded: out of the holder’s Needs me with its presence row');
  assert.deepEqual((await read(f, 'reader-account')).parked, []);

  // Saved again on a new head: live again, routed once, and every later change still works.
  await writeLane(f, () => ({ head: 'ab'.repeat(32) }));
  assert.equal(routes(f).length, 1, 'one routing row, never two');
  assert.equal((await read(f, 'reader-account')).parked.length, 1, 'back in the holder’s Needs me');
  const cleared = await set(f, null);
  assert.equal(cleared.park, null, 'clearing works after a supersede and a save');
  assert.deepEqual(routes(f), []);

  // Superseded, then abandoned: nothing is left behind.
  await set(f, { reason: 'Until the lead decides.' });
  await supersede();
  await writeLane(f, () => ({ state: 'abandoned' }));
  assert.deepEqual(routes(f), [], 'an abandoned superseded Lane leaves no routing row');
});

test('an Intent cascade that closes a parked Lane removes its routing row at both of its steps', async t => {
  const f = await finishFixture(t);
  await set(f, { reason: 'Until the lead decides.' });
  assert.equal(routes(f).length, 1);
  await run(f, 'markLifecycle', ctx =>
    overlapStore.markHostedOverlapLifecycle(ctx, f.projectId, f.lane.laneId, 'lifecycle-plan'),
  );
  assert.deepEqual(routes(f), [], 'a staged close hides the park with the presence row');
  await writeLane(f, () => ({ head: 'cd'.repeat(32) }));
  assert.equal(routes(f).length, 1, 'a still-open Lane written again routes again');
  await run(f, 'materializeLifecycle', ctx =>
    overlapStore.materializeHostedOverlapLifecycle(ctx, f.projectId, f.lane.laneId, 99),
  );
  assert.deepEqual(routes(f), [], 'the promoted close removes it');
  assert.deepEqual((await read(f)).parked, []);
});

test('a writer who is not the starter, holder or owner cannot park; the person a park names may clear it', async t => {
  const f = await finishFixture(t);
  await seed(f, [
    ['accountHandles', { owner: 'writer-account', handle: 'sample-writer' }],
    ['projectContributors', { projectId: f.projectId, contributor: 'writer-account' }],
  ]);
  await assert.rejects(
    set(f, { reason: 'Not my Lane.' }, 'writer-account'),
    refused('PROJECT_UNAVAILABLE', /started this Lane/),
    'write access alone does not let someone park another person’s Lane',
  );
  await set(f, { holder: '@sample-writer', reason: 'Waits for your copy review.' });
  await assert.rejects(
    set(f, { holder: '@sample-writer', reason: 'Re-parked by the holder.' }, 'writer-account'),
    refused('PROJECT_UNAVAILABLE'),
    'the named person may release the park, not re-park it',
  );
  const released = await set(f, null, 'writer-account');
  assert.equal(
    released.park,
    null,
    'the named person released it, as a requested reviewer dismisses a request',
  );
  assert.deepEqual(routes(f), []);
  assert.deepEqual((await read(f, 'writer-account')).parked, []);
});

// Through the CLI: a later save carries the park forward, and a repeated `save {park}` on a clean checkout (the
// journal replays the settled save as nothing-to-save) still applies the park (review fcc0d8e1 / 1edbde56, finding 2).
test('save {park} parks through the CLI, a later save keeps it, and a repeat on a clean checkout still applies', async t => {
  const s = await resolutionFixture(t, { overlap: false }),
    f = s.f,
    laneId = f.lane.laneId;
  await s.transport().dispatch('open', { laneId });
  writeFileSync(join(s.root, 'first.txt'), 'first edit');
  const parked = await s.transport().dispatch('save', { park: { reason: 'Waits for the lead.' } });
  assert.equal(parked.result.park.reason, 'Waits for the lead.');
  assert.equal((await f.readLane(laneId)).park.reason, 'Waits for the lead.');
  // Review e09e956c (2): the park moved only the Lane's version, and the checkout follows it, so the next save is
  // not refused as stale first (3 extra calls).
  assert.equal(
    readHostedLaneCheckout(s.root).selection.version,
    (await f.readLane(laneId)).version,
    'the checkout records the version the park wrote',
  );
  writeFileSync(join(s.root, 'second.txt'), 'second edit');
  await s.transport().dispatch('save', {});
  assert.equal((await f.readLane(laneId)).park?.reason, 'Waits for the lead.', 'a later save keeps the park');
  const cleared = await s.transport().dispatch('save', { park: null });
  assert.equal(cleared.result.park, null);
  assert.equal((await f.readLane(laneId)).park, undefined);
  // The identical command again, nothing edited: the save is a replay, the park is not.
  const again = await s.transport().dispatch('save', { park: { reason: 'Waits for the lead.' } });
  assert.equal(again.result.status, 'nothing-to-save');
  assert.equal(again.result.park.reason, 'Waits for the lead.', 'the park call still ran');
  assert.equal((await f.readLane(laneId)).park?.reason, 'Waits for the lead.');
  const clearAgain = await s.transport().dispatch('save', { park: null });
  assert.equal(clearAgain.result.status, 'nothing-to-save');
  assert.equal(clearAgain.result.park, null);
  assert.equal((await f.readLane(laneId)).park, undefined, 'cleared on the server, not only in the reply');
});
