// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { boundPeers, PEERS_MAX_BYTES } from '../dist/agent-peers.js';

test('caps landed entries and long escaped paths within the byte budget', () => {
  const full = {
    v: 1,
    coverage: 'local',
    landed: Array.from({ length: 9 }, (_, n) => ({
      head: String(n).repeat(64),
      paths: ['path', 'a', 'b', 'c'],
      sync: 'clean',
    })),
  };
  const bounded = boundPeers(full);
  assert.equal(bounded.landed.length, 5);
  assert.equal(bounded.more, 4);
  assert.ok(bounded.landed.every(item => item.more === 1));
  const huge = boundPeers({
    v: 1,
    coverage: 'local',
    landed: [{ head: 'a'.repeat(64), paths: ['界'.repeat(6000)], sync: 'conflict' }],
  });
  assert.ok(Buffer.byteLength(JSON.stringify(huge)) <= PEERS_MAX_BYTES);
  assert.equal(huge.more, 1);
});
