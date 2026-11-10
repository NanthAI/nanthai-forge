// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

test('diff and show action help works without opening an owner', () => {
  for (const action of ['diff', 'show']) {
    const result = spawnSync(
      process.execPath,
      [resolve('dist/cli.js'), 'agent', '/unavailable/owner', action, '--help'],
      { encoding: 'utf8' },
    );
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /laneId/);
    assert.match(result.stdout, action === 'show' ? /path, force\?/ : /byteBudget/);
  }
});
