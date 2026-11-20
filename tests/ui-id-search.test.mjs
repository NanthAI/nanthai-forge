// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { moduleUrl } from './convex-module.mjs';
const search = await import(moduleUrl('../web/src/shell/search-model.ts'));
const { planningGroups, searchPlanningGroups, initiativeRows } = await import(
  moduleUrl('../web/src/planning-rows.ts')
);
const { IdLookup, idPrefix, idLookupText } = await import(moduleUrl('../web/src/id-search.ts'));

// Ids shaped like dogfood's: an Intent (= its planned Item), its Lane, a Candidate, an orphan Lane.
const intentId = '1d69905b-3c1e-4a8f-9b0d-2f4e6a8c0b1d';
const laneId = '2ae78416-28fd-4d5e-b77e-252bf67edc4e';
const viewId = '9c7e00b3-cb67-45a4-9548-b03ade9c53f4';
const orphanId = 'ce0bf002-2fb7-42aa-b1ac-4f5938f88258';
const work = {
  intents: [
    { id: intentId, outcome: 'Search by id', createdAt: '2026-11-18' },
    // A title that merely contains another record's hex: found by text, ranked after the id match.
    { id: 'aaaaaaaa-0000-4000-8000-000000000000', outcome: 'Follow up on 2ae78416', createdAt: '2026-11-19' },
  ],
  lanes: [
    { id: laneId, intentId, name: 'Search by id', state: 'open' },
    { id: orphanId, intentId: 'gone', name: 'Orphan Lane', state: 'open' },
  ],
  views: [{ id: viewId, intentId, at: '2026-11-19', inputs: [{ laneId, head: 'h' }] }],
  runs: [],
};
function withLocation(run) {
  const previous = globalThis.location;
  globalThis.location = { href: 'http://local/' };
  try {
    return run();
  } finally {
    if (previous === undefined) delete globalThis.location;
    else globalThis.location = previous;
  }
}

test('an id query is 8+ hex characters, any case, with or without UUID dashes', () => {
  assert.equal(idPrefix('1d69905b'), '1d69905b');
  assert.equal(idPrefix('  1D69905B '), '1d69905b');
  assert.equal(idPrefix(intentId.toUpperCase()), intentId);
  assert.equal(idPrefix('2ae78416-28fd'), '2ae78416-28fd');
  for (const text of ['1d69905', 'search', '1d69905b fix', 'g1d69905b', 'x'.repeat(40)])
    assert.equal(idPrefix(text), undefined, text);
  assert.equal(idLookupText('1d69905b'), '1d69905b');
  assert.equal(idLookupText(intentId), intentId.replaceAll('-', ' '));
  assert.equal(idLookupText('2ae78416-28fd'), '2ae78416');
  assert.equal(idLookupText(undefined), undefined);
});

test('palette finds a Lane, Intent and Candidate by 8-char prefix, full UUID and uppercase', () =>
  withLocation(() => {
    const items = search.workSearchItems(work, true);
    // Lanes linked to an Intent stay folded into it until an id names one.
    assert.equal(items.filter(item => item.kind === 'Lane').length, 1);
    for (const query of ['2ae78416', laneId, laneId.toUpperCase(), '2AE78416-28FD']) {
      const [first, ...rest] = search.rankSearchItems(items, query, []);
      assert.equal(first.id, `lane:${laneId}`, query);
      assert.equal(first.href, search.searchHref(true, { projectTab: 'lanes', lane: laneId }));
      assert.ok(
        rest.every(item => item.id !== first.id),
        query,
      );
    }
    assert.equal(search.rankSearchItems(items, '1d69905b', [])[0].id, `intent:${intentId}`);
    assert.equal(search.rankSearchItems(items, viewId.slice(0, 8), [])[0].id, `view:${viewId}`);
    assert.equal(search.rankSearchItems(items, orphanId, [])[0].id, `lane:${orphanId}`);
    assert.deepEqual(search.rankSearchItems(items, 'deadbeef', []), []);
    assert.equal(search.idOnPage(items, '2ae78416'), true);
    assert.equal(search.idOnPage(items, 'deadbeef'), false);
  }));

test('a title that merely contains the hex ranks below the id match, even if opened recently', () =>
  withLocation(() => {
    const items = search.workSearchItems(work, true);
    const recent = ['intent:aaaaaaaa-0000-4000-8000-000000000000'];
    assert.deepEqual(
      search.rankSearchItems(items, '2ae78416', recent).map(item => item.id),
      [`lane:${laneId}`, 'intent:aaaaaaaa-0000-4000-8000-000000000000'],
    );
    // The group holding the id match leads, ahead of the fixed Intent-first order.
    assert.deepEqual(
      search.searchGroups(items, '2ae78416', recent, []).map(group => group.name),
      ['Lanes', 'Intents'],
    );
    // Ordinary text queries keep the fixed group order and the Lane folded into its Intent.
    assert.deepEqual(
      search.searchGroups(items, 'search', [], []).map(group => group.name),
      ['Intents', 'Candidates'],
    );
  }));

