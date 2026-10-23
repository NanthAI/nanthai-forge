// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseMaintenance, verificationReceipt, executeMaintenance } from '../scripts/r2-maintenance.mjs';
const command = { deployment: 'synthetic', projectId: 'project' };
const receipt = {
  schema: 1,
  project: JSON.stringify(['https://synthetic.convex.cloud', 'project']),
  operationId: 'original-pass',
  mode: 'verify',
  complete: true,
  kind: 4,
  failures: [],
  verificationRevision: 2,
  verifiedAt: '2026-10-01T00:00:00.000Z',
  safeToPurgeAfter: '2026-10-15T00:00:00.000Z',
};
test('maintenance defaults to dry-run and requires the R6 receipt only for purge', () => {
  assert.equal(parseMaintenance(['sweep', '--deployment', 'synthetic', '--project', 'project']).dryRun, true);
  assert.equal(
    parseMaintenance(['sweep', '--deployment', 'synthetic', '--project', 'project', '--apply']).dryRun,
    false,
  );
  assert.throws(() => parseMaintenance(['purge', '--deployment', 'synthetic', '--project', 'project']));
});
test('verification receipt binds deployment/project and requires completed zero-failure verification', () => {
  assert.equal(verificationReceipt(receipt, command).project, 'project');
  for (const patch of [
    { project: '["other","project"]' },
    { mode: 'run' },
    { complete: false },
    { kind: 3 },
    { failures: [{ code: 'missing' }] },
    { verificationRevision: undefined },
  ])
    assert.throws(() => verificationReceipt({ ...receipt, ...patch }, command));
});
test('purge command drains all four kinds, aggregates counts, and retains the verified pass pins', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'r2-maintenance-cli-'));
  try {
    const verification = join(directory, 'verify.json');
    await writeFile(verification, JSON.stringify(receipt));
    const calls = [];
    const result = await executeMaintenance(
      { ...command, operation: 'purge', dryRun: true, verification },
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
    assert.equal(calls.length, 8);
    assert.equal(result.scanned, 800);
    assert.equal(result.eligible, 16);
    assert.ok(calls.every(call => call.args.pass.operationId === receipt.operationId && call.args.dryRun));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
test('CLI failures redact secret-looking arguments and provider text', () => {
  const result = spawnSync(
    process.execPath,
    ['scripts/r2-maintenance.mjs', 'sweep', '--secret', 'SYNTHETIC_PRIVATE_SENTINEL'],
    { encoding: 'utf8' },
  );
  assert.equal(result.status, 1);
  assert.ok(!result.stderr.includes('SYNTHETIC_PRIVATE_SENTINEL'));
});
