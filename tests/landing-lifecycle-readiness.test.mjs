// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { performance } from 'node:perf_hooks';
import { runningChildRun, settledLandingEntries } from './landing-worker-fixture.mjs';

function readinessFixture(scale = 1) {
  const runs = new Map(
    Array.from({ length: 1500 * scale }, (_, id) => [String(id), { id: String(id), status: 'passed' }]),
  );
  const entries = new Map(
    Array.from({ length: 575 * scale }, (_, id) => [String(id), { id: String(id), status: 'queued' }]),
  );
  const active = { id: 'inflight', status: 'running' };
  runs.set(active.id, active);
  const counts = { queries: 0, records: 0, disposed: 0 };
  const store = {
    load() {
      assert.fail('Readiness must not hydrate whole Work');
    },
    readRecords() {
      return {
        all(collection, value, field) {
          assert.deepEqual([collection, value, field], ['runs', 'running', 'status']);
          counts.queries++;
          const selected = [...runs.values()].filter(run => run.status === value);
          counts.records += selected.length;
          return selected;
        },
        dispose() {
          counts.disposed++;
        },
      };
    },
    select(collection, id) {
      assert.equal(collection, 'landingEntries');
      counts.records++;
      return entries.get(id);
    },
  };
  return { store, active, entries, counts };
}

test('restart readiness waits for the saved child identity and the original terminal entries', () => {
  const f = readinessFixture();
  assert.equal(runningChildRun(f.store), undefined, 'running alone does not pin a signal target');
  f.active.childPid = 123;
  assert.equal(runningChildRun(f.store), f.active);
  assert.equal(f.counts.disposed, 2, 'release each selected record observation');
  const ids = ['0', '1'];
  assert.equal(settledLandingEntries(f.store, ids), false);
  f.entries.get('0').status = 'accepted';
  f.entries.get('1').status = 'checking';
  assert.equal(settledLandingEntries(f.store, ids), false);
  f.entries.get('1').status = 'accepted';
  assert.equal(settledLandingEntries(f.store, ids), true, 'unrelated queued work cannot block readiness');
  f.entries.delete('1');
  assert.equal(settledLandingEntries(f.store, ids), false, 'missing original work is not settled');
});

for (const scale of [1, 2])
  test(`durable readiness has a selected-read budget at ${scale}x dogfood history`, t => {
    const f = readinessFixture(scale);
    f.active.childPid = 123;
    f.entries.get('0').status = 'accepted';
    f.entries.get('1').status = 'accepted';
    const started = performance.now();
    assert.equal(runningChildRun(f.store), f.active);
    assert.equal(settledLandingEntries(f.store, ['0', '1']), true);
    assert.deepEqual(f.counts, { queries: 1, records: 3, disposed: 1 });
    t.diagnostic(
      JSON.stringify({
        runs: 1500 * scale + 1,
        entries: 575 * scale,
        ...f.counts,
        elapsedMs: performance.now() - started,
        convexCalls: 0,
        writes: 0,
      }),
    );
  });
