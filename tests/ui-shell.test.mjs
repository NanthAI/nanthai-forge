// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { createElement as h } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { moduleUrl } from './convex-module.mjs';
const route = await import(moduleUrl('../web/src/shell/route.ts'));
const { cockpitLanes, byAttention } = await import(moduleUrl('../web/src/cockpit/model.ts'));

test('every hosted project page belongs to exactly one destination', () => {
  const sections = Object.values(route.hostedSections).flat();
  assert.equal(new Set(sections).size, sections.length);
  assert.equal(route.hostedTab('lanes'), 'intents');
  assert.equal(route.hostedTab('delivery'), 'code');
  assert.equal(route.hostedTab('backups'), 'settings');
  assert.equal(route.hostedTab(null), 'now');
});

test('signed-out visitors only reach the public entry; repositories stay linkable', () => {
  assert.equal(route.entryFor(false, '?project=p1'), 'public');
  assert.equal(route.entryFor(false, '?codescape=c1'), 'repository');
  assert.equal(route.entryFor(true, '?project=p1'), 'project');
  assert.equal(route.entryFor(true, ''), 'account');
});

const oid = n => String(n).repeat(64).slice(0, 64);
const lane = (id, extra = {}) => ({
  id,
  intentId: 'i1',
  name: id,
  base: oid(1),
  head: oid(2),
  assignment: '',
  target: '',
  state: 'active',
  checkpoints: [{ head: oid(2), parent: oid(1), message: 'save', at: '2026-10-14T10:00:00Z' }],
  ...extra,
});
const view = (id, laneId, status = 'clean', at = '2026-10-14T10:05:00Z') => ({
  id,
  intentId: 'i1',
  base: oid(1),
  inputs: [{ laneId, head: oid(2) }],
  status,
  details: '',
  at,
});
const run = (viewId, status, details = '') => ({
  id: `r-${viewId}`,
  viewId,
  status,
  startedAt: '2026-10-14T10:06:00Z',
  details,
});

test('cockpit derives attention only from recorded Work', () => {
  const work = {
    intents: [{ id: 'i1', outcome: 'Fix tax rounding', agentStart: { laneId: 'agent' } }],
    lanes: [
      lane('working'),
      lane('failing'),
      lane('ready'),
      lane('conflicted', {
        pendingMerge: {
          parent: oid(3),
          channel: 'main',
          operation: {},
          conflicts: [{ path: 'a.ts', kind: 'text' }],
        },
      }),
      lane('done', { state: 'completed' }),
      lane('agent'),
    ],
    views: [view('vf', 'failing'), view('vr', 'ready')],
    runs: [run('vf', 'failed', '2 tests failed\nmore'), run('vr', 'passed')],
  };
  const lanes = cockpitLanes(work);
  const by = Object.fromEntries(lanes.map(item => [item.id, item]));
  assert.equal(by.working.tone, 'active');
  assert.equal(by.failing.tone, 'failed');
  assert.equal(by.failing.fact, 'Check failed · nobody’s on it');
  assert.equal(by.ready.tone, 'passed');
  assert.equal(by.conflicted.tone, 'conflict');
  assert.match(by.conflicted.fact, /a\.ts/);
  assert.equal(by.done.open, false);
  assert.equal(by.agent.byAgent, true);
  assert.equal(by.working.byAgent, false);
  assert.deepEqual(
    byAttention(lanes)
      .map(item => item.id)
      .slice(0, 3),
    ['conflicted', 'failing', 'ready'],
  );
});

test('a View of an older Lane head does not describe the current Lane', () => {
  const stale = { ...view('old', 'l'), inputs: [{ laneId: 'l', head: oid(9) }] };
  const [result] = cockpitLanes({
    intents: [],
    lanes: [lane('l')],
    views: [stale],
    runs: [run('old', 'passed')],
  });
  assert.equal(result.tone, 'active');
  assert.equal(result.intent, 'Unknown Intent');
});

test('the shell renders named destinations with the current page marked', async () => {
  const { Shell } = await import(moduleUrl('../web/src/shell/Shell.tsx'));
  const html = renderToStaticMarkup(
    h(
      Shell,
      {
        tabs: [
          { id: 'now', label: 'Now', glyph: 'now' },
          { id: 'code', label: 'Code', glyph: 'code' },
        ],
        current: 'now',
        onTab() {},
      },
      h('p', null, 'content'),
    ),
  );
  assert.match(html, /aria-current="page"[^>]*>.*Now/);
  assert.match(html, /href="#fx-main"/);
  assert.equal((html.match(/aria-label="Project"/g) ?? []).length, 2);
});

