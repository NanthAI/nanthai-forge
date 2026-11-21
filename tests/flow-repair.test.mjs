// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import { storageClock } from './storage-clock.mjs';
import assert from 'node:assert/strict';
import { batchesFixture, synthetic } from './hosted-landing-batches-fixture.mjs';
import { finishFixture } from './hosted-finish-fixture.mjs';
import { moduleUrl } from './convex-module.mjs';
import { flowToday, flowVerdict, HOUR_MS, stepFlow, utcDayStart } from '../dist/flow-day.js';

const { read } = await import(moduleUrl('../convex/projectLiveLine.ts'));
const { backfill } = await import(moduleUrl('../convex/projectLiveLineRepair.ts'));
const { writeLineMain } = await import(moduleUrl('../convex/projectLiveLineStore.ts'));

const summary = f =>
  [...f.tables.projectFinishReadRows.values()].find(row => row.kind === 'projectLiveLineSummary');
const getFlow = async f => (await f.tx('readFlow', read, { projectId: f.projectId }, 'owner')).flow;
const rebuild = (f, dayStart) => f.tx('repairFlow', backfill, { projectId: f.projectId, dayStart });
const update = (f, handler) => f.tx('seedFlow', { _handler: handler }, {});
const snapshot = at => ({ head: 'a'.repeat(64), at: new Date(at).toISOString() });
function receipt(f, number, at, projectId = f.projectId) {
  const id = `receipt-${number}`;
  f.tables.projectHostedAcceptances.set(id, {
    _id: id,
    _creationTime: at,
    projectId,
    receiptId: id,
    submissionId: id,
    attemptId: id,
    sequence: number,
    value: '{}',
  });
}
const publish = (f, at, count = 1, previous = false, sequence) =>
  update(f, ctx => writeLineMain(ctx, f.projectId, snapshot(at), count, previous, sequence));

function channel(f, updateSelection) {
  const row = [...f.tables.projectHostedChannels.values()].find(row => row.name === 'main');
  row.selection = JSON.stringify(updateSelection(JSON.parse(row.selection)));
}

/** Model full-page cursors and the byte split that the in-memory DB omits. */
function boundedProvider(f, receiptBytes) {
  f.extendContext(ctx => {
    const query = ctx.db.query.bind(ctx.db);
    ctx.db.query = table => {
      const result = query(table);
      if (table !== 'projectHostedAcceptances') return result;
      const paginate = result.paginate.bind(result);
      result.paginate = async options => {
        const page = await paginate(options);
        let bytes = 0;
        const limited = page.page.filter(
          row => (bytes += receiptBytes ?? Buffer.byteLength(row.value)) <= options.maximumBytesRead,
        );
        if (options.maximumBytesRead !== undefined && limited.length < page.page.length)
          return { ...page, page: limited, isDone: false, pageStatus: 'SplitRequired' };
        return { ...page, isDone: page.isDone && page.page.length < options.numItems };
      };
      return result;
    };
  });
}

