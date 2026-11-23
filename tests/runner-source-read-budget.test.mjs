// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Ferdinando Valsecchi
import test from 'node:test';
import assert from 'node:assert/strict';
import { physicalStateSourceFixture } from './physical-state-source-fixture.mjs';
import { moduleUrl } from './convex-module.mjs';
const { RUNNER_SOURCE_READ_BUDGET_MS } = await import(moduleUrl('../convex/projectStateSourceApi.ts'));

/** Object storage that never answers a GET: each read ends only when its own deadline aborts it. */
function hangingReads() {
  const fake = globalThis.fetch;
  let reads = 0;
  globalThis.fetch = (target, init = {}) => {
    if ((init.method ?? 'GET') !== 'GET') return fake(target, init);
    reads++;
    return new Promise((_resolve, reject) =>
      init.signal?.addEventListener('abort', () => reject(init.signal.reason), { once: true }),
    );
  };
  return { reads: () => reads, restore: () => (globalThis.fetch = fake) };
}

test('incident replay e62d834b (incident 2, 2026-11-20): slow object storage fails the runner source call with its storage cause inside the runner 30 s timeout', async t => {
  const f = await physicalStateSourceFixture(t, 20);
  const start = Date.now();
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: start });
  const base = performance.now();
  t.mock.method(performance, 'now', () => base + (Date.now() - start));
  const storage = hangingReads();
  try {
    let outcome;
    const call = f.source({ state: f.s.state.sha256, digests: [], all: true, runs: true }).then(
      () => (outcome = { replied: true }),
      error => (outcome = { error }),
    );
    // Simulated time jumps only to timers the call armed (its read deadlines), never while it does other
    // async work, so a slow runner cannot inflate the elapsed time.
    for (let round = 0; !outcome && round < 200; round++) {
      for (let i = 0; i < 50 && !outcome; i++) await new Promise(resolve => setImmediate(resolve));
      if (!outcome) t.mock.timers.runAll();
    }
    assert(outcome, 'the call ended inside the simulated clock rounds');
    await call;
    const elapsed = Date.now() - start;
    assert(storage.reads() > 0, 'the call read object storage');
    assert(outcome?.error, 'storage that never answers cannot produce source grants');
    // test-signal: allow elapsed is mocked-clock time (t.mock.timers), the budget under test
    assert(elapsed < 30_000, `the call ended before the runner's 30 s timeout (${elapsed} ms)`);
    // test-signal: allow elapsed is mocked-clock time (t.mock.timers), the budget under test
    assert(elapsed <= RUNNER_SOURCE_READ_BUDGET_MS, `the reads kept to their budget (${elapsed} ms)`);
    assert.equal(outcome.error.code, 'EXCHANGE_REQUEST_TIMEOUT', 'the cause is a storage read timeout');
  } finally {
    storage.restore();
  }
});
