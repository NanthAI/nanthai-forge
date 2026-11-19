// SPDX-License-Identifier: Apache-2.0
// Child of hosted-landing-queue-sim.test.mjs: the 5e3c3a3c parked incident on the historical
// no-new-run-wake mutant (pre-N1 code, applied by FORGE_TEST_SOURCE_PATCHES). The read-only
// detector must expose the stale chain without repairing it.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { synthetic } from '../hosted-landing-batches-fixture.mjs';
import { parkedIncident } from './parked-incident.mjs';
import { inspectQueue, requestRows } from './invariants.mjs';
const environment = { ...synthetic, FORGE_HOSTED_CHECK_KEY_SYNTHETIC: 'synthetic-queue-mutant' };
const prior = Object.fromEntries(Object.keys(environment).map(k => [k, process.env[k]]));
test.before(() => Object.assign(process.env, environment));
test.after(() => {
  for (const [k, v] of Object.entries(prior)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});
const known = JSON.parse(readFileSync(new URL('./known-violations.json', import.meta.url))).violations;
const snapshot = f =>
  JSON.stringify(
    Object.fromEntries(Object.entries(f.tables).map(([name, rows]) => [name, [...rows.values()]])),
  );
test('pre-N1 parked incident: the detector exposes the stale chain', async t => {
  const { f, followers } = await parkedIncident(t);
  const before = snapshot(f);
  const issues = await inspectQueue(f);
  assert.equal(snapshot(f), before, 'the detector cannot repair its counterexample');
  for (const id of ['L1', 'L2']) {
    if (known[id])
      assert(
        issues.some(issue => issue.id === id && followers.includes(issue.submission)),
        `retained incident demonstrates ${id}`,
      );
    else assert(!issues.some(issue => issue.id === id), `${id} must remain fixed`);
  }
  assert(
    requestRows(f).some(row => row.orderWait),
    'exercise real persisted wait edges',
  );
});
