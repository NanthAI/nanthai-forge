// SPDX-License-Identifier: Apache-2.0
// Child of hosted-landing-queue-sim.test.mjs: one review e7137e30 finding-4 scenario
// (FORGE_CHAIN_SCENARIO) on its pre-fix code (its CHAIN_MUTANTS entry, applied by
// FORGE_TEST_SOURCE_PATCHES). L1 must name every stranded follower; the parent asserts the
// scenario passed here by name.
import test from 'node:test';
import assert from 'node:assert/strict';
import { synthetic } from '../hosted-landing-batches-fixture.mjs';
import { scenarios, strandedL1 } from './chain-scenarios.mjs';
const environment = { ...synthetic, FORGE_HOSTED_CHECK_KEY_SYNTHETIC: 'synthetic-chain-mutant' };
const prior = Object.fromEntries(Object.keys(environment).map(k => [k, process.env[k]]));
test.before(() => Object.assign(process.env, environment));
test.after(() => {
  for (const [k, v] of Object.entries(prior)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});
const name = process.env.FORGE_CHAIN_SCENARIO;
test(`chain mutant ${name}: L1 names the stranded follower`, async t => {
  const { f, stranded } = await scenarios[name](t);
  assert.deepEqual(await strandedL1(f, stranded), [...stranded].sort());
});
