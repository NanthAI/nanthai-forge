// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { moduleUrl } from './convex-module.mjs';
const { assembleIndexValue } = await import(moduleUrl('../web/src/hosted-index-value.ts'));
const chunks = value => {
  const json = JSON.stringify(value),
    mid = Math.floor(json.length / 2);
  return [
    { position: 0, value: json.slice(0, mid) },
    { position: 1, value: json.slice(mid) },
  ];
};

test('selected planning values restore full body and unknown fields before editing', () => {
  const item = {
      id: 'item',
      body: 'a🌍'.repeat(40000),
      title: 'Original',
      version: 4,
      extension: { retained: true },
    },
    parts = chunks(item);
  assert.deepEqual(
    assembleIndexValue(
      'planningItems',
      { id: 'item', title: 'Original', body: '', payloadKey: 'key', payloadParts: 2 },
      parts,
    ),
    item,
  );
});
test('incomplete or reordered payload cannot become an editable record', () => {
  const header = { payloadKey: 'key', payloadParts: 2 },
    parts = chunks({ body: 'retained' });
  assert.throws(() => assembleIndexValue('planningItems', header, parts.slice(0, 1)), /incomplete/);
  assert.throws(() => assembleIndexValue('planningItems', header, parts.toReversed()), /incomplete/);
});
test('immutable Intent attributes hydrate with current live status and separate history counts', () => {
  const original = {
    id: 'intent',
    outcome: 'Large original',
    status: 'active',
    notes: [{ text: 'old' }],
    extension: { preserved: true },
  };
  assert.deepEqual(
    assembleIndexValue(
      'intents',
      { payloadKey: 'key', payloadParts: 2, status: 'completed', noteCount: 2000, lifecycleCount: 20 },
      chunks(original),
    ),
    { ...original, status: 'completed', notes: [], noteCount: 2000, lifecycle: [], lifecycleCount: 20 },
  );
  const small = { body: 'small' };
  assert.equal(assembleIndexValue('planningItems', small, []), small);
});

test('shared codec preserves the CLI local-observation overlay without changing browser hydration', () => {
  const original = { id: 'lane', state: 'active', extension: { retained: true } };
  const header = {
    id: 'lane',
    state: 'completed',
    localObservation: true,
    payloadKey: 'key',
    payloadParts: 2,
  };
  assert.deepEqual(assembleIndexValue('lanes', header, chunks(original)), original);
  assert.deepEqual(assembleIndexValue('lanes', header, chunks(original), { overlayLocalObservation: true }), {
    ...original,
    ...header,
  });
});

test('shared codec preserves transport-specific coverage errors and rejects duplicate positions', () => {
  const header = { payloadKey: 'key', payloadParts: 2 };
  const parts = chunks({ extension: 'retained' });
  parts[1].position = 0;
  assert.throws(() => assembleIndexValue('lanes', header, parts), /incomplete/);
  const failure = new Error('transport coverage failure');
  assert.throws(
    () =>
      assembleIndexValue('lanes', header, parts, {
        incomplete: () => {
          throw failure;
        },
      }),
    error => error === failure,
  );
});
