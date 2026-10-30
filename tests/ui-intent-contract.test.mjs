// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createElement as h } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { moduleUrl } from './convex-module.mjs';
const { TestContract } = await import(moduleUrl('../web/src/lane/TestContract.tsx'));
const { ReviewStory } = await import(moduleUrl('../web/src/review/ReviewStory.tsx'));
const { intentRows } = await import(moduleUrl('../web/src/intents/model.ts'));
const contract = {
  version: 2,
  operationId: randomUUID(),
  request: 'c'.repeat(64),
  candidateId: randomUUID(),
  measuredOn: 'a'.repeat(64),
  runId: randomUUID(),
  at: '2026-01-01T00:00:00.000Z',
  proposedTests: ['tests/leaf.test.mjs'],
  tests: [{ path: 'tests/leaf.test.mjs', durationMs: 1234 }],
  totalMs: 1234,
};
test('contract panel shows tests, time and exact measurement pins with existing exact-record copy controls', () => {
  const html = renderToStaticMarkup(h(TestContract, { contract }));
  for (const text of [
    'Proving tests',
    'tests/leaf.test.mjs',
    '1.23 s',
    contract.measuredOn,
    contract.candidateId,
    contract.runId,
  ])
    assert.ok(html.includes(text), text);
  assert.doesNotMatch(html, /<input|<form/);
  assert.equal((html.match(/aria-label="Copy /g) ?? []).length, 4);
  assert.equal(renderToStaticMarkup(h(TestContract, {})), '');
});
test('Review and Intent data expose the same latest version; contract-less review stays unchanged', () => {
  const rows = intentRows(
    [
      {
        id: 'intent',
        outcome: 'Outcome',
        status: 'active',
        testContracts: [{ ...contract, version: 1 }, contract],
      },
    ],
    [],
  );
  assert.deepEqual(rows[0].contract, contract);
  const data = { files: { items: [], total: 0 }, contract };
  const props = {
    data,
    outcome: 'Outcome',
    intentHref: '/intent',
    laneName: () => 'Lane',
    children: () => null,
  };
  assert.match(renderToStaticMarkup(h(ReviewStory, props)), /tests\/leaf.test.mjs/);
  assert.doesNotMatch(
    renderToStaticMarkup(h(ReviewStory, { ...props, data: { ...data, contract: null } })),
    /Proving tests/,
  );
});

test('review names both Intents and the failing tests without requiring another user step', () => {
  const semanticConflicts = [
    {
      runId: randomUUID(),
      intents: [
        { intentId: 'own-id', outcome: 'Own change' },
        { intentId: 'peer-id', outcome: 'Peer change' },
      ],
      failedTests: ['tests/prove.test.mjs'],
    },
  ];
  const props = {
    data: { files: { items: [], total: 0 }, contract: null, semanticConflicts },
    outcome: 'Own change',
    intentHref: '/intent',
    laneName: () => 'Lane',
    children: () => null,
  };
  const html = renderToStaticMarkup(h(ReviewStory, props));
  for (const text of [
    'Intent semantic conflict',
    'Own change',
    'Peer change',
    'own-id',
    'peer-id',
    'tests/prove.test.mjs',
  ])
    assert(html.includes(text), text);
  assert.doesNotMatch(html, /<input|<form|Confirm|Acknowledge/);
});
