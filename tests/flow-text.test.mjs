// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Ferdinando Valsecchi
// `nforge agent ROOT flow` (Item 85f456c1): the Flow view as text from the top bar's one line feed read.
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { agentFixture } from './hosted-agent-fixture.mjs';
import { flowText, flowStations } from '../dist/flow-text.js';
import { stepFlow, flowMain, rebuildFlowLandings, utcDayStart } from '../dist/flow-day.js';

const now = Date.parse('2026-11-20T14:05:00Z');
const lane = (stage, extra = {}) => ({
  laneId: randomUUID(),
  stage,
  held: false,
  overlap: false,
  changedAt: now - 60_000,
  ...extra,
});

test('flow is one line feed read and draws each stop with the top bar’s counts, held Lanes by id and the next step', async t => {
  const f = agentFixture(t);
  const conflict = lane('saved', { held: true, overlap: true, changedAt: now - 22 * 60_000 });
  const red = lane('ready', { held: true, mainRed: true });
  const lanes = [
    conflict,
    red,
    lane('editing', { changedAt: now - 75 * 60_000 }),
    lane('editing'),
    lane('saved'),
    lane('checking', { check: 'aaaaaaaa' }),
    lane('checking', { check: 'aaaaaaaa' }),
    lane('checking', { check: 'bbbbbbbb' }),
    lane('queued'),
    lane('ready'),
  ];
  let day = stepFlow(undefined, now - 3_600_000, { landed: 3, took: 300, ciSeconds: 600 });
  day = stepFlow(day, now, { landed: 1, fix: 1, took: 900, ciSeconds: 120, lostSeconds: 120 });
  Object.assign(f.lineFeed, { lanes, more: 0, main: { head: 'a'.repeat(64) }, flow: day });
  f.calls.length = 0;
  t.mock.method(Date, 'now', () => now);
  const reply = await f.transport().dispatch('flow', {});
  assert.deepEqual(
    f.calls.map(c => c.name),
    ['projectLiveLine:read'],
    'one read: the same feed the top bar subscribes to',
  );
  const { result } = reply;
  // One source: every stop's count is the feed's Lanes at that stop, as the top bar line counts them; a passed check
  // ('ready') counts at Checking, and In queue is its own stop (Item 85f456c1 lead decision).
  const of = { editing: ['editing'], saved: ['saved'], queued: ['queued'], checking: ['checking', 'ready'] };
  assert.deepEqual(
    result.stops.map(s => s.stop),
    ['editing', 'saved', 'queued', 'checking'],
  );
  for (const stop of result.stops)
    assert.equal(stop.open, lanes.filter(l => of[stop.stop].includes(l.stage)).length, stop.stop);
  const lines = result.text.split('\n');
  assert.match(lines[0], /10 open Lanes, 1 needs a person/, 'a main-red hold asks no person');
  assert.match(
    lines.find(l => l.startsWith('Editing')),
    /longest 1 h 15 min/,
  );
  assert.match(
    lines.find(l => l.startsWith('Saved')),
    new RegExp(`1 held: ${conflict.laneId.slice(0, 8)} \\(conflict\\)`),
  );
  assert.match(
    lines.find(l => l.startsWith('Checking')),
    /in 2 checks \(2, 1\) +1 passed, landing +1 held: .* \(main is failing\)/,
  );
  assert.match(
    lines.find(l => l.startsWith('In queue')),
    /^In queue +1 /,
  );
  assert.match(
    lines.find(l => l.startsWith('main')),
    /4 +landed today \(UTC\), 1 this hour/,
  );
  assert.match(result.text, /Ways back: needs fix 1 today/);
  assert.match(result.text, /landing checks used 12 CI min today, 2 on checks that did not land/);
  assert.match(result.text, /Land to main: middle 5 min, 9 in 10 under 15 min \(2 landings today\)/);
  assert.equal(
    result.next.includes(conflict.laneId),
    true,
    'the next step names the Lane that waits on a person',
  );
});

test('flow says when main is failing, counts Lanes past the feed’s page and is calm when nothing is open', () => {
  const failing = flowMain(undefined, true, now - 6 * 60_000);
  const busy = flowText(
    { lanes: [lane('editing')], more: 70, moreIsLowerBound: true, main: null, flow: failing },
    now,
  );
  assert.match(busy.text, /\+70 or more open Lanes past the first 1, not by stop/);
  assert.match(busy.text, /failing since 13:59 UTC/);
  assert.match(busy.next, /main is failing/);
  const old = flowText(
    {
      lanes: [],
      more: 0,
      moreIsLowerBound: false,
      main: null,
      flow: flowMain(undefined, true, now - 20 * 3_600_000),
    },
    now,
  );
  assert.match(old.text, /failing since 2026-11-19 18:05 UTC/, 'a red from before today carries its date');
  const quiet = flowText({ lanes: [], more: 0, moreIsLowerBound: false, main: null }, now);
  assert.match(quiet.text, /^Flow at 14:05 UTC: no open Lane, none needs a person\./);
  assert.equal(quiet.next, 'Nothing is open.');
  assert.deepEqual(
    flowStations({ lanes: [], more: 0, moreIsLowerBound: false, main: null }, now).map(s => s.open),
    [0, 0, 0, 0],
    'four stops: Editing, Saved, In queue, Checking',
  );
});

test('flow takes no parameters', async t => {
  const f = agentFixture(t);
  await assert.rejects(
    f.transport().dispatch('flow', { laneId: randomUUID() }),
    e => e.code === 'BAD_ARGUMENT',
  );
});

test('the Flow text distinguishes reconstructed landings, partial coverage and a retained pass', () => {
  const start = utcDayStart(now);
  const flow = {
    ...rebuildFlowLandings({ hours: [], took: [] }, start, [3], true),
    audit: { red: false, at: now },
  };
  const feed = { lanes: [], more: 0, moreIsLowerBound: false, main: null, flow };
  const rebuilt = flowText(feed, now);
  assert.match(rebuilt.text, /3 +landed today .*passing \(checked at 14:05 UTC\)/);
  assert.match(rebuilt.text, /no timing samples recorded today/);
  assert.match(rebuilt.text, /Partial coverage today: land-to-main times, first try/);
  const measured = flowText({ ...feed, flow: stepFlow(flow, now, { landed: 1, took: 400 }) }, now);
  assert.match(measured.text, /4 +landed today/);
  assert.match(measured.text, /middle 6 min/);
  assert.match(measured.text, /Partial coverage today: land-to-main times/);
});

test('f5c4d136: a Lane held on its own next step (fix) is held but needs no person, and the next step does not point at it', () => {
  const agent = lane('saved', { held: true, overlap: true, fix: true });
  const person = lane('ready', { held: true });
  const only = flowText({ lanes: [agent], more: 0, moreIsLowerBound: false, main: null }, now);
  assert.match(only.text, /none needs a person/);
  assert.match(only.text, /1 held: \w{8} \(conflict, its agent fixes it\)/);
  assert.match(only.text, /Next: Nothing waits on a person\./);
  const both = flowText({ lanes: [agent, person], more: 0, moreIsLowerBound: false, main: null }, now);
  assert.match(both.text, /1 needs a person/);
  assert.match(both.text, new RegExp(`status .*${person.laneId}`));
  assert.doesNotMatch(both.text.split('Next:')[1], new RegExp(agent.laneId));
});
