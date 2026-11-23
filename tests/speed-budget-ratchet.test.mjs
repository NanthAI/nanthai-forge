// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Ferdinando Valsecchi
// Issue a217b83e: speed budgets must not let check time bloat again after d5de1c98 (check p50 886 s to
// 663 s, shard runner-minutes per full check 121 to 82, receipt 378ab39b). Runner minutes per full check
// get their own budget (parallel shards hid coverage from wall time), and a line that holds for seven
// closed days ratchets down to the measured value plus its noise band (at least 15% of the line, never
// under the value judged now). A window over a ratcheted line but under the file max undoes the ratchet
// with a message, never a P0 (review F1 on a217b83e).
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  landingSpeedSample,
  observeLandingSpeed,
  speedBudgetIssue,
  speedBudgetMessage,
  speedBudgetsSchema,
} from '../dist/landing-speed-alerts.js';
import { speedBudgets as budgets } from '../dist/speed-budgets.js';
import { formatSpeedBudgets, speedBudgetRows } from '../dist/speed-budgets-report.js';
import { moduleUrl } from './convex-module.mjs';
const { retainCheckProgress } = await import(moduleUrl('../convex/projectHostedLandingCheckProgress.ts'));

const minute = 60_000,
  hour = 60 * minute,
  day = 24 * hour,
  start = Date.parse('2026-11-20T09:00:00.000Z');
const full = budgets.budgets.find(b => b.metric === 'runnerFull');
let n = 0;
/** One landing: check minutes, and accepted runner seconds stamped full or scoped. */
const sample = (at, { check = 10, runner = 4800, isFull = true } = {}) => ({
  at,
  id: `l${n++}`.padEnd(36, '0'),
  toMain: 20,
  check,
  settle: 8,
  counts: [1, 1, 1, runner, 0, 0, isFull ? runner : null],
  stages: { queue: 9, check, settle: 0.1 },
});
function replay(state, list, set = budgets) {
  const events = [];
  for (const s of list) {
    const out = observeLandingSpeed(state, s, set);
    state = out.state;
    events.push(...out.events);
  }
  return { state, events };
}

test('runner minutes per full check: a heavier test set breaks it once, naming the landing; a recovery follows', () => {
  assert(full && full.stat === 'p50' && full.max > 0, 'the budget exists in src/speed-budgets.json');
  const W = budgets.window.landings;
  const normal = Math.floor(full.max * 60 * 0.8);
  let at = start;
  // Scoped checks between full ones never count toward, or against, the full-check window.
  const steady = Array.from({ length: W * 2 }, (_, i) =>
    sample((at += minute), { runner: i % 2 ? 300 : normal, isFull: i % 2 === 0 }),
  );
  let { state, events } = replay(null, steady);
  assert.deepEqual(
    events.filter(e => e.budget.id === full.id),
    [],
  );
  const heavy = Math.ceil(full.max * 60 * 1.6);
  const slow = Array.from({ length: W }, () => sample((at += minute), { runner: heavy }));
  ({ state, events } = replay(state, slow));
  // The step is also a whole-check shift: named once, as its own message (tests/speed-budget-shift-waste.test.mjs).
  assert.deepEqual(
    events.filter(e => e.kind === 'shift').map(e => e.shift.after > e.shift.before),
    [true],
  );
  events = events.filter(e => e.kind !== 'shift');
  const broken = events.filter(e => e.budget.id === full.id);
  assert.equal(broken.length, 1, 'one alert, not one per landing');
  assert.equal(broken[0].kind, 'broken');
  assert.equal(broken[0].landing, slow[Math.floor(W / 2)].id, 'the landing that tipped the median is named');
  const text = speedBudgetMessage(broken[0], 'synthetic', budgets).text;
  assert.match(text, /runner minutes per full check p50/);
  assert.match(text, /checkTime/);
  ({ events } = replay(
    state,
    Array.from({ length: W }, () => sample((at += minute), { runner: normal })),
  ));
  const back = events.filter(e => e.kind === 'shift');
  assert(
    back.length <= 1 && back.every(e => e.shift.after < e.shift.before),
    'at most one shift, back to faster',
  );
  assert.deepEqual(
    events.filter(e => e.budget.id === full.id && e.kind !== 'shift').map(e => e.kind),
    ['recovered'],
  );
});

