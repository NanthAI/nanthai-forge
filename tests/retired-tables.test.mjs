// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execute, parseCommand } from '../scripts/retired-tables.mjs';
import {
  RETIRED_TABLES,
  exportTables,
  inventory,
  parseRows,
  restoreTables,
  sha256,
  verifyExport,
} from '../scripts/lib/retired-tables.mjs';
import {
  APPROVAL_DECISION,
  checkApproval,
  definitionBlockers,
  eligibility,
  purgePlan,
} from '../scripts/lib/retired-tables-purge.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));
const deployedAt = new Date('2026-10-30T10:00:00Z');
// Fixed export time, before the fixtures' approval (12:00Z): with the real clock the approval
// predated the export from 2026-11-10T12:00Z on, and every purge test failed APPROVAL_INVALID.
const exportedAt = new Date('2026-11-10T11:00:00Z');

function rowsFor(table, count, size = 40) {
  return Array.from({ length: count }, (_, i) => ({
    _id: `${table}:${i}`,
    _creationTime: 1_000 + i,
    projectId: 'project',
    body: 'x'.repeat(size),
  }));
}
// In-memory deployment with the CLI surface the scripts use. Counts every call.
function fake(tables = {}) {
  const store = new Map(Object.entries(tables).map(([name, rows]) => [name, [...rows]]));
  const calls = { data: 0, imports: [] };
  return {
    store,
    calls,
    async data(table, limit) {
      calls.data++;
      return (store.get(table) ?? [])
        .slice(0, limit)
        .map(row => `${JSON.stringify(row)}\n`)
        .join('');
    },
    async importTable(table, path, mode) {
      calls.imports.push({ table, mode });
      const added = parseRows(await readFile(path, 'utf8'));
      store.set(table, mode === 'replace' ? added : [...(store.get(table) ?? []), ...added]);
    },
  };
}
const dogfoodShape = () => ({
  projectPublicationAttempts: rowsFor('projectPublicationAttempts', 11),
  projectPublications: rowsFor('projectPublications', 19, 1400),
  projectPublicationPages: [],
  projectReturnSupersessions: rowsFor('projectReturnSupersessions', 2),
  hostedProjects: [
    { _id: 'p1', exchangeCleanupDone: true },
    { _id: 'p2', exchangeCleanupDone: true },
    { _id: 'p3', work: { intentMigration: { revision: 1 } } },
  ],
  projectBackups: [{ _id: 'b1', ownerDerived: { sha256: 'a', size: 1 } }, { _id: 'b2' }],
});
async function temporary(fn) {
  const directory = await mkdtemp(join(tmpdir(), 'forge-retired-'));
  try {
    return await fn(directory);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

test('inventory counts retired rows and bytes, and reports live-field usage without touching it', async () => {
  const source = fake(dogfoodShape());
  const result = await inventory(source);
  assert.equal(result.tables.projectPublicationAttempts.rows, 11);
  assert.equal(result.tables.projectPublications.rows, 19);
  assert.ok(result.tables.projectPublications.bytes > 19 * 1400);
  assert.equal(result.tables.projectPublicationPages.rows, 0);
  const usage = Object.fromEntries(result.fields.map(f => [`${f.table}.${f.path}`, f.rows]));
  assert.equal(usage['hostedProjects.exchangeCleanupDone'], 2);
  assert.equal(usage['hostedProjects.work.intentMigration'], 1);
  assert.equal(usage['projectBackups.ownerDerived'], 1);
  assert.equal(usage['projectBackups.metadataPublication'], 0);
  // Every retired table + one read each for hostedProjects and projectBackups.
  assert.equal(source.calls.data, Object.keys(RETIRED_TABLES).length + 2);
  assert.deepEqual(source.calls.imports, []);
});

test('a full page is reported as truncated, never exported as complete', async () => {
  const source = fake({ projectPublicationAttempts: rowsFor('projectPublicationAttempts', 5) });
  await temporary(async directory => {
    await assert.rejects(
      exportTables(source, join(directory, 'out'), { deployment: 'dev-a', cap: 5 }),
      error => error.code === 'TABLE_TRUNCATED',
    );
  });
});

test('export is private, checksummed, one read per table and never overwrites', async () => {
  const source = fake(dogfoodShape());
  await temporary(async directory => {
    const out = join(directory, 'out');
    const { manifestSha256, manifest } = await exportTables(source, out, {
      deployment: 'dev-a',
      now: new Date('2026-11-01T00:00:00Z'),
    });
    assert.equal(source.calls.data, Object.keys(RETIRED_TABLES).length);
    assert.equal(manifest.tables.projectPublications.rows, 19);
    assert.equal(manifest.deploymentDigest, sha256('dev-a'));
    assert.equal((await stat(join(out, 'projectPublications.jsonl'))).mode & 0o077, 0);
    assert.equal(sha256(await readFile(join(out, 'manifest.json'), 'utf8')), manifestSha256);
    assert.equal((await verifyExport(out)).manifestSha256, manifestSha256);
    await assert.rejects(
      exportTables(source, out, { deployment: 'dev-a', now: exportedAt }),
      error => error.code === 'EEXIST',
    );
    await writeFile(join(out, 'projectReturnSupersessions.jsonl'), '{"_id":"tampered"}\n');
    await assert.rejects(verifyExport(out), error => error.code === 'EXPORT_CHECKSUM_MISMATCH');
  });
});

test('restore round trip: an export of the source rebuilds identical rows in an empty scratch deployment', async () => {
  const source = fake(dogfoodShape());
  await temporary(async directory => {
    await exportTables(source, directory + '/out', { deployment: 'dev-a', now: exportedAt });
    const scratch = fake();
    const result = await restoreTables(scratch, directory + '/out', { deployment: 'scratch-b' });
    assert.equal(result.restored.projectPublications, 19);
    assert.equal(result.restored.projectPublicationPages, 0);
    for (const table of Object.keys(RETIRED_TABLES))
      assert.deepEqual(scratch.store.get(table) ?? [], source.store.get(table) ?? [], table);
    // Empty tables are not imported: 3 populated tables, 1 import each.
    assert.equal(scratch.calls.imports.length, 3);
    assert.ok(scratch.calls.imports.every(call => call.mode === 'append'));
  });
});

test('restore refuses the source deployment, a non-empty target and a lossy import', async () => {
  const source = fake(dogfoodShape());
  await temporary(async directory => {
    const out = directory + '/out';
    await exportTables(source, out, { deployment: 'dev-a', now: exportedAt });
    await assert.rejects(
      restoreTables(fake(), out, { deployment: 'dev-a' }),
      error => error.code === 'RESTORE_TARGET_IS_SOURCE',
    );
    await assert.rejects(
      restoreTables(fake({ projectPublications: rowsFor('projectPublications', 1) }), out, {
        deployment: 'scratch-b',
      }),
      error => error.code === 'RESTORE_TARGET_NOT_EMPTY',
    );
    const lossy = fake();
    const original = lossy.importTable.bind(lossy);
    lossy.importTable = async (table, path, mode) => {
      await original(table, path, mode);
      lossy.store.set(table, lossy.store.get(table).slice(1));
    };
    await assert.rejects(
      restoreTables(lossy, out, { deployment: 'scratch-b' }),
      error => error.code === 'RESTORE_MISMATCH',
    );
  });
});

test('purge dry run reports tables, calls and I/O, measures the call budget and deletes nothing', async () => {
  const source = fake(dogfoodShape());
  await temporary(async directory => {
    const out = directory + '/out';
    await exportTables(source, out, { deployment: 'dev-a', now: exportedAt });
    source.calls.data = 0;
    // A row created after the export must be flagged, not silently covered.
    source.store.get('projectPublicationAttempts').push({ _id: 'late', _creationTime: 9_999 });
    const plan = await purgePlan(source, out, { deployedAt });
    assert.equal(source.calls.data, Object.keys(RETIRED_TABLES).length);
    assert.equal(plan.totals.rows, 11 + 1 + 19 + 2);
    assert.equal(plan.tables.projectPublicationAttempts.unexportedRows, 1);
    assert.equal(plan.tables.projectPublications.unexportedRows, 0);
    assert.equal(plan.cost.userFunctionCalls, 0);
    assert.equal(plan.cost.cliRequests, Object.keys(RETIRED_TABLES).length + 3 * 2);
    assert.equal(plan.cost.documentsDeleted, plan.totals.rows);
    assert.equal(plan.cost.indexEntriesDeleted, 12 * 3 + 19 * 3 + 2 * 2);
    assert.equal(plan.cost.basis, 'estimate');
    assert.equal(plan.eligibility.known, true);
    assert.deepEqual(source.calls.imports, []);
  });
});

function approvalFor(plan, patch = {}) {
  return {
    decision: APPROVAL_DECISION,
    approvedBy: 'owner',
    approvedAt: '2026-11-10T12:00:00Z',
    deploymentDigest: plan.deploymentDigest,
    manifestSha256: plan.manifestSha256,
    tables: Object.keys(RETIRED_TABLES),
    backupFixClosed: true,
    alertReceived: true,
    verifiedBackup: {
      id: 'verified',
      completedAt: '2026-11-04T18:35:17Z',
      r2Bytes: 1000,
      sha256: 'a'.repeat(64),
    },
    ...patch,
  };
}

test('purge --execute is refused without a matching approval record, then executes and reconciles the same operation', async () => {
  const source = fake(dogfoodShape());
  await temporary(async directory => {
    const out = directory + '/out';
    await exportTables(source, out, { deployment: 'dev-a', now: exportedAt });
    const plan = await purgePlan(source, out, { deployedAt });
    const now = new Date('2026-11-10T13:00:00Z');
    const check = patch => () => checkApproval(approvalFor(plan, patch), plan, { deployedAt, now });
    check({})();
    const rejects = (patch, code) =>
      assert.throws(check(patch), error => error.code === code, JSON.stringify(Object.keys(patch)));
    rejects({ decision: 'maybe' }, 'APPROVAL_INVALID');
    rejects({ approvedBy: '' }, 'APPROVAL_INVALID');
    rejects({ approvedAt: '2099-01-01T00:00:00Z' }, 'APPROVAL_INVALID');
    rejects({ manifestSha256: 'f'.repeat(64) }, 'APPROVAL_MISMATCH');
    rejects({ deploymentDigest: sha256('other') }, 'APPROVAL_MISMATCH');
    rejects({ tables: ['projectPublications'] }, 'APPROVAL_MISMATCH');
    rejects({ verifiedBackup: null }, 'APPROVAL_BACKUPS_INSUFFICIENT');
    rejects({ alertReceived: false }, 'APPROVAL_BACKUPS_INSUFFICIENT');
    rejects({ backupFixClosed: false }, 'APPROVAL_BACKUPS_INSUFFICIENT');
    assert.throws(
      () => checkApproval(approvalFor(plan), plan, { deployedAt: undefined, now }),
      error => error.code === 'DEPLOY_TIME_REQUIRED',
    );

    const file = join(directory, 'approval.json');
    await writeFile(file, JSON.stringify(approvalFor(plan)));
    const before = JSON.stringify([...source.store]);
    const command = {
      command: 'purge',
      deployment: 'dev-a',
      operationId: '16ec05bd-25e1-4bd5-8a01-9bae82b0da38',
      directory: out,
      deployedAt,
      execute: true,
      approval: file,
    };
    await assert.rejects(
      execute({ ...command, now: new Date('2026-11-01T00:00:00Z') }, source),
      error => error.code === 'APPROVAL_INVALID',
    );
    source.calls.data = 0;
    const result = await execute({ ...command, now }, source);
    assert.deepEqual(result.after, { rows: 0, bytes: 0 });
    assert.equal(source.calls.data, Object.keys(RETIRED_TABLES).length + 3); // Plan reads, then one verification read per populated table.
    assert.equal(source.calls.imports.length, 3);
    assert.deepEqual((await execute({ ...command, now }, source)).after, result.after);
    assert.equal(source.calls.imports.length, 3); // A replay adds no writes.

    await writeFile(file, '{');
    await assert.rejects(execute({ ...command, now }, source), error => error.code === 'APPROVAL_INVALID');
    assert.notEqual(JSON.stringify([...source.store]), before);
  });
});

test('dropped tables exported to private storage are approved by the named lead decision and Issue; backup-gated tables still need the B1.9 backup proof', async () => {
  const overlap = () => ({
    projectHostedOverlapAcks: rowsFor('projectHostedOverlapAcks', 3),
    projectHostedAckBatches: rowsFor('projectHostedAckBatches', 2),
    projectHostedOverlapDeliveries: rowsFor('projectHostedOverlapDeliveries', 4),
  });
  const now = new Date('2026-11-10T13:00:00Z');
  await temporary(async directory => {
    const source = fake(overlap());
    await exportTables(source, directory + '/out', { deployment: 'dev-a', now: exportedAt });
    const plan = await purgePlan(source, directory + '/out', {});
    const lead = patch => ({
      ...approvalFor(plan, { backupFixClosed: false, alertReceived: false, verifiedBackup: null }),
      approvedBy: 'lead',
      leadDecision: 'standing cleanup rule: dropped tables, exported, dev only',
      issue: '853fcde3-3c8a-47e0-ac75-5e9b9be7e5d2',
      ...patch,
    });
    assert.doesNotThrow(() => checkApproval(lead({}), plan, { now }));
    for (const patch of [{ leadDecision: '' }, { issue: undefined }])
      assert.throws(() => checkApproval(lead(patch), plan, { now }), { code: 'APPROVAL_INVALID' });
    assert.throws(() => checkApproval(lead({ manifestSha256: 'f'.repeat(64) }), plan, { now }), {
      code: 'APPROVAL_MISMATCH',
    });
  });
  await temporary(async directory => {
    const source = fake({ ...overlap(), projectPublications: rowsFor('projectPublications', 1) });
    await exportTables(source, directory + '/out', { deployment: 'dev-a', now: exportedAt });
    const plan = await purgePlan(source, directory + '/out', { deployedAt });
    const withoutBackup = {
      ...approvalFor(plan, { verifiedBackup: null }),
      leadDecision: 'standing cleanup rule',
      issue: '853fcde3-3c8a-47e0-ac75-5e9b9be7e5d2',
    };
    assert.throws(() => checkApproval(withoutBackup, plan, { deployedAt, now }), {
      code: 'APPROVAL_BACKUPS_INSUFFICIENT',
    });
  });
});

test('purge rejects changed rows, wrong deployment and changed replay inputs before writes', async () => {
  await temporary(async directory => {
    const source = fake(dogfoodShape()),
      out = join(directory, 'export');
    await exportTables(source, out, { deployment: 'dev-a', now: exportedAt });
    const plan = await purgePlan(source, out, { deployedAt });
    const approval = join(directory, 'approval.json');
    await writeFile(approval, JSON.stringify(approvalFor(plan)));
    const command = {
      command: 'purge',
      directory: out,
      deployment: 'dev-a',
      deployedAt,
      execute: true,
      approval,
      operationId: '21bcc0e4-d507-490f-8dc6-6fc063befc46',
      now: new Date('2026-11-10T13:00:00Z'),
    };
    await assert.rejects(execute({ ...command, deployment: 'other' }, source), { code: 'APPROVAL_MISMATCH' });
    source.store.get('projectPublications')[0].body = 'changed same ID';
    await assert.rejects(execute(command, source), { code: 'PURGE_INVENTORY_CHANGED' });
    assert.equal(source.calls.imports.length, 0);
  });
});

test('unknown replacement outcome replays the same operation without repeating that deletion', async () => {
  await temporary(async directory => {
    const source = fake(dogfoodShape()),
      out = join(directory, 'export');
    await exportTables(source, out, { deployment: 'dev-a', now: exportedAt });
    const plan = await purgePlan(source, out, { deployedAt });
    const approval = join(directory, 'approval.json');
    await writeFile(approval, JSON.stringify(approvalFor(plan)));
    const command = {
      command: 'purge',
      directory: out,
      deployment: 'dev-a',
      deployedAt,
      execute: true,
      approval,
      operationId: '94597fd3-e338-46e7-90c1-d2b3ebf4609e',
      now: new Date('2026-11-10T13:00:00Z'),
    };
    const original = source.importTable;
    let lost = true;
    source.importTable = async (...args) => {
      await original(...args);
      if (lost) {
        lost = false;
        throw Object.assign(new Error('lost'), { code: 'CONVEX_CLI_FAILED' });
      }
    };
    await assert.rejects(execute(command, source), { code: 'CONVEX_CLI_FAILED' });
    assert.deepEqual((await execute(command, source)).after, { rows: 0, bytes: 0 });
    assert.equal(source.calls.imports.length, 3);
    await writeFile(approval, JSON.stringify(approvalFor(plan, { approvedBy: 'another' })));
    await assert.rejects(execute(command, source), { code: 'PURGE_OPERATION_CHANGED' });
    assert.equal(source.calls.imports.length, 3);
  });
});

test('concurrent identical purge requests serialize before reading live data', async () => {
  await temporary(async directory => {
    const source = fake(dogfoodShape()),
      out = join(directory, 'export');
    await exportTables(source, out, { deployment: 'dev-a', now: exportedAt });
    const plan = await purgePlan(source, out, { deployedAt });
    const approval = join(directory, 'approval.json');
    await writeFile(approval, JSON.stringify(approvalFor(plan)));
    const command = {
      command: 'purge',
      directory: out,
      deployment: 'dev-a',
      deployedAt,
      execute: true,
      approval,
      operationId: 'b2fc6400-2d68-4f34-8969-4b963f5a8f0e',
      now: new Date('2026-11-10T13:00:00Z'),
    };
    const [a, b] = await Promise.all([execute(command, source), execute(command, source)]);
    assert.deepEqual(a.after, b.after);
    assert.equal(source.calls.imports.length, 3);
  });
});

test('definition blockers name live code that still reads retired tables (schema stays untouched)', async () => {
  const blockers = await definitionBlockers(root);
  assert.deepEqual(Object.keys(blockers), Object.keys(RETIRED_TABLES));
  for (const files of Object.values(blockers)) assert.ok(files.every(file => !file.endsWith('schema.ts')));
  assert.ok(blockers.projectReturnSupersessions.includes('convex/projectRecoveryHosted.ts'));
  // Definitions must stay until the purge: schema push and Route A restores of older backups need them.
  const schema = [
    await readFile(join(root, 'convex/schema.ts'), 'utf8'),
    await readFile(join(root, 'convex/ownerAcceptanceFields.ts'), 'utf8'),
    await readFile(join(root, 'convex/projectPublicationFields.ts'), 'utf8'),
  ].join('\n');
  for (const [table, { gate }] of Object.entries(RETIRED_TABLES))
    if (gate !== 'exported') assert.match(schema, new RegExp(`\\b${table}: defineTable`));
});

test('command parsing refuses unsafe combinations', () => {
  const ok = ['purge', '--deployment', 'dev-a', '--dir', '/tmp/x', '--deployed-at', '2026-10-30T10:00:00Z'];
  assert.equal(parseCommand(ok).execute, false);
  const refused = (args, code) =>
    assert.throws(
      () => parseCommand(args),
      error => error.code === code,
      args.join(' '),
    );
  refused([...ok, '--execute'], 'APPROVAL_REQUIRED');
  refused([...ok, '--approval', '/tmp/a.json'], 'ARGUMENT_INVALID');
  refused(['purge', '--deployment', 'dev-a', '--dir', '/tmp/x'], 'ARGUMENT_INVALID');
  refused(
    ['export', '--deployment', 'dev-a', '--dir', '/tmp/x', '--execute', '--approval', 'a'],
    'ARGUMENT_INVALID',
  );
  refused(['export', '--deployment', 'Not A Name', '--dir', '/tmp/x'], 'ARGUMENT_INVALID');
  refused(['restore', '--deployment', 'dev-a'], 'ARGUMENT_INVALID');
  refused(['nuke', '--deployment', 'dev-a'], 'ARGUMENT_INVALID');
});

test('the command line help runs without a deployment', () => {
  const result = spawnSync(process.execPath, [join(root, 'scripts/retired-tables.mjs'), '--help'], {
    encoding: 'utf8',
  });
  assert.equal(result.status, 0);
  assert.match(result.stdout, /dry run unless --execute/);
});
