// SPDX-License-Identifier: Apache-2.0
// The top bar's main figure (Item 32e8de50): landings on main today and the share that landed first try, judged on
// the landing's own write (docs/concepts.md#first-try). A Lane whose submission ended without landing is marked on the
// patch that end already makes, the next submission's binding carries the mark, and its landing counts as not a
// first try; the summary writes per landing stay what they were, and agents read the same figure with its words.
import test from 'node:test';
import { storageClock } from './storage-clock.mjs';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { synthetic } from './hosted-landing-batches-fixture.mjs';
import { finishFixture } from './hosted-finish-fixture.mjs';
import { moduleUrl } from './convex-module.mjs';
const line = await import(moduleUrl('../convex/projectLiveLine.ts'));
const sub = await import(moduleUrl('../convex/projectLiveLineSubmission.ts'));
const store = await import(moduleUrl('../convex/projectLiveLineStore.ts'));
const day = await import(moduleUrl('../src/flow-day.ts'));
const main = await import(moduleUrl('../src/hosted-main.ts'));
const cli = await import(moduleUrl('../src/hosted-pull.ts'));
const previousEnvironment = Object.fromEntries(Object.keys(synthetic).map(key => [key, process.env[key]]));
test.beforeEach(t => storageClock(t));
test.before(() => Object.assign(process.env, synthetic));
test.after(() => {
  for (const [key, value] of Object.entries(previousEnvironment)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});
const read = f => f.tx('observerBudgetPage', line.read, { projectId: f.projectId }, 'owner');
const marks = f => [...f.tables.projectLiveLineLanes.values()];
const state = (f, id, phase, extra = {}) => ({
  id,
  projectId: f.projectId,
  phase,
  held: false,
  hold: null,
  observation: { state: phase, pendingReason: null, cause: null },
  error: null,
  counts: { runnerSeconds: 60 },
  ...extra,
});
const bind = (f, s) =>
  f.tx(
    'mainTodayBind',
    {
      _handler: ctx =>
        sub.bindLineSubmission(ctx, s, {
          actor: 'owner',
          operationId: f.request().finish.composeOperationId,
        }),
    },
    {},
  );
const move = (f, before, after) =>
  f.tx(
    'mainTodayMove',
    {
      _handler: async ctx => {
        if (before.phase !== 'landed' && after.phase === 'landed')
          await store.writeLineMain(ctx, f.projectId, { head: after.id, at: new Date().toISOString() }, 1);
        await sub.transitionLineSubmission(ctx, before, after);
      },
    },
    {},
  );
function countSummaryWrites(f) {
  const rows = f.tables.projectFinishReadRows;
  const counter = { n: 0 };
  const set = rows.set.bind(rows);
  rows.set = (id, doc) => {
    if (doc?.kind === 'projectLiveLineSummary') counter.n++;
    return set(id, doc);
  };
  return counter;
}
const today = async f => day.mainToday((await read(f)).flow, Date.now());

test('a first submission lands first try, within the existing publication and exit writes', async t => {
  const f = await finishFixture(t);
  const a = state(f, randomUUID(), 'checking');
  await bind(f, a);
  const summary = countSummaryWrites(f);
  await move(f, a, { ...a, phase: 'landed' });
  assert.equal(summary.n, 2, 'publication and exit carry the count and judgement: no extra summary write');
  assert.deepEqual(await today(f), {
    landed: 1,
    firstTry: 1,
    judged: 1,
    share: 1,
    words: '1 today · 100% first try',
  });
});

test('a failed check marks the Lane on the patch it makes; the resubmission that lands is not a first try', async t => {
  const f = await finishFixture(t);
  const a = state(f, randomUUID(), 'checking');
  await bind(f, a);
  await move(f, a, {
    ...a,
    phase: 'terminal-failed',
    observation: { state: 'terminal-failed', pendingReason: null, cause: 'check-failed' },
    error: { code: 'CHECK_FAILED', message: 'synthetic' },
  });
  assert.ok(
    marks(f).every(mark => mark.retried === true),
    'the end without landing marks its Lane',
  );
  const b = state(f, randomUUID(), 'checking');
  await bind(f, b);
  await move(f, b, { ...b, phase: 'landed' });
  const figure = await today(f);
  assert.equal(figure.landed, 1);
  assert.equal(figure.firstTry, 0, 'landed after a needs-fix round');
  assert.equal(figure.judged, 1);
  assert.equal(figure.words, '1 today · 0% first try');
});

test('a withdrawn submission before any check also marks the Lane (one rule with Stats: ended without landing)', async t => {
  const f = await finishFixture(t);
  const a = state(f, randomUUID(), 'queued');
  await bind(f, a);
  await move(f, a, {
    ...a,
    phase: 'terminal-failed',
    error: { code: 'LANDING_CANCELLED', message: 'withdrawn' },
  });
  assert.ok(marks(f).every(mark => mark.retried === true));
});

test('a replaced attempt or a thrown-away check is not a first try, even with no bound Lane', async t => {
  const f = await finishFixture(t);
  const id = n => `${String(n).repeat(8)}-0000-4000-8000-000000000000`;
  await move(f, state(f, id(1), 'checking'), state(f, id(1), 'landed', { supersedes: randomUUID() }));
  await move(
    f,
    state(f, id(2), 'checking', { counts: { discardedRunnerSeconds: 30 } }),
    state(f, id(2), 'landed', { counts: { runnerSeconds: 60, discardedRunnerSeconds: 30 } }),
  );
  await move(
    f,
    state(f, id(3), 'checking'),
    state(f, id(3), 'landed', {
      counts: { runnerSeconds: 60, discardedRunnerUnknown: 'superseded-check-execution-unreported' },
    }),
  );
  await move(f, state(f, id(4), 'checking'), state(f, id(4), 'landed'));
  const figure = await today(f);
  assert.deepEqual(
    { landed: figure.landed, firstTry: figure.firstTry, judged: figure.judged },
    { landed: 4, firstTry: 1, judged: 4 },
  );
  assert.equal(figure.words, '4 today · 25% first try');
});

test('agents read the same figure: capabilities on a bare status, the clone’s main read on request', async t => {
  const f = await finishFixture(t);
  const a = state(f, randomUUID(), 'checking');
  await bind(f, a);
  await move(f, a, { ...a, phase: 'landed' });
  const read = await f.tx('mainTodayRead', { _handler: ctx => store.readMainDay(ctx.db, f.projectId) }, {});
  // The server sends the stored day, not a figure: a cached read never serves yesterday's after UTC midnight.
  const sent = main.mainDaySchema.parse(read);
  assert.deepEqual(await cli.mainTodayFrom(sent), await today(f), 'one source for web and agents');
});

test('the share counts only judged landings, rounds away from 0 % and 100 %, and follows the UTC day', () => {
  const hour = day.HOUR_MS;
  const start = 20_000 * 24 * hour; // a UTC midnight
  let value = day.stepFlow(undefined, start - hour, { landed: 1, first: true });
  // A landing written before the judgement existed counts as landed, never as a first try or a miss.
  value = day.stepFlow(value, start + hour, { landed: 1 });
  for (let i = 0; i < 299; i++) value = day.stepFlow(value, start + 2 * hour, { landed: 1, first: i !== 0 });
  const figure = day.mainToday(value, start + 3 * hour);
  assert.equal(figure.landed, 300, 'yesterday’s landing is not today’s');
  assert.equal(figure.judged, 299);
  assert.equal(day.firstTryPercent(figure), 99, '298 of 299 is not shown as 100 %');
  assert.equal(day.firstTryPercent({ firstTry: 1, judged: 299 }), 1, '1 of 299 is not shown as 0 %');
  assert.equal(day.mainTodayWords({ landed: 0, firstTry: 0, judged: 0, share: null }), '0 today');
  assert.equal(day.utcDayStart(start + 3 * hour), start);
  assert.deepEqual(
    day.flowDay({ hours: [], took: [], first: [[1, 2]] }).first,
    [],
    'another row shape is dropped',
  );
});
