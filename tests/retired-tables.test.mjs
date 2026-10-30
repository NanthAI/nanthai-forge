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
  weeklyBackupRuns,
} from '../scripts/lib/retired-tables-purge.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));
const deployedAt = new Date('2026-10-30T10:00:00Z');

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
  ownerAcceptanceMachines: rowsFor('ownerAcceptanceMachines', 11),
  ownerAcceptanceRequests: rowsFor('ownerAcceptanceRequests', 19, 1400),
  projectPublicationAttempts: [],
  projectPublications: [],
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
  assert.equal(result.tables.ownerAcceptanceMachines.rows, 11);
  assert.equal(result.tables.ownerAcceptanceRequests.rows, 19);
  assert.ok(result.tables.ownerAcceptanceRequests.bytes > 19 * 1400);
  assert.equal(result.tables.projectPublications.rows, 0);
  const usage = Object.fromEntries(result.fields.map(f => [`${f.table}.${f.path}`, f.rows]));
  assert.equal(usage['hostedProjects.exchangeCleanupDone'], 2);
  assert.equal(usage['hostedProjects.work.intentMigration'], 1);
  assert.equal(usage['projectBackups.ownerDerived'], 1);
  assert.equal(usage['projectBackups.metadataPublication'], 0);
  // 6 retired tables + one read each for hostedProjects and projectBackups.
  assert.equal(source.calls.data, 8);
  assert.deepEqual(source.calls.imports, []);
});

test('a full page is reported as truncated, never exported as complete', async () => {
  const source = fake({ ownerAcceptanceMachines: rowsFor('ownerAcceptanceMachines', 5) });
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
    assert.equal(manifest.tables.ownerAcceptanceRequests.rows, 19);
    assert.equal(manifest.deploymentDigest, sha256('dev-a'));
    assert.equal((await stat(join(out, 'ownerAcceptanceRequests.jsonl'))).mode & 0o077, 0);
    assert.equal(sha256(await readFile(join(out, 'manifest.json'), 'utf8')), manifestSha256);
    assert.equal((await verifyExport(out)).manifestSha256, manifestSha256);
    await assert.rejects(
      exportTables(source, out, { deployment: 'dev-a' }),
      error => error.code === 'EEXIST',
    );
    await writeFile(join(out, 'projectReturnSupersessions.jsonl'), '{"_id":"tampered"}\n');
    await assert.rejects(verifyExport(out), error => error.code === 'EXPORT_CHECKSUM_MISMATCH');
  });
});

test('restore round trip: an export of the source rebuilds identical rows in an empty scratch deployment', async () => {
  const source = fake(dogfoodShape());
  await temporary(async directory => {
    await exportTables(source, directory + '/out', { deployment: 'dev-a' });
    const scratch = fake();
    const result = await restoreTables(scratch, directory + '/out', { deployment: 'scratch-b' });
    assert.equal(result.restored.ownerAcceptanceRequests, 19);
    assert.equal(result.restored.projectPublications, 0);
    for (const table of Object.keys(RETIRED_TABLES))
      assert.deepEqual(scratch.store.get(table) ?? [], source.store.get(table), table);
    // Empty tables are not imported: 3 populated tables, 1 import each.
    assert.equal(scratch.calls.imports.length, 3);
    assert.ok(scratch.calls.imports.every(call => call.mode === 'append'));
  });
});

