// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { maintenanceCli } from '../dist/maintenance-cli.js';

test('the maintenance CLI exposes dry-run, resume and verify usage without contacting a deployment', () => {
  const result = spawnSync(process.execPath, ['dist/cli.js', 'maintenance', 'r2-backfill', '--help'], {
    encoding: 'utf8',
  });
  assert.equal(result.status, 0);
  for (const text of ['--dry-run', '--resume', '--verify', '--state', 'No Convex files are deleted'])
    assert.ok(result.stdout.includes(text));
});
for (const args of [
  ['other'],
  ['r2-backfill', '--unknown'],
  ['r2-backfill', 'https://example.convex.cloud', 'synthetic', '--dry-run', '--verify'],
  ['r2-backfill', 'https://example.convex.cloud', 'synthetic', '--state'],
])
  test(`maintenance rejects invalid arguments before constructing a network client: ${args.at(-1)}`, async () => {
    await assert.rejects(maintenanceCli(args), error => error.code === 'BAD_ARGUMENT');
  });
