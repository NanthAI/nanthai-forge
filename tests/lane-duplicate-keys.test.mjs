// SPDX-License-Identifier: Apache-2.0
// Item f9309eec: the Lane page logged React "two children with the same key" warnings on the dogfood Lane. Source
// rows can repeat (a save recorded twice with the same head, an event read on two pages, two moves at one instant),
// so every list on the page must key by something unique, never hide the repeat behind an index.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createElement as h } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { moduleUrl } from './convex-module.mjs';

globalThis.location ??= new URL('http://local/local/project/lanes/l');
const { HostedLaneView } = await import(moduleUrl('../web/src/lane/HostedLane.tsx'));
const { laneTimeline } = await import(moduleUrl('../web/src/lane/timeline.ts'));

const base = 'a'.repeat(64);
const head = 'b'.repeat(64);
const at = '2026-11-05T11:00:00Z';
const save = (extra = {}) => ({ head, parent: base, at, message: 'Save', ...extra });
const records = (lane = {}, rest = {}) => ({
  intents: [{ id: 'i', outcome: 'Parser', createdAt: at }],
  lanes: [
    {
      id: 'l',
      name: 'Parser',
      intentId: 'i',
      state: 'active',
      base,
      head,
      checkpoints: [save(), save(), save({ at: '2026-11-05T11:05:00Z' })],
      lifecycle: [{ to: 'active', at }],
      ...lane,
    },
  ],
  views: [{ id: 'v', intentId: 'i', at, inputs: [{ laneId: 'l', head, saveIndex: 0 }] }],
  runs: [],
  channelMoves: [],
  ...rest,
});
const message = (operationId, text = 'hello') => ({
  operationId,
  at: '2026-11-05T11:10:00Z',
  actor: 'sample-owner',
  command: { kind: 'message', text, context: { laneId: 'l' } },
});

/** Render and return every console.error line React printed (key warnings are logged, not thrown). */
function problems(fn) {
  const seen = [];
  const original = console.error;
  console.error = (...args) => seen.push(args.map(String).join(' '));
  try {
    fn();
  } finally {
    console.error = original;
  }
  return seen.filter(line => /same key|unique "key"/.test(line));
}
const render = (recordsValue, events = []) =>
  renderToStaticMarkup(
    h(HostedLaneView, {
      laneId: 'l',
      records: recordsValue,
      sessions: [],
      events,
      now: Date.parse('2026-11-05T12:00:00Z'),
      changes: h('p', null, 'Source changes'),
      send: async () => true,
      lifecycle: { items: null, status: null, dialog: null, abandon: () => {} },
    }),
  );

test('f9309eec: a save recorded twice with one head lists once in the record, not under a repeated key', () => {
  assert.deepEqual(
    problems(() => render(records())),
    [],
  );
});

test('f9309eec: an event read twice (same operation id) shows once in the timeline and the conversation', () => {
  const events = [message('op-1'), message('op-1'), message('op-2')];
  assert.deepEqual(
    problems(() => render(records(), events)),
    [],
  );
});

test('f9309eec: two accepted moves at one instant for one Candidate show once in the timeline', () => {
  const move = { channel: 'main', status: 'accepted', head, viewId: 'v', at: '2026-11-05T11:20:00Z' };
  assert.deepEqual(
    problems(() => render(records({}, { channelMoves: [move, { ...move }] }))),
    [],
  );
});

test('f9309eec: timeline ids stay unique when one id arrives from two sources', () => {
  const dup = { id: 'sync:op', at, tone: 'plain', glyph: 'sync', text: 'Updated from main' };
  const queue = new Map([['l', { events: [dup, { ...dup }] }]]);
  const feed = [{ id: 'sync:op', at, tone: 'plain', glyph: 'file', text: 'Same id again' }];
  const events = laneTimeline(records(), 'l', feed, true, [], queue);
  const ids = events.map(event => event.id);
  assert.equal(new Set(ids).size, ids.length, ids.join(' '));
});

test('f9309eec: two accepted moves of one Candidate on different channels at one instant both show', () => {
  const move = { status: 'accepted', head, viewId: 'v', at: '2026-11-05T11:20:00Z' };
  const moves = [
    { ...move, channel: 'main' },
    { ...move, channel: 'release' },
  ];
  const text = laneTimeline(records({}, { channelMoves: moves }), 'l', [], true, []).map(event => event.text);
  assert.deepEqual(text.filter(line => line.startsWith('Accepted')).sort(), [
    'Accepted on main',
    'Accepted on release',
  ]);
});
