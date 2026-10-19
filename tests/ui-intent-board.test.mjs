// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { moduleUrl } from './convex-module.mjs';
const { intentRows, filterIntents } = await import(moduleUrl('../web/src/intents/model.ts'));
const { intentColumns, intentFlags, recentDone } = await import(
  moduleUrl('../web/src/intents/board-model.ts')
);
const { IntentBoard } = await import(moduleUrl('../web/src/intents/IntentBoard.tsx'));
const { readIntentLayout, layoutKey } = await import(moduleUrl('../web/src/intents/useIntentLayout.ts'));
const now = Date.parse('2026-10-15T12:00:00Z');
const make = (id, status = 'active', tone = 'active', label = 'Working') =>
  intentRows(
    [{ id, outcome: `${id} long title `.repeat(12), status, createdAt: '2026-10-15T11:00:00Z' }],
    [
      {
        id: `l-${id}`,
        intentId: id,
        name: id,
        open: true,
        tone,
        label,
        accepted: false,
        startedBy: { kind: 'agent', name: 'gpt-u14' },
      },
    ],
  )[0];

test('Board partitions the same derived list status without duplicating or dropping flags', () => {
  const rows = [
    make('working'),
    make('checking', 'active', 'running'),
    make('ready', 'active', 'passed'),
    make('marked', 'ready'),
    make('paused', 'active', 'waiting', 'Paused'),
    make('failed', 'active', 'failed'),
    make('conflict', 'active', 'conflict'),
    make('done', 'completed'),
    make('abandoned', 'abandoned'),
  ];
  const columns = intentColumns(rows);
  assert.equal(columns.ready.length, filterIntents(rows, 'ready').length);
  assert.equal(columns.done.length, filterIntents(rows, 'done').length);
  assert.equal(
    columns.working.length + columns.checking.length + columns.ready.length,
    filterIntents(rows, 'open').length,
  );
  assert.equal(
    new Set(
      Object.values(columns)
        .flat()
        .map(row => row.id),
    ).size,
    rows.length,
  );
  assert.deepEqual(
    columns.checking.map(row => row.id),
    ['checking'],
  );
  assert.ok(columns.working.some(row => row.id === 'paused'));
  assert.equal(intentFlags(rows[4]).paused, true);
  assert.equal(intentFlags(rows[5]).failed, true);
  assert.equal(intentFlags(rows[6]).needsYou, true);
});

test('Done recent cards retain full count, including abandoned; unknown dates are not recent', () => {
  const rows = [
    make('new', 'completed'),
    { ...make('old', 'completed'), lastAt: '2026-10-01T00:00:00Z' },
    { ...make('unknown', 'abandoned'), lastAt: undefined },
    { ...make('boundary', 'completed'), lastAt: new Date(now - 7 * 86400000).toISOString() },
  ];
  assert.deepEqual(
    recentDone(rows, now).map(row => row.id),
    ['new', 'boundary'],
  );
  assert.equal(intentColumns(rows).done.length, 4);
});

test('Board renders bounded card pages, accessible progress, full titles, initials and Done disclosure', () => {
  const rows = Array.from({ length: 45 }, (_, i) => make(`working-${i}`));
  const html = renderToStaticMarkup(
    createElement(IntentBoard, { rows, now, intentHref: id => `/intents/${id}`, showDone() {} }),
  );
  assert.equal((html.match(/class="fx-intent-card"/g) || []).length, 20);
  assert.match(html, /Show 20 more/);
  assert.doesNotMatch(html, /<progress/);
  assert.match(html, /Agents: gpt-u14/);
  assert.match(html, /gpt-u14 \(agent\)/);
  assert.match(html, /fx-board-done-collapsed/);
  assert.match(html, /Show all 0/);
  assert.doesNotMatch(html, /draggable/);
});

test('URL layout overrides storage and preference keys isolate accounts and projects', () => {
  assert.equal(readIntentLayout('?intentLayout=list', 'board'), 'list');
  assert.equal(readIntentLayout('?intentLayout=board', 'list'), 'board');
  assert.equal(readIntentLayout('', 'board'), 'board');
  assert.equal(readIntentLayout('?intentLayout=bad', 'board'), 'list');
  assert.notEqual(layoutKey('hosted:a:p'), layoutKey('hosted:b:p'));
  assert.notEqual(layoutKey('hosted:a:p'), layoutKey('hosted:a:q'));
});

const { intentBoardFacts } = await import(moduleUrl('../web/src/intents/board-facts.ts'));
const renderBoard = rows =>
  renderToStaticMarkup(
    createElement(IntentBoard, { rows, now, intentHref: id => `/intents/${id}`, showDone() {} }),
  );

test('Done uses the cohort acceptance time and omits misleading zero accepted metadata', () => {
  const row = { ...make('landed', 'completed'), lastAt: '2026-09-01T00:00:00Z' };
  const work = {
    views: [{ id: 'cohort', intentId: 'captain', inputs: [{ laneId: row.lanes[0].id, head: 'h' }] }],
    channelMoves: [{ viewId: 'cohort', channel: 'main', status: 'accepted', at: '2026-10-15T11:30:00Z' }],
  };
  const facts = intentBoardFacts([row], work, []);
  assert.equal(facts[0].landedAt, '2026-10-15T11:30:00Z');
  assert.equal(recentDone(facts, now).length, 1);
  const html = renderBoard(facts);
  assert.match(html, /Landed.*30 min ago/);
  assert.doesNotMatch(html, /0 accepted|No check|No recorded agents|<progress|>—</);
  assert.match(html, /Past 7 days/);
});

