// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { childEnv } from '../scripts/child-env.mjs';
for (const count of [3000, 29000])
  test(`pull budget at ${count} files: no-op, 10 and 1000 changes`, async t => {
    const { stdout } = await promisify(execFile)(
      process.execPath,
      ['tests/hosted-pull-scale.mjs', String(count)],
      {
        env: childEnv({ extra: { FORGE_OBJECT_CACHE: 'off' } }),
      },
    );
    const measured = JSON.parse(stdout.trim());
    assert.equal(measured.files, count);
    t.diagnostic(stdout.trim());
  });
