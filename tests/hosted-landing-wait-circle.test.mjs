// SPDX-License-Identifier: Apache-2.0
// Item 273650ab (found in the queue sim 2026-11-23): with checks about four times longer, passed
// entries waited on each other in a circle with nothing scheduled, freed only by the stall alarm.
// Entry 4's re-check was composed on younger entry 9's predicted head (it publishes after 9), 9 waited
// for older 7 (both change CI actions) and 7 for older 4. The drive never runs the stall alarm, so an
// entry left neither landed nor failed fails the test with what it waits for.
import test from 'node:test';
import assert from 'node:assert/strict';
import { synthetic } from './hosted-landing-batches-fixture.mjs';
import { drive } from './queue-sim/overtake-drive.mjs';
import { stream } from './queue-sim/streams.mjs';
const env = {
  ...synthetic,
  FORGE_HOSTED_CHECK_KEY_ID: 'SYNTHETIC',
  FORGE_HOSTED_CHECK_KEY_SYNTHETIC: 'synthetic-wait-circle',
};
const prior = Object.fromEntries(Object.keys(env).map(k => [k, process.env[k]]));
test.before(() => Object.assign(process.env, env));
test.after(() => {
  for (const [k, v] of Object.entries(prior)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

test('Item 273650ab: four CI changes at long check lengths never wait on each other in a circle', async t => {
  // The sim's stream-lo-1 (dogfood-like risk share) with checks four times longer.
  const shape = stream(101, 16, 40, 0.1, 'fast', 600);
  const r = await drive(t, { ownerApprovalPaths: ['scripts/deploy*'], ...shape });
  assert.equal(r.landedAt.filter(at => at !== undefined).length, 16, 'every entry lands');
  assert.equal(r.idle, 0, 'idle costs zero scheduled work');
  // Entry 4 was composed on 9's predicted head: it lands with or after 9, and 9 goes ahead of 7.
  assert(r.landedAt[3] >= r.landedAt[8] && r.landedAt[8] < r.landedAt[6], JSON.stringify(r.landedAt));
});