test('single-Lane and unknown check cards stay quiet; multi-Lane cards report meaningful landed progress', () => {
  const one = make('single');
  one.agents = [];
  one.lanes[0].startedBy = undefined;
  const quiet = renderBoard([one]);
  assert.doesNotMatch(quiet, /<progress|fx-board-check|fx-board-agents|>—</);
  const multi = make('multi');
  multi.lanes.push({ ...multi.lanes[0], id: 'second', accepted: true });
  const html = renderBoard([multi]);
  assert.match(html, /2 Lanes.*1 landed/);
  assert.match(html, /aria-label="1 of 2 Lanes landed"/);
  for (const state of ['passed', 'failed', 'running', 'queued', 'preparing']) {
    const row = make(state);
    row.lanes[0].runStatus = state;
    assert.match(renderBoard([row]), /fx-board-check/);
  }
  for (const state of ['cancelled', 'interrupted']) {
    const row = make(state);
    row.lanes[0].runStatus = state;
    assert.doesNotMatch(renderBoard([row]), /fx-board-check/);
  }
});

test('named session actors survive a newer workflow session and resolve both Lane and Intent contexts', () => {
  const row = make('u13');
  row.lanes[0].startedBy = { kind: 'agent', name: 'Agent workflow' };
  const session = (name, id, context, extra = {}) => ({
    name,
    sessionId: id,
    context,
    status: 'working',
    lastSeen: now,
    kind: 'agent',
    ...extra,
  });
  const sessions = [
    session('Agent workflow', 'generic', { laneId: 'l-u13' }),
    session('gpt-u13', 'named', { laneId: 'l-u13' }, { lastSeen: now - 1000 }),
    session('gpt-u14', 'intent-only', { intentId: 'u13' }),
    session('Dino', 'person', { laneId: 'l-u13' }, { kind: 'person' }),
  ];
  const [facts] = intentBoardFacts([row], { views: [] }, sessions);
  assert.deepEqual(
    facts.agents.map(agent => agent.name),
    ['gpt-u14', 'gpt-u13'],
  );
  assert.match(renderBoard([facts]), /gpt-u13 \(agent\)/);
  assert.doesNotMatch(renderBoard([facts]), /Agent workflow|Dino/);
});

test('missing acceptance time never relabels note or save activity as landing time', () => {
  const row = make('unknown-landing', 'completed');
  row.agents = [];
  const html = renderBoard([row]);
  assert.doesNotMatch(html, /Landed|ago/);
  assert.equal((html.match(/>Done</g) ?? []).length, 1); // column heading; never a card
});

test('cohort landing follows exact View dependencies and ignores mismatched dependency heads', () => {
  const row = make('dependent', 'completed');
  const source = {
    id: 'source',
    head: 'saved',
    intentId: row.id,
    inputs: [{ laneId: row.lanes[0].id, head: 'saved' }],
  };
  const cohort = {
    id: 'captain',
    head: 'combined',
    intentId: 'captain',
    inputs: [],
    dependencies: [{ kind: 'view', viewId: 'source', head: 'saved' }],
  };
  const work = {
    views: [source, cohort],
    channelMoves: [{ viewId: 'captain', channel: 'main', status: 'accepted', at: '2026-10-15T11:30:00Z' }],
  };
  assert.equal(intentBoardFacts([row], work, [])[0].landedAt, '2026-10-15T11:30:00Z');
  cohort.dependencies[0].head = 'different';
  assert.equal(intentBoardFacts([row], work, [])[0].landedAt, undefined);
});

test('abandoned work uses recent activity without calling a prior landing its closure time', () => {
  const row = { ...make('abandoned-recent', 'abandoned'), landedAt: '2026-09-01T00:00:00Z' };
  assert.equal(recentDone([row], now).length, 1);
  const html = renderBoard([row]);
  assert.match(html, /Abandoned/);
  assert.doesNotMatch(html, /ago|Landed/);
});

test('44 Planned Intents are bounded to five quiet Initiative cards outside Working', () => {
  const rows = intentRows(
    Array.from({ length: 44 }, (_, n) => ({
      id: `planned-${n}`,
      outcome: `Backlog ${n}`,
      status: 'active',
      createdAt: '2026-10-15T11:00:00Z',
    })),
    [],
  );
  const columns = intentColumns(rows);
  assert.equal(columns.planned.length, 44);
  assert.equal(columns.working.length, 0);
  const html = renderToStaticMarkup(
    createElement(IntentBoard, {
      rows,
      now,
      intentHref: id => `/intents/${id}`,
      showDone() {},
      initiatives: new Map(rows.map(row => [row.id, { id: 'phase3', title: 'Phase 3' }])),
    }),
  );
  assert.equal((html.match(/class="fx-intent-card"/g) || []).length, 5);
  assert.match(html, /Show 5 more/);
  assert.match(html, /Phase 3/);
  assert.doesNotMatch(html, /<time|0 Lanes|Needs you/);
});
