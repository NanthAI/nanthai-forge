// SPDX-License-Identifier: Apache-2.0
// Item a217b83e follow-ups. (1) Name the landing behind a whole-check shift, judged on full checks reserved
// after it landed: the check runner runs from main, so the landing whose own check first saw the shift is
// never blamed (lead 7c9e5a86). Replayed on the live 2026-11-19 checks around d5de1c98 (hosted coverage
// stopped, runner minutes per full check about 121 -> 77). (2) The daily waste tripwire: cancelled or
// discarded runner minutes per UTC day, same alert/P0 path, F1 ratchet and not-enough-data note (lead
// 20b27f1d). Replayed on the live days 2026-11-09 to 11-19. (5) Every ratchet undo records the flow it
// could have moved: landings landed while the tighter line held, and outcomes it changed (0: speed lines
// only send alerts; lead note on a217b83e).
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import {
  LINE_OUTCOMES_CHANGED,
  closedDay,
  judgeClosedDay,
  observeLandingSpeed,
  speedBudgetIssue,
  speedBudgetMessage,
  speedBudgetsSchema,
  wholeCheckShift,
} from '../dist/landing-speed-alerts.js';
import { speedBudgets as budgets } from '../dist/speed-budgets.js';
import { speedBudgetRows } from '../dist/speed-budgets-report.js';
import { readHostedMetricPages } from '../dist/self-metrics-hosted-pages.js';
import { fixture, period as metricPeriod, at as metricAt } from './self-metrics-hosted-fixture.mjs';

const replayData = JSON.parse(
  readFileSync(new URL('./fixtures/speed-budget-replay-2026-11-19.json', import.meta.url), 'utf8'),
);
const minute = 60_000,
  hour = 60 * minute,
  day = 24 * hour;
const pad = id => id.padEnd(36, '0');
function replay(state, list, set = budgets) {
  const events = [];
  for (const s of list) {
    const out = observeLandingSpeed(state, s, set);
    state = out.state;
    events.push(...out.events);
  }
  return { state, events };
}
const r1 = n => Math.round(n * 10) / 10;
/** The live landings: a full check stamps slot 6 (batch members carry a share, never a full-check stamp). */
const liveSamples = () =>
  replayData.checks.map(([id, committed, reserved, ended, exec, effective, batch]) => {
    const at = Date.parse(committed),
      check = r1((Date.parse(ended) - Date.parse(reserved)) / minute),
      settle = r1((at - Date.parse(ended)) / 1000);
    return {
      at,
      id: pad(id),
      toMain: 20,
      check,
      settle,
      counts: [0, 0, 0, exec, 0, 0, ...(effective === 'full' && !batch ? [exec] : [])],
      stages: { queue: 5, check, settle: settle / 60 },
    };
  });

test('live replay: the d5de1c98 shift is named once, on checks reserved after it landed, never on the check that saw it', () => {
  const samples = liveSamples();
  const { events } = replay(null, samples);
  const shifts = events.filter(e => e.kind === 'shift');
  assert.equal(shifts.length, 1, 'one message per shift');
  const [shift] = shifts;
  assert(
    shift.shift.before > 110 && shift.shift.after < 90,
    `121 -> 77 runner min: ${shift.shift.before} -> ${shift.shift.after}`,
  );
  const named = shift.shift.landings.map(id => id.slice(0, 8));
  // The coverage change landed in batch 378ab39b at 14:04:51Z; its own run (reserved 13:48:47Z) is pre-shift.
  assert(named.includes('378ab39b'), `the cause is named: ${named}`);
  // 1c9278da's check (reserved 14:28:44Z) is the first full check after: it saw the shift, it did not cause it.
  assert(!named.includes('1c9278da'), 'the landing whose check first saw it is not named');
  // Only the landings committed between the last full check before (13:16:21Z) and the first after.
  for (const id of named) {
    const row = replayData.checks.find(c => c[0] === id);
    assert(row[1] >= '2026-11-19T13:16:21' && row[1] < '2026-11-19T14:28:44', `${id} landed in the gap`);
  }
  assert.equal(named.length, 9, 'full-check spacing bounds the precision: 9 of the 84 replayed landings');
  // Judged once three full checks after it agree: not before the third one landed.
  const third = samples.findIndex(s => s.id.startsWith('beead25b'));
  assert.equal(shift.since, new Date(samples[third].at).toISOString());
  const text = speedBudgetMessage(shift, 'dogfood', budgets).text;
  assert.match(text, /Runner minutes per full check went from [\d.]+ to [\d.]+ min/);
  assert.match(text, /never in the landing whose own check saw it/);
  assert.match(text, /378ab39b/);
  assert.match(text, /Credit, not a fault/);
  assert.match(text, /opens no Issue/);
});

