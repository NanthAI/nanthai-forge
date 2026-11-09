// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { childEnv } from '../scripts/child-env.mjs';
// --expose-gc: the scale script gates on live memory over an in-run baseline after a full GC, not RSS.
const run = (count, ...extra) =>
  promisify(execFile)(
    process.execPath,
    ['--expose-gc', 'tests/hosted-pull-scale.mjs', String(count), ...extra],
    {
      env: childEnv({ extra: { FORGE_OBJECT_CACHE: 'off' } }),
    },
  );
for (const count of [3000, 29000])
  test(`pull budget at ${count} files: no-op, 10 and 1000 changes`, async t => {
    const { stdout } = await run(count);
    const measured = JSON.parse(stdout.trim());
    assert.equal(measured.files, count);
    t.diagnostic(stdout.trim());
  });

test('pull budget fails when pull retains about twice the clean peak memory', async () => {
  await assert.rejects(run(3000, 'plant'), error => /peak live memory \+[\d.]+ MiB over/.test(error.stderr));
});