test('the full-check stamp comes from the accepted run: full gate stamps it, a scoped recheck clears it', () => {
  const state = {
    at: '2026-11-20T09:00:00.000Z',
    timing: { committedAt: '2026-11-20T09:20:00.000Z' },
    version: 3,
  };
  const run = (effective, scoped) => ({
    id: 'r',
    at: '2026-11-20T09:01:00.000Z',
    status: 'passed',
    endedAt: '2026-11-20T09:12:00.000Z',
    counts: { completed: 1, passed: 1, failed: 0 },
    planDigest: null,
    executionId: null,
    terminalDigest: null,
    execution: { seconds: 4920.4, shards: 12 },
    gate: { mode: 'full', effective },
    plan: scoped ? { scoped: { reason: 'shared impact', tests: 40 } } : null,
  });
  retainCheckProgress(state, run('full', false), Date.parse('2026-11-20T09:12:00.000Z'));
  assert.deepEqual(state.counts, { runnerSeconds: 4920, runnerFull: true });
  assert.equal(landingSpeedSample(state).counts[6], 4920);
  retainCheckProgress(state, run('full', true), Date.parse('2026-11-20T09:13:00.000Z'));
  assert.deepEqual(state.counts, { runnerSeconds: 4920 });
  assert.equal(landingSpeedSample(state).counts[6], undefined, 'a scoped recheck is not a full check');
  // F6: a run with no gate (no configured contract gate, BYOCI) is a whole run.
  const ungated = run('full', false);
  delete ungated.gate;
  retainCheckProgress(state, ungated, Date.parse('2026-11-20T09:14:00.000Z'));
  assert.deepEqual(state.counts, { runnerSeconds: 4920, runnerFull: true });
  retainCheckProgress(state, run('changed', false), Date.parse('2026-11-20T09:15:00.000Z'));
  assert.equal(state.counts.runnerFull, undefined, 'a narrower effective gate is not a full check');
});

test('F5: too few full checks in a full row says so once, a note not silence; legacy rows never read as short', () => {
  const W = budgets.window.landings;
  let at = start;
  // 30% full checks: 12 of every 40 landings.
  const thin = Array.from({ length: 80 }, (_, i) =>
    sample((at += minute), { runner: 4000, isFull: i % 10 < 3 }),
  );
  const { state, events } = replay(null, thin);
  const short = events.filter(e => e.budget.id === full.id);
  assert.deepEqual(
    short.map(e => e.kind),
    ['short'],
    'once, not per landing',
  );
  assert(short[0].stamped < W);
  const text = speedBudgetMessage(short[0], 'synthetic', budgets).text;
  assert.match(text, /cannot be judged/);
  assert.match(text, /Not enough data/);
  assert.match(text, /full checks; batch members and scoped rechecks do not count/);
  assert(state.short[full.id]);
  // The metrics report says the same, beside the live row.
  const rows = speedBudgetRows(
    { finishTimings: [], runs: [], landingSpeed: { short: state.short } },
    { from: '2026-11-19T00:00:00.000Z', to: '2026-11-27T00:00:00.000Z', asOf: '2026-11-27T00:00:00.000Z' },
    budgets,
  );
  const row = rows.find(r => r.id === full.id);
  assert.equal(row.status, 'unrun');
  assert.match(row.note, /^not enough data: 0 full checks in the period, the window needs 20/);
  assert.match(row.note, /live row: too few stamped landings/);
  // Enough full checks again clears it silently, and a later shortage says so again.
  const back = replay(
    state,
    Array.from({ length: 40 }, () => sample((at += minute), { runner: 4000 })),
  );
  assert.equal(back.state.short?.[full.id], undefined);
  // A row written before the stamp existed does not read as short while its new full stamps (30% of
  // landings here) have not reached the oldest quarter of the row; once they span it, the note is due.
  const legacy = { ...state, samples: state.samples.map(r => [...r.slice(0, 7), [1, 1, 1, 4000, 0, 0]]) };
  delete legacy.short;
  const thinAgain = i => sample((at += minute), { runner: 4000, isFull: i % 10 < 3 });
  const late = replay(
    legacy,
    Array.from({ length: 30 }, (_, i) => thinAgain(i)),
  );
  assert.deepEqual(
    late.events.filter(e => e.budget.id === full.id),
    [],
  );
  const later = replay(
    late.state,
    Array.from({ length: 10 }, (_, i) => thinAgain(i)),
  );
  assert.deepEqual(
    later.events.filter(e => e.budget.id === full.id).map(e => e.kind),
    ['short'],
  );
});

