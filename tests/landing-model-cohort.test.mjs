// SPDX-License-Identifier: Apache-2.0
// Regression for Issue 6e587f06: an unaccepted prefix cannot terminalize its peer.
import test from 'node:test';
import { readLandingTransition } from '../dist/hosted-landing.js';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { moduleUrl } from './convex-module.mjs';
const speculative = await import(moduleUrl('../convex/projectHostedLandingSpeculativeConflict.ts'));
import { landingApi } from './hosted-finish-fixture.mjs';
import { batchesFixture, states, synthetic } from './hosted-landing-batches-fixture.mjs';
const prior = Object.fromEntries(Object.keys(synthetic).map(key => [key, process.env[key]]));
test.before(() => Object.assign(process.env, synthetic));
test.after(() => {
  for (const [key, value] of Object.entries(prior)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});
const current = (f, index) => states(f).find(state => state.id === f.entries[index].state.id);
const rowOf = (f, index) =>
  [...f.tables.projectHostedLandingRequests.values()].find(
    row => row.submissionId === f.entries[index].state.id,
  );
async function settle(f, failPrefix = false, prefixIndex = 0) {
  for (let wave = 0; wave < 12; wave++) {
    const pending = f.runs().filter(run => run.status === 'queued');
    if (!pending.length) return;
    for (const run of pending) {
      const files = JSON.parse(f.c.objects.get(run.request.expectedHead)).files;
      const prefix = files.some(
        file =>
          file.path === 'collision' && file.blob === f.c.file('collision', `member ${prefixIndex}`).blob,
      );
      if (failPrefix && prefix) await f.fail(run.id, 'tests/member-0.test.mjs');
      else await f.rawChecks.pass(await f.rawChecks.activate(run.id));
    }
    await f.drain();
  }
  assert.fail('cohort did not settle');
}
for (const count of [2, 8])
  test(`N=${count}: prefix-only conflict retries automatically after its unaccepted member fails`, async t => {
    const f = await batchesFixture(t, { count, conflict: true, batchMaxSize: 8 });
    assert(f.entries.every(entry => entry.candidate.result.status === 'clean'));
    const selections = f.entries.map(entry => JSON.stringify(entry.selection));
    await f.drain();
    assert.equal(current(f, 0).phase, 'checking');
    assert.equal(current(f, 1).phase, 'queued');
    assert.equal(current(f, 1).error, null);
    assert.equal(current(f, 1).attemptId, f.entries[1].state.attemptId);
    const advice = JSON.parse(rowOf(f, 1).wouldConflict);
    assert.equal(advice.predecessor.groupId, current(f, 0).batchId);
    assert.equal(rowOf(f, 1).orderWait, f.entries[count === 2 ? 0 : count - 1].state.id);
    assert.equal(rowOf(f, 1).alarm, null);
    assert.equal(f.runs().length, 1, 'advice creates no diagnostic check');
    const idle = f.counts.length;
    assert.equal(await f.drain(), 0);
    assert.equal(f.counts.length, idle, 'idle makes zero calls');
    await settle(f, true);
    assert.equal(current(f, 0).phase, 'terminal-failed');
    // The rejected member can win the normal retry order. In that case A's
    // solo retry conflicts with B's now-accepted bytes, which is valid.
    assert(['CHECK_FAILED', 'COMPOSITION_CONFLICT'].includes(current(f, 0).error.code));
    assert(
      f.runs().some(run => run.status === 'failed'),
      'the original shared prefix check failed',
    );
    assert.equal(current(f, 1).phase, 'landed');
    assert.equal(rowOf(f, 1).wouldConflict, undefined);
    assert(
      ![...f.tables.projectHostedLandingObservations.values()]
        .map(
          row =>
            readLandingTransition(
              row.value,
              JSON.parse(
                [...f.tables.projectHostedLandingRequests.values()].find(
                  request => request.submissionId === row.submissionId,
                ).value,
              ),
            ).submission,
        )
        .some(state => state.id === current(f, 1).id && state.error?.code === 'COMPOSITION_CONFLICT'),
    );
    assert.equal(
      JSON.parse(f.c.objects.get(f.currentMain().head)).files.find(file => file.path === 'collision').blob,
      f.c.file('collision', 'member 1').blob,
    );
    assert.deepEqual(
      f.entries.map(entry => JSON.stringify(entry.selection)),
      selections,
    );
    assert.equal(states(f).filter(state => state.phase === 'landed').length, count - 1);
    t.diagnostic(
      JSON.stringify({
        count,
        calls: f.counts.length,
        reads: f.counts.reduce((sum, c) => sum + c.documents, 0),
        writes: f.counts.reduce((sum, c) => sum + c.writes, 0),
        maxReads: Math.max(...f.counts.map(c => c.documents)),
        peakRssBytes: process.resourceUsage().maxRSS * 1024,
      }),
    );
  });
test('prefix success reevaluates the rejected member on accepted main without another check', async t => {
  const f = await batchesFixture(t, { count: 2, conflict: true });
  await f.drain();
  assert.equal(current(f, 1).phase, 'queued');
  await settle(f);
  assert.equal(current(f, 0).phase, 'landed');
  assert.equal(current(f, 1).phase, 'terminal-failed');
  assert.equal(current(f, 1).error.code, 'COMPOSITION_CONFLICT');
  assert.equal(f.runs().length, 1);
});

test('cancellation of the internal prefix releases the rejection and fences a late shared pass', async t => {
  const f = await batchesFixture(t, { count: 2, conflict: true });
  await f.drain();
  const run = await f.rawChecks.activate(f.runs()[0].id);
  await f.transaction('cancel-internal-prefix', landingApi.cancel, {
    projectId: f.projectId,
    request: JSON.stringify({ operationId: randomUUID(), authorityEpoch: 1, submissionId: current(f, 0).id }),
  });
  await f.drain();
  await assert.rejects(f.rawChecks.pass(run), error => error.data?.code === 'CHECK_CANCELLED');
  await f.drain();
  await settle(f);
  assert.equal(current(f, 0).error.code, 'LANDING_CANCELLED');
  assert.equal(current(f, 1).phase, 'landed');
  assert.equal(rowOf(f, 1).wouldConflict, undefined);
});
test('a main conflict after a clean internal prefix is still terminal before that prefix checks', async t => {
  const f = await batchesFixture(t, {
    count: 6,
    batchMaxSize: 3,
    concurrency: 1,
    memberPaths: ['member-0', 'collision', 'member-2', 'member-3', 'collision', 'member-5'],
  });
  await f.drain();
  await f.rawChecks.pass(await f.rawChecks.activate(f.runs()[0].id));
  await f.drain();
  assert.equal(current(f, 3).phase, 'checking');
  assert.equal(current(f, 4).phase, 'terminal-failed');
  assert.equal(current(f, 4).error.code, 'COMPOSITION_CONFLICT');
  assert.equal(rowOf(f, 4).wouldConflict, undefined);
  const batch = [...f.tables.projectHostedLandingBatches.values()]
    .map(row => JSON.parse(row.value))
    .find(batch => batch.members.some(member => member.submissionId === current(f, 4).id));
  const source = await f.c.progress({ request: { operationId: batch.composeOperationId } });
  assert.equal(source.state.dropped[0].againstMain, true);
  const root = JSON.parse(f.c.objects.get(source.state.dropped[0].conflicts.sha256));
  assert.equal(
    root.left,
    f.currentMain().head,
    'retain proof against accepted main, not the intermediate prefix',
  );
  const fixed = await f.c.compute(source.input);
  assert.deepEqual(
    JSON.parse(fixed.manifest).dropped,
    source.state.dropped,
    'both workers retain identical base proof',
  );
  await settle(f);
  assert.equal(f.runs().length, 2, 'no diagnostic checks');
});

test('an internal rejection transfers to its own cohort after the external predecessor lands', async t => {
  const f = await batchesFixture(t, {
    count: 6,
    batchMaxSize: 3,
    memberPaths: ['member-0', 'member-1', 'member-2', 'collision', 'collision', 'member-5'],
  });
  await f.drain();
  assert.equal(current(f, 4).phase, 'queued');
  assert.equal(rowOf(f, 4).orderWait, current(f, 2).id);
  await f.rawChecks.pass(await f.rawChecks.activate(f.runs()[0].id));
  await f.drain();
  assert.equal(current(f, 4).phase, 'queued');
  assert.equal(rowOf(f, 4).orderWait, current(f, 5).id);
  assert.equal(JSON.parse(rowOf(f, 4).wouldConflict).predecessor.groupId, current(f, 3).batchId);
  await settle(f, true, 3);
  assert.equal(current(f, 4).phase, 'landed');
  assert.notEqual(current(f, 3).phase, 'landed');
});
test('full cohort advisory replay is one bounded metadata transaction with no writes or idle calls', async t => {
  const f = await batchesFixture(t, { count: 8, conflict: true });
  await f.drain();
  const batch = [...f.tables.projectHostedLandingBatches.values()]
    .map(row => JSON.parse(row.value))
    .find(batch => batch.id === current(f, 1).batchId);
  const source = await f.c.progress({ request: { operationId: batch.composeOperationId } });
  const predecessor = JSON.parse(rowOf(f, 1).wouldConflict).predecessor;
  const { groupId, ...waitFor } = predecessor;
  const before = f.counts.length;
  await f.transaction(
    'replay-internal-advice-budget',
    {
      _handler: ctx =>
        speculative.deferSpeculativeConflict(
          ctx,
          { projectId: f.projectId, batchId: batch.id },
          batch,
          source.state.dropped,
          waitFor,
        ),
    },
    {},
  );
  const calls = f.counts.slice(before);
  assert.equal(calls.length, 1);
  assert(calls[0].documents <= batch.members.length + 2);
  assert.equal(calls[0].writes, 0);
  assert.equal(await f.drain(), 0);
  assert.equal(f.counts.length, before + 1);
  t.diagnostic(
    JSON.stringify({
      groupSize: batch.members.length,
      calls: calls.length,
      reads: calls[0].documents,
      writes: calls[0].writes,
    }),
  );
});