/** One full check per landing, reserved 12 min before it commits; runner minutes from `value(i)`. */
const fullLandings = (from, count, value, idPrefix = 'f') =>
  Array.from({ length: count }, (_, i) => ({
    at: from + i * 20 * minute,
    id: pad(`${idPrefix}${i}`),
    toMain: 20,
    check: 10,
    settle: 120,
    counts: [0, 0, 0, value(i) * 60, 0, 0, value(i) * 60],
    stages: { queue: 8, check: 10, settle: 2 },
  }));
const docs = (at, id) => ({
  at,
  id: pad(id),
  toMain: 5,
  check: 1,
  settle: 5,
  counts: [0, 0, 0, 30, 0, 0],
  stages: { queue: 3, check: 1, settle: 0.1 },
});

test('a slowdown names the landing committed between checks; one slow runner or a slow creep names nobody', () => {
  const t0 = Date.parse('2026-11-21T08:00:00.000Z');
  const steady = i => 76 + ((i * 7) % 5) - 2; // 74 to 78 runner min
  const before = fullLandings(t0, 12, steady, 'a');
  // The last pre-shift check (reserved at R) lands late, after the first slower check is reserved; the
  // culprit, a docs-sized landing, lands in between. A landing that commits inside the gap is a candidate
  // too, so only the culprit is named here.
  const last = before.at(-1),
    R = last.at - 12 * minute;
  Object.assign(last, { at: R + 40 * minute, settle: 1800, stages: { queue: 8, check: 10, settle: 30 } });
  const culprit = docs(R + 15 * minute, 'culprit');
  const after = fullLandings(R + 32 * minute, 4, i => 120 + i, 'b');
  const { events } = replay(null, [...before, culprit, ...after]);
  const shift = events.filter(e => e.kind === 'shift');
  assert.equal(shift.length, 1);
  assert.deepEqual(
    shift[0].shift.landings.map(id => id.replace(/0+$/, '')),
    ['culprit'],
    'only the landing in the gap',
  );
  assert.match(
    speedBudgetMessage(shift[0], 'synthetic', budgets).text,
    /adds about [\d.]+ runner minutes to every full check/,
  );
  // No repeat while the shift stays in the row.
  const later = replay(
    replay(null, [...before, culprit, ...after]).state,
    fullLandings(after.at(-1).at + hour, 6, () => 121, 'c'),
  );
  assert.deepEqual(
    later.events.filter(e => e.kind === 'shift'),
    [],
  );

  // One slow runner among steady checks, then a creep of 1% per check: never a shift.
  const blip = fullLandings(t0, 20, i => (i === 14 ? 130 : steady(i)), 'd');
  assert.deepEqual(
    replay(null, blip).events.filter(e => e.kind === 'shift'),
    [],
  );
  const creep = fullLandings(t0, 30, i => 76 * 1.01 ** i, 'e');
  assert.deepEqual(
    replay(null, creep).events.filter(e => e.kind === 'shift'),
    [],
  );
  // Scoped checks carry no full-check stamp and never form a split.
  assert.equal(
    wholeCheckShift(before.map(s => [s.at, 20, 10, s.id, 120, null, null, [0, 0, 0, 1, 0, 0]])),
    null,
  );
});

