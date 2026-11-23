// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Ferdinando Valsecchi
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

// Shape 2 (friction 917d1dfa): in strict mode six CI changes each stacked as a one-member group on the
// predicted-head train and passed, parked behind older plain entry 2 (sequence 2), whose own Lane pass
// was refused when main moved. Entry 2 went back to the queue needing a train slot, but the six
// passed groups waiting for it filled the pipeline width, so it never started its re-check.
test('Item 273650ab: an older entry the whole train waits for re-checks with every slot held by passed groups', async t => {
  const shape = stream(7919, 14, 30, 0.5, 'strict');
  const r = await drive(t, { ownerApprovalPaths: ['scripts/deploy*'], ...shape });
  assert.equal(r.landedAt.filter(at => at !== undefined).length, 14, 'every entry lands');
  assert.equal(r.idle, 0, 'idle costs zero scheduled work');
  // It checks on main, never stacked behind the groups that wait for it: it lands before them.
  assert(r.landedAt[1] < Math.min(...r.landedAt.slice(2, 7)), JSON.stringify(r.landedAt));
});