test('cockpit tolerates partial hosted index records (Views without inputs, Lanes without checkpoints)', () => {
  const lanes = cockpitLanes({
    intents: [{ id: 'i1', outcome: 'Hosted intent' }],
    lanes: [{ id: 'l1', intentId: 'i1', name: 'Hosted lane', base: 'b', head: 'h', state: 'active' }],
    views: [{ id: 'v1', intentId: 'i1', base: 'b', status: 'clean', at: '2026-10-14T00:00:00.000Z' }],
    runs: [],
  });
  assert.equal(lanes.length, 1);
  assert.equal(lanes[0].label, 'Working');
  assert.equal(lanes[0].checkpoints, 0);
  assert.equal(lanes[0].owner, '');
});

const search = await import(moduleUrl('../web/src/shell/search-model.ts'));
test('search ranks opened items first, matches every query word and never manufactures results', () => {
  const items = [
    { id: 'a', kind: 'Intent', title: 'Fix long tax title', at: '2026-10-15', href: '/a' },
    { id: 'b', kind: 'Lane', title: 'Fix tax rounding', at: '2026-10-14', href: '/b' },
    { id: 'c', kind: 'File', title: 'src/tax.ts', href: '/c' },
  ];
  assert.deepEqual(
    search.rankSearchItems(items, 'tax', ['c', 'b']).map(x => x.id),
    ['c', 'b', 'a'],
  );
  assert.deepEqual(
    search.rankSearchItems(items, 'lane rounding', []).map(x => x.id),
    ['b'],
  );
  assert.deepEqual(search.rankSearchItems(items, 'absent', []), []);
  assert.deepEqual(
    search.rankSearchItems(items, '', []).map(x => x.id),
    ['a', 'b', 'c'],
  );
});

test('search links discard stale source and drill-down pins before choosing a result', () => {
  const previous = globalThis.location;
  globalThis.location = {
    href: 'http://local/?tab=intents&intent=old&lane=old&laneId=old&state=old&sourceHead=old&sourceBackup=old',
  };
  try {
    const result = new URL(
      search.searchHref(false, { tab: 'code', view: 'source', file: 'src/a b.ts' }),
      'http://local/',
    );
    assert.match(result.pathname, /code/);
    assert.match(decodeURIComponent(result.pathname), /src\/a b\.ts/);
    for (const stale of ['intent', 'lane', 'laneId', 'state', 'sourceHead', 'sourceBackup'])
      assert.equal(result.searchParams.has(stale), false);
  } finally {
    if (previous === undefined) delete globalThis.location;
    else globalThis.location = previous;
  }
});