test('palette Items group lists looked-up Items, five shown until Show all', () =>
  withLocation(() => {
    const found = search.itemSearchItems(
      Array.from({ length: 7 }, (_, i) => ({
        id: `ee9899ca-0000-4000-8000-00000000000${i}`,
        kind: 'issue',
        title: `Item ${i}`,
        status: 'open',
      })),
      true,
    );
    const [group] = search.searchGroups(found, 'ee9899ca', [], []);
    assert.equal(group.name, 'Items');
    assert.equal(group.items.length, 5);
    assert.equal(group.total, 7);
    assert.match(group.items[0].href, /planningItem=ee9899ca/);
    assert.equal(search.searchGroups(found, 'ee9899ca', [], [], 'Item')[0].items.length, 7);
    const [initiative] = search.itemSearchItems([{ id: 'abcdef01', kind: 'initiative', title: 'G' }], true);
    assert.match(initiative.href, /planningRoute=initiative%3Aabcdef01/);
  }));

test('an id lookup runs at most once per id, debounced, and never while idle or found on the page', async () => {
  const calls = [];
  const timers = [];
  const clock = {
    set: (run, ms) => {
      const timer = { run, ms, live: true };
      timers.push(timer);
      return timer;
    },
    clear: timer => {
      if (timer) timer.live = false;
    },
  };
  const flush = async () => {
    for (const timer of timers.splice(0)) if (timer.live) timer.run();
    await new Promise(resolve => setImmediate(resolve));
  };
  let changed = 0;
  const lookup = new IdLookup(
    async text => {
      calls.push(text);
      return [{ id: text }];
    },
    () => changed++,
    350,
    clock,
  );
  // Idle palette: nothing asked, nothing called.
  await flush();
  assert.equal(calls.length, 0);
  // Ordinary text and short hex never look anything up.
  for (const query of ['s', 'se', 'search', '1d6990']) lookup.want(idPrefix(query), false);
  await flush();
  assert.equal(calls.length, 0);
  // Typing an id key by key, then extending it: one call once typing settles.
  for (let n = 8; n <= 13; n++) lookup.want(idPrefix(intentId.slice(0, n)), false);
  await flush();
  assert.deepEqual(calls, ['1d69905b']);
  assert.equal(changed, 1);
  assert.deepEqual(lookup.found('1d69905b-3c'), [{ id: '1d69905b' }]);
  // The same id again, in any case: answered from the first lookup.
  lookup.want(idPrefix('1D69905B'), false);
  await flush();
  assert.equal(calls.length, 1);
  // Completing that prefix to its full UUID reuses the prefix answer.
  lookup.want(idPrefix(intentId), false);
  await flush();
  assert.equal(calls.length, 1);
  assert.deepEqual(lookup.found(intentId), [{ id: '1d69905b' }]);
  // An id the page already holds: no call.
  lookup.want(idPrefix('2ae78416'), true);
  await flush();
  assert.equal(calls.length, 1);
  // Pasting a full UUID: exactly one call with the server's id text.
  lookup.want(idPrefix(laneId), false);
  await flush();
  assert.deepEqual(calls, ['1d69905b', laneId.replaceAll('-', ' ')]);
  lookup.want(idPrefix('cafebabe'), false);
  lookup.cancel();
  await flush();
  assert.equal(calls.length, 2);
});

test('the palette lookup is a one-shot read, never a subscription, and only for an id not on the page', () => {
  const source = readFileSync(new URL('../web/src/shell/ProjectSearch.tsx', import.meta.url), 'utf8');
  assert.match(source, /client\.query\(planningSearch,/);
  assert.doesNotMatch(source, /useHostedQuery\(planningSearch/);
  assert.match(source, /lookup\.want\(prefix, known\)/);
  assert.match(source, /idOnPage\(work, prefix\)/);
});

const item = (id, kind, extra = {}) => ({
  id,
  kind,
  title: id,
  status: 'open',
  intentIds: [],
  version: 1,
  at: '2026-11-19',
  body: '',
  ...extra,
});
test('planning filter finds rows by Item, Intent, Lane and Candidate id ahead of title matches', () => {
  const itemId = 'ee9899ca-29c7-41ba-b3c4-faa1ad28cba9';
  const initiativeId = '28591eeb-b74b-413a-ac41-1fef018b3dc1';
  const groups = planningGroups(
    [
      item(initiativeId, 'initiative', { title: 'P7', intentIds: [intentId] }),
      item(itemId, 'issue', { title: 'Site search by id' }),
      item('bbbbbbbb-0000-4000-8000-000000000000', 'issue', { title: 'Mentions 2ae78416 and ee9899ca' }),
    ],
    [{ id: intentId, outcome: 'Search by id', status: 'active' }],
    [{ id: laneId, intentId }],
    [{ id: viewId, intentId }],
  );
  const rowsFor = query =>
    searchPlanningGroups(groups, query).flatMap(group => initiativeRows(group.rows).map(row => row.id));
  for (const query of ['2ae78416', laneId, laneId.toUpperCase(), viewId.slice(0, 8), '1D69905B'])
    assert.equal(rowsFor(query)[0], intentId, query);
  assert.deepEqual(rowsFor('2ae78416'), [intentId, 'planning:bbbbbbbb-0000-4000-8000-000000000000']);
  assert.deepEqual(rowsFor('ee9899ca'), [
    `planning:${itemId}`,
    'planning:bbbbbbbb-0000-4000-8000-000000000000',
  ]);
  assert.deepEqual(rowsFor(itemId.toUpperCase()), [`planning:${itemId}`]);
  // An Initiative's own id opens its whole group.
  assert.deepEqual(rowsFor('28591EEB'), [intentId]);
  assert.deepEqual(rowsFor('deadbeef'), []);
  // Text search is unchanged.
  assert.deepEqual(rowsFor('site search'), [`planning:${itemId}`]);
});
