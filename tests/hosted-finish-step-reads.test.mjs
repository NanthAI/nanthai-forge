// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Ferdinando Valsecchi
// Item 411727ba, review of the settle read cut: finishStep loads its landing once and hands that state to
// batchFinishStep, so a finish wake that is not a pre-queue compose no longer reads the landing row twice.
import test from 'node:test';
import assert from 'node:assert/strict';
import { batchesFixture, states, synthetic } from './hosted-landing-batches-fixture.mjs';

const prior = Object.fromEntries(Object.keys(synthetic).map(k => [k, process.env[k]]));
test.before(() => Object.assign(process.env, synthetic));
test.after(() => {
  for (const [k, v] of Object.entries(prior)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

test('a landing wake reads its landing row once in finishStep and its cohort step, then lands unchanged', async t => {
  const f = await batchesFixture(t, { count: 1, batching: false });
  for (let tick = 0; tick < 400 && states(f)[0].phase !== 'landed'; tick++) {
    for (const run of f.runs().filter(run => run.status === 'queued'))
      await f.rawChecks.pass(await f.rawChecks.activate(run.id));
    const task = f.pending()[0];
    if (task) await f.execute(task);
  }
  assert.equal(states(f)[0].phase, 'landed');
  const landingReads = name =>
    f.counts
      .filter(row => row.name === name)
      .map(row => row.readDocumentsByTable.projectHostedLandingRequests);
  // Base reads: the first settle 2, the cohort step 3 (one landing load duplicated inside batchFinishStep).
  assert.equal(landingReads('finishSettle')[0], 1, 'the first settle loads its landing once');
  for (const reads of landingReads('batch-step'))
    assert.equal(reads, 2, 'a cohort step loads its landing once');
});
