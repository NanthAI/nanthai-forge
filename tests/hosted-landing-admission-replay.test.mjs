// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { synthetic } from './hosted-landing-batches-fixture.mjs';
import { replayAdmission } from './landing-admission-replay.mjs';
const fixture = JSON.parse(
  readFileSync(new URL('./fixtures/landing-admission-timelines.json', import.meta.url)),
);
const configuration = { ...synthetic, FORGE_HOSTED_CHECK_KEY_SYNTHETIC: 'synthetic-admission-replay' };
const prior = Object.fromEntries(Object.keys(configuration).map(key => [key, process.env[key]]));
test.before(() => Object.assign(process.env, configuration));
test.after(() => {
  for (const [key, value] of Object.entries(prior))
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
});
for (const cell of fixture.cells)
  for (const mode of ['full', false])
    test(`admission replay N=${cell.concurrency} mode=${mode}: all clean source lands with owned audit completion`, async t => {
      const result = await replayAdmission(t, cell, { admissionCheck: mode });
      t.diagnostic(JSON.stringify({ N: cell.concurrency, mode, result }));
      assert.equal(result.landed.length, 10);
    });
