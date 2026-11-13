// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { synthetic } from './hosted-landing-batches-fixture.mjs';
import { replayAdmission } from './landing-admission-replay.mjs';
const fixture = JSON.parse(
  readFileSync(new URL('./fixtures/landing-admission-timelines.json', import.meta.url)),
);
const configuration = { ...synthetic, FORGE_HOSTED_CHECK_KEY_SYNTHETIC: 'synthetic-admission-sensitivity' };
const prior = Object.fromEntries(Object.keys(configuration).map(key => [key, process.env[key]]));
test.before(() => Object.assign(process.env, configuration));
test.after(() => {
  for (const [key, value] of Object.entries(prior))
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
});
// Representative red isolation guards; the research matrix rotates each culprit
// over all ten arrivals (one red and three spaced reds) outside the landing suite.
for (const cell of fixture.cells)
  for (const mode of ['full', false])
    for (const count of [1, 3])
      for (const rotation of [0])
        test(`red-change admission N=${cell.concurrency} mode=${mode} red=${count} rotation=${rotation}: green survivors land and every culprit is isolated`, async t => {
          const red = Array.from({ length: count }, (_, i) => (rotation + i * 3) % 10);
          const result = await replayAdmission(t, cell, { admissionCheck: mode, red });
          t.diagnostic(JSON.stringify({ N: cell.concurrency, mode, count, rotation, red, result }));
          assert.equal(result.landed.length, 10 - count);
          assert.equal(result.isolated.length, count);
        });
