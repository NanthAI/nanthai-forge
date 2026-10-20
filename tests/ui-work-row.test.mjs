// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { createElement as h } from 'react';
import { renderToStaticMarkup as html } from 'react-dom/server';
import { moduleUrl } from './convex-module.mjs';
const { WorkRow, LaneFactLine } = await import(moduleUrl('../web/src/ui/WorkRow.tsx'));
const { laneFacts, filterLaneFacts } = await import(moduleUrl('../web/src/ui/lane-facts.ts'));
const { cockpitLanes } = await import(moduleUrl('../web/src/cockpit/model.ts'));
const { withSessions } = await import(moduleUrl('../web/src/cockpit/coordination.ts'));
const { LaneListView } = await import(moduleUrl('../web/src/HostedLanes.tsx'));
const { IntentListView } = await import(moduleUrl('../web/src/intents/IntentList.tsx'));
const { InlineWorkNav } = await import(moduleUrl('../web/src/shell/WorkHeader.tsx'));

const now = Date.parse('2026-10-17T12:00:00Z');
const ago = minutes => new Date(now - minutes * 60000).toISOString();
const sha = c => c.repeat(64);
const save = (head, at) => ({ head, parent: sha('0'), at, message: 'save' });

function work() {
  return {
    intents: [
      {
        id: 'i1',
        outcome: 'Owner-derived source exchange during push',
        status: 'active',
        createdAt: ago(600),
      },
      { id: 'i2', outcome: 'Quiet docs merge', status: 'active', createdAt: ago(600) },
      { id: 'i3', outcome: 'Landed work', status: 'completed', createdAt: ago(900) },
      { id: 'i4', outcome: 'Dropped work', status: 'abandoned', createdAt: ago(900) },
    ],
    lanes: [
      {
        id: 'l1',
        intentId: 'i1',
        name: 'sidecars',
        base: sha('0'),
        head: sha('1'),
        state: 'active',
        assignment: '',
        checkpoints: [save(sha('a'), ago(30)), save(sha('1'), ago(4))],
      },
      {
        id: 'l2',
        intentId: 'i2',
        name: 'Quiet docs merge',
        base: sha('0'),
        head: sha('2'),
        state: 'active',
        assignment: '',
        startedBy: { kind: 'agent', name: 'claude-docmerge' },
        checkpoints: [save(sha('b'), ago(240)), save(sha('2'), ago(180))],
      },
      {
        id: 'l3',
        intentId: 'i3',
        name: 'Landed work',
        base: sha('0'),
        head: sha('3'),
        state: 'completed',
        assignment: '',
        checkpoints: [save(sha('3'), ago(200))],
        lifecycle: [{ from: 'active', to: 'completed', at: ago(180) }],
      },
      {
        id: 'l4',
        intentId: 'i4',
        name: 'Dropped work',
        base: sha('0'),
        head: sha('4'),
        state: 'abandoned',
        assignment: '',
        checkpoints: [],
        lifecycle: [
          { from: 'active', to: 'abandoned', at: ago(1440), reason: 'superseded', actor: { name: 'Dino' } },
        ],
      },
    ],
    views: [
      {
        id: 'v3',
        intentId: 'i3',
        base: sha('0'),
        head: sha('9'),
        status: 'clean',
        at: ago(181),
        inputs: [{ laneId: 'l3', head: sha('3') }],
      },
    ],
    runs: [],
    channelMoves: [
      {
        channel: 'main',
        viewId: 'v3',
        head: sha('9'),
        at: ago(180),
        acceptedBy: { name: 'Agent workflow' },
        automatic: { actor: 'Agent workflow', summary: 'auto' },
      },
    ],
  };
}
const session = {
  sessionId: 's1',
  name: 'gpt-i4',
  environment: 'Codex CLI',
  status: 'working',
  summary: '',
  context: { laneId: 'l1' },
  lastSeen: now - 60000,
};

test('Lane facts state who, what and when, and never use Active or Unassigned', () => {
  const records = work();
  const facts = laneFacts(records, withSessions(cockpitLanes(records), [session], now), now);
  const sidecars = facts.get('l1');
  assert.equal(sidecars.label, 'Working');
  assert.equal(sidecars.who.name, 'gpt-i4');
  assert.equal(sidecars.intent, 'Owner-derived source exchange during push');
  assert.match(sidecars.text, /^2 saves · last save 4 min/);
  const nobody = facts.get('l2');
  assert.equal(nobody.tone, 'waiting');
  assert.equal(nobody.label, 'Waiting');
  assert.equal(nobody.intent, undefined, 'the Intent line is omitted when it matches the Lane name');
  assert.match(nobody.text, /^Nobody working · last save 3 h ago by claude-docmerge · 2 saves$/);
  const landed = facts.get('l3');
  assert.equal(landed.label, 'Done');
  assert.equal(landed.glyph, 'passed');
  assert.equal(landed.auto, true);
  assert.match(landed.text, /^Landed on main 3 h ago · Candidate of 1 Lane · accepted by Agent workflow$/);
  const dropped = facts.get('l4');
  assert.equal(dropped.label, 'Abandoned');
  assert.equal(dropped.tone, 'stale');
  assert.match(dropped.text, /^Abandoned 24 h ago by Dino · superseded$/);
  for (const fact of facts.values())
    assert.doesNotMatch(`${fact.label} ${fact.text}`, /\bActive\b|Unassigned/);
});

