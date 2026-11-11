// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { planningIssueArguments } from '../dist/planning-issue-arguments.js';
import { hostedAgentCommandSchemas } from '../dist/hosted-agent-contract.js';
import { liveLanesInput } from '../dist/hosted-live-lanes.js';
import { agentFixture } from './hosted-agent-fixture.mjs';
import { validateHostedCliCommand } from '../dist/hosted-cli-validation.js';

const issueActions = [
  ['start', 'planningItemId', {}],
  ['planning', 'id', { reconcile: false }],
  ['put-planning-item', 'itemId', { expectedVersion: 1, status: 'closed' }],
  ['comment-planning-item', 'itemId', { text: 'Synthetic evidence' }],
  ['lanes', 'planningItemId', {}],
  ['friction-triage', 'planningItemId', { frictionIds: [randomUUID()], status: 'planned' }],
];

test('every Issue-taking agent action is covered by the alias contract', () => {
  const advertised = Object.entries(hostedAgentCommandSchemas)
    .filter(([, schema]) => schema.shape?.planningItemId)
    .map(([action]) => action);
  advertised.push('lanes');
  assert.deepEqual(advertised.sort(), issueActions.map(([action]) => action).sort());
});

for (const [action, target, extra] of issueActions)
  test(`${action} accepts canonical planningItemId and both Issue aliases, and rejects ambiguity locally`, async t => {
    const id = randomUUID(),
      schema = action === 'lanes' ? liveLanesInput : hostedAgentCommandSchemas[action];
    const expected = schema.parse({ ...extra, [target]: id });
    for (const key of ['planningItemId', 'id', 'itemId']) {
      assert.doesNotThrow(() => validateHostedCliCommand('.', action, { ...extra, [key]: id }));
      assert(schema.safeParse({ ...extra, [key]: id }).success, `${key} is advertised and accepted by MCP`);
      assert.deepEqual(schema.parse(planningIssueArguments(action, { ...extra, [key]: id })), expected);
    }
    assert.deepEqual(
      schema.parse(planningIssueArguments(action, { ...extra, planningItemId: id, id, itemId: id })),
      expected,
    );
    assert.throws(
      () => validateHostedCliCommand('.', action, { ...extra, planningItemId: id, itemId: randomUUID() }),
      error => error.code === 'BAD_ARGUMENT' && /Use planningItemId/.test(error.message),
    );
    const s = agentFixture(t);
    await assert.rejects(
      s.transport().dispatch(action, { ...extra, planningItemId: id, itemId: randomUUID() }),
      error => error.code === 'BAD_ARGUMENT' && /Use planningItemId/.test(error.message),
    );
    assert.equal(s.calls.length, 0, 'ambiguous Issue aliases never reach the server');
  });

test('Issue aliases never reinterpret an execution intentId', () => {
  const planningItemId = randomUUID(),
    intentId = randomUUID();
  assert.deepEqual(planningIssueArguments('start', { id: planningItemId, intentId }), {
    planningItemId,
    intentId,
  });
  assert.deepEqual(planningIssueArguments('status', { id: planningItemId }), { id: planningItemId });
});
