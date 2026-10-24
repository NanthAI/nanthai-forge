// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { createElement as h } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { moduleUrl } from './convex-module.mjs';
const { railStops } = await import(moduleUrl('../web/src/ui/rail-stops.ts'));
const { Rail, ProgressHeader } = await import(moduleUrl('../web/src/ui/Rail.tsx'));
const signals = await import(moduleUrl('../web/src/ui/signals.tsx'));
const { toneLabel } = await import(moduleUrl('../web/src/ui/status.ts'));
const { ChannelStrip, LiveStatus } = await import(moduleUrl('../web/src/shell/StatusBar.tsx'));
const ui = await import(moduleUrl('../web/src/ui/primitives.tsx'));

const segs = lane => railStops(lane).segments.join(' ');

test('journey rail follows the fill table and only fills the check stop for a check on this head', () => {
  assert.equal(segs({ tone: 'active', checkpoints: 0 }), 'on off off off');
  assert.equal(segs({ tone: 'active', checkpoints: 3 }), 'on on off off');
  assert.equal(segs({ tone: 'running', checkpoints: 3, runStatus: 'running' }), 'on on run off');
  assert.equal(segs({ tone: 'running', checkpoints: 3, runStatus: 'queued' }), 'on on off off');
  assert.equal(segs({ tone: 'passed', checkpoints: 3, runStatus: 'passed' }), 'ok ok ok off');
  assert.equal(segs({ tone: 'failed', checkpoints: 3, runStatus: 'failed' }), 'on on bad off');
  assert.equal(segs({ tone: 'conflict', checkpoints: 3, runStatus: 'passed' }), 'conf conf off off');
  assert.equal(segs({ tone: 'plain', checkpoints: 3, runStatus: 'passed', accepted: true }), 'ok ok ok ok');
  // No run on the current head: a Lane saved after its last check is back to "saved".
  assert.equal(segs({ tone: 'active', checkpoints: 4 }), 'on on off off');
  assert.equal(
    railStops({ tone: 'failed', checkpoints: 1, runStatus: 'failed' }).title,
    'edited, saved; check failed',
  );
});

