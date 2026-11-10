// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { finishSubmissions } from '../dist/landing-submission-read.js';
import { finishAttempt } from '../dist/agent-finish-journal.js';

test('finish retains the original submitted head while sync selects its attempt head', () => {
  const head = 'a'.repeat(64),
    synced = 'b'.repeat(64);
  const lane = { id: randomUUID(), intentId: randomUUID(), head: synced };
  const command = {
    operationId: randomUUID(),
    laneId: lane.id,
    accept: { channel: 'main', expectedPrevious: null },
  };
  const attempt = finishAttempt(command, 0, head, null);
  attempt.sync = { head: synced };
  const store = { select: collection => (collection === 'lanes' ? lane : undefined) };
  const result = finishSubmissions(store, command, [attempt], { status: 'accepted' })[0];
  assert.equal(result.head, head);
  assert.equal(result.attemptHead, synced);
  assert.equal(result.state, 'landed');
});