test('a UTC-day rebuild replaces the live landing count once across tied receipt pages and keeps measured figures', async t => {
  const f = await finishFixture(t);
  const now = Date.now();
  const start = utcDayStart(now);
  const at = now - 1;
  await publish(f, at);
  const saved = summary(f);
  const value = JSON.parse(saved.value);
  const flow = stepFlow(value.flow, at, {
    first: true,
    took: 125,
    fix: 2,
    reverted: 1,
    fixedOnTop: 1,
    ciSeconds: 600,
    lostSeconds: 120,
  });
  saved.value = JSON.stringify({ ...value, flow });
  for (let i = 0; i < 300; i++) receipt(f, i, i < 200 ? start : Math.max(start + 0.1, now));
  receipt(f, 300, start - 1);
  receipt(f, 301, start + 24 * HOUR_MS);
  receipt(f, 302, now, 'another-project');

  boundedProvider(f);
  channel(f, selection => ({ ...selection, sourceRevision: 299 }));
  const expectedPartial = [
    'took',
    'firstTry',
    'needsFix',
    'reverted',
    'fixedOnTop',
    'ciMinutes',
    'lostMinutes',
  ];
  const result = await rebuild(f, start);
  assert.deepEqual(result, { status: 'rebuilt', receipts: 300, landed: 300, partial: expectedPartial });
  const projection = await getFlow(f);
  const today = flowToday(projection, Date.now(), start);
  assert.equal(today.byHour[0], 200);
  assert.equal(today.byHour[12], 100);
  assert.deepEqual(
    [
      today.middle,
      today.firstTry,
      today.fix,
      today.reverted,
      today.fixedOnTop,
      today.ciMinutes,
      today.lostMinutes,
    ],
    [125, 1, 2, 1, 1, 10, 2],
  );
  const before = summary(f).value;
  assert.deepEqual(await rebuild(f, start), { ...result, status: 'already-rebuilt', receipts: 0 });
  assert.equal(summary(f).value, before);
  assert.equal((await rebuild(f, start - 24 * HOUR_MS)).status, 'day-changed');
  const next = stepFlow(projection, start + 24 * HOUR_MS, { landed: 1 });
  assert.deepEqual(flowToday(next, start + 24 * HOUR_MS, start + 24 * HOUR_MS).partial, []);
});

test('publication seeds a missing historical day from receipts, then live publications only count their own receipts', async t => {
  const f = await finishFixture(t);
  const now = Date.now();
  const start = utcDayStart(now);
  // A legacy summary has two agreeing counters, both initialized after the first receipt.
  await publish(f, now - 1);
  for (let i = 0; i < 4; i++) receipt(f, i, start);
  await publish(f, now, 2, true, 2);
  assert.equal(flowToday(await getFlow(f), now, start).landed, 4, 'publication included in the replay once');
  receipt(f, 4, now);
  await publish(f, now, 1, true, 4);
  await publish(f, now, 1, true, 4);
  assert.equal(
    flowToday(await getFlow(f), now, start).landed,
    5,
    'same-time publications count once per sequence',
  );
  assert.equal((await rebuild(f, start)).receipts, 0);
});

for (const count of [299, 301]) {
  test(`a day with ${count} receipts reports landing coverage based on the real page boundary`, async t => {
    const f = await finishFixture(t, { startAt: Date.UTC(2026, 10, 10, 12, 30) });
    const now = Date.now();
    const start = utcDayStart(now);
    await publish(f, now, 310);
    // Two distinct receipt times in the same hour as the live count.
    for (let i = 0; i < count; i++) receipt(f, i, i < 200 ? now - 1 : now);
    boundedProvider(f);
    channel(f, selection => ({ ...selection, sourceRevision: count - 1 }));
    const result = await rebuild(f, start);
    assert.equal(result.receipts, Math.min(300, count));
    assert.equal(
      result.landed,
      count <= 300 ? count : 310,
      'exact replay replaces a complete day, capped replay keeps known counts',
    );
    assert.equal(result.partial.includes('landed'), count > 300);
  });
}

test('a capped replay counts the new batch once even when the receipt page never reaches it', async t => {
  const f = await finishFixture(t);
  const now = Date.now();
  const start = utcDayStart(now);
  for (let i = 0; i < 305; i++) receipt(f, i, start);
  for (let i = 305; i < 309; i++) receipt(f, i, now);
  boundedProvider(f);
  await publish(f, now, 4, true, 305);
  const result = flowToday(await getFlow(f), now, start);
  assert.equal(result.landed, 304, '300 known legacy receipts plus all four newly published receipts');
  assert.ok(result.partial.includes('landed'));
});