test('every rail names its stops in words and never shows a percentage', () => {
  const html = renderToStaticMarkup(
    h(Rail, { lane: { tone: 'passed', checkpoints: 2, runStatus: 'passed' } }),
  );
  assert.match(html, /tabindex="0"/);
  assert.match(html, /role="tooltip"/);
  assert.match(html, /Checked · not accepted/);
  assert.match(html, /Edited · saved · checked · accepted/);
  assert.match(html, /aria-label="Progress: /);
  assert.doesNotMatch(html, /%/);
  const dim = renderToStaticMarkup(
    h(Rail, { lane: { tone: 'stale', checkpoints: 1 }, size: 'lg', dim: true }),
  );
  assert.match(dim, /fx-rail fx-rail-lg fx-rail-dim/);
});

test('status words are the short set and never mention records or hashes', () => {
  assert.equal(toneLabel.passed, 'Ready');
  assert.equal(toneLabel.failed, 'Check failed');
  assert.equal(toneLabel.stale, 'Not seen');
  for (const word of Object.values(toneLabel))
    assert.doesNotMatch(word, /view|exact|receipt|operation|[0-9a-f]{7}/i);
});

test('undo is a button only when it can act; otherwise the slot says why', () => {
  assert.match(renderToStaticMarkup(h(signals.Undo, { onUndo: () => undefined })), /<button[^>]*>Undo</);
  assert.match(renderToStaticMarkup(h(signals.Undo, {})), /Nothing to undo\./);
  assert.match(renderToStaticMarkup(h(signals.AutoTag)), />auto</);
});

test('recommended answers are outlined, never brand-filled; the hot count turns neutral at zero', () => {
  assert.match(renderToStaticMarkup(h(ui.Button, { variant: 'rec' }, 'Accept')), /fx-btn fx-btn-rec/);
  assert.match(renderToStaticMarkup(h(signals.CountPill, { count: 2, hot: true })), /fx-count fx-count-hot/);
  assert.doesNotMatch(renderToStaticMarkup(h(signals.CountPill, { count: 0, hot: true })), /hot/);
  assert.match(
    renderToStaticMarkup(h(ui.Panel, { title: 'Needs you', count: 0, hot: true }, 'x')),
    /class="fx-count">0</,
  );
});

test('the info affordance is a labelled button with a tooltip, not permanent text', () => {
  const html = renderToStaticMarkup(
    h(signals.InfoTip, { label: 'About overlaps' }, 'Advisory; nothing is locked.'),
  );
  assert.match(html, /<button[^>]*aria-label="About overlaps"/);
  assert.match(html, /role="tooltip"/);
});

test('the channel strip shows who moved main and its check, with the hash only in the tooltip', () => {
  const head = 'a'.repeat(64);
  const html = renderToStaticMarkup(
    h(ChannelStrip, {
      head,
      at: Date.now() - 12 * 60_000,
      check: 'passed',
      by: { name: 'claude-3', kind: 'agent' },
      live: h(LiveStatus, {}),
    }),
  );
  assert.match(html, /accepted 12 min ago/);
  assert.match(html, /· claude-3/);
  assert.match(html, /passing/);
  assert.match(html, />Live</);
  assert.doesNotMatch(html.replace(/title="[^"]*"/g, ''), /aaaaaaa/);
  const auto = renderToStaticMarkup(
    h(ChannelStrip, { head, at: Date.now(), automatic: true, by: { name: 'x' }, live: null }),
  );
  assert.match(auto, />auto</);
  assert.match(auto, /· x/);
  assert.match(renderToStaticMarkup(h(LiveStatus, { error: 'down', local: true })), /Connection paused/);
});

test('accepted success feedback enters the shared toast stack after mount', () => {
  assert.equal(
    renderToStaticMarkup(
      h(signals.AcceptedToast, { accepted: { title: 'synthetic' }, onClose: () => undefined }),
    ),
    '',
  );
});

test('progress tooltips name the current state and the header offers its legend on demand', () => {
  for (const [lane, state] of [
    [{ tone: 'active', checkpoints: 0 }, 'Edited · not saved'],
    [{ tone: 'active', checkpoints: 2 }, 'Saved · not checked'],
    [{ tone: 'running', checkpoints: 2, runStatus: 'running' }, 'Saved · check running'],
    [{ tone: 'failed', checkpoints: 2, runStatus: 'failed' }, 'Saved · check failed'],
    [{ tone: 'conflict', checkpoints: 2 }, 'Saved · conflict'],
    [{ tone: 'passed', checkpoints: 2, accepted: true }, 'Accepted'],
  ])
    assert.ok(renderToStaticMarkup(h(Rail, { lane })).includes(state));
  const header = renderToStaticMarkup(h(ProgressHeader));
  assert.match(header, /aria-label="Progress legend"/);
  assert.match(header, /role="tooltip"/);
});

test('only preparing and running checks spin; cancelled and interrupted remain grey', async () => {
  const { CheckPanel } = await import(moduleUrl('../web/src/lane/CheckPanel.tsx'));
  for (const status of ['cancelled', 'interrupted', 'queued', 'preparing', 'running']) {
    const html = renderToStaticMarkup(h(CheckPanel, { run: { id: 'r', status }, now: Date.now() }));
    if (['cancelled', 'interrupted'].includes(status)) {
      assert.match(html, /fx-tone-plain/);
      assert.doesNotMatch(html, /fx-tone-running|fx-tone-failed/);
      assert.match(html, new RegExp(status[0].toUpperCase() + status.slice(1)));
      assert.equal(segs({ tone: 'plain', checkpoints: 1, runStatus: status }), 'on on off off');
    } else if (status === 'queued') {
      assert.match(html, /fx-tone-waiting/);
      assert.doesNotMatch(html, /fx-tone-running/);
      assert.match(html, /Queued/);
    } else assert.match(html, /fx-tone-running/);
  }
});
