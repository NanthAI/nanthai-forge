// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { moduleUrl } from './convex-module.mjs';

// Ids shaped like dogfood's: a Lane and a landing receipt.
const laneId = '2ae78416-28fd-4d5e-b77e-252bf67edc4e';
const receiptId = '8d27a463-0b8d-46e3-8301-9046a7a99034';
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

// Incident 2026-11-20 (Item ee9899ca): on the live site the owner pasted 1d69905b into ⌘K and got "Nothing
// matches.". Every address under /- is the rebuilt app, whose palette (app/keys.tsx) never had id search; the
// old shell's palette is gone. The rebuilt palette's lookup sends these three existing reads,
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