test('Work navigation shares the h1 row and uses only supplied counts', async () => {
  const { WorkHeaderProvider } = await import(moduleUrl('../web/src/shell/WorkHeader.tsx'));
  const { PageHead } = await import(moduleUrl('../web/src/shell/Shell.tsx'));
  const html = renderToStaticMarkup(
    h(
      WorkHeaderProvider,
      { page: 'planning', counts: { intents: 7, lanes: 5, views: 3 }, onChange() {} },
      h(PageHead, { title: 'Planning', actions: h('button', null, 'New issue') }),
    ),
  );
  assert.match(html, /fx-title-row.*<h1>Work<\/h1><nav class="fx-work-nav"/);
  assert.match(html, /aria-label="Work views"/);
  assert.match(html, /fx-count">7<\/span>/);
  assert.match(html, /fx-count">5<\/span>/);
  assert.doesNotMatch(html, /<span>Views<\/span>/);
  assert.equal((html.match(/class="fx-count"/g) ?? []).length, 2);
  assert.match(html, /fx-page-actions.*New issue/);
});

test('palette groups query matches and bounds the empty state without dropping searchable records', () => {
  const items = Array.from({ length: 20 }, (_, i) => ({
    id: `lane:${i}`,
    kind: 'Lane',
    title: `Tax ${i}`,
    href: `/lanes/${i}`,
  }));
  const empty = search.searchGroups(items, '', ['lane:8'], ['lane:1', 'lane:1', 'lane:2']);
  assert.ok(empty.flatMap(group => group.items).length <= 8);
  assert.equal(empty[0].name, 'Needs you');
  assert.equal(empty[1].items[0].id, 'lane:8');
  const [group] = search.searchGroups(items, 'tax', [], []);
  assert.equal(group.name, 'Lanes');
  assert.equal(group.items.length, 5);
  assert.equal(group.total, 20);
  assert.equal(search.searchGroups(items, 'tax', [], [], 'Lane')[0].items.length, 20);
});
test('View search names composition and keeps its number secondary', () => {
  const previous = globalThis.location;
  globalThis.location = { href: 'http://local/' };
  try {
    const items = search.workSearchItems(
      {
        intents: [{ id: 'i1', outcome: 'Fix tax' }],
        lanes: [lane('l1')],
        views: [view('v1', 'l1'), { ...view('v2', 'l1'), intentId: undefined, inputs: [] }],
        runs: [],
      },
      false,
    );
    assert.equal(items.find(item => item.id === 'view:v1').title, 'Fix tax');
    assert.equal(items.find(item => item.id === 'view:v1').secondary, 'View 1');
    assert.equal(items.find(item => item.id === 'view:v2').title, 'main + 0 Lanes');
  } finally {
    if (previous === undefined) delete globalThis.location;
    else globalThis.location = previous;
  }
});

test('Intent filter counts stay hidden until the loaded set is complete, with no duplicate summary', async () => {
  const { IntentListView } = await import(moduleUrl('../web/src/intents/IntentList.tsx'));
  const html = renderToStaticMarkup(
    h(IntentListView, { rows: [], now: 0, intentHref: () => '/', countsKnown: false }),
  );
  assert.equal((html.match(/visibility:hidden/g) ?? []).length, 5);
  assert.doesNotMatch(html, /ready for review|Planning board|fx-page-summary/);
});

const { GithubStatus } = await import(moduleUrl('../web/src/settings/GithubStatus.tsx'));
test('GitHub commands distinguish disconnected, imported and pushed repositories', () => {
  const disconnected = renderToStaticMarkup(h(GithubStatus, {}));
  assert.match(disconnected, /Not connected to GitHub/);
  assert.match(disconnected, /Preview/);
  assert.match(disconnected, /--repo REPO --dry-run/);
  assert.doesNotMatch(disconnected, /--push|Publication unknown|fx-st/);
  const malformed = renderToStaticMarkup(h(GithubStatus, { repository: 'example/project; echo unsafe' }));
  assert.doesNotMatch(malformed, /echo unsafe/);
  const imported = renderToStaticMarkup(h(GithubStatus, { repository: 'example/project' }));
  assert.match(imported, /Publishes to example\/project/);
  assert.match(imported, /never pushed/);
  assert.match(imported, /Publish/);
  assert.match(imported, /--repo example\/project --push/);
  const pushed = renderToStaticMarkup(
    h(GithubStatus, {
      binding: {
        repository: 'example/project',
        branch: 'main',
        pushed: 1,
        pushedAt: '2026-10-15T12:00:00.000Z',
        commits: [{ state: 'abc', commit: 'def' }],
      },
    }),
  );
  assert.match(pushed, /last pushed/);
  assert.match(pushed, /dateTime="2026-10-15T12:00:00.000Z"/);
  assert.doesNotMatch(pushed, /never pushed|OWNER\/REPO/);
});

test('palette keeps Planned Intents searchable and uses the shared progress label', () => {
  const work = {
    intents: [{ id: 'p', outcome: 'Backlog task', status: 'active' }],
    lanes: [],
    views: [],
    runs: [],
  };
  assert.equal(search.workSearchItems(work, false)[0].secondary, 'Planned');
  assert.equal(search.rankSearchItems(search.workSearchItems(work, false), 'Backlog', []).length, 1);
  work.lanes.push({ id: 'old', intentId: 'p', name: 'Previous attempt', state: 'abandoned' });
  assert.equal(search.workSearchItems(work, true)[0].secondary, 'Lane · Previous attempt');
  assert.equal(search.workSearchItems(work, true).length, 1);
});

test('palette groups all linked Lanes under one Intent while retaining orphan Lanes', () => {
  const items = search.workSearchItems(
    {
      intents: [{ id: 'i', outcome: 'Fix tax' }],
      lanes: [
        {
          id: 'a',
          intentId: 'i',
          name: 'Fix tax',
          state: 'active',
          checkpointCount: 1,
          lastCheckpointAt: '2026-10-16T12:00:00Z',
        },
        { id: 'b', intentId: 'i', name: 'Tax tests' },
        { id: 'c', intentId: 'missing', name: 'Orphan' },
      ],
      views: [],
      runs: [],
    },
    false,
    Date.parse('2026-10-16T12:05:00Z'),
  );
  assert.equal(items.length, 2);
  assert.equal(items[0].secondary, 'Lanes · Working · 5 min / Tax tests');
  assert.doesNotMatch(items[0].secondary, /Fix tax/);
  assert.equal(search.rankSearchItems(items, 'Tax tests', [])[0].id, 'intent:i');
  assert.equal(items[1].id, 'lane:c');
});

test('GitHub mirror settings render retry progress and retained divergent heads', () => {
  const status = {
    status: 'retrying',
    repository: 'example/project',
    code: 'GITHUB_SYNC_GIT_FAILED',
    nextAttemptAt: '2026-10-17T12:00:00Z',
    state: 'state-one',
    localHead: 'local-one',
    remoteHead: 'remote-one',
    expectedHead: 'expected-one',
  };
  const retry = renderToStaticMarkup(h(GithubStatus, { autoPush: status }));
  assert.match(retry, /retrying/);
  assert.match(retry, /next attempt/);
  const conflict = renderToStaticMarkup(h(GithubStatus, { autoPush: { ...status, status: 'needs-you' } }));
  assert.match(conflict, /Needs you/);
  for (const value of ['state-one', 'local-one', 'remote-one', 'expected-one'])
    assert.ok(conflict.includes(value));
});
