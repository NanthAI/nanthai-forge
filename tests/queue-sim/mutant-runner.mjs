// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { synthetic } from '../hosted-landing-batches-fixture.mjs';
import { simulate } from './driver.mjs';
const environment = { ...synthetic, FORGE_HOSTED_CHECK_KEY_SYNTHETIC: 'synthetic-queue-mutant' };
const prior = Object.fromEntries(Object.keys(environment).map(k => [k, process.env[k]]));
test.before(() => Object.assign(process.env, environment));
test.after(() => {
  for (const [k, v] of Object.entries(prior)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});
test('queue mutation detector', async t => {
  const result = await simulate(t, { seed: 4, profile: 'slow-old', stopOn: 'S4' });
  if (result.violations.some(issue => issue.id === 'S4')) assert.fail('QUEUE_INVARIANT S4');
});