test('Open · Ready · Done · All filters sum and sort open work by attention', () => {
  const records = work();
  const facts = laneFacts(records, withSessions(cockpitLanes(records), [session], now), now);
  const rows = [...facts.entries()].map(([id, fact]) => ({ id, fact }));
  const ids = filter => filterLaneFacts(rows, filter).map(row => row.id);
  assert.deepEqual(ids('open'), ['l2', 'l1']);
  assert.deepEqual(ids('ready'), []);
  assert.deepEqual(ids('done'), ['l3', 'l4']);
  assert.equal(ids('all').length, ids('open').length + ids('done').length);
});

test('Lanes and Intents lists render the same Work row and Lane glyph', () => {
  const lanes = html(h(LaneListView, { records: work(), sessions: [session], now, href: id => `#${id}` }));
  assert.match(lanes, /class="fx-wrs"/);
  assert.equal((lanes.match(/<li class="fx-wr /g) || []).length, 2, 'Open shows the two open Lanes');
  assert.match(lanes, /Find a Lane/);
  assert.match(lanes, /<option value="" selected="">Anyone<\/option>/);
  assert.match(lanes, /Nobody working · last save 3 h ago by claude-docmerge/);
  assert.match(lanes, /class="fx-wr-intent"[^>]*>.*Owner-derived source exchange during push/);
  assert.doesNotMatch(lanes, /Active Lanes|Past Lanes|Unassigned|lane-work-row|fx-row-arrow/);
  for (const name of ['Open', 'Ready', 'Done', 'All']) assert.match(lanes, new RegExp(`>${name}<`));
  const intents = html(
    h(IntentListView, {
      rows: [
        {
          id: 'i1',
          outcome: 'One',
          status: 'active',
          tone: 'active',
          label: 'Working',
          open: [],
          lanes: [],
          decisions: 0,
        },
      ],
      now,
      intentHref: id => `#${id}`,
    }),
  );
  assert.match(
    intents,
    /<li class="fx-wr fx-wr-active"><div class="fx-wr-main"><a href="#i1" class="fx-wr-title"/,
  );
  assert.match(intents, />Proposed<[^]*>Planned<[^]*>In motion<[^]*>Done<[^]*>All</);
  assert.doesNotMatch(intents, />Open<|>Ready</);
  const nav = html(h(InlineWorkNav, { header: { page: 'lanes', counts: { lanes: 3 }, onChange() {} } }));
  const lanePath = html(
    h(LaneFactLine, { fact: { open: true, tone: 'active', label: 'Working', text: 'x', glyph: 'lane' } }),
  );
  const path = lanePath.match(/<path d="([^"]+)"/)[1];
  assert.ok(nav.includes(path), 'the Work segment draws the same Lane glyph');
  assert.match(
    nav,
    /rect x="2.5" y="2.5" width="11" height="11" rx="2"/,
    'Planning uses the Initiative glyph',
  );
});

test('a Work row keeps modified clicks as links and marks closed rows', () => {
  const markup = html(
    h(WorkRow, {
      tone: 'passed',
      title: 'Done thing',
      href: '/x',
      label: 'Done',
      pillGlyph: 'passed',
      done: true,
    }),
  );
  assert.match(markup, /class="fx-wr fx-wr-passed fx-wr-done"/);
  assert.match(markup, /<a href="\/x" class="fx-wr-title" title="Done thing">Done thing<\/a>/);
  assert.doesNotMatch(markup, /fx-wr-fact/);
});

test('a Lane with no saves on an accepted main head is open, not landed; a saved Lane on main is landed', () => {
  const at = '2026-10-20T10:00:00.000Z',
    base = 'a'.repeat(64),
    saved = 'b'.repeat(64);
  const work = {
    intents: [{ id: 'i', outcome: 'Fresh work', createdAt: at }],
    lanes: [
      { id: 'fresh', intentId: 'i', state: 'active', base, head: base, checkpoints: [] },
      { id: 'landed', intentId: 'i', state: 'active', base, head: saved, checkpoints: [{ at }] },
    ],
    views: [],
    runs: [],
    channelMoves: [
      { channel: 'main', head: base, status: 'accepted' },
      { channel: 'main', head: saved, status: 'accepted' },
    ],
  };
  const [fresh, landed] = cockpitLanes(work);
  assert.equal(fresh.open, true);
  assert.equal(fresh.accepted, false);
  assert.equal(landed.open, false);
  assert.equal(landed.accepted, true);
});

test('hosted completion without landing evidence is unknown, while local and recorded outcomes stay exact', () => {
  const records = work();
  const synced = laneFacts(records, cockpitLanes(records), now, true);
  assert.match(synced.get('l3').text, /^Landed on main/);
  assert.equal(synced.get('l3').detail, undefined);
  assert.equal(synced.get('l4').label, 'Abandoned');
  assert.match(synced.get('l4').text, /^Closed without landing .*superseded$/);
  records.channelMoves = [];
  const lanes = cockpitLanes(records);
  const unknown = laneFacts(records, lanes, now, true).get('l3');
  assert.equal(unknown.text, 'Completed on owner machine');
  assert.equal(unknown.detail, 'Landing details arrive with the next push');
  assert.equal(unknown.tone, 'plain');
  assert.equal(unknown.glyph, undefined);
  assert.match(html(h(LaneFactLine, { fact: unknown })), /title="Landing details arrive with the next push"/);
  assert.match(laneFacts(records, lanes, now).get('l3').text, /^Closed without landing/);
});
