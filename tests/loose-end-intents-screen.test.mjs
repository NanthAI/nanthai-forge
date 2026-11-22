// SPDX-License-Identifier: Apache-2.0
// Item fc1831eb: the Loose ends page lists open Intents with no Item (web side). The group is read on request, one
// bounded page at a time; the owner tidies picked rows in batches of 25 through one retry-safe mutation each, and a
// batch that failed outright is replayed exactly as it was. Each test names the behaviour it guards.
import test from 'node:test';
import assert from 'node:assert/strict';
import { ConvexError } from 'convex/values';
import { moduleUrl } from './convex-module.mjs';
import { looseEndIntentCursor, looseEndIntentPageSize } from '../dist/hosted-lifecycle.js';

const { looseEndsScreen, mergePage } = await import(moduleUrl('../web/src/app/needs/loose-ends.ts'));
const { INTENT_BATCH, INTENT_CURSOR, intentBatches, intentWord, reopenIntents, tidyIntents } = await import(
  moduleUrl('../web/src/app/needs/loose-intents.ts')
);

const NOW = Date.UTC(2026, 10, 22, 12);
const day = 86_400_000;
const id = n => `5d1c7a0e-0000-4000-8002-${String(n).padStart(12, '0')}`;
const pin = n => ({ projectId: 'p1', intentId: id(n), version: 3, laneRevision: 0, observedAt: NOW });
const intent = (n, extra = {}) => ({
  selection: pin(n),
  status: 'active',
  title: `Leftover Intent ${n}`,
  lastActivityAt: new Date(NOW - n * day).toISOString(),
  reason: 'No linked Item',
  ...extra,
});
const live = (setAside = { authorityEpoch: 1 }) => ({
  at: NOW,
  setAside,
  groups: { idle: { reported: true, rows: [], continueCursor: null } },
});
const page = (rows, continueCursor = null) => ({
  at: NOW,
  setAside: { authorityEpoch: 1 },
  groups: { intents: { reported: true, rows, continueCursor } },
});
const section = (read, pages) =>
  looseEndsScreen(read, pages, NOW).sections.find(entry => entry.key === 'intents');

test('the web cursor and batch size are the server’s', () => {
  assert.equal(INTENT_CURSOR, looseEndIntentCursor);
  assert.equal(INTENT_BATCH, looseEndIntentPageSize);
});

test('open Intents are not read until asked: the group offers its first page and adds nothing to the count', () => {
  const screen = looseEndsScreen(live(), {}, NOW);
  const group = screen.sections.find(entry => entry.key === 'intents');
  assert.equal(group.unread, true);
  assert.deepEqual(group.rows, []);
  assert.equal(group.cursor, null);
  assert.equal(screen.total, 0);
  assert.equal(screen.exhausted, true, 'the other groups still read "nothing left"');
});

test('a read page lists Intents oldest first as returned, with last activity, and the owner can pick them', () => {
  const read = live();
  const pages = mergePage({}, 'intents', page([intent(9), intent(4)], 'next'));
  const group = section(read, pages);
  assert.equal(group.unread, false);
  assert.deepEqual(
    group.rows.map(row => [row.title, row.age, row.pickable, row.action]),
    [
      ['Leftover Intent 9', '9 days', true, 'tidy'],
      ['Leftover Intent 4', '4 days', true, 'tidy'],
    ],
  );
  assert.equal(group.rows[0].laneId, null, 'an Intent is never handed to an agent as a Lane');
  assert.deepEqual(group.rows[0].intent, pin(9));
  assert.equal(group.cursor, 'next');
  const screen = looseEndsScreen(read, pages, NOW);
  assert.match(screen.sentence.bold, /^2 or more loose ends/);
});

test('a member who is not the owner sees the rows but cannot tidy them', () => {
  const pages = mergePage({}, 'intents', page([intent(2)]));
  const [row] = section(live(null), pages).rows;
  assert.equal(row.pickable, false);
  assert.equal(row.action, null);
});

test('an Intent the batch would refuse is listed for review, not pickable, and says why', () => {
  const pages = mergePage(
    {},
    'intents',
    page([
      intent(1, { reason: 'Item link not reported' }),
      intent(2, { lastActivityAt: null }),
      intent(3, { status: 'proposed' }),
      intent(4, { status: 'ready' }),
      intent(5),
    ]),
  );
  const rows = section(live(), pages).rows;
  assert.deepEqual(
    rows.map(row => row.pickable),
    [false, false, false, false, true],
  );
  assert.match(rows[0].evidence, /Item link not reported.*review it before tidying/);
  assert.match(rows[1].evidence, /review them first/);
  assert.equal(rows[1].age, 'activity not known');
  assert.match(rows[2].evidence, /proposed; review it before tidying/, 'Undo would reopen it as open');
  assert.match(rows[3].evidence, /ready; review it before tidying/);
});

