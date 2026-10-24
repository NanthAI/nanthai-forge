// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { createElement as h } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { moduleUrl } from './convex-module.mjs';
const { codeSourceLink, savedLink } = await import(moduleUrl('../web/src/shell/ObjectActions.tsx'));
const { Breadcrumbs, workHref } = await import(moduleUrl('../web/src/shell/Breadcrumbs.tsx'));
const { Menu } = await import(moduleUrl('../web/src/ui/Menu.tsx'));

function at(href, run) {
  const old = globalThis.location;
  globalThis.location = new URL(href);
  try {
    run();
  } finally {
    if (old) globalThis.location = old;
    else delete globalThis.location;
  }
}
const head = 'b'.repeat(64);
test('Lane source opens the hosted Code browser at its exact save and retains Lane identity', () => {
  at('https://forge.test/?project=project-a&projectTab=lanes&lane=lane-a&token=private', () => {
    const url = new URL(codeSourceLink(head, 'lane-a'), location.href);
    // HostedFrame always renders HostedCode; the head only sets the Source picker.
    assert.equal(url.searchParams.get('head'), head);
    assert.equal(url.searchParams.has('sourceHead'), false);
    assert.equal(url.searchParams.has('sourceBackup'), false);
    assert.equal(url.searchParams.get('sourceLane'), 'lane-a');
    assert.equal(url.searchParams.get('view'), 'source');
    assert.equal(url.searchParams.has('lane'), false);
    assert.equal(url.searchParams.has('token'), false);
    assert.match(url.pathname + url.search, /code|delivery/);
  });
});
test('local Code retains the reader head and exact file links retain their line anchor', () => {
  at('http://localhost/?tab=intents&lane=lane-a', () => {
    const url = new URL(codeSourceLink(head, 'lane-a'), location.href);
    assert.equal(url.searchParams.get('head'), head);
    assert.equal(url.searchParams.get('sourceLane'), 'lane-a');
    const file = new URL(savedLink(head, 'src/a.ts', 8));
    assert.equal(file.hash, '#L8');
    assert.equal(file.searchParams.get('sourceLane'), 'lane-a');
  });
});
test('breadcrumbs link every level, preserve project identity and clear detail/source state', () => {
  at('http://localhost/?project=p1&projectTab=delivery&lane=old&head=abc&sourceLane=old&file=a.ts#L4', () => {
    const url = new URL(workHref({ intent: 'i1' }), location.href);
    assert.equal(url.searchParams.get('project'), 'p1');
    for (const key of ['lane', 'head', 'sourceLane', 'file']) assert.equal(url.searchParams.has(key), false);
    assert.equal(url.hash, '');
    const html = renderToStaticMarkup(
      h(Breadcrumbs, {
        items: [
          { label: 'Long Intent', href: '/intent' },
          { label: 'Lane', href: '/lane' },
        ],
      }),
    );
    assert.equal((html.match(/<a /g) ?? []).length, 3);
    assert.match(html, /aria-label="Breadcrumb"/);
    assert.match(html, /title="Long Intent"/);
    assert.match(html, /aria-current="page">Lane/);
  });
});
test('shared Menu has an accessible button and starts closed during server rendering', () => {
  const html = renderToStaticMarkup(h(Menu, { label: 'More' }, h('button', null, 'Copy')));
  assert.match(html, /aria-haspopup="menu"/);
  assert.match(html, /aria-expanded="false"/);
});

test('source picker names the selected Lane even when another Lane or main has the same hash', async () => {
  const { SourcePicker } = await import(moduleUrl('../web/src/shell/SourcePicker.tsx'));
  const { currentSource, sourceOptions } = await import(moduleUrl('../web/src/shell/source-options.ts'));
  const lanes = [
    { id: 'first', name: 'Other Lane', head, state: 'active' },
    { id: 'second', name: 'Selected Lane', head, state: 'active' },
  ];
  const options = sourceOptions({ main: head, now: 0, lanes, views: [], intents: [], moves: [], runs: [] });
  const render = current => renderToStaticMarkup(h(SourcePicker, { current, options, choose: () => {} }));
  const html = render(currentSource(head, 'second', options, lanes));
  assert.match(html, /aria-label="Source: Selected Lane"/);
  assert.match(html, /latest save · bbbbbbbb/);
  const pinned = render(currentSource('d'.repeat(64), 'second', options, lanes));
  assert.match(pinned, /aria-label="Source: Selected Lane"/);
  assert.match(pinned, /save dddddddd/);
  assert.match(render(currentSource(head, undefined, options, lanes)), /aria-label="Source: main"/);
  assert.match(
    render(currentSource('e'.repeat(64), undefined, options, lanes)),
    /aria-label="Source: Exact head"/,
  );
});

test('source options group main, open Lanes and the newest Candidate per Lane set', async () => {
  const { sourceOptions, resolveHead } = await import(moduleUrl('../web/src/shell/source-options.ts'));
  const now = Date.parse('2026-10-17T12:00:00Z');
  const at = minutes => new Date(now - minutes * 60_000).toISOString();
  const main = 'a'.repeat(64);
  const options = sourceOptions({
    main,
    now,
    lanes: [
      {
        id: 'l1',
        name: 'Held',
        head: '1'.repeat(64),
        state: 'active',
        assignment: 'gpt-i4',
        lastCheckpointAt: at(4),
      },
      { id: 'l2', name: 'Unheld', head: '2'.repeat(64), state: 'active', assignment: '' },
      { id: 'l3', name: 'Landed', head: '3'.repeat(64), state: 'active', main: { included: true } },
      { id: 'l4', name: 'Closed', head: '4'.repeat(64), state: 'completed' },
    ],
    views: [
      { id: 'v-old', intentId: 'i1', head: '5'.repeat(64), at: at(90), inputs: [{ laneId: 'l1' }] },
      { id: 'v-new', intentId: 'i1', head: '6'.repeat(64), at: at(10), inputs: [{ laneId: 'l1' }] },
      { id: 'v-main', intentId: 'i2', head: main, at: at(180), inputs: [{ laneId: 'l3' }] },
      { id: 'v-none', intentId: 'i2', head: null, at: at(1) },
    ],
    intents: [
      { id: 'i1', outcome: 'Search' },
      { id: 'i2', outcome: 'Export' },
    ],
    moves: [{ channel: 'main', viewId: 'v-main', head: main, at: at(180), status: 'accepted' }],
    runs: [{ viewId: 'v-new', status: 'passed', startedAt: at(4), endedAt: at(2) }],
  });
  assert.equal(options.main.meta, `accepted 3 h ago · ${main.slice(0, 8)}`);
  assert.deepEqual(
    options.lanes.map(lane => [lane.name, lane.meta]),
    [
      ['Held', 'gpt-i4 · last save 4 min ago'],
      ['Unheld', 'nobody working · no saves yet'],
    ],
  );
  assert.deepEqual(
    options.candidates.map(option => [option.name, option.meta]),
    [
      ['Search', 'passed 2 min ago'],
      ['Export', 'accepted 3 h ago'],
    ],
  );
  const known = [main, ...options.lanes.map(lane => lane.head)];
  assert.equal(resolveHead('1111111', known), '1'.repeat(64));
  assert.equal(resolveHead(` ${'F'.repeat(64)} `, known), 'f'.repeat(64));
  assert.equal(resolveHead('111', known), null);
  assert.equal(resolveHead('9999999', known), null);
  assert.equal(resolveHead('not a hash', known), null);
});
