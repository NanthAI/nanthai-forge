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
      return { rows: [{ id: text }], retry: false };
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
  assert.match(source, /client\.query\(api\.projectHostedPlanningSearch\.search,/);
  assert.doesNotMatch(source, /useHostedQuery\(api\.projectHostedPlanningSearch/);
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

// Item ee9899ca, receipt line: a landing receipt id (8+ hex or full, any case) finds its landing.
const receiptId = '8d27a463-0b8d-46e3-8301-9046a7a99034';
const landingRow = (extra = {}) => ({
  receiptId,
  title: 'Site search finds Items by id',
  laneId,
  intentId,
  committedAt: '2026-11-20T00:42:01.578Z',
  landedHead: 'c92859e3',
  ...extra,
});
test('a receipt id lists its landing first in a Landings group, opening its Lane, else Intent, else code', () =>
  withLocation(() => {
    const items = [...search.workSearchItems(work, true), ...search.landingSearchItems([landingRow()], true)];
    for (const query of ['8d27a463', '8D27A463', receiptId, receiptId.toUpperCase()]) {
      const groups = search.searchGroups(items, query, [], []);
      assert.equal(groups[0].name, 'Landings', query);
      assert.equal(groups[0].items[0].id, `landing:${receiptId}`, query);
    }
    const [landing] = search.landingSearchItems([landingRow()], true);
    assert.equal(landing.href, search.searchHref(true, { projectTab: 'lanes', lane: laneId }));
    assert.equal(landing.secondary, 'Receipt 8d27a463');
    const [byIntent] = search.landingSearchItems([landingRow({ laneId: null })], true);
    assert.equal(byIntent.href, search.searchHref(true, { projectTab: 'intent', intent: intentId }));
    const [byCode] = search.landingSearchItems(
      [landingRow({ laneId: null, intentId: null, title: null })],
      true,
    );
    assert.equal(byCode.href, search.searchHref(true, { projectTab: 'delivery', head: 'c92859e3' }));
    assert.equal(byCode.title, 'Receipt 8d27a463');
    // A text query never surfaces a landing by its receipt id alone.
    assert.deepEqual(
      search.rankSearchItems(items, 'deadbeef', []).map(item => item.id),
      [],
    );
  }));

test('one id lookup sends the Item search and the receipt read together; no landing is an empty answer', async () =>
  withLocation(async () => {
    const { ConvexError } = await import('convex/values');
    const calls = [];
    const items = async text => {
      calls.push(['items', text]);
      return JSON.stringify({ items: [{ id: 'ee9899ca-0000-4000-8000-000000000001', matchedBy: 'id' }] });
    };
    const landing = async id => {
      calls.push(['landing', id]);
      return JSON.stringify({ schema: 1, landings: [landingRow()], nextCursor: null });
    };
    // A full UUID is looked up in the planning search's spaced form and the receipt read's dashed form.
    const found = await search.idLookupItems(receiptId.replaceAll('-', ' '), { items, landing }, true);
    assert.deepEqual(calls, [
      ['items', receiptId.replaceAll('-', ' ')],
      ['landing', receiptId],
    ]);
    assert.deepEqual(
      found.rows.map(item => item.kind),
      ['Item', 'Landing'],
    );
    assert.equal(found.retry, false);
    // An id that names no landing (or more than one) answers empty, so the Item still shows and no retry runs.
    for (const code of ['NOT_FOUND', 'AMBIGUOUS_ID']) {
      const none = await search.idLookupItems(
        '1d69905b',
        {
          items,
          landing: async () => {
            throw new ConvexError({ code, message: 'no landing' });
          },
        },
        true,
      );
      assert.deepEqual(
        none.rows.map(item => item.kind),
        ['Item'],
        code,
      );
      assert.equal(none.retry, false, code);
    }
    // Any other failure drops only the receipt read's rows (review finding 3 on de1fd508): the Item still
    // shows, and the answer says to retry, so IdLookup lets a later query ask again.
    const partial = await search.idLookupItems(
      '1d69905b',
      {
        items,
        landing: async () => {
          throw new ConvexError({ code: 'HOSTED_REQUEST_FAILED', message: 'retry' });
        },
      },
      true,
    );
    assert.deepEqual(
      partial.rows.map(item => item.kind),
      ['Item'],
    );
    assert.equal(partial.retry, true);
    // Without the planning capability or a signed-in reader, that call is not sent at all.
    calls.length = 0;
    assert.deepEqual(
      (await search.idLookupItems('8d27a463', { landing }, true)).rows.map(item => item.kind),
      ['Landing'],
    );
    assert.deepEqual(await search.idLookupItems('8d27a463', {}, true), { rows: [], retry: false });
    assert.deepEqual(calls, [['landing', '8d27a463']]);
  }));

test('the receipt lookup is the existing one-shot receipt read, never a subscription', () => {
  const source = readFileSync(new URL('../web/src/shell/ProjectSearch.tsx', import.meta.url), 'utf8');
  assert.match(source, /client\.query\(api\.projectHostedLandings\.read, \{ projectId, receiptId \}\)/);
  assert.doesNotMatch(source, /useHostedQuery\(api\.projectHostedLandings/);
});

test('a result opened after a landing at its code does not keep that landing pinned (Argon review nit 1)', () => {
  const previous = globalThis.location;
  globalThis.location = { href: 'http://local/?project=p&projectTab=delivery&head=c92859e3' };
  try {
    const [file] = [search.searchHref(true, { projectTab: 'delivery', file: 'a.ts', sourceHead: 'main1' })];
    assert.doesNotMatch(file, /[?&]head=/);
    assert.match(file, /sourceHead=main1/);
  } finally {
    if (previous === undefined) delete globalThis.location;
    else globalThis.location = previous;
  }
});

test('a failed read keeps the other reads rows, and only that id may be asked again', async () => {
  const timers = [];
  const clock = {
    set: run => (timers.push(run), run),
    clear: run => {
      const at = timers.indexOf(run);
      if (at >= 0) timers.splice(at, 1);
    },
  };
  const flush = async () => {
    for (const run of timers.splice(0)) run();
    await new Promise(resolve => setImmediate(resolve));
  };
  const answers = [
    { rows: [{ id: '1d69905b' }], retry: true },
    { rows: [{ id: '1d69905b' }, { id: '1d69905b-landing' }], retry: false },
  ];
  const calls = [];
  const lookup = new IdLookup(
    async text => (calls.push(text), answers.shift()),
    () => {},
    350,
    clock,
  );
  // Before its answer an id query is pending, so the palette says it is looking rather than "nothing matches".
  lookup.want('1d69905b', false);
  assert.equal(lookup.pending('1d69905b'), true);
  await flush();
  assert.deepEqual(lookup.found('1d69905b'), [{ id: '1d69905b' }]);
  assert.equal(lookup.pending('1d69905b'), false);
  assert.equal(lookup.failed('1d69905b'), false);
  // The failed read is asked again on the next query for that id; a complete answer is then kept.
  lookup.want('1d69905b', false);
  await flush();
  lookup.want('1d69905b', false);
  await flush();
  assert.deepEqual(calls, ['1d69905b', '1d69905b']);
  assert.equal(lookup.found('1d69905b').length, 2);
  // A lookup whose every read failed says so and is retried, never cached as "no such id".
  const failing = new IdLookup(
    async () => Promise.reject(new Error('offline')),
    () => {},
    350,
    clock,
  );
  failing.want('cafebabe', false);
  await flush();
  assert.equal(failing.failed('cafebabe'), true);
  assert.deepEqual(failing.found('cafebabe'), []);
});

test('lookupEach sends every read and drops only the rows of one that fails', async () => {
  const { lookupEach } = await import(moduleUrl('../web/src/id-search.ts'));
  assert.deepEqual(await lookupEach([Promise.resolve([1]), Promise.reject(new Error('x')), [2]]), {
    rows: [1, 2],
    retry: true,
  });
  assert.deepEqual(await lookupEach([Promise.resolve([1]), []]), { rows: [1], retry: false });
});

// Incident 2026-11-20 (Item ee9899ca): on the live site the owner pasted 1d69905b into ⌘K and got "Nothing
// matches.". Every address under /- is the rebuilt app, whose palette (app/keys.tsx) never had id search; the
// tests above cover only the old shell's palette. The rebuilt palette's lookup sends these three existing reads,
// and its arguments are checked against the real Convex validators, so the fake cannot drift from the server.
test('the rebuilt palette finds an Item, a Lane and a landing by id through the real reads and validators', async () => {
  const { checkArgs } = await import('./convex-args.mjs');
  const { getFunctionName } = await import('convex/server');
  const { ConvexError } = await import('convex/values');
  const { idRows, idGroups } = await import(moduleUrl('../web/src/app/id-palette.ts'));
  const modules = {
    projectHostedPlanningSearch: await import(moduleUrl('../convex/projectHostedPlanningSearch.ts')),
    projectHostedLaneHistory: await import(moduleUrl('../convex/projectHostedLaneHistory.ts')),
    projectHostedLandings: await import(moduleUrl('../convex/projectHostedLandings.ts')),
  };
  const route = {
    frame: 'project',
    handle: 'example',
    project: 'parser',
    place: 'needs',
    section: '',
    rest: '',
  };
  const itemId = '1d69905b-6539-42d9-a8ed-519234dbf9c6';
  const calls = [];
  const replies = {
    'projectHostedPlanningSearch:search': () =>
      JSON.stringify({
        items: [
          { id: itemId, kind: 'issue', title: 'Speed series follow-ups', matchedBy: 'id' },
          // A text mention of the id is someone else's Item: never offered as what the id names.
          { id: 'ad80e037-35a3-44c5-9ba2-025519a2c45f', kind: 'issue', title: 'Mentions 1d69905b' },
        ],
      }),
    'projectHostedLaneHistory:resolveLaneId': () => JSON.stringify({ ids: [laneId], more: false }),
    'projectHostedLandings:read': () => {
      throw new ConvexError({ code: 'NOT_FOUND', message: 'No landing' });
    },
  };
  const query = async (ref, args) => {
    const name = getFunctionName(ref);
    const [module, fn] = name.split(':');
    checkArgs(modules[module][fn], args, name);
    calls.push([name, args]);
    return replies[name]();
  };
  const found = await idRows('1d69905b', route, 'synthetic', query);
  assert.deepEqual(
    calls.map(([name]) => name),
    [
      'projectHostedPlanningSearch:search',
      'projectHostedLaneHistory:resolveLaneId',
      'projectHostedLandings:read',
    ],
  );
  assert.equal(found.retry, false);
  const groups = idGroups(found.rows, '1d69905b');
  assert.deepEqual(
    groups.map(group => [group.title, group.entries.map(entry => entry.label)]),
    [['Items', ['1d69905b · Speed series follow-ups']]],
  );
  // The palette filters by what was typed: an entry matches its full id in any case.
  assert.match(groups[0].entries[0].text, new RegExp(itemId));
  const lane = idGroups(found.rows, '2ae78416');
  assert.deepEqual(
    lane.map(group => group.title),
    ['Lanes'],
  );
  // A full UUID: the planning search gets its spaced form, the Lane resolver its first 35 characters (its
  // limit) and the receipt read the dashed id.
  calls.length = 0;
  replies['projectHostedLandings:read'] = () =>
    JSON.stringify({
      schema: 1,
      landings: [{ receiptId, title: 'Fix id search', laneId }],
      nextCursor: null,
    });
  const full = await idRows(receiptId.replaceAll('-', ' '), route, 'synthetic', query);
  assert.deepEqual(
    calls.map(([name, args]) => args.text ?? args.prefix ?? args.receiptId),
    [receiptId.replaceAll('-', ' '), receiptId.slice(0, 35), receiptId],
  );
  const landing = idGroups(full.rows, receiptId).find(group => group.title === 'Landings');
  assert.equal(landing.entries[0].label, `${receiptId.slice(0, 8)} · Fix id search`);
});

test('the rebuilt palette opens what an id names at its rebuilt address', async () =>
  withLocation(async () => {
    const { idRows } = await import(moduleUrl('../web/src/app/id-palette.ts'));
    const route = {
      frame: 'project',
      handle: 'example',
      project: 'parser',
      place: 'stats',
      section: '',
      rest: '',
    };
    const itemId = '1d69905b-6539-42d9-a8ed-519234dbf9c6';
    const query = async ref => {
      const name = (await import('convex/server')).getFunctionName(ref);
      if (name.endsWith(':search'))
        return JSON.stringify({ items: [{ id: itemId, title: 'An Item', matchedBy: 'id' }] });
      if (name.endsWith(':resolveLaneId')) return JSON.stringify({ ids: [laneId] });
      return JSON.stringify({
        landings: [{ receiptId }, { receiptId: '8d27a463-0000-4000-8000-000000000002', laneId }],
      });
    };
    const { rows } = await idRows('1d69905b', route, 'synthetic', query);
    // A landing opens its Lane (Code's History holds only its newest pages: review 4cb180d5 finding 1), else its receipt.
    assert.deepEqual(
      rows.map(row => row.href),
      [
        `/example/parser/plan/${itemId}`,
        `/example/parser/lanes/${laneId}`,
        `/example/parser/code/${receiptId}`,
        `/example/parser/lanes/${laneId}`,
      ],
    );
  }));
