// SPDX-License-Identifier: Apache-2.0
import assert from 'node:assert/strict';
import { continuation } from '../scripts/bench-t3code/forge-protocol.mjs';

/** Build-failing dead-end guard, shared by production CLI, wait, bound and MCP tests. */
export function assertAgentResponseShape(response, root) {
  if (response.error) {
    assert.equal(typeof response.error.code, 'string');
    assert.equal(typeof response.error.message, 'string');
    return; // An explicit terminal action error is an outcome, not a protocol dead end.
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
