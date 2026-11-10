// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { createElement as h } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { moduleUrl } from './convex-module.mjs';
import { overlapNowFixture } from './hosted-cockpit-fixture.mjs';
import { laneSummary } from '../dist/work-hosted-summary.js';
import { nowOverlapSignals } from '../dist/now-overlap-signals.js';
const { hostedAttention } = await import(moduleUrl('../web/src/shell/Attention.tsx'));
const { HostedNowView } = await import(moduleUrl('../web/src/cockpit/HostedNow.tsx'));
const { NowSituation } = await import(moduleUrl('../web/src/cockpit/NowLayout.tsx'));
const ack = {
  acknowledge: async () => true,
  reply: async () => true,
  busy: '',
  error: '',
  retrying: () => false,
};
globalThis.location = { href: 'https://forge.test' };
const render = f =>
  renderToStaticMarkup(
    h(HostedNowView, {
      ...f,
      loading: false,
      ack,
      newIntent() {},
      showFirstRun: false,
      laneHref: id => `#lane-${id}`,
    }),
  );

test('A, B, B2, B3 and C render the same shell; shared files never ask a person for an answer', () => {
  for (const state of ['A', 'B', 'B2', 'B3', 'C']) {
    const f = overlapNowFixture(state),
      model = hostedAttention(f.records, f.live, f.now),
      html = render(f);
    assert.equal(model.unanswered, undefined, state);
    assert.equal((html.match(/class="fx-dec fx-dec-overlap"/g) ?? []).length, 0, state);
    assert.doesNotMatch(html, /unanswered|Acknowledge all|Answered today/, state);
    if (state !== 'A') assert(model.overlaps.length > 0);
    const visible = html
      .replace(/ title="[^"]*"/g, '')
      .replace(/<span role="tooltip"[^>]*>[\s\S]*?<\/span>/g, '');
    assert.doesNotMatch(visible, /advisory|Forge never locks|please|this may take a while/);
  }
});
test('current source pins outrank old coordination events and stale index heads are explicitly incomplete', () => {
  const f = overlapNowFixture('B');
  for (const lane of f.records.lanes) lane.overlaps = [];
  f.records.lanes[0].head = 'new-head';
  let model = hostedAttention(f.records, f.live, f.now);
  assert.equal(model.decisions.length, 0);
  assert.equal(model.overlapsComplete, false);
  f.records.lanes[0].head = f.live.overlapSignals.edits[0].head;
  for (const edit of f.live.overlapSignals.edits) edit.paths = [];
  f.live.events = f.records.lanes.slice(0, 2).map((lane, i) => ({
    operationId: `event-${i}`,
    actor: 'viewer',
    at: f.now,
    command: { kind: 'change', laneId: lane.id, paths: ['old.ts'] },
  }));
  model = hostedAttention(f.records, f.live, f.now);
  assert.deepEqual(model.overlaps, [], 'fresh empty path projections replace stale event paths');
});
test('old Lane summaries stay valid and delivery summaries are capped at twenty', () => {
  const f = overlapNowFixture('C'),
    lane = {
      ...f.records.lanes[0],
      overlapInbox: Array.from({ length: 25 }, () => f.records.lanes[0].overlaps[0]),
    };
  assert.equal(laneSummary(lane).overlaps.length, 20);
  delete lane.overlapInbox;
  assert.equal(laneSummary(lane).overlaps, undefined);
});
test('project signals include behind-main files', () => {
  const entry = (laneId, paths) => ({
    laneId,
    head: 'b',
    baseHead: 'a',
    baseSequence: 1,
    open: true,
    complete: true,
    changes: JSON.stringify(paths.map(path => ({ path }))),
  });
  const signals = nowOverlapSignals(
    [entry('a', ['x', 'y']), entry('b', ['x'])],
    { sequence: 2, coverageAfter: 0, changes: JSON.stringify([['y', 2]]) },
    { head: 'c', sourceRevision: 2 },
    true,
  );
  assert.deepEqual(signals.behindMain[0].paths, ['y']);
  assert.equal(signals.complete, true);
});
