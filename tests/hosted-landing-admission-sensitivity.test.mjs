// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Ferdinando Valsecchi
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
// One width per process keeps Convex fixtures for the research matrix within the test heap.
const width = process.env.FORGE_ADMISSION_REPLAY_WIDTH;
const cells = width ? fixture.cells.filter(cell => String(cell.concurrency) === width) : fixture.cells;
assert(cells.length, 'set FORGE_ADMISSION_REPLAY_WIDTH to 3, 5 or 10');
const rotations = width ? [...Array(10).keys()] : [0];
const redCounts = width ? [0, 1, 3] : [1, 3];
const measurements = new Map();
test.before(() => Object.assign(process.env, configuration));
test.after(t => {
  for (const [key, value] of Object.entries(prior))
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  if (!width) return;
  const average = (runs, key) => runs.reduce((sum, run) => sum + run[key], 0) / runs.length;
  for (const red of redCounts) {
    const full = measurements.get(`full/${red}`);
    const queue = measurements.get(`false/${red}`);
    const expected = red ? rotations.length : 1;
    assert.equal(full?.length, expected, 'every full-admission rotation must finish');
    assert.equal(queue?.length, expected, 'every queue-only rotation must finish');
    const result = {
      width: Number(width),
      redPercent: red * 10,
      rotations: expected,
      fullCiMinutes: average(full, 'ciMinutes'),
      queueCiMinutes: average(queue, 'ciMinutes'),
      fullGreenMeanMs: average(full, 'submitMeanMs'),
      queueGreenMeanMs: average(queue, 'submitMeanMs'),
    };
    const cheaper = result.fullCiMinutes < result.queueCiMinutes ? 'full' : 'queue-only';
    t.diagnostic(JSON.stringify({ ...result, cheaper }));
    assert.equal(cheaper, red === 3 ? 'full' : 'queue-only');
  }
});
// Representative red isolation guards; the research matrix rotates each culprit
// over all ten arrivals (one red and three spaced reds) outside the landing suite.
for (const cell of cells)
  for (const mode of ['full', false])
    for (const count of redCounts)
      for (const rotation of count ? rotations : [0])
        test(`red-change admission N=${cell.concurrency} mode=${mode} red=${count} rotation=${rotation}: green survivors land and every culprit is isolated`, async t => {
          const red = Array.from({ length: count }, (_, i) => (rotation + i * 3) % 10);
          const result = await replayAdmission(t, cell, { admissionCheck: mode, red });
          assert.equal(result.landed.length, 10 - count);
          assert.equal(result.isolated.length, count);
          if (width) {
            const key = `${mode}/${count}`;
            const runs = measurements.get(key) ?? [];
            runs.push({ ciMinutes: result.ciMinutes, submitMeanMs: result.submitMeanMs });
            measurements.set(key, runs);
          } else t.diagnostic(JSON.stringify({ N: cell.concurrency, mode, count, rotation, red, result }));
        });
