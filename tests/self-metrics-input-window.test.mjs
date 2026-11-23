// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Ferdinando Valsecchi
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { buildComposePages } from '../dist/hosted-compose.js';
import { saveBytes, savePin } from '../dist/hosted-save.js';
import { hydrateMetricInputs, resolveMetricInputPins } from '../dist/self-metrics-hosted-inputs.js';

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

test('covered metadata transfers overlap full batches and read a shared compose tail once', async () => {
  const objects = new Map();
  const lanes = [];
  const head = 'a'.repeat(64);
  const page = next => {
    const id = randomUUID();
    lanes.push({ id, version: 0, intentId: randomUUID(), revert: false });
    const value = {
      schema: 1,
      kind: 'forge-hosted-compose-page',
      entries: [
        {
          laneId: id,
          head,
          version: 0,
          sourceVersion: 0,
          lifecycleVersion: 0,
          state: { object: { sha256: head, size: 0 }, recipe: null },
        },
      ],
      next,
    };
    const pin = savePin(value);
    objects.set(pin.sha256, saveBytes(value));
    return pin;
  };
  const tail = page(null);
  const roots = Array.from({ length: 39 }, () => page(tail));
  roots.splice(13, 0, tail);
  async function read(parallel) {
    const seen = new Set();
    let active = 0,
      peak = 0,
      calls = 0;
    const resolved = await resolveMetricInputPins(
      roots,
      lanes,
      [],
      async batch => {
        assert(batch.length <= 8);
        calls++;
        peak = Math.max(peak, ++active);
        // Yield just long enough to observe overlapping requests without a wall clock.
        await Promise.resolve();
        active--;
        return batch.map(pin => {
          assert(!seen.has(pin.sha256), 'a shared page is transferred once');
          seen.add(pin.sha256);
          return objects.get(pin.sha256);
        });
      },
      undefined,
      new Map(),
      parallel,
    );
    return { resolved, calls, peak, reads: seen.size };
  }
  const canonical = await read(false);
  const covered = await read(true);
  assert.deepEqual(covered.resolved, canonical.resolved);
  assert.equal(covered.calls, canonical.calls);
  assert.equal(covered.reads, roots.length);
  assert.equal(canonical.peak, 1);
  assert.equal(covered.peak, 4);

  const cache = new Map();
  await assert.rejects(
    resolveMetricInputPins(
      roots,
      lanes,
      [],
      async batch => {
        if (batch[0].sha256 === roots[0].sha256) throw Error('synthetic transfer interrupted');
        return batch.map(pin => objects.get(pin.sha256));
      },
      undefined,
      cache,
      true,
    ),
    /synthetic transfer interrupted/,
  );
  assert.equal(cache.size, 24, 'the other verified batches are retained for fallback');
  const cached = new Set(cache.keys());
  const retried = await resolveMetricInputPins(
    roots,
    lanes,
    [],
    async batch =>
      batch.map(pin => {
        assert(!cached.has(pin.sha256), 'fallback only requests missing pages');
        return objects.get(pin.sha256);
      }),
    undefined,
    cache,
  );
  assert.deepEqual(retried, canonical.resolved);
});
