// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Ferdinando Valsecchi
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
  assert.equal(result.stdout, '');
  assert.deepEqual(JSON.parse(result.stderr), {
    error: { code: 'ARGUMENT_INVALID', message: 'Check the maintenance command and its arguments.' },
  });
});
test('early purge CLI distinguishes missing backup evidence from an invalid verification receipt', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'r2-maintenance-cli-'));
  try {
    const verification = join(directory, 'verify.json');
    const now = Date.parse(receipt.verifiedAt) + 3_600_000;
    const clock = 'data:text/javascript,' + encodeURIComponent(`Date.now = () => ${now};`);
    const run = () =>
      spawnSync(
        process.execPath,
        [
          '--import',
          clock,
          'scripts/r2-maintenance.mjs',
          'purge',
          '--deployment',
          command.deployment,
          '--project',
          command.projectId,
          '--verification',
          verification,
          '--backup-state-dir',
          directory,
          '--early-owner-approved',
          'SYNTHETIC_PRIVATE_SENTINEL',
        ],
        { encoding: 'utf8' },
      );
    await writeFile(verification, 'SYNTHETIC_PRIVATE_SENTINEL');
    const invalid = run();
    assert.equal(invalid.status, 1);
    assert.deepEqual(JSON.parse(invalid.stderr), {
      error: {
        code: 'R2_VERIFIED_PASS_REQUIRED',
        message: 'Use a completed, zero-failure verification receipt for the selected project.',
      },
    });
    await writeFile(
      verification,
      JSON.stringify({ ...receipt, fullDigest: true, count: 1, digestChecks: 1 }),
    );
    const missing = run();
    assert.equal(missing.status, 1);
    assert.equal(missing.stdout, '');
    assert.deepEqual(JSON.parse(missing.stderr), {
      error: {
        code: 'R2_BACKUP_REQUIRED',
        message:
          'Check backup storage credentials and the completed file-inclusive backup receipt and manifest.',
      },
    });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
