// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Ferdinando Valsecchi
// Today's figures agree (Item 8d21cc9e): on one fixture day, Needs me (the Flow figures), Stats (today so far), the top
// bar and `nforge status` report the same landings today and the same main state. The owner saw Stats at 95 beside
// Needs me's 129 because today's Stats row was rewritten only by a Stats open (it dated from 13:00 UTC), and "main red"
// beside "main failed 0 today" because an open red counted nowhere until it ended.
import test from 'node:test';
import assert from 'node:assert/strict';
import { storageClock } from './storage-clock.mjs';
import { batchesFixture, synthetic } from './hosted-landing-batches-fixture.mjs';
import { finishFixture } from './hosted-finish-fixture.mjs';
import { moduleUrl } from './convex-module.mjs';

const statsApi = await import(moduleUrl('../convex/projectStats.ts'));
const { scheduleStatsClose, utcDay } = await import(moduleUrl('../convex/projectStatsClose.ts'));
const line = await import(moduleUrl('../convex/projectLiveLine.ts'));
const store = await import(moduleUrl('../convex/projectLiveLineStore.ts'));
const flowDay = await import(moduleUrl('../src/flow-day.ts'));
const { flowText } = await import(moduleUrl('../src/flow-text.ts'));
const { mainDaySchema } = await import(moduleUrl('../src/hosted-main.ts'));
const { mainTodayFrom, splitMainToday } = await import(moduleUrl('../src/hosted-pull.ts'));
const channels = await import(moduleUrl('../convex/projectHostedChannels.ts'));
const { readHostedCliStatus } = await import(moduleUrl('../src/hosted-cli-status.ts'));
const { flowFigures, mainHealth } = await import(moduleUrl('../web/src/app/flow/model.ts'));
const prior = Object.fromEntries(Object.keys(synthetic).map(k => [k, process.env[k]]));
test.beforeEach(t => storageClock(t));
test.before(() => Object.assign(process.env, synthetic));
test.after(() => {
  for (const [k, v] of Object.entries(prior)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

const HOUR = 3_600_000;
async function at(t, ms, run) {
  const clock = t.mock.method(Date, 'now', () => ms);
  try {
    return await run();
  } finally {
    clock.mock.restore();
  }
}

/** Every surface's landings today and main state, read the way each one reads it. */
async function surfaces(f, day, now) {
  const feed = await f.tx('todayLine', line.read, { projectId: f.projectId }, 'owner');
  const needs = flowFigures(feed, now);
  const health = mainHealth(needs.verdict, undefined, now);
  const top = flowDay.mainToday(feed.flow, now);
  const stats = JSON.parse(
    await f.tx('todayStats', statsApi.read, { projectId: f.projectId, from: day, to: day }),
  );
  // `nforge status` has two routes: a Lane's capabilities reply and a clone's channel read (`today: 2`).
  const sent = mainDaySchema.parse(
    await f.tx('todayMainDay', { _handler: ctx => store.readMainDay(ctx.db, f.projectId, true) }, {}),
  );
  const cloneRead = splitMainToday(
    await f.tx('todayChannel', channels.current, { projectId: f.projectId, today: 2 }, 'owner'),
  );
  const oldClone = splitMainToday(
    await f.tx('todayChannelOld', channels.current, { projectId: f.projectId, today: 1 }, 'owner'),
  );
  assert.equal(
    oldClone.today?.main ?? oldClone.today?.audit,
    undefined,
    'today: 1 keeps the older strict day',
  );
  const text = async mainToday =>
    (await readHostedCliStatus('.', { dispatch: async () => ({ result: { needsFix: [], mainToday } }) }))
      .text;
  const status = { text: await text(await mainTodayFrom(sent)) };
  const clone = { text: await text(await mainTodayFrom(cloneRead.today)) };
  const agentFlow = flowText(
    { lanes: [], more: 0, moreIsLowerBound: false, main: null, flow: feed.flow },
    now,
  );
  return {
    landed: {
      needsMe: needs.landed,
      stats: stats.window.landings,
      topBar: top.landed,
      status: Number(/main: (\d+) today/.exec(status.text)?.[1]),
      cloneStatus: Number(/main: (\d+) today/.exec(clone.text)?.[1]),
      flow: agentFlow.today.landed,
    },
    red: {
      needsMe: health?.state === 'failed',
      topBar: flowDay.flowVerdict(feed.flow)?.red === true,
      status: /· main red/.test(status.text),
      cloneStatus: /· main red/.test(clone.text),
      topBarWords: /^main red/.test(flowDay.mainStateWords(feed.flow, now) ?? ''),
      flow: agentFlow.main.red,
    },
    failedToday: { needsMe: needs.failed, flow: agentFlow.today.mainFailed },
    health,
    statusText: status.text,
    flowLines: agentFlow.text,
    todayUpTo: stats.todayUpTo,
  };
}
const same = (record, message) =>
  assert.equal(new Set(Object.values(record)).size, 1, `${message}: ${JSON.stringify(record)}`);

test('one fixture day: Needs me, Stats, the top bar and nforge status say the same landings and main state', async t => {
  const f = await batchesFixture(t);
  await f.drain();
  await f.passChecks();
  await f.drain();
  // The fixture's rows count creation from 1970 while its clock (and so the line's hour buckets) reads the fixed day:
  // put the receipts on that clock's day, as production's one clock does.
  const landedAt = Date.UTC(2026, 10, 10, 12); // storageClock's fixed instant
  const receipts = [...f.tables.projectHostedAcceptances.values()].map((row, i) => {
    const moved = { ...row, _creationTime: landedAt - 1_000 + i };
    f.tables.projectHostedAcceptances.set(row._id, moved);
    return moved;
  });
  const last = Math.max(...receipts.map(r => r._creationTime));
  const day = utcDay(last);
  // The hour's first landing schedules today so far for the end of that hour (no Stats open), from the landing's
  // speed record.
  const calls = [];
  await at(t, last, () =>
    scheduleStatsClose(
      { scheduler: { runAfter: async (delay, _ref, args) => calls.push({ delay, args }) } },
      f.projectId,
      last - HOUR,
      last,
    ),
  );
  assert.deepEqual(
    calls.map(c => c.args),
    [{ projectId: f.projectId, day, provisional: true }],
  );
  const closeAt = last + calls[0].delay;
  assert.equal(closeAt, (Math.floor(last / HOUR) + 1) * HOUR + 5_000, 'at the end of the hour it counts');
  await at(t, closeAt, () => f.tx('statsClose', statsApi.closeDay, calls[0].args));
  const now = closeAt + 55_000;
  assert.equal(utcDay(now), day, 'the fixture day goes on');

  const green = await at(t, now, () => surfaces(f, day, now));
  same(green.landed, 'landings today');
  assert.equal(green.landed.stats, receipts.length, 'every receipt of the day, as the receipts say');
  assert.equal(green.todayUpTo, closeAt, 'Stats states the time it counts up to');

  // main goes red (an audit's red event, sequence 7): every surface says red, and main failed today counts it.
  const redAt = now - 30_000;
  await f.tx(
    'todayRed',
    {
      _handler: ctx =>
        store.lineMainState(ctx.db, f.projectId, {
          red: true,
          at: new Date(redAt).toISOString(),
          sequence: 7,
        }),
    },
    {},
  );
  const red = await at(t, now, () => surfaces(f, day, now));
  same(red.landed, 'landings today while red');
  assert.ok(Object.values(red.red).every(Boolean), JSON.stringify(red.red));
  assert.deepEqual(red.failedToday, { needsMe: 1, flow: 1 }, 'a red still open counts as main failed today');
  assert.match(red.health.word, /^main red since \d\d:\d\d$/, 'the red word says since when');
  assert.equal(red.health.red, 7, 'and names its red view (code/red/7)');
  assert.match(red.statusText, /main: \d+ today.*\(UTC day\) · main red since \d\d:\d\d UTC/);
  assert.match(
    red.flowLines,
    /main failed 1 today \(still red, 0 reverted, 0 fixed on top\); main is failing now since/,
  );

  // Fixed on top: green everywhere, and the episode still counts once today.
  await f.tx(
    'todayGreen',
    {
      _handler: ctx =>
        store.lineMainState(ctx.db, f.projectId, {
          red: false,
          at: new Date(now).toISOString(),
          ended: 'fixed-on-top',
        }),
    },
    {},
  );
  const fixed = await at(t, now, () => surfaces(f, day, now));
  assert.ok(!Object.values(fixed.red).some(Boolean), JSON.stringify(fixed.red));
  assert.deepEqual(fixed.failedToday, { needsMe: 1, flow: 1 }, 'the ended red counts once');
  assert.match(fixed.statusText, /· main green/);
});

test('a red that began before the UTC day: no count today, its date shown; its end counts on the day it began', async t => {
  const f = await finishFixture(t);
  const midnight = Date.UTC(2026, 10, 23);
  const began = midnight - 10 * 60_000; // 23:50 UTC
  const flip = (red, at, extra = {}) =>
    f.tx(
      'todayFlip',
      {
        _handler: ctx =>
          store.lineMainState(ctx.db, f.projectId, { red, at: new Date(at).toISOString(), ...extra }),
      },
      {},
    );
  const flow = () =>
    JSON.parse(
      [...f.tables.projectFinishReadRows.values()].find(r => r.kind === 'projectLiveLineSummary').value,
    ).flow;
  await flip(true, began, { sequence: 9 });
  const now = midnight + 10 * 60_000;
  const open = flowFigures({ flow: flow() }, now);
  assert.equal(open.failed, 0, 'began yesterday (UTC): not today’s');
  assert.equal(flowFigures({ flow: flow() }, began + 60_000).failed, 1, 'it was yesterday’s while open');
  assert.match(
    mainHealth(open.verdict, undefined, now).word,
    /^main red since \d+ Nov \d\d:\d\d$/,
    'with its date',
  );
  assert.equal(flowDay.mainStateWords(flow(), now), 'main red since 22 Nov 23:50 UTC');
  // It ends at 00:20 UTC, fixed on top: counted in the hour it began, so yesterday's, never today's as well.
  await flip(false, now + 10 * 60_000, { ended: 'fixed-on-top' });
  assert.equal(flowFigures({ flow: flow() }, now + 11 * 60_000).failed, 0);
  assert.equal(flowFigures({ flow: flow() }, began + 60_000).failed, 1);
});