/** A one-budget file so the ratchet is judged on its own numbers. */
const only = (extra = {}, max = 10) =>
  speedBudgetsSchema.parse({
    ...budgets,
    window: { landings: 5 },
    budgets: [
      {
        id: 'check-p50',
        area: 'hosted check run',
        measuredBy: 'landing-record',
        metric: 'check',
        stat: 'p50',
        unit: 'min',
        max,
        source: 'Synthetic: ratchet fixture, ten landings a day.',
        reason: 'Synthetic: judges the ratchet rule on its own numbers.',
        ...extra,
      },
    ],
  });
/** `days` UTC days of ten landings each, check minutes from `value(day, i)`. */
const days = (from, count, value) =>
  Array.from({ length: count }, (_, d) =>
    Array.from({ length: 10 }, (_, i) => sample(from + d * day + i * hour, { check: value(d, i) })),
  ).flat();
const steadyCheck = (d, i) => 7 + ((d * 3 + i) % 5) * 0.2; // 7.0 to 7.8 min

test('seven closed days under the line ratchet it to the measured value plus its noise band, recorded with a reason', () => {
  const set = only();
  let { state, events } = replay(null, days(start, 7, steadyCheck), set);
  assert.deepEqual(events, [], 'the seventh day is still open: no ratchet yet');
  ({ state, events } = replay(state, days(start + 7 * day, 1, steadyCheck), set));
  const ratchet = events.filter(e => e.kind === 'ratcheted');
  assert.equal(ratchet.length, 1, 'the first landing of the eighth day closes the seventh and ratchets once');
  const { from, line, reason } = ratchet[0];
  assert.equal(from, 10);
  const worst = Number(/worst ([\d.]+)/.exec(reason)[1]),
    median = Number(/median ([\d.]+)/.exec(reason)[1]);
  assert(
    line < 10 && line >= worst && worst >= 7,
    `tightened, never below the worst held day ${worst}: ${line}`,
  );
  assert(line >= median + 1.5 - 1e-9, `the band is at least 15% of the line 10: ${line}`);
  assert.match(reason, /7 closed days, 2026-11-20 to 2026-11-26/);
  assert.match(reason, /band [\d.]+ \(3 x 1.4826 x MAD, at least 15% of the line\)/);
  assert.equal(state.ratchet['check-p50'].line, line);
  assert.equal(state.ratchet['check-p50'].landing, ratchet[0].landing);
  const said = speedBudgetMessage(ratchet[0], 'synthetic', set).text;
  assert.match(said, /undoes it \(a message, not a P0\)/);
  assert.match(said, /pin the budget to its file max with "ratchet": false/);
  // F1: a window over the ratcheted line but under the file max undoes the ratchet, never a P0.
  const over = Math.round((line + 0.5) * 10) / 10;
  ({ state, events } = replay(
    state,
    days(start + 8 * day, 1, () => over),
    set,
  ));
  assert.deepEqual(
    events.map(e => e.kind),
    ['undone'],
  );
  assert.equal(events[0].from, line);
  assert.equal(events[0].line, 10, 'back to the line before it');
  assert.match(
    events[0].reason,
    /^Ratchet undone: the window reached [\d.]+, over the ratcheted line [\d.]+ \d+ days? after it tightened; line back to 10 \(the file max\)\./,
  );
  assert.match(speedBudgetMessage(events[0], 'synthetic', set).text, /no P0 Issue/);
  assert.equal(state.ratchet['check-p50'].line, undefined);
  // Over the file max is still the P0.
  ({ events } = replay(
    state,
    days(start + 9 * day, 1, () => 11),
    set,
  ));
  assert.deepEqual(
    events.map(e => e.kind),
    ['broken'],
  );
  assert.equal(events[0].line, 10);
});

test('F1: a quiet week followed by a normal day never opens a P0, and a ratchet never sets a line under the value judged now', () => {
  const set = only();
  const quiet = (d, i) => ([7.5, 7.5, 7.5, 7.5, 7.6, 7.4, 7.7][d] ?? 7.5) + (i % 2) * 0.01;
  // Day 7 ends on two slow landings: its p50 holds, but the window the next landing judges is higher.
  const rising = (d, i) => (d === 6 && i >= 8 ? 9.3 : quiet(d, i));
  let { state, events } = replay(null, days(start, 7, rising), set);
  // Day 8 opens on a value higher than every held day: it closes day 7 and ratchets with that floor.
  ({ state, events } = replay(
    state,
    days(start + 7 * day, 1, () => 9.3),
    set,
  ));
  const ratchet = events.find(e => e.kind === 'ratcheted');
  assert(ratchet && ratchet.line >= 9.3, `never under the value judged now: ${ratchet?.line}`);
  assert(!events.some(e => e.kind === 'broken' || e.kind === 'undone'));
  // A normal day after that: no P0, no undo.
  ({ events } = replay(
    state,
    days(start + 8 * day, 1, () => 7.8),
    set,
  ));
  assert.deepEqual(events, []);
  // Without the higher day: the band floor still leaves a normal day's spread under the line.
  ({ state, events } = replay(null, days(start, 8, quiet), set));
  const tight = state.ratchet['check-p50'].line;
  assert(tight >= 7.5 * 1.15, `15% band floor: ${tight}`);
  ({ events } = replay(
    state,
    days(start + 8 * day, 1, () => 7.9),
    set,
  ));
  assert.deepEqual(
    events.filter(e => e.kind === 'broken' || e.kind === 'undone'),
    [],
  );
});

