// SPDX-License-Identifier: Apache-2.0
// Issue 78a97771 cohort regression: a withdrawn, known failing member stops supplying speculative
// source to the cohort stacked on it. Survivors recompose without it and land; its cancelled check
// evidence stays and late callbacks for its old shared run cannot publish it.
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { batchesFixture, states, synthetic } from './hosted-landing-batches-fixture.mjs';
import { landingApi } from './hosted-finish-fixture.mjs';
const prior = Object.fromEntries(Object.keys(synthetic).map(key => [key, process.env[key]]));
test.before(() => Object.assign(process.env, synthetic));
test.after(() => {
  for (const [key, value] of Object.entries(prior)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});
const batches = f => [...f.tables.projectHostedLandingBatches.values()].map(row => JSON.parse(row.value));
const current = (f, index) => states(f).find(state => state.id === f.entries[index].state.id);
const files = (f, head) => JSON.parse(f.c.objects.get(head)).files;
const carries = (f, head, index) =>
  files(f, head).some(
    file => file.path === 'collision' && file.blob === f.c.file('collision', `member ${index}`).blob,
  );
async function drainActive(f) {
  for (let steps = 0; ; steps++) {
    const task = f.pending().find(task => !task.name.startsWith('projectHostedLandingStall:'));
    if (!task) return steps;
    assert(steps < 2000, 'cohort settles without a busy loop');
    await f.execute(task);
  }
}

for (const count of [10, 20])
  test(`N=${count}: a withdrawn known-failing predecessor member stops feeding peers; survivors land`, async t => {
    // Entry 1 is the known failing member in the predecessor cohort; entry 3 is stacked behind it.
    const f = await batchesFixture(t, {
      count,
      batching: 'default',
      batchMaxSize: 3,
      memberPaths: Array.from({ length: count }, (_, index) =>
        index === 1 || index === 3 ? 'collision' : `member-${index}`,
      ),
    });
    await drainActive(f);
    const failing = current(f, 1);
    const shared = f.runs().find(run => carries(f, run.request.expectedHead, 1));
    assert(shared, 'the failing member is inside a shared speculative check');
    const stacked = batches(f).filter(batch => batch.predecessor?.submissionId);
    assert(stacked.length, 'a successor cohort is stacked on the speculative predecessor');
    const active = await f.rawChecks.activate(shared.id);
    const before = f.counts.length;
    await f.transaction('withdraw-known-failing', landingApi.cancel, {
      projectId: f.projectId,
      request: JSON.stringify({ operationId: randomUUID(), authorityEpoch: 1, submissionId: failing.id }),
    });
    const withdrawCalls = f.counts.slice(before);
    // One metadata transaction, bounded by the live train (measured 281/154 at N=10, 409/226 at N=20).
    assert.equal(withdrawCalls.length, 1);
    assert(withdrawCalls[0].documents < 160 + 15 * count && withdrawCalls[0].writes < 90 + 9 * count);
    assert(
      !withdrawCalls[0].touched.some(table => /Backups|WorkRecords|WorkEvents|WorkGenerations/.test(table)),
      'no history hydration',
    );
    await drainActive(f);
    // No live group still stacks on the withdrawn member's source.
    for (const batch of batches(f).filter(batch => !['superseded', 'landed'].includes(batch.phase)))
      assert.notEqual(batch.predecessor?.submissionId, failing.id, 'no live cohort stacks on it');
    // Late callback for the old shared run: a failure cannot terminalize survivors or publish it.
    await f.fail(active.id ?? shared.id, 'tests/member-1.test.mjs').catch(() => {});
    await drainActive(f);
    for (let wave = 0; states(f).some(s => !['landed', 'terminal-failed'].includes(s.phase)); wave++) {
      assert(wave < 30, JSON.stringify(states(f).map(s => [s.phase, s.error?.code])));
      for (const run of f.runs().filter(run => run.status === 'queued')) {
        assert(!carries(f, run.request.expectedHead, 1), 'no later check carries the withdrawn source');
        await f.rawChecks.pass(await f.rawChecks.activate(run.id));
      }
      await drainActive(f);
    }
    assert.equal(current(f, 1).error.code, 'LANDING_CANCELLED');
    assert.equal(states(f).filter(s => s.phase === 'landed').length, count - 1, 'every survivor lands');
    const main = f.currentMain().head;
    assert(carries(f, main, 3) && !carries(f, main, 1), 'main has the survivor, never the withdrawn bytes');
    // Cancelled-check evidence stays: the shared run record remains with its outcome.
    assert(
      f.runs().some(run => run.id === shared.id),
      'the withdrawn member’s check record is retained',
    );
    assert.equal(f.pending().length, 0, 'zero idle work');
    t.diagnostic(
      JSON.stringify({
        count,
        withdrawCalls: withdrawCalls.length,
        reads: withdrawCalls.reduce((sum, c) => sum + c.documents, 0),
        writes: withdrawCalls.reduce((sum, c) => sum + c.writes, 0),
        runs: f.runs().length,
      }),
    );
  });
