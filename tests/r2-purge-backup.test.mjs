// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { earlyPurgeBackup } from '../scripts/lib/r2-purge-backup.mjs';
import { executeMaintenance, parseMaintenance } from '../scripts/r2-maintenance.mjs';
const now = Date.parse('2026-10-23T16:00:00Z');
async function fixture(t) {
  const dir = await mkdtemp(join(tmpdir(), 'early-backup-'));
  t.after(() => rm(dir, { force: true, recursive: true }));
  const receipt = {
    operation: 'backup',
    complete: true,
    operationId: 'ac6be83e-1111-4111-8111-111111111111',
    time: '2026-10-22T16:00:00.000Z',
    includeFileStorage: true,
    size: 200,
    sha256: 'a'.repeat(64),
  };
  const manifest = {
    format: 1,
    operationId: receipt.operationId,
    time: receipt.time,
    deployment: 'synthetic',
    includeFileStorage: true,
    databaseOnly: false,
    size: receipt.size,
    sha256: receipt.sha256,
    storedFiles: 10,
    identity: {},
  };
  const state = {
    target: { deployment: 'synthetic', bucket: 'fake', prefix: 'hosted-backups/dev/' },
    receipts: { [receipt.operationId]: receipt },
  };
  const save = () => writeFile(join(dir, 'last-run.json'), JSON.stringify(state));
  await save();
  const command = {
    operation: 'purge',
    deployment: 'synthetic',
    projectId: 'project',
    backupStateDirectory: dir,
    earlyOwnerApproved: 'Owner decision: current data verified',
    dryRun: true,
    verification: join(dir, 'verify.json'),
  };
  const verification = {
    schema: 1,
    project: '["synthetic","project"]',
    operationId: 'full-pass',
    mode: 'verify',
    complete: true,
    kind: 4,
    count: 10,
    digestChecks: 10,
    fullDigest: true,
    failures: [],
    verificationRevision: 2,
    verifiedAt: '2026-10-23T15:00:00Z',
    safeToPurgeAfter: '2026-11-06T15:00:00Z',
  };
  await writeFile(command.verification, JSON.stringify(verification));
  const heads = [];
  const client = {
    head: async key => {
      heads.push(key);
      return key.endsWith('snapshot.zip') ? { size: 200, sha256: 'a'.repeat(64) } : { size: 100 };
    },
    manifest: async () => manifest,
  };
  return { dir, receipt, state, manifest, save, command, client, heads, verification };
}
test('early backup reuses completed weekly state and checks the manifest and snapshot without writes', async t => {
  const x = await fixture(t);
  const result = await earlyPurgeBackup(x.command, { now, client: x.client });
  assert.equal(result.complete, true);
  assert.equal(result.includeFileStorage, true);
  assert.equal(result.operationId, x.receipt.operationId);
  assert.match(result.manifestKey, /^hosted-backups\/dev\/.+\/manifest.json$/);
  assert.equal(x.heads.length, 2);
});
for (const [label, change] of [
  [
    'no completed receipt',
    x => {
      x.state.receipts = {};
    },
  ],
  [
    'incomplete receipt',
    x => {
      x.receipt.complete = false;
    },
  ],
  [
    'database-only receipt',
    x => {
      x.receipt.includeFileStorage = false;
    },
  ],
  [
    'foreign deployment',
    x => {
      x.state.target.deployment = 'other';
    },
  ],
  [
    'old backup',
    x => {
      x.receipt.time = '2026-10-15T00:00:00Z';
    },
  ],
  [
    'future backup',
    x => {
      x.receipt.time = '2026-10-24T00:00:00Z';
    },
  ],
  [
    'missing manifest',
    x => {
      x.client.head = async () => null;
    },
  ],
  [
    'database-only manifest',
    x => {
      x.manifest.databaseOnly = true;
    },
  ],
  [
    'foreign manifest',
    x => {
      x.manifest.deployment = 'other';
    },
  ],
  [
    'mismatched digest',
    x => {
      x.manifest.sha256 = 'b'.repeat(64);
    },
  ],
  [
    'missing snapshot',
    x => {
      x.client.head = async key => (key.endsWith('snapshot.zip') ? null : { size: 100 });
    },
  ],
  [
    'snapshot mismatch',
    x => {
      x.client.head = async () => ({ size: 1 });
    },
  ],
])
  test(`early backup refuses ${label}`, async t => {
    const x = await fixture(t);
    change(x);
    await x.save();
    await assert.rejects(earlyPurgeBackup(x.command, { now, client: x.client }), {
      code: 'R2_BACKUP_REQUIRED',
    });
  });
test('legacy file-inclusive completed backup manifest and receipt remain valid', async t => {
  const x = await fixture(t);
  delete x.receipt.includeFileStorage;
  delete x.manifest.includeFileStorage;
  delete x.manifest.databaseOnly;
  await x.save();
  assert.equal((await earlyPurgeBackup(x.command, { now, client: x.client })).includeFileStorage, true);
});
test('early purge journals approval before page calls and retains it in the completed receipt', async t => {
  const x = await fixture(t),
    calls = [];
  const result = await executeMaintenance(
    x.command,
    async (_, name, args) => {
      const journal = await readFile(x.command.verification + '.purge.jsonl', 'utf8');
      assert.ok(journal.includes(x.command.earlyOwnerApproved));
      assert.equal(args.pass.early.backup.operationId, x.receipt.operationId);
      assert.equal(args.dryRun, true);
      calls.push(name);
      return { scanned: 10, eligible: 10, deleted: 0, skipped: 0, isDone: true, cursor: '' };
    },
    { now, client: x.client },
  );
  assert.equal(calls.length, 4);
  assert.equal(result.deleted, 0);
  assert.equal(result.verification.early.ownerApproval, x.command.earlyOwnerApproved);
  const journal = (await readFile(result.journal, 'utf8')).trim().split('\n').map(JSON.parse);
  assert.equal(journal[0].status, 'started');
  assert.equal(journal.at(-1).status, 'complete');
});
for (const [label, patch] of [
  ['sampled', { fullDigest: false }],
  ['failures', { failures: [{ id: 'bad', code: 'mismatch' }] }],
  ['stale', { verifiedAt: '2026-10-22T15:59:59Z' }],
  ['incomplete counts', { digestChecks: 9 }],
  ['incomplete kinds', { kind: 3 }],
])
  test(`early purge CLI refuses ${label} evidence before any storage read`, async t => {
    const x = await fixture(t);
    await writeFile(x.command.verification, JSON.stringify({ ...x.verification, ...patch }));
    await assert.rejects(
      executeMaintenance(x.command, () => assert.fail('no page call'), {
        now,
        client: { head: () => assert.fail('no storage read') },
      }),
    );
  });
test('early command flags require an approval note and the existing backup state directory together', () => {
  const args = [
    'purge',
    '--deployment',
    'synthetic',
    '--project',
    'project',
    '--verification',
    '/fake/verify.json',
  ];
  for (const tail of [
    ['--early-owner-approved', 'approved'],
    ['--backup-state-dir', '/fake/state'],
    ['--early-owner-approved', ' ', '--backup-state-dir', '/fake/state'],
  ])
    assert.throws(() => parseMaintenance([...args, ...tail]));
  const parsed = parseMaintenance([
    ...args,
    '--early-owner-approved',
    'approved',
    '--backup-state-dir',
    '/fake/state',
  ]);
  assert.equal(parsed.earlyOwnerApproved, 'approved');
  assert.equal(parsed.dryRun, true);
});
