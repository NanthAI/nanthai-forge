// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { observedConflictRecovery } from '../dist/hosted-observed-conflict.js';
import { printedCommand } from '../scripts/bench-t3code/forge-protocol.mjs';

function fixture() {
  const submission = {
    id: randomUUID(),
    attemptId: randomUUID(),
    request: { candidateId: randomUUID() },
    error: {
      code: 'COMPOSITION_CONFLICT',
      message: 'shared.txt conflicts against composed prefix; retained conflict root',
    },
  };
  const candidate = { id: randomUUID(), head: null, digest: 'a'.repeat(64) };
  let reads = 0;
  const transport = {
    root: '/synthetic',
    address: { url: 'https://fixture.invalid', projectId: 'synthetic' },
    async query(name, args) {
      reads++;
      assert.equal(name, 'projectHostedLanding:status');
      assert.deepEqual(args, { submissionId: submission.id });
      return { request: submission, attempt: { id: submission.attemptId, candidate } };
    },
  };
  return { submission, candidate, transport, reads: () => reads };
}

test('observed conflicts read the rejected attempt once and advertise its sync with retained details', async () => {
  const s = fixture();
  const result = await observedConflictRecovery(s.transport, { submission: s.submission });
  const conflict = result.recovery.conflict;
  assert.equal(conflict.candidateId, s.candidate.id);
  assert.notEqual(
    conflict.candidateId,
    s.submission.request.candidateId,
    'a recomposed or batched conflict uses the actual rejected Candidate',
  );
  assert.deepEqual(conflict.candidate, s.candidate);
  assert.deepEqual(conflict.error, s.submission.error);
  const next = printedCommand(conflict.command, s.transport.root);
  assert.equal(next.action, 'sync');
  assert.deepEqual(next.body, { ...s.transport.address, candidateId: s.candidate.id });
  assert.deepEqual(
    conflict.next,
    { action: 'sync', candidateId: s.candidate.id },
    'MCP next contains only action parameters',
  );
  assert.equal(s.reads(), 1);
});

test('embedded recovery and conflict details survive without another read; successful history costs zero', async () => {
  const s = fixture();
  for (const advice of [
    { recovery: { next: { action: 'sync' }, details: 'retained' } },
    { conflict: { next: { action: 'resolve' }, paths: ['shared.txt'] } },
  ]) {
    const entry = { submission: s.submission, ...advice };
    assert.equal(await observedConflictRecovery(s.transport, entry), entry);
  }
  for (let n = 0; n < 575; n++) {
    const entry = { submission: { ...s.submission, error: null } };
    assert.equal(await observedConflictRecovery(s.transport, entry), entry);
  }
  assert.equal(s.reads(), 0);
});

test('conflict recovery rejects an unrelated attempt instead of selecting a different Candidate', async () => {
  const s = fixture();
  const query = s.transport.query;
  s.transport.query = async (...args) => {
    const status = await query(...args);
    return { ...status, attempt: { ...status.attempt, id: randomUUID() } };
  };
  await assert.rejects(observedConflictRecovery(s.transport, { submission: s.submission }), {
    code: 'HOSTED_PROTOCOL_INVALID',
  });
  assert.equal(s.reads(), 1);
});
