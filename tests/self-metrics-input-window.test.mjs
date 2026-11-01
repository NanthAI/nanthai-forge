// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { buildComposePages } from '../dist/hosted-compose.js';
import { saveBytes } from '../dist/hosted-save.js';
import { hydrateMetricInputs } from '../dist/self-metrics-hosted-inputs.js';

test('metric input windows traverse queued pins linearly without changing object calls or inputs', async t => {
  const count = 600,
    pins = new Map(),
    objects = new Map(),
    lanes = [],
    moves = [];
  for (let i = 0; i < count; i++) {
    const laneId = randomUUID(),
      intentId = randomUUID(),
      head = 'a'.repeat(64);
    const built = buildComposePages([
      {
        laneId,
        head,
        version: 0,
        sourceVersion: 0,
        lifecycleVersion: 0,
        state: { object: { sha256: head, size: 0 }, recipe: null },
      },
    ]);
    for (const page of built.pages) objects.set(page.pin.sha256, saveBytes(page.value));
    pins.set(`move:${i}`, built.manifest.root);
    lanes.push({ id: laneId, version: 0, intentId, revert: false });
    moves.push({ id: String(i), inputs: [] });
  }
  let objectCalls = 0,
    visited = 0;
  const records = { moves, runs: [], submissions: [] };
  // Count iteration work across the real hydration call, independently of wall time/RSS.
  // The old queue-wide copy on every eight-pin batch visits 24,000 entries here.
  const values = Map.prototype.values;
  Map.prototype.values = function* () {
    for (const value of values.call(this)) {
      visited++;
      yield value;
    }
  };
  try {
    await hydrateMetricInputs(records, pins, lanes, [], async batch => {
      objectCalls++;
      assert(batch.length <= 8);
      return batch.map(pin => objects.get(pin.sha256));
    });
  } finally {
    Map.prototype.values = values;
  }
  assert.equal(objectCalls, Math.ceil(count / 8));
  assert(visited <= count * 4, `${visited} queue entries visited for ${count} input pages`);
  for (let i = 0; i < count; i++) assert.equal(records.moves[i].inputs[0].laneId, lanes[i].id);
  t.diagnostic(JSON.stringify({ inputs: count, visited, objectCalls }));
});
