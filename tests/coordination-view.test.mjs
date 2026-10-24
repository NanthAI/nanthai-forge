// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { moduleUrl } from './convex-module.mjs';
const { contextLabels, sessionRows, eventRows, activityLink } = await import(
  moduleUrl('../web/src/coordination-view.ts')
);
const labels = {
  intents: [
    { id: 'i1', outcome: 'Improve source search' },
    { id: 'i2', outcome: 'Ship mobile layout' },
  ],
  lanes: [{ id: 'l1', name: 'Search implementation', intentId: 'i1' }],
};
const sessions = [
  {
    sessionId: 's1',
    name: 'Zoe',
    status: 'working',
    summary: 'Indexing',
    environment: 'Local',
    lastSeen: 30,
    context: { intentId: 'i1', laneId: 'l1' },
  },
  {
    sessionId: 's2',
    name: 'Amy',
    status: 'completed',
    summary: 'Responsive layouts',
    environment: 'Local',
    lastSeen: 50,
    context: { intentId: 'i2' },
  },
];
test('project activity searches readable linked work and sorts without mutating source records', () => {
  const original = structuredClone(sessions);
  assert.equal(
    sessionRows(sessions, labels, 'search implementation', 'working', 'newest')[0].sessionId,
    's1',
  );
  assert.deepEqual(
    sessionRows(sessions, labels, '', 'all', 'name').map(x => x.name),
    ['Amy', 'Zoe'],
  );
  assert.deepEqual(sessions, original);
  assert.deepEqual(contextLabels({ intentId: 'not-loaded', laneId: 'missing' }, labels), {
    intent: 'Linked Intent',
    lane: 'Linked Lane',
  });
});
test('Intent activity excludes unrelated work and carries acknowledgement context from its message', () => {
  const events = [
    {
      operationId: 'm1',
      at: 1,
      command: { kind: 'message', text: 'Ready to review', sessionId: 's1', context: { intentId: 'i1' } },
    },
    { operationId: 'a1', at: 3, command: { kind: 'ack', text: 'Read', messageId: 'm1' } },
    {
      operationId: 'm2',
      at: 2,
      command: { kind: 'message', text: 'Layout ready', context: { intentId: 'i2' } },
    },
  ];
  assert.deepEqual(
    eventRows(events, sessions, labels, '', 'all', 'newest', 'i1').map(x => x.operationId),
    ['a1', 'm1'],
  );
  assert.deepEqual(
    eventRows(events, sessions, labels, '', 'message', 'oldest', 'i1').map(x => x.operationId),
    ['m1'],
  );
  assert.equal(sessionRows(sessions, labels, '', 'all', 'newest', 'i1').length, 1);
});

test('Lane-only activity belongs to its owning Intent and acknowledgements retain the same scope', () => {
  const laneOnly = { ...sessions[0], context: { laneId: 'l1' } };
  assert.deepEqual(contextLabels(laneOnly.context, labels), {
    intent: 'Improve source search',
    lane: 'Search implementation',
  });
  assert.equal(sessionRows([laneOnly, ...sessions], labels, '', 'all', 'newest', 'i1', 'l1').length, 2);
  assert.equal(sessionRows([laneOnly], labels, '', 'all', 'newest', 'i2', 'l1').length, 0);
  const events = [
    { operationId: 'm', at: 1, command: { kind: 'message', text: 'Ready', context: { laneId: 'l1' } } },
    { operationId: 'a', at: 2, command: { kind: 'ack', text: 'Read', messageId: 'm' } },
    { operationId: 'unknown', at: 3, command: { kind: 'ack', text: 'Read', messageId: 'unloaded' } },
  ];
  assert.deepEqual(
    eventRows(events, [], labels, '', 'all', 'newest', 'i1', 'l1').map(x => x.operationId),
    ['a', 'm'],
  );
});
test('activity links retain the project and open the narrowest known context', () => {
  const lane = new URLSearchParams(
    activityLink('project & one', { intentId: 'i1', laneId: 'l1' }, 'message 1', 'events'),
  );
  assert.equal(lane.get('project'), 'project & one');
  assert.equal(lane.get('lane'), 'l1');
  assert.equal(lane.get('laneTab'), 'activity');
  assert.equal(lane.get('session'), 'message 1');
  assert.equal(lane.get('activityTab'), 'events');
  assert.equal(lane.has('intent'), false);
  const intent = new URLSearchParams(activityLink('p', { intentId: 'i1' }, 's'));
  assert.equal(intent.get('intentTab'), 'coordination');
  assert.equal(intent.get('intent'), 'i1');
  assert.equal(intent.get('activityTab'), 'sessions');
  assert.equal(new URLSearchParams(activityLink('p', {})).get('projectTab'), 'coordination');
});

test('activity remains readable before its Lane or Intent exists in the uploaded index', () => {
  const announced = { ...sessions[0], context: { laneId: 'not-uploaded', intentId: 'new-intent' } };
  assert.equal(
    sessionRows([announced, ...sessions], labels, '', 'all', 'newest', undefined, 'not-uploaded')[0],
    announced,
  );
  assert.deepEqual(sessionRows([announced, ...sessions], labels, '', 'all', 'newest', 'new-intent'), [
    announced,
  ]);
  assert.deepEqual(contextLabels(announced.context, labels), {
    intent: 'Linked Intent',
    lane: 'Linked Lane',
  });
});

const { activityAuthor } = await import(moduleUrl('../web/src/coordination-view.ts'));
test('session identity wins over legacy agent text; prefix is a fallback only without a structured session', () => {
  const event = {
    actorDisplayName: 'Project owner',
    command: { kind: 'message', text: 'gpt-old: Ready', context: {} },
  };
  assert.equal(activityAuthor(event, []), 'gpt-old');
  assert.equal(activityAuthor({ ...event, command: { ...event.command, sessionId: 's1' } }, sessions), 'Zoe');
  assert.equal(
    activityAuthor({ ...event, command: { ...event.command, sessionId: 'missing' } }, []),
    'Project owner',
  );
  assert.equal(
    activityAuthor({ ...event, command: { ...event.command, text: 'Ready' } }, []),
    'Project owner',
  );
});