const savedEnvironment = Object.fromEntries(Object.keys(synthetic).map(key => [key, process.env[key]]));
test.beforeEach(t => storageClock(t));
test.before(() => Object.assign(process.env, synthetic));
test.after(() => {
  for (const [key, value] of Object.entries(savedEnvironment)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

for (const batch of [false, true]) {
  test(`a ${batch ? 'batch' : 'single'} publication commits when historical receipts exhaust the repair byte budget`, async t => {
    const f = batch ? await batchesFixture(t) : await finishFixture(t);
    const start = utcDayStart(Date.now());
    for (let i = 0; i < 250; i++) receipt(f, i, start);
    channel(f, selection => ({
      ...selection,
      sourceRevision: 249,
      receipt: {
        ...selection.receipt,
        previousHead: selection.head,
        previousReceiptId: 'older-synthetic-receipt',
      },
    }));
    // Charge the replay's queried receipts at a synthetic size without making
    // unrelated acceptance point reads large too.
    boundedProvider(f, 80 * 1024);
    if (!batch) await f.enqueue(f.request());
    for (let round = 0; round < 3; round++) {
      if (batch) await f.drain();
      else while (f.pending().length) await f.execute();
      await f.passChecks();
    }
    if (batch) await f.drain();
    else while (f.pending().length) await f.execute();
    const published = [...f.tables.projectHostedAcceptances.values()].filter(row => row.sequence >= 250);
    assert.equal(published.length, batch ? 4 : 1, 'acceptance survives a byte-limited legacy day');
    const day = flowToday(await getFlow(f), Date.now(), start);
    assert.ok(day.partial.includes('landed'), 'byte-bounded history is explicitly partial');
    assert.equal(day.landed, 12 + published.length, 'the live publication counts every new receipt once');
  });
}

test('Flow recovers the retained main verdict while an absent, running or inconclusive audit gives no first verdict', async t => {
  const f = await finishFixture(t);
  const now = Date.now();
  await publish(f, now, 0);
  const projection = () => getFlow(f).then(flowVerdict);
  assert.equal(await projection(), null, 'main has no conclusive check yet');
  const auditId = await update(f, ctx =>
    ctx.db.insert('projectHostedMainAudits', { projectId: f.projectId }),
  );
  const check = { runId: 'a'.repeat(8), sequence: 1, head: snapshot(now).head };
  const patch = value => update(f, ctx => ctx.db.patch(auditId, value));
  await patch({ audit: { ...check, status: 'running' } });
  assert.equal(await projection(), null);
  await patch({ audit: { ...check, status: 'passed' } });
  assert.equal(await projection(), null, 'a reduced pass never established lastGreen');

  await patch({ lastGreen: check });
  assert.deepEqual(
    await projection(),
    { red: false, since: null, checkedAt: null },
    'a retained green with no run keeps its verdict',
  );
  assert.equal(
    (await getFlow(f)).main,
    undefined,
    'the old wire field remains absent without a known streak',
  );
  for (const [runId, endedAt] of [
    ['green-one', now - 60_000],
    ['green-two', now],
  ]) {
    f.tables.projectHostedCheckRuns.set(runId, {
      _id: runId,
      _creationTime: now,
      projectId: f.projectId,
      runId,
      candidateId: 'synthetic',
      status: 'passed',
      value: JSON.stringify({ status: 'passed', endedAt: new Date(endedAt).toISOString() }),
    });
    await patch({ lastGreen: { ...check, runId } });
    assert.deepEqual(
      await projection(),
      { red: false, since: null, checkedAt: endedAt },
      'a pass is evidence at a time, not the start of the green streak',
    );
  }
  await patch({ red: { runId: check.runId, head: check.head, since: new Date(now).toISOString() } });
  assert.deepEqual(await projection(), { red: true, since: now, checkedAt: null });
  await rebuild(f, utcDayStart(now));
  assert.deepEqual(
    JSON.parse(summary(f).value).flow.main,
    { red: true, since: now },
    'repair seeds the shared summary',
  );
});
