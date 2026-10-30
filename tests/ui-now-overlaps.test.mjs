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
const { unansweredOverlaps } = await import(moduleUrl('../web/src/cockpit/overlap-model.ts'));
const { HostedNowView } = await import(moduleUrl('../web/src/cockpit/HostedNow.tsx'));
const { NowSituation } = await import(moduleUrl('../web/src/cockpit/NowLayout.tsx'));
const ack = {
  acknowledge: async () => true,
  reply: async () => true,
  acknowledgeOverlaps: async () => true,
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

test('A, B, B2, B3 and C use the same shell/panel model and only gone agents need a person', () => {
  for (const [state, decisions, total] of [
    ['A', 0, 0],
    ['B', 1, 1],
    ['B2', 0, 1],
    ['B3', 0, 0],
    ['C', 2, 9],
  ]) {
    const f = overlapNowFixture(state),
      model = hostedAttention(f.records, f.live, f.now),
      html = render(f);
    assert.equal(model.decisions.length, decisions, state);
    assert.equal(
      [...model.unanswered.values()].reduce((sum, items) => sum + items.length, 0),
      total,
      state,
    );
    assert.equal((html.match(/class="fx-dec fx-dec-overlap"/g) ?? []).length, decisions);
    if (total) assert.match(html, new RegExp(`${total} unanswered`));
    if (state === 'A') assert.doesNotMatch(html, /Overlap unanswered|overlap[s]? unanswered|unanswered by/);
    if (state === 'C') {
      assert.match(html, /Acknowledge all \(4\)/);
      assert.match(html, /\+1 more/);
      assert.match(html, /Codex ended 41 min ago/);
      assert.match(html, /gemini-cli last seen 2 h ago/);
      assert.match(html, /fx-dec-age">41 min/);
      assert.match(html, /fx-person-stale/);
      assert.match(html, /unanswered by Codex/);
      assert.match(html, /Answered today · 0/);
    }
    const visible = html
      .replace(/ title="[^"]*"/g, '')
      .replace(/<span role="tooltip"[^>]*>[\s\S]*?<\/span>/g, '');
    assert.doesNotMatch(visible, /advisory|Forge never locks|please|this may take a while/);
  }
});
test('current detections show without deliveries, dedupe aliases and subtract native/server answers per Lane', () => {
  const f = overlapNowFixture('B');
  const delivery = f.records.lanes[0].overlaps[0];
  f.live.overlapSignals.notices[0].noticeId = 'f'.repeat(64);
  let model = hostedAttention(f.records, f.live, f.now);
  assert.equal(model.unanswered.get(f.records.lanes[0].id).length, 1);
  assert.equal(model.decisions[0].noticeIds.length, 2);
  f.records.lanes[0].overlaps = [];
  model = hostedAttention(f.records, f.live, f.now);
  assert.equal(model.decisions.length, 1);
  assert.equal(model.deliveredUnanswered.size, 0, 'detections never become metric deliveries');
  f.live.overlapAnswers.push({ laneId: f.records.lanes[0].id, noticeId: 'f'.repeat(64) });
  assert.equal(hostedAttention(f.records, f.live, f.now).decisions.length, 0);
  f.records.lanes[0].overlaps = [delivery];
  f.records.intents[0].notes = [
    { overlapAnswer: { laneId: f.records.lanes[0].id, noticeId: delivery.noticeId } },
  ];
  assert.equal(hostedAttention(f.records, f.live, f.now).deliveredUnanswered.size, 0);
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
  f.live.overlapSignals.notices = [];
  f.live.events = f.records.lanes.slice(0, 2).map((lane, i) => ({
    operationId: `event-${i}`,
    actor: 'viewer',
    at: f.now,
    command: { kind: 'change', laneId: lane.id, paths: ['old.ts'] },
  }));
  model = hostedAttention(f.records, f.live, f.now);
  assert.deepEqual(model.overlaps, [], 'fresh empty path projections replace stale event paths');
});
test('situation supports unanswered notices without a current edited-both row', () => {
  const html = renderToStaticMarkup(
    h(NowSituation, { facts: { decisions: 1, open: 1, overlaps: 0, unanswered: 2 } }),
  );
  assert.match(html, /href="#fx-who">2 unanswered/);
  assert.doesNotMatch(html, /overlapping file|, /);
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
test('dogfood 560 Lanes, 50 sessions and 100 answers do no IO with a bounded map allocation', t => {
  const f = overlapNowFixture('C');
  const lanes = Array.from({ length: 560 }, (_, i) => ({
    ...f.records.lanes[0],
    id: `lane-${i}`,
    open: true,
    overlaps: Array.from({ length: 20 }, (_, j) => ({
      noticeId: `${i}-${j}`,
      file: `file-${j}`,
      lanes: [`lane-${i}`, 'peer'],
      at: '2026-10-14T10:00:00Z',
    })),
  }));
  const answers = Array.from({ length: 100 }, (_, i) => ({ laneId: `lane-${i}`, noticeId: `${i}-0` }));
  for (let i = 0; i < 10; i++) unansweredOverlaps(lanes, answers);
  const started = performance.now();
  const result = unansweredOverlaps(lanes, answers);
  const ms = performance.now() - started;
  assert.equal(
    [...result.values()].reduce((n, items) => n + items.length, 0),
    11100,
  );
  assert.ok(ms < 5, `${ms} ms < 5 ms`);
  t.diagnostic(
    JSON.stringify({
      lanes: 560,
      answers: 100,
      ms,
      calls: 0,
      reads: 0,
      writes: 0,
      rss: process.memoryUsage().rss,
      peakRssKiB: process.resourceUsage().maxRSS,
    }),
  );
});
test('project detection uses the agent notice identity, includes behind-main files and caps display coverage', () => {
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
  assert.equal(signals.notices.length, 2);
  assert.equal(signals.notices[0].noticeId, signals.notices[1].noticeId);
  assert.deepEqual(signals.behindMain[0].paths, ['y']);
  assert.equal(signals.complete, true);
  const capped = nowOverlapSignals(
    [
      entry(
        'a',
        Array.from({ length: 30 }, (_, i) => `${i}`),
      ),
      entry(
        'b',
        Array.from({ length: 30 }, (_, i) => `${i}`),
      ),
    ],
    null,
    { head: 'a', sourceRevision: 1 },
    true,
  );
  assert.equal(capped.notices.length, 40);
  assert.equal(capped.complete, false);
});

test('an ended session cannot displace an unfinished agent still owning the same Lane', () => {
  const f = overlapNowFixture('B');
  f.live.sessions.push({
    ...f.live.sessions[0],
    sessionId: 'replacement',
    name: 'Replacement agent',
    status: 'working',
    lastSeen: f.now - 60000,
  });
  f.live.sessions[0].lastSeen = f.now;
  const model = hostedAttention(f.records, f.live, f.now);
  assert.equal(model.decisions.length, 0);
  assert.equal(model.unansweredBySession.get('replacement'), 1);
});
