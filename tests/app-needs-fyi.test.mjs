// SPDX-License-Identifier: Apache-2.0
// Needs me › FYI as data (Item 48049998, decision b15fff49): an agent's conflict and a refusal are FYI rows, newest
// first, beside landings, settings changes and messages; a dismissal is keyed to the row version so a newer version
// shows again; Clear all hides what came before it; events count from the clear line or from today; the figures say
// "or more" when the read stopped short, and CI time thrown away is "not reported" when a redone check did not say.
import test from 'node:test';
import assert from 'node:assert/strict';
import { moduleUrl } from './convex-module.mjs';

const { needsView } = await import(moduleUrl('../web/src/app/needs/model.ts'));
const { fyiView, tileText, sinceText, startOfDay } = await import(moduleUrl('../web/src/app/needs/fyi.ts'));

const NOW = new Date(2026, 10, 17, 15, 0).getTime();
const minutesAgo = n => NOW - n * 60_000;
const held = (laneId, why, since, extra = {}) => ({
  laneId,
  title: `Title ${laneId}`,
  actor: 'sample-one',
  agent: 'quiet-otter',
  why,
  note: null,
  submissionId: null,
  since,
  ...extra,
});
const needs = lanes =>
  needsView({
    held: lanes,
    more: 0,
    moreIsLowerBound: false,
    approvals: JSON.stringify({ requests: [], complete: true }),
    canDecide: true,
  });
const landing = (receiptId, at, extra = {}) => ({
  receiptId,
  sequence: 1,
  at,
  title: `Landing ${receiptId}`,
  actor: 'sample-one',
  agent: true,
  checked: true,
  redone: false,
  redoneWhy: null,
  thrown: 0,
  laneId: `lane-${receiptId}`,
  ...extra,
});
const fyiRead = (extra = {}) => ({
  owner: true,
  state: { clearedAt: null, clearedSequence: null, dismissed: [] },
  landings: [],
  landingsMore: false,
  broke: [],
  settings: [],
  access: [],
  messages: [],
  messagesMore: false,
  ...extra,
});

test('agent conflicts and refusals are FYI rows beside landings and settings, newest first, by area', () => {
  const view = fyiView(
    fyiRead({
      landings: [landing('r1', minutesAgo(5)), landing('r0', minutesAgo(3 * 24 * 60))],
      settings: [
        { id: 's1', at: minutesAgo(30), actor: 'sample-one', areas: ['checks'], rule: 'owner-person' },
      ],
      messages: [
        { id: 'm1', at: minutesAgo(1), actor: 'p', agent: 'amber-fox', text: 'Heads up', laneId: 'x' },
      ],
    }),
    needs([held('c', 'conflict', minutesAgo(10)), held('r', 'rejected', minutesAgo(20))]).fyi,
    NOW,
  );
  assert.deepEqual(
    view.rows.map(row => [row.key.split('@')[0], row.area]),
    [
      ['message:m1', 'code'],
      ['landing:r1', 'code'],
      ['held:c', 'code'],
      ['held:r', 'code'],
      ['setting:s1', 'outside'],
    ],
    "yesterday's landing is outside today's window; held Lanes and messages last while their state does",
  );
  const conflict = view.rows.find(row => row.key.startsWith('held:c'));
  assert.match(conflict.fact, /^next: sample-one\/quiet-otter updates it from main and lands again/);
  assert.deepEqual(view.counts, { all: 5, code: 4, outside: 1 });
  assert.equal(view.rows.find(row => row.key.startsWith('setting:')).title, 'Settings changed: checks');
});

test('a dismissal hides that version only: a newer hold on the same Lane shows again', () => {
  const first = needs([held('c', 'conflict', minutesAgo(10))]).fyi;
  const key = fyiView(fyiRead(), first, NOW).rows[0].key;
  const dismissed = fyiRead({ state: { clearedAt: null, clearedSequence: null, dismissed: [key] } });
  assert.deepEqual(fyiView(dismissed, first, NOW).rows, []);
  const again = needs([held('c', 'conflict', minutesAgo(2))]).fyi;
  assert.equal(fyiView(dismissed, again, NOW).rows.length, 1, 'held again later: a new version');
});

test('Clear all hides what came before it and the figures count from the clear line', () => {
  const clearedAt = minutesAgo(15);
  const read = fyiRead({
    state: { clearedAt, clearedSequence: 4, dismissed: [] },
    landings: [
      landing('new', minutesAgo(5), { redone: true, thrown: 240 }),
      landing('newer', minutesAgo(1), { redone: true, thrown: 60 }),
    ],
  });
  const view = fyiView(
    read,
    needs([held('old', 'conflict', minutesAgo(40)), held('fresh', 'conflict', minutesAgo(3))]).fyi,
    NOW,
  );
  assert.deepEqual(
    view.rows.map(row => row.key.split('@')[0]),
    ['landing:newer', 'held:fresh', 'landing:new'],
  );
  assert.deepEqual(view.tiles, { landed: 2, broke: 0, redone: 2, thrown: 300, atLeast: false });
  assert.deepEqual(
    tileText(view.tiles).map(tile => `${tile.n} ${tile.label}`),
    ['2 landed', '0 broke main', '2 checks redone', '5 min CI time thrown away'],
  );
  assert.match(sinceText(view.since, NOW), /^since you cleared at /);
});

test('never cleared: the window is today, and the figures say "or more" past the read', () => {
  const view = fyiView(
    fyiRead({
      landings: [landing('a', minutesAgo(2), { redone: true, thrown: null }), landing('b', minutesAgo(3))],
      landingsMore: true,
    }),
    [],
    NOW,
  );
  assert.equal(view.since.at, startOfDay(NOW));
  assert.equal(sinceText(view.since, NOW), 'today');
  assert.deepEqual(
    tileText(view.tiles).map(tile => tile.n),
    ['2+', '0', '1+', 'not reported'],
  );
});

test('an email invitation never shows its address; a settings change names its areas', () => {
  const view = fyiView(
    fyiRead({
      access: [
        { id: 'i1', at: minutesAgo(1), role: 'read', handle: null, state: 'pending', inviter: 'sample-one' },
        {
          id: 'i2',
          at: minutesAgo(2),
          role: 'write',
          handle: 'odile',
          state: 'accepted',
          inviter: 'sample-one',
        },
      ],
    }),
    [],
    NOW,
  );
  assert.deepEqual(
    view.rows.map(row => row.title),
    ['Someone invited as a reader', '@odile invited as a writer'],
  );
  assert.notEqual(
    view.rows[0].key,
    fyiView(
      fyiRead({
        access: [
          {
            ...view.rows[0],
            id: 'i1',
            state: 'accepted',
            at: minutesAgo(1),
            role: 'read',
            handle: null,
            inviter: null,
          },
        ],
      }),
      [],
      NOW,
    ).rows[0].key,
    'an accepted invitation is a new version',
  );
});
