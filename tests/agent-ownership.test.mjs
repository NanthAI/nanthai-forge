// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { boundPeers, PEERS_MAX_BYTES } from '../dist/agent-peers.js';
import { PRESENCE } from '../dist/presence.js';

test('ownership and stalled observations stay within the lifecycle digest budget', () => {
  const bounded = boundPeers({
    v: 1,
    coverage: 'local',
    ownership: { actor: 'x'.repeat(200), state: 'working' },
    stalled: Array.from({ length: 20 }, () => ({
      lane: randomUUID(),
      actor: 'x'.repeat(200),
      quietMs: 9999999,
      offer: 'take',
    })),
  });
  assert.ok(Buffer.byteLength(JSON.stringify(bounded)) <= PEERS_MAX_BYTES);
  assert.ok(bounded.stalled.length <= 3);
  assert.ok(bounded.more >= 17);
  const escaped = boundPeers({
    v: 1,
    coverage: 'local',
    ownership: { actor: '\n'.repeat(200), sessionId: '\n'.repeat(200), state: 'working' },
  });
  assert.ok(Buffer.byteLength(JSON.stringify(escaped)) <= PEERS_MAX_BYTES);
});

test('SM-C M11: a completed session is completed, not working, however recent its last activity', async () => {
  const { laneOwnership } = await import('../dist/agent-ownership.js');
  const now = Date.now(),
    lane = { id: 'lane-1', owner: { actor: 'builder', at: new Date(now).toISOString() } };
  const presence = status => ({
    s1: { sessionId: 's1', name: 'builder', context: { laneId: lane.id }, lastSeen: now - 1000, status },
  });
  for (const [status, state] of [
    ['working', 'working'],
    ['waiting', 'waiting'],
    ['completed', 'completed'],
  ])
    assert.equal(laneOwnership({}, lane, now, presence(status)).state, state, status);
  const old = presence('completed');
  old.s1.lastSeen = now - PRESENCE.workingMs - 1;
  assert.equal(laneOwnership({}, lane, now, old).state, 'completed');
});