test('a page read to its end with none left says so without calling the screen partial', () => {
  const pages = mergePage({}, 'intents', page([]));
  const screen = looseEndsScreen(live(), pages, NOW);
  const group = screen.sections.find(entry => entry.key === 'intents');
  assert.equal(group.why, 'None found. Every open Intent has an Item.');
  assert.equal(screen.exhausted, true);
});

test('an empty page that continues keeps its cursor and does not claim none were found', () => {
  const pages = mergePage({}, 'intents', page([], 'again'));
  const group = section(live(), pages);
  assert.equal(group.cursor, 'again');
  assert.equal(group.why, null);
});

test('Intents are batched 25 to a mutation; each batch carries its own operation id and the exact request', () => {
  const pins = Array.from({ length: 60 }, (_, n) => pin(n));
  const batches = intentBatches(7, pins);
  assert.deepEqual(
    batches.map(batch => batch.ids.length),
    [25, 25, 10],
  );
  assert.equal(new Set(batches.map(batch => batch.operationId)).size, 3);
  const request = JSON.parse(batches[2].request);
  assert.equal(request.authorityEpoch, 7);
  assert.deepEqual(request.intents, pins.slice(50));
  assert.ok(request.reason.length > 0);
});

test('a batch that fails outright marks only its rows failed and is returned to replay unchanged; the rest keep the server’s words', async () => {
  const batches = intentBatches(
    1,
    Array.from({ length: 30 }, (_, n) => pin(n)),
  );
  const seen = [];
  const call = async ({ operationId, request }) => {
    seen.push(operationId);
    if (operationId === batches[1].operationId) throw new Error('network');
    return JSON.stringify({
      results: JSON.parse(request).intents.map(entry =>
        entry.intentId === id(3)
          ? { intentId: entry.intentId, result: 'saved-since-selection' }
          : { intentId: entry.intentId, result: 'set-aside', version: 4 },
      ),
    });
  };
  const { results, versions, failed } = await tidyIntents(call, batches);
  assert.equal(
    results[id(3)],
    'saved-since-selection',
    'a save newer than the page read is skipped and named',
  );
  assert.equal(results[id(0)], 'set-aside');
  assert.equal(versions[id(0)], 4);
  assert.equal(results[id(27)], 'failed');
  assert.deepEqual(failed, [batches[1]], 'the same operation id and request, so a replay reconciles');
  assert.deepEqual(
    seen,
    batches.map(batch => batch.operationId),
  );
});

test('Undo reopens at the version the receipt returned; one changed since is skipped, any other failure is retryable', async () => {
  const calls = [];
  const call = async ({ request }) => {
    const { target, action, authorityEpoch, operationId } = JSON.parse(request);
    calls.push([action, authorityEpoch, target.intentId, target.version, target.cascade, operationId]);
    if (target.intentId === id(2)) throw new ConvexError({ code: 'WORK_STALE' });
    if (target.intentId === id(3)) throw new Error('network');
  };
  const results = await reopenIntents(
    call,
    5,
    [1, 2, 3].map(n => ({
      intentId: id(n),
      version: 4,
      operationId: `0000000${n}-0000-4000-8000-000000000000`,
    })),
  );
  assert.deepEqual(results, { [id(1)]: 'reopened', [id(2)]: 'changed', [id(3)]: 'failed' });
  assert.deepEqual(calls[0], ['reopen', 5, id(1), 4, false, '00000001-0000-4000-8000-000000000000']);
  // A retry after a lost reply replays the operation id each row was given, so the server reconciles it.
  await reopenIntents(call, 5, [
    { intentId: id(3), version: 4, operationId: '00000003-0000-4000-8000-000000000000' },
  ]);
  assert.equal(calls.at(-1)[5], calls[2][5]);
});

test('every refusal word the server can return reads as a named skip; only a failed call offers retry', () => {
  for (const result of [
    'saved-since-selection',
    'intent-changed',
    'lane-changed',
    'item-linked',
    'item-link-not-reported',
    'child-review-required',
    'not-open',
    'not-found',
  ]) {
    const word = intentWord(result);
    assert.match(word.word, /^Skipped: /, result);
    assert.equal(word.retry, false);
  }
  assert.equal(intentWord('failed').retry, true);
  assert.equal(intentWord('set-aside').done, true);
});
