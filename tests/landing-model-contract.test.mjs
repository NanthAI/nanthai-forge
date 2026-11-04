// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { landingModelFindings } from '../scripts/check-landing-model.mjs';
const read = path => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');
test('landing model tracks both source protocol phase sets', () => {
  assert.deepEqual(landingModelFindings(read), []);
});
for (const path of ['src/hosted-landing.ts', 'convex/projectHostedLandingBatchState.ts'])
  test(`phase drift fails the foundation guard: ${path}`, () => {
    const findings = landingModelFindings(name =>
      name === path ? read(name).replace('phase: z.enum([', "phase: z.enum(['unmodeled', ") : read(name),
    );
    assert.equal(findings.length, 1);
    assert.match(findings[0], /update landing-queue model/);
  });
