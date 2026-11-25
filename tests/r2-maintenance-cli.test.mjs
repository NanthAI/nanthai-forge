// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Ferdinando Valsecchi
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { parseMaintenance, executeMaintenance } from '../scripts/r2-maintenance.mjs';
const command = { deployment: 'synthetic', projectId: 'project' };
test('maintenance defaults to dry-run and only sweeps', () => {
  assert.equal(parseMaintenance(['sweep', '--deployment', 'synthetic', '--project', 'project']).dryRun, true);
  assert.equal(
    parseMaintenance(['sweep', '--deployment', 'synthetic', '--project', 'project', '--apply']).dryRun,
    false,
  );
  assert.throws(() => parseMaintenance(['purge', '--deployment', 'synthetic', '--project', 'project']));
});
test('the sweep command pages to the end and aggregates counts', async () => {
  const calls = [];
  const result = await executeMaintenance(
    { ...command, operation: 'sweep', dryRun: true },
    async (_, name, args) => {
      calls.push({ name, args });
      return {
        scanned: 100,
        eligible: 2,
        deleted: 0,
        skipped: 0,
        isDone: args.cursor !== null,
        cursor: 'next',
      };
    },
  );
  assert.equal(calls.length, 2);
  assert.equal(result.scanned, 200);
  assert.equal(result.eligible, 4);
  assert.ok(calls.every(call => call.name === 'projectR2Maintenance:sweepPage' && call.args.dryRun));
});
test('CLI failures redact secret-looking arguments and provider text', () => {
  const result = spawnSync(
    process.execPath,
    ['scripts/r2-maintenance.mjs', 'sweep', '--secret', 'SYNTHETIC_PRIVATE_SENTINEL'],
    { encoding: 'utf8' },
  );
  assert.equal(result.status, 1);
  assert.equal(result.stdout, '');
  assert.deepEqual(JSON.parse(result.stderr), {
    error: { code: 'ARGUMENT_INVALID', message: 'Check the maintenance command and its arguments.' },
  });
});
