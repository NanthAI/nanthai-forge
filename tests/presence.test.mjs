// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { createElement as h } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { PRESENCE, presenceState, collapseSessions } from '../dist/presence.js';
import { moduleUrl } from './convex-module.mjs';
const { Sessions } = await import(moduleUrl('../web/src/cockpit/Sessions.tsx'));

const session = (extra = {}) => ({
  sessionId: 'one',
  name: 'gpt-b6',
  status: 'working',
  lastSeen: 1_000_000,
  lastActivity: 1_000_000,
  activityKind: 'edited files',
  actor: 'owner',
  environment: 'Local Lane',
  summary: 'Implement presence',
  context: { laneId: 'lane' },
  ...extra,
});

test('fake clock crosses inclusive working and quiet boundaries; heartbeats do not extend activity', t => {
  t.mock.timers.enable({ apis: ['Date'], now: 1_000_000 });
  const row = session();
  t.mock.timers.tick(PRESENCE.workingMs);
  assert.equal(presenceState(row, Date.now()), 'working');
  t.mock.timers.tick(1);
  row.lastSeen = Date.now();
  assert.equal(presenceState(row, Date.now()), 'quiet');
  t.mock.timers.tick(PRESENCE.foldMs - PRESENCE.workingMs - 1);
  assert.equal(presenceState(row, Date.now()), 'quiet');
  t.mock.timers.tick(1);
  assert.equal(presenceState(row, Date.now()), 'not-seen');
  assert.equal(row.status, 'working');
  assert.equal(presenceState({ ...row, status: 'completed' }, Date.now()), 'completed');
});

test('newest same-name Lane observation collapses duplicates including explicit completion', () => {
  const rows = collapseSessions([
    session(),
    session({ sessionId: 'two', lastActivity: 1_000_001, status: 'completed' }),
    session({ sessionId: 'other-lane', context: { laneId: 'other' } }),
    session({ sessionId: 'other-name', name: 'claude-3' }),
  ]);
  assert.equal(rows.length, 3);
  assert.equal(rows[0].status, 'completed');
});

test('quiet sessions remain visible, old sessions fold, and copy records activity kind', () => {
  const now = 10_000_000;
  const html = renderToStaticMarkup(
    h(Sessions, {
      now,
      laneName: () => 'Presence',
      sessions: [
        session({ lastActivity: now - 25 * 60_000 }),
        session({ sessionId: 'dup', lastActivity: now - 26 * 60_000 }),
        session({ name: 'older', lastActivity: now - 91 * 60_000 }),
      ],
    }),
  );
  assert.match(html, /quiet · 25 min/);
  assert.match(html, /Implement presence/);
  const kindOnly = renderToStaticMarkup(
    h(Sessions, {
      now,
      laneName: () => 'Presence',
      sessions: [session({ summary: 'Presence', lastActivity: now - 25 * 60_000 })],
    }),
  );
  assert.match(kindOnly, /edited files/);
  assert.match(html, /1 not seen since/);
  assert.doesNotMatch(html, />older</);
  assert.equal((html.match(/>gpt-b6</g) ?? []).length, 1);
});

test('nested sessions share quiet/folded states, collapse across roots, and survive completed or accepted parents', async () => {
  const { sessionTreeRows } = await import(moduleUrl('../web/src/cockpit/session-tree.ts'));
  const now = 10_000_000;
  const child = session({
    sessionId: 'child',
    name: 'claude-3',
    context: { laneId: 'child-lane' },
    lastActivity: now - 25 * 60_000,
  });
  const parent = session({ sessionId: 'parent', lastActivity: now, subagents: [child] });
  const old = session({
    sessionId: 'old',
    name: 'older-child',
    lastActivity: now - 91 * 60_000,
    context: { laneId: 'old-lane' },
  });
  const roots = [
    { ...parent, subagents: [child, old] },
    { ...child, sessionId: 'duplicate', lastActivity: now - 26 * 60_000 },
  ];
  const tree = sessionTreeRows(roots, now, false);
  assert.equal(tree.listed, 2);
  assert.equal(tree.folded.length, 1);
  assert.deepEqual(
    tree.visible.map(row => row.sessionId),
    ['parent'],
  );
  assert.deepEqual(
    tree.visible[0].subagents.map(row => row.sessionId),
    ['child'],
  );
  const html = renderToStaticMarkup(h(Sessions, { now, laneName: () => undefined, sessions: roots }));
  assert.match(html, /quiet · 25 min/);
  assert.doesNotMatch(html, />older-child</);
  assert.equal((html.match(/>claude-3</g) ?? []).length, 1);
  for (const [sessions, ended] of [
    [[{ ...parent, status: 'completed' }], []],
    [[parent], ['lane']],
  ]) {
    assert.deepEqual(
      sessionTreeRows(sessions, now, false, ended).visible.map(row => row.sessionId),
      ['child'],
    );
  }
});

test("day-old sessions leave Who's working and older last-seen shows a date", async () => {
  const { sessionTreeRows } = await import(moduleUrl('../web/src/cockpit/session-tree.ts'));
  const { seenAt } = await import(moduleUrl('../web/src/ui/status.ts'));
  const now = new Date(2026, 9, 17, 9, 0).getTime();
  const at = (days, hour, minute = 0) => new Date(2026, 9, 17 - days, hour, minute).getTime();
  assert.equal(seenAt(at(0, 8, 5), now), '08:05');
  assert.equal(seenAt(at(1, 19, 23), now), 'yesterday 19:23');
  assert.match(seenAt(at(2, 19, 23), now), /15/);
  assert.doesNotMatch(seenAt(at(2, 19, 23), now), /19:23/);
  const rows = [
    session({ sessionId: 'yesterday', name: 'last-night', lastActivity: at(1, 19, 23) }),
    session({ sessionId: 'gone', name: 'long-gone', lastActivity: now - PRESENCE.hideMs - 1 }),
  ];
  const tree = sessionTreeRows(rows, now, true);
  assert.deepEqual(
    tree.visible.map(row => row.sessionId),
    ['yesterday'],
  );
  assert.equal(tree.total, 1);
  const html = renderToStaticMarkup(h(Sessions, { now, laneName: () => undefined, sessions: rows }));
  assert.match(html, /1 not seen since yesterday 19:23/);
  assert.doesNotMatch(html, /long-gone/);
});
