// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Ferdinando Valsecchi
// Who waits on whom drawn as chains (Item 8f94e5c3): the longest wait first, a long queue shortened to its two ends, a
// shared stretch drawn once, a loop marked, a person at the end with Decide; a lone Region in a Dock draws no header
// bar (owner 2026-11-23, solo-region.ts); the Lanes headline never splices an Item title into its sentence; a held row
// never reads "Held held".
import test from 'node:test';
import assert from 'node:assert/strict';
import { createElement as h } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { moduleUrl } from './convex-module.mjs';

const { waitChains, MAX_CHAINS, MAX_STEPS } = await import(moduleUrl('../web/src/app/lanes/wait-chains.ts'));
const { WaitChains } = await import(moduleUrl('../web/src/app/lanes/WaitChains.tsx'));
const model = await import(moduleUrl('../web/src/app/lanes/model.ts'));
const { Yard } = await import(moduleUrl('../web/src/app/lanes/Yard.tsx'));
const { Region } = await import(moduleUrl('../web/src/ds/parts.tsx'));
const { SoloRegionProvider } = await import(moduleUrl('../web/src/ds/solo-region.ts'));

const at = minutes => new Date(Date.UTC(2026, 10, 23, 10, 0) - minutes * 60_000).toISOString();
const wait = (laneId, onLane, since, extra = {}) => ({
  laneId,
  on: onLane ?? 'main',
  onLane,
  why: `${laneId} waits`,
  since: at(since),
  person: false,
  ...extra,
});
const queue = n => Array.from({ length: n }, (_, i) => wait(`q${i + 1}`, i === 0 ? null : `q${i}`, n - i));

test('a queue of 12 is one chain, and a queue of 50 keeps both ends and says how many Lanes it skips', () => {
  const twelve = waitChains(queue(12).slice(1));
  assert.equal(twelve.chains.length, 1);
  assert.equal(twelve.chains[0].steps.filter(step => step.kind === 'lane').length <= MAX_STEPS, true);
  const fifty = waitChains(queue(50).slice(1)).chains[0];
  assert.equal(fifty.steps.length, MAX_STEPS, 'two ends of three, and the skip between');
  const skip = fifty.steps.find(step => step.kind === 'skip');
  assert.ok(skip.lanes > 0);
  assert.deepEqual(
    [fifty.steps[0].laneId, fifty.steps.at(-1).laneId],
    ['q50', 'q1'],
    'the Lane that waits longest behind, and the front of the queue it waits for',
  );
  assert.equal(skip.lanes, 50 - (MAX_STEPS - 1), 'every Lane between the two ends is counted, none lost');
});

test('chains come longest wait first; a shared stretch is drawn once, and the other chain ends on it', () => {
  const waits = [
    wait('a', 'front', 30),
    wait('b', 'a', 10),
    wait('c', 'a', 50),
    wait('d', null, 5, { on: 'a person', person: true }),
  ];
  const { chains } = waitChains(waits);
  assert.deepEqual(
    chains.map(chain => chain.tail.laneId),
    ['c', 'b', 'd'],
    'ranked by the oldest wait each holds',
  );
  const joined = chains[0].steps.at(-1);
  assert.equal(joined.laneId, 'a');
  assert.equal(joined.joined, true, 'a Lane drawn in the first chain is marked, not repeated in full');
  const person = chains[2].steps.at(-1);
  assert.deepEqual([person.kind, person.person], ['end', true]);
});

test('two Lanes that wait on each other are drawn as a marked loop, and so is a loop behind a tail', () => {
  const pure = waitChains([wait('x', 'y', 20), wait('y', 'x', 10)]);
  assert.equal(pure.chains.length, 1);
  assert.equal(pure.chains[0].loop, true);
  const behind = waitChains([wait('t', 'x', 5), wait('x', 'y', 20), wait('y', 'x', 10)]);
  assert.equal(behind.chains.length, 1);
  assert.equal(behind.chains[0].loop, true);
  assert.deepEqual(
    behind.chains[0].steps.map(step => step.laneId),
    ['t', 'x', 'y', 'x'],
  );
});

test('only the longest chains are listed, and the rest are counted', () => {
  const waits = Array.from({ length: MAX_CHAINS + 3 }, (_, i) => wait(`l${i}`, null, i + 1, { on: 'main' }));
  const { chains, more } = waitChains(waits);
  assert.equal(chains.length, MAX_CHAINS);
  assert.equal(more, 3);
});

test('a loop is never cut by the cap or by shortening: the Lane it returns to and the way round stay drawn (review round)', () => {
  const waits = [
    ...Array.from({ length: MAX_CHAINS }, (_, i) =>
      wait(`old${i}`, null, 500 + i, { on: 'a person', person: true }),
    ),
    wait('t1', 't2', 40),
    wait('t2', 't3', 40),
    wait('t3', 't4', 40),
    wait('t4', 'x', 40),
    wait('x', 'y', 5),
    wait('y', 'z', 5),
    wait('z', 'x', 5),
  ];
  const { chains, more } = waitChains(waits);
  const loop = chains.find(chain => chain.loop);
  assert.ok(loop, 'eight older chains do not push the newer loop out');
  assert.equal(more, 0);
  assert.deepEqual(
    loop.steps.filter(step => step.kind === 'lane').map(step => step.laneId),
    ['t1', 'x', 'y', 'z', 'x'],
    'the return point and the cycle are kept; the Lanes before it are the ones skipped',
  );
  assert.equal(loop.steps.find(step => step.kind === 'skip').lanes, 3);
});

