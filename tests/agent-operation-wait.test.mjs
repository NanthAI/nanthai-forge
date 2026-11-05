// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { operationWait } from '../dist/agent-operation-wait.js';
import { normalizeHostedFinishResult } from '../dist/hosted-agent-finish-result.js';
import { landAnnouncement, landWaitCommand } from '../dist/hosted-land-wait.js';
import { landSummary } from '../dist/hosted-land-summary.js';
import { continuation } from '../scripts/bench-t3code/forge-protocol.mjs';

const root = "/synthetic/owner's project";
function pending(operationId = randomUUID()) {
  return {
    operationId,
    result: {
      phase: 'finish',
      replayParameters: { operationId, message: 'Original source' },
      submission: { operationId, phase: 'ready', observation: { state: 'pending' } },
    },
  };
}

test('an admitted finish has one executable blocking wait on its original operation, even with a passed run', () => {
  const response = pending();
  response.result.run = { id: randomUUID(), status: 'passed' };
  const result = normalizeHostedFinishResult(root, {}, response.result);
  const next = continuation(result, root);
  assert.equal(next.root, root);
  assert.equal(next.action, 'wait');
  assert.deepEqual(next.body, {
    operationIds: [response.operationId],
    until: 'acceptance',
    timeoutSeconds: 3600,
  });
  assert.equal(result.waitCommand, result.command);
  assert.equal(result.command, landWaitCommand(root, response));
  assert.equal(result.inProgress, true);
  assert.match(result.instruction, /killed shell/);
  const announcement = landAnnouncement(root, { message: 'Later caller' }, response).join('\n');
  assert(announcement.includes(result.command));
  assert(!announcement.includes('replay:'), 'admitted work advertises wait, not a competing finish');
});

test('check-only dry runs resume the original run, without acceptance or a new finish', () => {
  const runId = randomUUID();
  const result = normalizeHostedFinishResult(
    root,
    {},
    {
      phase: 'check',
      run: { id: runId, status: 'running' },
    },
  );
  assert.deepEqual(continuation(result, root).body, { runId, timeoutSeconds: 3600 });
  const done = normalizeHostedFinishResult(
    root,
    {},
    {
      ...result,
      run: { id: runId, status: 'passed' },
    },
  );
  assert.equal(done.waitCommand, undefined);
  assert.equal(done.next, undefined);
  assert.equal(done.inProgress, undefined);
  assert.equal(done.instruction, undefined);
  assert.deepEqual(landSummary({ result: done }), ['CHECK PASSED (not landed)']);
});

for (const state of ['landed', 'superseded', 'terminal-failed'])
  test(`terminal ${state} removes every pending wait hint and keeps the outcome's next step`, () => {
    const response = pending();
    const result = normalizeHostedFinishResult(root, {}, response.result);
    const terminal = normalizeHostedFinishResult(
      root,
      {},
      {
        ...result,
        submission: { ...result.submission, phase: state, observation: { state } },
      },
    );
    assert.equal(terminal.inProgress, undefined);
    assert.equal(terminal.instruction, undefined);
    assert.equal(terminal.waitCommand, undefined);
    if (state === 'terminal-failed') {
      assert.equal(continuation(terminal, root).action, 'finish');
      assert.equal(terminal.next.operationId, undefined, 'a failed operation is never resubmitted');
    } else {
      assert.equal(terminal.next, undefined);
      assert.match(landSummary({ result: terminal })[0], state === 'landed' ? /^LANDED/ : /^SUPERSEDED/);
    }
  });

for (const status of ['submitted', 'retryable', 'failed', 'failed-outcome'])
  test(`composing source ${status} distinguishes active observation from stopped-source recovery`, () => {
    const response = pending();
    response.result.submission.phase = 'composing';
    response.result.progress =
      status === 'failed-outcome'
        ? { outcome: { status: 'failed', error: { code: 'SYNTHETIC_SOURCE_FAILED' } } }
        : { status, jobId: randomUUID() };
    const result = normalizeHostedFinishResult(root, {}, response.result);
    if (status !== 'retryable') {
      assert.deepEqual(result.next.operationIds, [response.operationId]);
      assert.equal(result.next.action, 'wait');
      assert.equal(result.command, landWaitCommand(root, response));
    } else {
      assert.equal(result, response.result, 'preserve source recovery before normalizing wait advice');
      assert.equal(landWaitCommand(root, response), undefined);
      const announcement = landAnnouncement(root, {}, response).join('\n');
      assert(announcement.includes(JSON.stringify(response.result.replayParameters)));
      assert(!announcement.includes(' wait '));
    }
  });

test('source work without admission retains its replay, without inventing a landing to wait on', () => {
  const original = { operationId: randomUUID(), message: 'Original source message', keepOpen: true };
  const source = {
    phase: 'save',
    next: { action: 'finish', ...original },
    replay: { command: 'private recovery helper' },
    replayParameters: original,
  };
  assert.equal(normalizeHostedFinishResult(root, {}, source), source);
  const announcement = landAnnouncement(root, {}, { operationId: source.next.operationId, result: source });
  assert.match(announcement.join('\n'), /source preparation is unfinished; keep this turn active; replay:/);
  assert(announcement.join('\n').includes(JSON.stringify(original)));
  assert(!announcement.join('\n').includes('private recovery helper'));
});

for (const count of [575, 1150])
  test(`wait continuation formats ${count} selected targets without source/Work/transport IO`, t => {
    // No store, transport or repository argument is available to this production formatter.
    const operationIds = Array.from({ length: count }, () => randomUUID());
    const started = performance.now();
    const result = operationWait(root, { operationIds, until: 'terminal' });
    const elapsedMs = performance.now() - started;
    assert.deepEqual(continuation(result, root).body.operationIds, operationIds);
    assert(Buffer.byteLength(result.command) < count * 40 + 200, 'command bytes grow with selected IDs only');
    t.diagnostic(
      JSON.stringify({
        targets: count,
        elapsedMs,
        commandBytes: Buffer.byteLength(result.command),
        addedCalls: 0,
        addedDbReads: 0,
        addedDbWrites: 0,
        sourceBytes: 0,
        idleCalls: 0,
      }),
    );
  });
