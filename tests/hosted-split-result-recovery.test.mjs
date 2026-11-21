// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { synthetic } from './hosted-landing-batches-fixture.mjs';
import { splitResultIncident } from './queue-sim/split-result-incident.mjs';

const prior = Object.fromEntries(Object.keys(synthetic).map(key => [key, process.env[key]]));
test.before(() => Object.assign(process.env, synthetic));
test.after(() => {
  for (const [key, value] of Object.entries(prior)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

test('incident cd63bbe9: a failed cohort splits and the alarm repairs its dispatched recheck', async t => {
  if (process.env.FORGE_SPLIT_RESULT_MUTANT === '1') {
    await assert.rejects(splitResultIncident(t), /checking stall arms one result recovery/);
    return;
  }
  await splitResultIncident(t);
  const childEnvironment = {
    ...process.env,
    FORGE_SPLIT_RESULT_MUTANT: '1',
    FORGE_TEST_PRECOMPILED: '0',
    FORGE_TEST_SOURCE_PATCHES: JSON.stringify([
      {
        file: 'convex/projectHostedCheckReconcile.ts',
        find: '  if (reports) {',
        replace: "  if (reports) return 'none';\n  if (reports) {",
      },
    ]),
  };
  delete childEnvironment.NODE_TEST_CONTEXT;
  const { stdout } = await promisify(execFile)(
    process.execPath,
    [
      '--import',
      './tests/check-runtime.mjs',
      '--test',
      '--test-reporter=tap',
      fileURLToPath(import.meta.url),
    ],
    { env: childEnvironment },
  );
  assert.match(
    stdout,
    /^ok 1 - incident cd63bbe9: a failed cohort splits and the alarm repairs its dispatched recheck$/m,
  );
});
