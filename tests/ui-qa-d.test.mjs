// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { moduleUrl } from './convex-module.mjs';
const { hostedDecisions, hostedFeed } = await import(moduleUrl('../web/src/cockpit/coordination.ts'));
const { hostedAttention } = await import(moduleUrl('../web/src/shell/Attention.tsx'));
const event = {
  operationId: 'question',
  recipientActor: 'owner',
  actor: 'agent-owner',
  at: 1,
  command: { kind: 'message', sessionId: 'agent-session', text: 'Ready?', context: { laneId: 'lane' } },
};
const session = {
  sessionId: 'agent-session',
  name: 'gpt-qa',
  kind: 'agent',
  context: { laneId: 'lane' },
  status: 'working',
};
const records = state => ({
  lanes: [{ id: 'lane', intentId: 'intent', state }],
  intents: [{ id: 'intent', status: 'active' }],
});
test('Needs you hides completed and abandoned sender work, preserving Activity and unknown work', () => {
  for (const state of ['completed', 'abandoned']) {
    assert.equal(hostedDecisions([event], [session], [], records(state)).length, 0);
    assert.equal(hostedDecisions([event], [], [], records(state)).length, 0);
    assert.equal(hostedDecisions([event], [{ ...session, context: {} }], [], records(state)).length, 0);
    assert.equal(hostedFeed([event], [session], [], 10).length, 1);
  }
  assert.equal(hostedDecisions([event], [session], [], records('active')).length, 1);
  assert.equal(hostedDecisions([event], [], [], { lanes: [], intents: [] }).length, 1);
  for (const status of ['completed', 'abandoned']) {
    assert.equal(
      hostedDecisions([event], [session], [], { ...records('active'), intents: [{ id: 'intent', status }] })
        .length,
      0,
    );
  }
});
test('sender session scope wins over a message about a different completed Lane', () => {
  const different = { ...session, context: { laneId: 'live' } };
  assert.equal(hostedDecisions([event], [different], [], records('completed')).length, 1);
});
test('shared attention count agrees with Needs you after sender completion', () => {
  const work = { ...records('completed'), views: [], runs: [], checks: [], channelMoves: [] };
  const result = hostedAttention(
    work,
    { sessions: [session], events: [event], unacked: [event], claims: [] },
    Date.now(),
  );
  assert.equal(result.decisions.length, 0);
});