test('restore refuses the source deployment, a non-empty target and a lossy import', async () => {
  const source = fake(dogfoodShape());
  await temporary(async directory => {
    const out = directory + '/out';
    await exportTables(source, out, { deployment: 'dev-a' });
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

test('weekly backup windows follow cron 0 3 * * 1 UTC', () => {
  assert.deepEqual(weeklyBackupRuns(deployedAt), ['2026-11-02T03:00:00.000Z', '2026-11-09T03:00:00.000Z']);
  // Exactly at a run time that run does not count: the data it saw predates the deploy.
  assert.deepEqual(weeklyBackupRuns(new Date('2026-11-02T03:00:00Z')), [
    '2026-11-09T03:00:00.000Z',
    '2026-11-16T03:00:00.000Z',
  ]);
  assert.equal(eligibility(deployedAt).eligibleAfter, '2026-11-09T03:00:00.000Z');
  assert.equal(eligibility(undefined).known, false);
});

test('purge dry run reports tables, calls and I/O, measures the call budget and deletes nothing', async () => {
  const source = fake(dogfoodShape());
  await temporary(async directory => {
    const out = directory + '/out';
    await exportTables(source, out, { deployment: 'dev-a' });
    source.calls.data = 0;
    // A row created after the export must be flagged, not silently covered.
    source.store.get('ownerAcceptanceMachines').push({ _id: 'late', _creationTime: 9_999 });
    const plan = await purgePlan(source, out, { deployedAt });
    assert.equal(source.calls.data, Object.keys(RETIRED_TABLES).length);
    assert.equal(plan.totals.rows, 11 + 1 + 19 + 2);
    assert.equal(plan.tables.ownerAcceptanceMachines.unexportedRows, 1);
    assert.equal(plan.tables.ownerAcceptanceRequests.unexportedRows, 0);
    assert.equal(plan.cost.userFunctionCalls, 0);
    assert.equal(plan.cost.cliRequests, 6 + 3 * 2);
    assert.equal(plan.cost.documentsDeleted, plan.totals.rows);
    assert.equal(plan.cost.indexEntriesDeleted, 12 * 2 + 19 * 4 + 2 * 2);
    assert.equal(plan.cost.basis, 'estimate');
    assert.equal(plan.eligibility.eligibleAfter, '2026-11-09T03:00:00.000Z');
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
    coveringBackups: [
      { id: 'backup-1', completedAt: '2026-11-02T03:40:00Z' },
      { id: 'backup-2', completedAt: '2026-11-09T03:40:00Z' },
    ],
    ...patch,
  };
}

test('purge --execute is refused without a matching approval record, then still not enabled', async () => {
  const source = fake(dogfoodShape());
  await temporary(async directory => {
    const out = directory + '/out';
    await exportTables(source, out, { deployment: 'dev-a' });
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
    rejects({ coveringBackups: [] }, 'APPROVAL_BACKUPS_INSUFFICIENT');
    // Both backups in the same week, or one that predates the deploy, do not count.
    rejects(
      {
        coveringBackups: [
          { id: 'a', completedAt: '2026-11-09T03:40:00Z' },
          { id: 'b', completedAt: '2026-11-09T04:00:00Z' },
        ],
      },
      'APPROVAL_BACKUPS_INSUFFICIENT',
    );
    rejects(
      {
        coveringBackups: [
          { id: 'a', completedAt: '2026-10-26T03:40:00Z' },
          { id: 'b', completedAt: '2026-11-09T03:40:00Z' },
        ],
      },
      'APPROVAL_BACKUPS_INSUFFICIENT',
    );
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
      directory: out,
      deployedAt,
      execute: true,
      approval: file,
    };
    await assert.rejects(
      execute({ ...command, now: new Date('2026-11-01T00:00:00Z') }, source),
      error => error.code === 'APPROVAL_INVALID',
    );
    await assert.rejects(execute({ ...command, now }, source), error => error.code === 'PURGE_NOT_ENABLED');
    await writeFile(file, '{');
    await assert.rejects(execute({ ...command, now }, source), error => error.code === 'APPROVAL_INVALID');
    assert.deepEqual(source.calls.imports, []);
    assert.equal(JSON.stringify([...source.store]), before);
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
  for (const table of Object.keys(RETIRED_TABLES))
    assert.match(schema, new RegExp(`\\b${table}: defineTable`));
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
  assert.match(result.stdout, /nothing here deletes data/);
});