const laneOf = laneId => ({
  title: `Title of ${laneId}`,
  state: laneId === 'b' ? 'conflict' : 'active',
  word: 'Checking',
});
const draw = (waits, now = Date.UTC(2026, 10, 23, 10, 0)) =>
  renderToStaticMarkup(
    h(WaitChains, { waits, laneOf, laneHref: id => `/lanes/${id}`, decideHref: '/needs', now }),
  );

test('the picture: a chip per Lane with its state dot, the wait time on each arrow, Decide only where a person decides', () => {
  const html = draw([wait('b', 'a', 12), wait('a', null, 90, { on: 'a person', person: true })]);
  assert.match(html, /data-st="conflict"[^>]*><i class="wc-dot"/);
  assert.match(html, /wc-age num">12 min</);
  assert.match(html, /wc-age num">2 h</);
  assert.match(html, /wc-end" data-person="">a person</);
  assert.equal((html.match(/Decide/g) ?? []).length, 1);
  assert.doesNotMatch(draw([wait('b', 'a', 12)]), /Decide/);
  assert.match(draw([wait('x', 'y', 20), wait('y', 'x', 10)]), /Loop: each waits on the next/);
  assert.equal(draw([]).includes('<li'), false, 'no waits draws no chain');
});

test('a Region that is the only one in its Dock draws no header bar and no handle, only its name for assistive technology', () => {
  const region = (solo, handle) =>
    renderToStaticMarkup(
      h(
        SoloRegionProvider,
        { value: solo },
        h(Region, { title: 'On the way to main', count: 3, handle }, 'body'),
      ),
    );
  const alone = region(true);
  assert.doesNotMatch(alone, /class="ph/);
  assert.match(alone, /<h2 class="sr">On the way to main<\/h2>/);
  const among = region(false, h('i', { className: 'grip' }));
  assert.match(among, /class="ph"/);
  assert.match(among, /class="grip"/);
  // A fold or tools live in the bar, so a region that has them keeps it.
  assert.match(
    renderToStaticMarkup(
      h(SoloRegionProvider, { value: true }, h(Region, { title: 'Notes', tools: 'x' }, 'body')),
    ),
    /class="ph/,
  );
  // The rule is for the dock's own region, never one drawn inside it.
  assert.match(
    renderToStaticMarkup(
      h(
        SoloRegionProvider,
        { value: true },
        h(Region, { title: 'Outer' }, h(Region, { title: 'Inner', count: 1 }, 'x')),
      ),
    ),
    /<h2>Inner<\/h2>/,
  );
});

const mark = (laneId, stage, extra = {}) => ({
  laneId,
  stage,
  held: false,
  overlap: false,
  changedAt: 1,
  ...extra,
});
const feed = lanes => ({ lanes, more: 0, moreIsLowerBound: false, main: null });
const meta = (laneId, intent) => ({
  laneId,
  intentId: laneId,
  intent,
  actor: 'mara',
  lastSaveAt: null,
  landing: null,
});

test('the Lanes headline never splices an Item title into the sentence; the next Lane is a link target with a time', () => {
  const title = 'Public pages: share cards, sitemap and page titles and a very long rest of the title';
  const lane = { ...mark('c', 'checking'), held: false };
  const entries = [
    {
      position: 1,
      laneId: 'c',
      phase: 'checking',
      landingState: { state: 'checking' },
      submittedAt: at(5),
      lastProgressAt: at(1),
      checkStartedAt: at(2),
    },
  ];
  const yard = model.buildYard(
    feed([lane]),
    [meta('c', title)],
    { total: 1, listed: 1, more: false, entries },
    Date.UTC(2026, 10, 23, 10, 0),
  );
  assert.ok(yard.next, 'the first in the queue is next');
  const said = model.situation(yard, Date.UTC(2026, 10, 23, 10, 0));
  assert.doesNotMatch(`${said.lead} ${said.rest}`, /Public pages/);
  assert.equal(said.next.laneId, 'c');
  assert.equal(said.next.title, title);
  assert.match(said.next.words, /^(is next to land|lands in about \d+ min)$/);
  const withTime = {
    ...yard,
    next: { ...yard.next, check: { startedAt: 0, usualMs: 600_000, slowMs: null, note: null } },
  };
  assert.equal(model.situation(withTime, 120_000).next.words, 'lands in about 8 min');
  assert.equal(
    model.situation(withTime, 590_000).next.words,
    'is next to land',
    'under 90 seconds left is just next',
  );
});

test('a held Lane row says Held once: the reason is not drawn again when it is the state word', () => {
  const yard = model.buildYard(
    feed([mark('h', 'saved', { held: true })]),
    [meta('h', 'A held Lane')],
    undefined,
    0,
  );
  const row = yard.rows[0];
  assert.equal(row.word, 'Held');
  const html = renderToStaticMarkup(
    h(Yard, {
      project: { handle: 'o', project: 'p' },
      rows: yard.rows,
      hrefOf: id => `/${id}`,
      dense: false,
    }),
  );
  assert.doesNotMatch(html, /<b>held<\/b>/i);
  assert.match(html, />Held</);
});