const waste = budgets.budgets.find(b => b.id === 'runner-waste-daily');
/** The live days as the Stats day close sees them: each accepted landing's discarded seconds (null: pending). */
const wasteDays = (data = replayData.wasteDays) =>
  Object.entries(data).map(([d, values]) =>
    closedDay(
      d,
      values.map((minutes, i) => ({
        id: pad(`${d.slice(5).replace('-', '')}w${i}`),
        discardedRunnerSeconds: minutes === null ? null : minutes * 60,
      })),
    ),
  );
function closeDays(state, days) {
  const events = [];
  for (const closed of days) {
    const out = judgeClosedDay(state, closed, budgets);
    state = out.state;
    events.push(...out.events);
  }
  return { state, events };
}

test('live replay: the daily waste tripwire breaks on the 11-17 incident day and the 11-19 wave, recovers between', () => {
  assert(waste && waste.stat === 'day' && waste.max > 0, 'the budget exists in src/speed-budgets.json');
  assert.doesNotThrow(() => speedBudgetsSchema.parse(budgets));
  const { state, events } = closeDays(undefined, wasteDays());
  const mine = events.filter(e => e.budget.id === waste.id);
  assert.deepEqual(
    mine.map(e => `${e.kind} ${e.day}`),
    ['short 2026-11-09', 'broken 2026-11-17', 'recovered 2026-11-18', 'broken 2026-11-19'],
  );
  const [short, broken, recovered, again] = mine;
  assert.equal(short.unknown, 130, 'every 11-09 landing predates the stamp: not enough data, not zero');
  assert.match(
    speedBudgetMessage(short, 'dogfood', budgets).text,
    /Not enough data: a day missing more than half/,
  );
  assert(Math.abs(broken.value - 6613) < 2, `11-17 total: ${broken.value}`);
  assert(Math.abs(again.value - 7945) < 2, `11-19 total: ${again.value}`);
  assert.equal(recovered.landing, broken.landing, 'the recovery names the break it ends');
  const said = speedBudgetMessage(broken, 'dogfood', budgets).text;
  assert.match(
    said,
    /cancelled or discarded runner minutes per UTC day on UTC day 2026-11-17 \(114 landings\) was 66\d\d(\.\d)? min; budget 2100 min/,
  );
  assert.match(said, /Most of that day's waste came from landing 1117w\d+/);
  const issue = speedBudgetIssue(broken, 'p1', budgets);
  assert.match(issue.title, /^P0 speed budget broken: cancelled or discarded runner minutes per UTC day/);
  assert.match(issue.body, /on each closed UTC day must stay at or under 2100 min/);
  assert.match(issue.body, /Crossed on UTC day 2026-11-17/);
  assert.equal(issue.reopen, true);
  // The day state rides on one Stats day row per day (never the landing row) and stays small.
  assert(JSON.stringify(state).length <= 600, JSON.stringify(state));
  // Window budgets are never judged here, and a landing never judges a day budget.
  assert(events.every(e => e.budget.stat === 'day'));
  const landing = observeLandingSpeed(
    null,
    {
      at: Date.parse('2026-11-19T10:00:00Z'),
      id: pad('x'),
      toMain: 20,
      check: 10,
      settle: 8,
      counts: [0, 0, 0, 1, 9e6, 0],
      stages: { queue: 9, check: 10, settle: 0.1 },
    },
    budgets,
  );
  assert(landing.events.every(e => e.budget.id !== waste.id) && !('waste' in landing.state));
});

test('the daily line ratchets with the F1 rules: 7 quiet days tighten it, a normal day undoes it without a P0', () => {
  const quiet = Object.fromEntries(
    Array.from({ length: 8 }, (_, d) => [
      `2026-12-${String(d + 1).padStart(2, '0')}`,
      [100, 120 + d * 5, 90],
    ]),
  );
  let { state, events } = closeDays(undefined, wasteDays(quiet));
  const tightened = events.filter(e => e.kind === 'ratcheted');
  assert.equal(tightened.length, 1, 'the seventh held day tightens it once');
  assert.equal(tightened[0].day, '2026-12-07');
  const line = tightened[0].line;
  assert(line < waste.max && line >= 0.15 * waste.max, `F1: band at least 15% of the old line, got ${line}`);
  ({ state, events } = closeDays(state, wasteDays({ '2026-12-09': [Math.ceil(line) + 400] })));
  assert.deepEqual(
    events.map(e => e.kind),
    ['undone'],
    'over the tightened line, under the file max: a message, no P0',
  );
  // Tightened at the 12-07 close: the 12-08 day (3 landings) and the 12-09 day (1) landed while it held.
  assert.deepEqual(events[0].flow, { landed: 4, changed: 0 });
  assert.deepEqual(state.ratchet[waste.id].undos, [['2026-12-09', line, waste.max, 4, 0]]);
  ({ events } = closeDays(state, wasteDays({ '2026-12-11': [waste.max + 1] })));
  assert.deepEqual(
    events.map(e => e.kind),
    ['broken'],
    'over the file max is the P0',
  );
});

test('a closed day counts pending usage as unknown and names the landing that discarded the most', () => {
  assert.deepEqual(
    closedDay('2026-12-20', [
      { id: pad('a1'), discardedRunnerSeconds: 600 },
      { id: pad('b2'), discardedRunnerSeconds: null },
      { id: pad('c3'), discardedRunnerSeconds: 1800 },
      { id: pad('d4'), discardedRunnerSeconds: 0 },
    ]),
    { day: '2026-12-20', seconds: 2400, unknown: 1, landings: 4, top: 'c3000000' },
  );
  assert.equal(closedDay('2026-12-21', [{ id: pad('e5'), discardedRunnerSeconds: 0 }]).top, null);
  // More than half unknown: one note, then judged again once a day has its data.
  let out = judgeClosedDay(
    undefined,
    { day: '2026-12-22', seconds: 0, unknown: 3, landings: 4, top: null },
    budgets,
  );
  assert.deepEqual(
    out.events.map(e => e.kind),
    ['short'],
  );
  out = judgeClosedDay(
    out.state,
    { day: '2026-12-23', seconds: 0, unknown: 3, landings: 4, top: null },
    budgets,
  );
  assert.deepEqual(out.events, [], 'the note is said once');
  out = judgeClosedDay(
    out.state,
    { day: '2026-12-24', seconds: 60, unknown: 0, landings: 4, top: null },
    budgets,
  );
  assert(!out.state.short && out.state.ratchet[waste.id]);
});

test('every ratchet undo records its flow: landings landed while it held, and 0 outcomes changed', () => {
  const set = speedBudgetsSchema.parse({
    ...budgets,
    budgets: [{ ...budgets.budgets.find(b => b.id === 'check-p50'), max: 10 }],
  });
  const t0 = Date.parse('2026-12-01T09:00:00.000Z');
  const landing = (at, check, i) => ({
    at,
    id: pad(`u${i}`),
    toMain: 20,
    check,
    settle: 8,
    stages: { queue: 9, check, settle: 0.1 },
  });
  // Day 1 holds under 20 landings (no window value yet), so seven held days close on day 9.
  const list = Array.from({ length: 90 }, (_, i) =>
    landing(t0 + Math.floor(i / 10) * day + (i % 10) * hour, 7 + (i % 5) * 0.2, i),
  );
  let { state, events } = replay(null, list, set);
  const line = events.find(e => e.kind === 'ratcheted').line;
  const over = Array.from({ length: 15 }, (_, i) => landing(t0 + 9 * day + i * hour, line + 0.6, 100 + i));
  ({ state, events } = replay(state, over, set));
  const undone = events.find(e => e.kind === 'undone');
  assert(undone, 'the window over the tightened line undoes it');
  assert.equal(undone.flow.changed, 0);
  assert(undone.flow.landed > 0 && undone.flow.landed <= 40, `landed while it held: ${undone.flow.landed}`);
  assert.match(
    undone.reason,
    /Flow: \d+ landings landed while it held; it changed 0 of their outcomes \(a speed line only sends alerts\)\./,
  );
  assert.deepEqual(state.ratchet['check-p50'].undos, [['2026-12-10', line, 10, undone.flow.landed, 0]]);
  assert.match(speedBudgetMessage(undone, 'synthetic', set).text, /changed 0 of their outcomes/);
  assert.equal(LINE_OUTCOMES_CHANGED, 0);
});

test('0 outcomes changed holds only while no landing path reads a speed line: every reader of the speed row is listed', () => {
  // A new reader (a gate, a queue hold) must make the undo record count the outcomes it changed, then join this list.
  const readers = readdirSync(new URL('../convex/', import.meta.url))
    .filter(file => file.endsWith('.ts'))
    .filter(file =>
      /\.query\('projectLandingSpeed'\)/.test(
        readFileSync(new URL(`../convex/${file}`, import.meta.url), 'utf8'),
      ),
    )
    .sort();
  assert.deepEqual(readers, [
    'projectFailureCause.ts', // expected check time shown on the check screen
    'projectLandingSpeed.ts', // the alert path itself
    'projectLandingSpeedRepair.ts', // maintenance of retained samples
    'projectSelfMetrics.ts', // nforge metrics
  ]);
});

test('nforge metrics judges the newest whole UTC day, names the worst, and says when a day has too little data', () => {
  const finishTimings = Object.entries(replayData.wasteDays).flatMap(([d, values]) =>
    values.map((minutes, i) => ({
      id: `${d}-${i}`,
      at: new Date(Date.parse(`${d}T00:00:00.000Z`) + (i + 1) * 60_000).toISOString(),
      minutes: 20,
      costs: { runnerDiscarded: minutes },
    })),
  );
  const row = (from, to) =>
    speedBudgetRows({ finishTimings, runs: [] }, { from, to }, budgets).find(r => r.id === waste.id);
  const busy = row('2026-11-09T00:00:00.000Z', '2026-11-20T00:00:00.000Z');
  assert.equal(busy.status, 'fail');
  assert(Math.abs(busy.value - 7945) < 2);
  assert.match(busy.note, /UTC day 2026-11-19: 101 landings, 3 unknown/);
  assert.match(busy.note, /worst whole day in the period 2026-11-19/);
  const calm = row('2026-11-12T00:00:00.000Z', '2026-11-17T00:00:00.000Z');
  assert.equal(calm.status, 'pass');
  assert.match(calm.note, /UTC day 2026-11-16/);
  const early = row('2026-11-09T00:00:00.000Z', '2026-11-10T00:00:00.000Z');
  assert.equal(early.status, 'unrun');
  assert.match(early.note, /not enough data/);
});

test('review d2d1a7e8: nforge metrics reads the daily line from the Stats day row and agrees with the close on every P0', () => {
  // The day state lives on the newest Stats day row (the landing row never holds it). Eight quiet days
  // tighten the line at the 12-07 close; 12-08 holds it.
  const quiet = Object.fromEntries(
    Array.from({ length: 8 }, (_, d) => [
      `2026-12-${String(d + 1).padStart(2, '0')}`,
      [100, 120 + d * 5, 90],
    ]),
  );
  const { state } = closeDays(undefined, wasteDays(quiet));
  const line = state.ratchet[waste.id].line;
  assert(line < waste.max, 'the line tightened');
  const kept = { day: '2026-12-08', ratchet: state.ratchet };
  const timings = days =>
    Object.entries(days).flatMap(([d, values]) =>
      values.map((minutes, i) => ({
        id: `${d}-${i}`,
        at: new Date(Date.parse(`${d}T00:00:00.000Z`) + (i + 1) * 60_000).toISOString(),
        minutes: 20,
        costs: { runnerDiscarded: minutes },
      })),
    );
  const row = (days, dayBudgets, to = '2026-12-10T00:00:00.000Z') =>
    speedBudgetRows(
      { finishTimings: timings(days), runs: [], ...(dayBudgets ? { dayBudgets } : {}) },
      { from: '2026-12-01T00:00:00.000Z', to },
      budgets,
    ).find(r => r.id === waste.id);
  // Held: the automatic line shows, with the row that keeps it.
  const held = row(quiet, kept, '2026-12-09T00:00:00.000Z');
  assert.equal(held.line, line);
  assert.match(held.note, new RegExp(`automatic line ${line} \\(ratcheted 2026-12-07\\)`));
  assert.match(held.note, /kept by the Stats day close through 2026-12-08/);
  assert.equal(held.status, 'pass');
  // Before the 7th held day: the days left show.
  const early = closeDays(undefined, wasteDays(Object.fromEntries(Object.entries(quiet).slice(0, 3)))).state;
  const waiting = row(quiet, { day: '2026-12-03', ratchet: early.ratchet }, '2026-12-04T00:00:00.000Z');
  assert.equal(waiting.line, undefined);
  assert.match(
    waiting.note,
    /next ratchet check in 4 held days; kept by the Stats day close through 2026-12-03/,
  );
  // A landing-row ratchet entry for the same id is never read for a day budget.
  const stray = speedBudgetRows(
    { finishTimings: timings(quiet), runs: [], landingSpeed: { ratchet: state.ratchet } },
    { from: '2026-12-01T00:00:00.000Z', to: '2026-12-09T00:00:00.000Z' },
    budgets,
  ).find(r => r.id === waste.id);
  assert.equal(stray.line, undefined, 'the day line comes from the Stats day row only');
  // Each next day, metrics and the close agree on the P0: under the line, over it (undo, no P0), over the max.
  for (const minutes of [Math.floor(line) - 50, Math.ceil(line) + 50, waste.max - 10, waste.max + 50]) {
    const next = { ...quiet, '2026-12-09': [minutes] };
    const closed = judgeClosedDay(state, wasteDays({ '2026-12-09': [minutes] })[0], budgets);
    const p0 = closed.events.some(e => e.budget.id === waste.id && e.kind === 'broken');
    const metrics = row(next, kept);
    assert.equal(
      metrics.status,
      p0 ? 'fail' : 'pass',
      `${minutes} min: metrics ${metrics.status}, close P0 ${p0}`,
    );
    if (minutes > line && minutes <= waste.max) {
      assert(
        closed.events.some(e => e.kind === 'undone'),
        'over the tightened line the close undoes it',
      );
      assert.match(metrics.note, /over the automatic line: the day close undoes the ratchet/);
    }
  }
});

test('review d2d1a7e8: the metrics read takes the day line from the newest Stats day row, on the first acceptances page only', async () => {
  const f = fixture();
  f.landing('one', metricAt(10), metricAt(10));
  const quiet = Object.fromEntries(
    Array.from({ length: 8 }, (_, d) => [`2026-12-${String(d + 1).padStart(2, '0')}`, [100, 90]]),
  );
  const older = closeDays(undefined, wasteDays(Object.fromEntries(Object.entries(quiet).slice(0, 2)))).state;
  const newer = closeDays(undefined, wasteDays(quiet)).state;
  const stats = (day, state) =>
    f.put(
      'projectStatsDays',
      { projectId: 'project', day, value: '{}', budgets: JSON.stringify(state) },
      `${day}T00:10:00.000Z`,
    );
  stats('2026-12-08', newer);
  stats('2026-12-02', older);
  const first = JSON.parse(
    await f.query('projectSelfMetrics:page', { stream: 'acceptances', ...metricPeriod, cursor: null }),
  );
  assert.deepEqual(first.dayBudgets, { day: '2026-12-08', ratchet: newer.ratchet }, 'the newest day row');
  const runs = JSON.parse(
    await f.query('projectSelfMetrics:page', { stream: 'runs', ...metricPeriod, cursor: null }),
  );
  assert.equal(runs.dayBudgets, undefined, 'it rides only on the first acceptances page');
  const { records } = await readHostedMetricPages(f.query, metricPeriod);
  assert.deepEqual(records.dayBudgets, first.dayBudgets);
  assert.equal(f.meter.writes, 0);
});
