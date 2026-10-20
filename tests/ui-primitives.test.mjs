// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { createElement as h } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { moduleUrl } from './convex-module.mjs';
const ui = await import(moduleUrl('../web/src/ui/primitives.tsx'));
const status = await import(moduleUrl('../web/src/ui/status.ts'));
const { concepts } = await import(moduleUrl('../web/src/ui/concepts.ts'));

test('freshness keeps quiet sessions listed before folding and never claims presence', () => {
  const now = 10_000_000;
  assert.equal(status.freshness(now - 30_000, now, 'working'), 'active');
  assert.equal(status.freshness(now - 30_000, now, 'waiting'), 'waiting');
  assert.equal(status.freshness(now - status.STALE_AFTER_MS - 1, now, 'working'), 'plain');
  assert.equal(status.freshness(now - 90 * 60_000 - 1, now, 'working'), 'stale');
  assert.ok(!Object.values(status.toneLabel).some(label => /online/i.test(label)));
});

test('relative ages are compact and handle bad input', () => {
  const now = Date.parse('2026-10-14T12:00:00Z');
  assert.equal(status.age(now - 2_000, now), 'just now');
  assert.equal(status.age(now - 40_000, now), '40 s');
  assert.equal(status.age(now - 12 * 60_000, now), '12 min');
  assert.equal(status.age(now - 3 * 3_600_000, now), '3 h');
  assert.equal(status.age('not a date', now), '');
  assert.equal(status.age(undefined, now), '');
});

test('initials and avatar hues are stable', () => {
  assert.equal(status.initials('Maya Chen'), 'MC');
  assert.equal(status.initials('claude-1'), 'C1');
  assert.equal(status.initials('codex'), 'CO');
  assert.equal(status.initials('  '), '?');
  assert.equal(status.hue('session-a'), status.hue('session-a'));
});

test('status pills pair a glyph with words, never colour alone', () => {
  const html = renderToStaticMarkup(h(ui.StatusPill, { tone: 'conflict' }));
  assert.match(html, /fx-tone-conflict/);
  assert.match(html, /<svg[^>]*aria-hidden="true"/);
  assert.match(html, />Conflict</);
});

test('agents and people are distinguishable by shape and label', () => {
  const agent = renderToStaticMarkup(h(ui.Avatar, { name: 'codex-2', kind: 'agent' }));
  const person = renderToStaticMarkup(h(ui.Avatar, { name: 'Maya Chen' }));
  assert.match(agent, /fx-av-agent/);
  assert.match(agent, /title="codex-2 \(agent\)"/);
  assert.match(person, /fx-av-human/);
});

test('concept terms explain Intent and Candidate in one plain line', () => {
  assert.equal(concepts.intent.explain, 'The outcome you want.');
  const html = renderToStaticMarkup(h(ui.ConceptTerm, { concept: 'view', explain: true }));
  assert.match(html, /title="Candidate: An exact combination of Lanes, ready to check and accept\."/);
  assert.match(html, /fx-concept-explain/);
});

test('exact record hides empty values and renders nothing when all are empty', () => {
  const html = renderToStaticMarkup(
    h(ui.ExactRecord, {
      rows: [
        ['Candidate', 'abc123'],
        ['Pins', undefined],
      ],
    }),
  );
  assert.match(html, /<details class="fx-record">/);
  assert.match(html, /abc123/);
  assert.doesNotMatch(html, /Pins/);
  assert.equal(renderToStaticMarkup(h(ui.ExactRecord, { rows: [['Pins', undefined]] })), '');
});

test('buttons default to type=button so they never submit enclosing forms by accident', () => {
  const html = renderToStaticMarkup(h(ui.Button, { variant: 'primary', icon: 'arrow' }, 'Accept'));
  assert.match(html, /type="button"/);
  assert.match(html, /fx-btn-primary/);
});
