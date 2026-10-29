// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { durabilityFixture } from './hosted-durability-fixture.mjs';
import { snapshotAccumulator } from '../scripts/lib/hosted-durability-compare.mjs';
import { parseCommand, execute } from '../scripts/hosted-durability.mjs';
function summary(patch, options = { databaseOnly: true }) {
  const tables = durabilityFixture();
  delete tables._storage;
  patch?.(tables);
  const accumulator = snapshotAccumulator(options);
  for (const [table, rows] of Object.entries(tables)) {
    accumulator.add({ kind: 'table', table });
    rows.forEach(value => accumulator.add({ kind: 'record', table, value }));
  }
  return accumulator.finish();
}
test('database-only ZIP validation accepts R2 rows without Convex files; ordinary validation requires files', () => {
  const add = tables => {
    tables.projectObjects = [
      { _id: 'blob', storageId: 'alias', location: 'r2', r2Committed: true, r2Key: 'v1/p/project/o/hash' },
    ];
  };
  assert.equal(summary(add).files.count, 0);
  assert.throws(() => summary(add, {}), { code: 'STORAGE_INCOMPLETE' });
});
test('database-only validation refuses remaining Convex source/archive/import bytes', () => {
  for (const [table, row] of [
    ['projectObjects', { storageId: 'only-copy' }],
    ['projectBackups', { storageId: 'only-copy' }],
    ['projectProposals', { archiveReceipt: { storageId: 'only-copy' } }],
    ['imports', { artifactKey: 'only-copy' }],
  ])
    assert.throws(
      () =>
        summary(tables => {
          tables[table] = [row];
        }),
      { code: 'DATABASE_ONLY_STORAGE_REMAINS' },
    );
});
test('export and weekly backup select database-only explicitly and leave default exports inclusive', () => {
  assert.equal(
    parseCommand(['export', '--deployment', 'synthetic', '--path', 'db.zip', '--database-only'], {})
      .databaseOnly,
    true,
  );
  assert.equal(
    parseCommand(['export', '--deployment', 'synthetic', '--path', 'full.zip'], {}).databaseOnly,
    false,
  );
  const env = { R2_BUCKET: 'fake', HOSTED_DURABILITY_DATABASE_ONLY: '1' };
  assert.equal(
    parseCommand(
      ['backup', '--deployment', 'synthetic', '--prefix', 'backup/', '--state-dir', '/private/state'],
      env,
    ).databaseOnly,
    true,
  );
  assert.equal(
    parseCommand(['verify', '--left-export', 'a.zip', '--right-export', 'b.zip', '--database-only'], {})
      .databaseOnly,
    true,
  );
});
test('database export passes exclusion to the exporter and dry-run reports it without provider calls', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'hosted-db-export-'));
  try {
    const path = join(directory, 'db.zip'),
      command = { command: 'export', deployment: 'synthetic', path, databaseOnly: true };
    const dry = await execute({ ...command, dryRun: true }, () => assert.fail('no provider'));
    assert.equal(dry.includeFileStorage, false);
    const result = await execute(command, async (_, output, options) => {
      assert.equal(options.databaseOnly, true);
      await writeFile(output, 'database snapshot');
    });
    assert.equal(result.includeFileStorage, false);
    assert.equal(await readFile(path, 'utf8'), 'database snapshot');
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('database-only validation resolves R2 artifact references in either table order and refuses missing/uncommitted bindings', () => {
  for (const committed of [true, false])
    for (const bindingsFirst of [true, false]) {
      const run = () =>
        summary(tables => {
          delete tables.imports;
          delete tables.derivedArtifacts;
          delete tables.artifactBlobs;
          const bindings = () => {
            tables.artifactBlobs = [
              { _id: 'artifact', committed, removed: false, r2Key: 'v1/i/import/a/hash' },
            ];
          };
          if (bindingsFirst) bindings();
          tables.imports = [{ _id: 'import', artifactKey: 'r2blob:artifact' }];
          tables.derivedArtifacts = [{ _id: 'derived', storageId: 'r2blob:artifact', removed: false }];
          if (!bindingsFirst) bindings();
        });
      if (committed) assert.doesNotThrow(run);
      else assert.throws(run, { code: 'DATABASE_ONLY_STORAGE_REMAINS' });
    }
});
