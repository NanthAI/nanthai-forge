// SPDX-License-Identifier: Apache-2.0
import assert from 'node:assert/strict';
import { continuation } from '../scripts/bench-t3code/forge-protocol.mjs';
import { canonicalRoot } from '../dist/root-paths.js';

/** Build-failing dead-end guard, shared by production CLI, wait, bound and MCP tests. */
export function assertAgentResponseShape(response, root, retained = {}) {
  if (response.error) {
    assert.equal(typeof response.error.code, 'string');
    assert.equal(typeof response.error.message, 'string');
    const recovery = response.error.recovery;
    // Callers can carry known retained state even if a broken wrapper drops it.
    // Error wording is not state; an error without recovery must be explicitly terminal.
    const pending =
      retained.sourceCompleted || recovery?.phase === 'local-apply' || response.error.terminal !== true;
    if (pending) {
      assert(recovery, 'Pending local apply lost its recovery data');
      assert.equal(recovery.status, 'blocked');
      assert.equal(recovery.sourceCompleted, true);
      for (const key of ['operationId', 'applyOperationId', 'laneId', 'root'])
        assert.equal(typeof recovery[key], 'string');
      for (const key of ['operationId', 'applyOperationId', 'laneId'])
        if (retained[key]) assert.equal(recovery[key], retained[key]);
      for (const key of ['from', 'to']) {
        assert(recovery[key], `Local apply lost ${key} pins`);
        if (retained[key]) assert.deepEqual(recovery[key], retained[key]);
      }
      assert.equal(recovery.root, canonicalRoot(root), 'Local apply switched checkout root');
      assert(recovery.blockers?.length, 'Local obstruction lost blockers');
      const next = continuation(recovery, root);
      assert(next, 'Blocked local apply has no executable next action');
      assert.equal(next.action, 'recover-apply', 'Unchanged retry cannot clear unresolved local blockers');
      assert.equal(next.body.applyOperationId, recovery.applyOperationId);
      assert.equal(next.root, recovery.root);
      const { action, ...body } = recovery.next;
      assert.equal(action, next.action);
      assert.deepEqual(body, next.body);
      return next;
    }
    return;
  }
  const result = response.result ?? {};
  const submission = result.submission;
  const terminal =
    result.terminal === true ||
    ['landed', 'terminal-failed', 'superseded'].includes(
      submission?.observation?.state ?? submission?.phase ?? result.phase,
    ) ||
    ['passed', 'failed', 'cancelled', 'runner-unavailable', 'interrupted'].includes(result.run?.status);
  const advice = result.recovery?.conflict ?? result.conflict ?? result.recovery ?? result;
  const next = continuation(advice, root);
  assert(terminal || next, 'Agent response has neither a terminal outcome nor a followable continuation');
  if (terminal) {
    assert(!['submitted', 'retryable'].includes(result.status), 'Terminal outcome retained pending status');
    assert(
      !['submitted', 'retryable'].includes(result.progress?.status),
      'Terminal outcome retained pending source',
    );
    assert(!result.inProgress, 'Terminal outcome retained inProgress');
    assert(!result.waitCommand, 'Terminal outcome retained wait command');
    if (next?.action === 'finish')
      assert.notEqual(
        next.body.operationId,
        response.operationId ?? result.operationId,
        'Terminal outcome advertises replaying the failed operation',
      );
  }
  return next;
}
