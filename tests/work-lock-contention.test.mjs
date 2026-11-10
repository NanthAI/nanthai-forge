// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { indexBuild, indexGet, indexSet, indexUpdate } from '../dist/work-record-index.js';
import { digest } from '../dist/hash.js';
test('multi-selector index updates preserve lookups across splits and removals with fewer persisted nodes', () => {
  const objects = new Map();
  let writes = 0;
  const io = {
    read: id => structuredClone(objects.get(id)),
    put: value => {
      const id = digest(JSON.stringify(value));
      objects.set(id, structuredClone(value));
      writes++;
      return id;
    },
  };
  const values = new Map(Array.from({ length: 200 }, (_, i) => ['key-' + i, [i]])),
    base = indexBuild(io, values);
  const changes = new Map([
    ...Array.from({ length: 30 }, (_, i) => ['key-' + i, i % 2 ? [] : [i, 300 + i]]),
    ...Array.from({ length: 30 }, (_, i) => ['new-' + i, [500 + i]]),
  ]);
  writes = 0;
  let sequential = base;
  for (const [key, positions] of changes) sequential = indexSet(io, sequential, key, positions);
  const previousWrites = writes;
  writes = 0;
  const batched = indexUpdate(io, base, changes),
    batchedWrites = writes;
  assert.ok(batchedWrites < previousWrites);
  for (const key of new Set([...values.keys(), ...changes.keys()]))
    assert.deepEqual(indexGet(io, batched, key), indexGet(io, sequential, key));
  assert.deepEqual(indexGet(io, base, 'key-0'), [0]);
});
