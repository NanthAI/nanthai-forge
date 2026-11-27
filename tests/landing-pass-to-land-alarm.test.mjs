// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Ferdinando Valsecchi
// Queue health alarm (Item 42200ce4, Guard 6 863c85ab): the time from a landing's first passed check
// to its commit, judged by regression ladder rung 1 inside the accept mutation. Replays incident
// 5e3c3a3c (passed landings waited p50 79 / p90 101 min on 2026-11-17) and the accepted bench
// 8c9b84fc queue traces, which must stay quiet.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { finishFixture } from './hosted-finish-fixture.mjs';
import { policyPreset } from '../dist/autonomy-policy.js';
import { moduleUrl } from './convex-module.mjs';
import {
  PASS_HELD,
  keepsPassStamp,
  landingSpeedSample,
  observeLandingSpeed,
  speedBudgetMessage,
  windowValue,
} from '../dist/landing-speed-alerts.js';
import { speedBudgets as budgets } from '../dist/speed-budgets.js';

import { synthetic } from './hosted-landing-batches-fixture.mjs';

const ID = 'pass-to-land-p90';
// The finish fixture's checks report through the synthetic trusted runner.
const prior = Object.fromEntries(Object.keys(synthetic).map(k => [k, process.env[k]]));
test.before(() => Object.assign(process.env, synthetic));
test.after(() => {
  for (const [key, value] of Object.entries(prior)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});
const WINDOW = budgets.window.landings;
const budget = budgets.budgets.find(b => b.id === ID);
/** Feeds landings in commit order; returns the final state and this budget's events. */
function replay(rows) {
  let state = null;
  const events = [];
  for (const { at, id, passToLand } of rows) {
    const out = observeLandingSpeed(
      state,
      {
        at,
        id,
        toMain: null,
        check: null,
        settle: null,
        passToLand,
        stages: { queue: null, check: null, settle: null },
      },
      budgets,
    );
    state = out.state;
    events.push(...out.events.filter(e => e.budget.id === ID));
  }
  return { state, events };
}

test('incident replay 5e3c3a3c: the pass-to-land alarm breaks on the 2026-11-17 dogfood landings before the diagnosis', () => {
  const fixture = JSON.parse(readFileSync(new URL('./fixtures/pass-to-land-5e3c3a3c.json', import.meta.url)));
  const rows = fixture.landings.map(([committedAt, id, passToLand]) => ({
    at: Date.parse(committedAt),
    id,
    passToLand,
  }));
  const diagnosis = Date.parse('2026-11-17T11:32:15Z');
  const { events } = replay(rows.filter(row => row.at <= diagnosis));
  const breaks = events.filter(
    e => e.kind === 'broken' && Date.parse(e.since) >= Date.parse('2026-11-17T08:00:00Z'),
  );
  assert.equal(breaks.length, 1, JSON.stringify(events.map(e => [e.kind, e.since, e.value])));
  assert.equal(events.at(-1).kind, 'broken', 'still broken when the incident was diagnosed');
  // About two hours before anyone diagnosed the queue.
  assert(diagnosis - Date.parse(breaks[0].since) > 90 * 60_000, breaks[0].since);
  assert(breaks[0].value > budget.max);
  const message = speedBudgetMessage(breaks[0], 'forge', budgets);
  assert.match(message.subject, /Speed budget broken: first passed check to commit p90/);
  // Guard 6: the alarm states the rule for any project, without pointing at Forge's own lead docs.
  assert.match(message.text, /pause new landings until pass-to-land recovers/);
  assert.match(message.text, /fix the queue first/);
  assert.doesNotMatch(message.text, /lead\.md|Guard 6/);
  assert.match(message.text, /nforge agent ROOT queue/);
});

test('accepted bench 8c9b84fc: the pass-to-land alarm stays quiet on every retained queue trace', () => {
  const directory = new URL('./fixtures/queue-traces/', import.meta.url);
  const traces = readdirSync(directory)
    .filter(name => /^n\d+-r\d+\.json$/.test(name))
    .sort()
    .map(name => JSON.parse(readFileSync(new URL(name, directory))));
  assert.equal(traces.length, 12, 'N=1, 3, 5, 10, three reps each');
  const rows = [];
  let base = 0;
  for (const trace of traces) {
    for (const task of trace.tasks) {
      if (task.committedAt == null) continue;
      const passes = trace.checks
        .filter(
          c =>
            c.outcome === 'passed' &&
            Number.isFinite(c.at) &&
            Number.isFinite(c.wallSeconds) &&
            c.members.includes(task.task),
        )
        .map(c => c.at + c.wallSeconds)
        .filter(end => end <= task.committedAt + 1);
      if (!passes.length) continue;
      rows.push({
        at: base + task.committedAt * 1000,
        id: `${trace.N}-${trace.rep}-${task.task}`,
        passToLand: Math.max(0, task.committedAt - Math.min(...passes)) / 60,
      });
    }
    base += 86_400_000;
  }
  rows.sort((a, b) => a.at - b.at);
  assert(rows.length >= 100, `${rows.length} bench landings`);
  const { state, events } = replay(rows);
  // Quiet: no break, recovery or undo. Twelve bench days hold the line for the ratchet's seven closed
  // days, so the one message is the automatic tighten (a217b83e), and its line keeps the F1 floors:
  // never under the band (15% of the line it replaced) nor the value judged then.
  assert.deepEqual(
    events.map(e => e.kind),
    ['ratcheted'],
  );
  const [tighten] = events;
  assert.equal(tighten.from, budget.max);
  assert(tighten.line < budget.max && tighten.line >= 0.15 * budget.max, `ratcheted line ${tighten.line}`);
  assert(tighten.line >= tighten.value, `line ${tighten.line} under its own value ${tighten.value}`);
  // Far from the bar: the bench lands within seconds of its pass.
  const p90 = windowValue(state.samples, 'passToLand', 'p90', WINDOW);
  assert(p90 < 1, `bench pass-to-land p90 ${p90} min`);
});

test('rows from before the stamp have no pass-to-land verdict; a reused check never counts from before its submission', () => {
  const state = {
    id: '11111111-1111-4111-8111-111111111111',
    acceptance: { receiptId: '22222222-2222-4222-8222-222222222222' },
    timing: {
      submittedAt: '2026-11-04T10:00:00.000Z',
      ciEndedAt: '2026-11-04T10:08:30.000Z',
      committedAt: '2026-11-04T10:12:00.000Z',
    },
  };
  // Never ready (checked and landed in one step): from its accepted check's end.
  assert.equal(landingSpeedSample(state).passToLand, 3.5);
  // The row's first-ready stamp wins over a later re-check.
  assert.equal(landingSpeedSample(state, null, Date.parse('2026-11-04T10:02:00.000Z')).passToLand, 10);
  // A check reused from an earlier submission ended before this one was submitted.
  const reused = { ...state, timing: { ...state.timing, ciEndedAt: '2026-11-04T09:00:00.000Z' } };
  assert.equal(landingSpeedSample(reused).passToLand, 12);
  assert.equal(windowValue([[1, 1, 1, 'old00000']], 'passToLand', 'p90', 1), null);
  const { state: kept } = replay(
    Array.from({ length: WINDOW - 1 }, (_, i) => ({ at: i, id: `p${i}`, passToLand: 30 })),
  );
  assert.equal(windowValue(kept.samples, 'passToLand', 'p90', WINDOW), null, 'no verdict below the window');
});

const speedSample = (f, receiptId) =>
  JSON.parse([...f.tables.projectLandingSpeed.values()][0].value).samples.find(s => s[3] === receiptId);

async function landOne(t) {
  const f = await finishFixture(t);
  const policy = [...f.tables.hostedProjects.values()].find(row => row._id === f.projectId).autonomyPolicy;
  f.patch('hostedProjects', f.projectId, {
    autonomyPolicy: { ...(policy ?? policyPreset('trusted')), agentDefaults: { preflight: 'advise' } },
  });
  const before = f.counts.length;
  await f.enqueue(f.request());
  await f.drain();
  await f.passChecks();
  await f.drain();
  const [row] = f.tables.projectHostedLandingRequests.values();
  const state = JSON.parse(row.value);
  assert.equal(state.phase, 'landed');
  const [speed] = f.tables.projectLandingSpeed.values();
  const sample = JSON.parse(speed.value).samples.find(s => s[3] === state.acceptance.receiptId);
  return { f, row, state, sample, before };
}

test('a landing that went straight in is judged by its landed state alone and leaves no stamp on its stored row', async t => {
  const { f, row, state, sample, before } = await landOne(t);
  // Never held after a pass: its stored row keeps its old size.
  assert.equal(row.passedAt, undefined);
  // The alarm's sample is exactly what the landed state gives (the accepted check's end).
  assert.equal(sample[10] ?? null, landingSpeedSample(state).passToLand ?? null);
  assert(!f.counts.slice(before).some(c => /passToLand|landingSpeed/i.test(c.name)), 'no new Convex call');
});

test('incident 5e3c3a3c shape: real code stamps the first ready, keeps it across a main-move re-check, and the landing is judged from it', async t => {
  const f = await finishFixture(t);
  const policy = [...f.tables.hostedProjects.values()].find(row => row._id === f.projectId).autonomyPolicy;
  f.patch('hostedProjects', f.projectId, {
    autonomyPolicy: { ...(policy ?? policyPreset('trusted')), agentDefaults: { preflight: 'advise' } },
  });
  // The fixture mocks Date.now only; the landing's commit stamp reads new Date(). In Convex both are
  // one clock, so here a bare new Date() follows the fixture clock too, or the commit would predate
  // the pass once the fixture clock runs ahead.
  const RealDate = Date;
  globalThis.Date = class extends RealDate {
    constructor(...args) {
      super(...(args.length ? args : [RealDate.now()]));
    }
  };
  t.after(() => (globalThis.Date = RealDate));
  const stored = () => [...f.tables.projectHostedLandingRequests.values()][0];
  await f.enqueue(f.request());
  await f.drain();
  // Main moves while the first check runs: the pass arrives on an old main.
  f.moveMain();
  await f.passChecks();
  while (f.pending().length && stored().passedAt === undefined) await f.execute();
  const first = stored().passedAt;
  assert.equal(JSON.parse(stored().value).phase, 'ready', 'the first pass made it ready');
  assert.equal(first, Date.now(), 'stamped by the write that made it ready');
  // It recomposes onto the new main and re-checks; the stamp never moves.
  for (let round = 0; round < 4 && JSON.parse(stored().value).phase !== 'landed'; round++) {
    await f.drain();
    assert.equal(stored().passedAt, first);
    await f.passChecks();
  }
  await f.drain();
  const row = stored();
  const state = JSON.parse(row.value);
  assert.equal(state.phase, 'landed');
  assert.equal(f.tables.projectHostedCheckRuns.size, 2, 'checked twice: the pass and the re-check');
  // Held and re-checked after its first pass: the stored row keeps the stamp for the metrics report.
  assert.equal(row.passedAt, first);
  assert(keepsPassStamp(state, first));
  // The alarm's sample counts from the first pass, which the landed state alone cannot give.
  const sample = speedSample(f, state.acceptance.receiptId);
  const fromFirst = landingSpeedSample(state, null, first).passToLand;
  assert.equal(sample[10], fromFirst);
  // The re-check wait shows: counted from the first pass, not from the accepted check's end.
  assert(fromFirst > landingSpeedSample(state).passToLand, JSON.stringify(state.timing));
});

test('the stored row keeps the first-ready stamp only when the landed state alone would misstate the wait', () => {
  const state = {
    timing: {
      submittedAt: '2026-11-04T10:00:00.000Z',
      ciEndedAt: '2026-11-04T10:08:30.000Z',
      committedAt: '2026-11-04T10:09:00.000Z',
    },
  };
  const at = iso => Date.parse(iso);
  assert.equal(
    keepsPassStamp(state, at('2026-11-04T10:08:00.000Z')),
    false,
    'within a minute of the accepted check',
  );
  assert.equal(keepsPassStamp(state, at('2026-11-04T09:30:00.000Z')), true, 'held, then re-checked');
  assert.equal(
    keepsPassStamp({ timing: { submittedAt: state.timing.submittedAt } }, at('2026-11-04T10:01:00.000Z')),
    true,
    'no accepted check end to fall back on',
  );
  assert.equal(keepsPassStamp({}, 1), true, 'no timing at all');
});

test("663e89b0: a landing held for a person's review after its pass gives no pass-to-land sample", async t => {
  const acceptance = await import(moduleUrl('../convex/projectHostedAcceptance.ts'));
  const web = process.env.FORGE_WEB_URL;
  process.env.FORGE_WEB_URL = 'https://forge.example.invalid';
  t.after(() => (web === undefined ? delete process.env.FORGE_WEB_URL : (process.env.FORGE_WEB_URL = web)));
  const f = await finishFixture(t);
  const policy = { ...policyPreset('trusted'), agentDefaults: { preflight: 'advise' } };
  policy.acceptance.ownerApprovalPaths = ['selected.txt'];
  f.patch('hostedProjects', f.projectId, { visibility: 'public', autonomyPolicy: policy });
  const queued = await f.enqueue(f.request());
  await f.drain();
  await f.passChecks();
  await f.drain();
  const [held] = f.tables.projectHostedLandingRequests.values();
  assert.equal(JSON.parse(held.value).observation.pendingReason, 'waiting-for-review');
  assert.equal(held.passedAt, PASS_HELD, 'marked when the hold starts, in the write that holds it');
  // The owner reviews 90 minutes later: a long wait, but for a person, not the queue.
  f.advanceClock(90 * 60_000);
  const now = (await f.current(queued.id)).submission;
  const approved = JSON.parse(
    await f.tx('ownerApprove', acceptance.approve, {
      projectId: f.projectId,
      submissionId: now.id,
      attemptId: now.attemptId,
    }),
  );
  assert.equal(approved.status, 'landed');
  await f.drain();
  const [row] = f.tables.projectHostedLandingRequests.values();
  const state = JSON.parse(row.value);
  assert.equal(state.phase, 'landed');
  const sample = speedSample(f, state.acceptance.receiptId);
  assert(sample, 'the landing still gives its other speed metrics');
  assert.equal(sample[10] ?? null, null, 'no pass-to-land sample');
  // The metrics report reads the same stamp from the stored row.
  assert.equal(row.passedAt, PASS_HELD);
  assert.equal(landingSpeedSample(state, null, row.passedAt).passToLand, null);
});

test('663e89b0: a stacked child that passed before its parent landed waits in ready for it and gives no pass-to-land sample', async t => {
  const f = await finishFixture(t);
  const policy = [...f.tables.hostedProjects.values()].find(row => row._id === f.projectId).autonomyPolicy;
  f.patch('hostedProjects', f.projectId, {
    autonomyPolicy: { ...(policy ?? policyPreset('trusted')), agentDefaults: { preflight: 'advise' } },
  });
  const parent = await f.enqueue(f.request());
  await f.drain();
  const childRequest = await f.resubmission([['child.txt', 'Child change\n']]);
  const child = await f.enqueue({
    ...childRequest,
    finish: { ...childRequest.finish, after: parent.id },
  });
  await f.drain();
  const stored = () =>
    [...f.tables.projectHostedLandingRequests.values()].find(r => JSON.parse(r.value).id === child.id);
  assert.equal(JSON.parse(stored().value).observation.pendingReason, 'waiting-for-dependency');
  // Step by step: the child's own check passes while its parent has not landed yet.
  let heldAfterPass = false;
  for (let round = 0; round < 3 && JSON.parse(stored().value).phase !== 'landed'; round++) {
    await f.passChecks();
    while (f.pending().length) {
      await f.execute();
      const state = JSON.parse(stored().value);
      if (state.observation.pendingReason === 'waiting-for-dependency' && stored().passedAt !== undefined)
        heldAfterPass = true;
    }
  }
  const row = stored();
  const landed = JSON.parse(row.value);
  assert.equal(landed.phase, 'landed');
  assert(heldAfterPass, 'its dependency wait came after its pass');
  // Its parent's landing time is not this queue's health: no sample, like a review hold.
  assert.equal(row.passedAt, PASS_HELD);
  assert.equal(speedSample(f, landed.acceptance.receiptId)[10] ?? null, null);
});
