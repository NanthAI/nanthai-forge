// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';

test('offline Modal bridge reserves before spawn, retains ambiguity and executes only the fixed worker', t => {
  const result = spawnSync(
    'python3',
    ['-B', 'tests/modal-source-bridge-fixture.py', 'scripts/modal-source/bridge.py'],
    {
      encoding: 'utf8',
      env: { PATH: process.env.PATH },
    },
  );
  assert.equal(result.status, 0, result.stderr);
  const counts = JSON.parse(result.stdout);
  assert.equal(counts.spawns, 2);
  t.diagnostic(JSON.stringify(counts));
});