test('F7: pinning after a ratchet judges at the file max; the report shows the automatic line and days left', () => {
  let { state } = replay(null, days(start, 8, steadyCheck), only());
  const line = state.ratchet['check-p50'].line;
  assert(line < 10);
  const period = {
    from: '2026-11-19T00:00:00.000Z',
    to: '2026-11-29T00:00:00.000Z',
    asOf: '2026-11-29T00:00:00.000Z',
  };
  const report = (set, live) =>
    formatSpeedBudgets(
      speedBudgetRows({ finishTimings: [], runs: [], landingSpeed: live }, period, set),
    ).join('\n');
  const text = report(only(), { ratchet: state.ratchet });
  assert.match(text, new RegExp(`check-p50: unrun / 10 min \\(automatic ${line}\\)`));
  assert.match(text, /automatic line [\d.]+ \(ratcheted 2026-11-27\); next ratchet check in 7 held days/);
  const pinned = only({ ratchet: false });
  let events;
  ({ state, events } = replay(
    state,
    days(start + 8 * day, 1, () => line + 0.5),
    pinned,
  ));
  assert.deepEqual(events, [], 'judged at the file max: no undo, no break');
  assert.equal(state.ratchet['check-p50'].line, undefined, 'the pin drops the ratcheted line');
  ({ state } = replay(state, days(start + 9 * day, 8, steadyCheck), pinned));
  assert.match(
    report(pinned, { ratchet: state.ratchet }),
    /pinned to the file max, automatic would pick [\d.]+/,
  );
});

test('a day over the line restarts the hold; a pinned line and a line at its data never move; the line never loosens', () => {
  const set = only();
  const spiky = (d, i) => (d === 3 && i > 3 ? 11 : steadyCheck(d, i));
  let { events } = replay(null, days(start, 10, spiky), set);
  assert.deepEqual(
    events.filter(e => e.kind === 'ratcheted'),
    [],
    'day 4 broke the hold; too few closed days follow it',
  );
  ({ events } = replay(null, days(start, 9, steadyCheck), only({ ratchet: false })));
  assert.deepEqual(
    events.filter(e => e.kind === 'ratcheted'),
    [],
    'ratchet false pins the line',
  );
  ({ events } = replay(
    null,
    days(start, 9, () => 10),
    set,
  ));
  assert.deepEqual(
    events.filter(e => e.kind === 'ratcheted'),
    [],
    'data at the line leaves it',
  );
  // An owner edit of the file max (with its reason) replaces the ratcheted line and restarts the hold.
  let { state } = replay(null, days(start, 8, steadyCheck), set);
  assert(state.ratchet['check-p50'].line < 10);
  ({ state, events } = replay(
    state,
    days(start + 8 * day, 1, () => 11),
    only({}, 12),
  ));
  assert.deepEqual(
    events.filter(e => e.kind === 'broken'),
    [],
    'judged on the new file line 12',
  );
  assert.equal(state.ratchet['check-p50'].line, undefined);
});

test('cost means keep their ledger: only percentile speed budgets ratchet, and the row stays bounded', () => {
  let { state } = replay(null, days(start, 6, steadyCheck));
  const ids = Object.keys(state.ratchet ?? {});
  assert(ids.length > 0);
  for (const id of ids) assert.notEqual(budgets.budgets.find(b => b.id === id).stat, 'mean', id);
  assert(Buffer.byteLength(JSON.stringify(state)) < 8_000, 'samples plus six held days per speed budget');
});

test('F8b: an event built without a line (older callers) reads the file max, never undefined', () => {
  const event = { kind: 'broken', budget: full, value: 120, landing: 'l', since: '2026-11-20T09:00:00.000Z' };
  const issue = speedBudgetIssue(event, 'project', budgets);
  assert.match(issue.body, new RegExp(`at or under ${full.max} min\\.`));
  assert.doesNotMatch(issue.body + issue.comment, /undefined/);
});
