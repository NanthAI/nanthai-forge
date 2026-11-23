// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';

import { PRESENCE, presenceState, collapseSessions } from '../dist/presence.js';

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
