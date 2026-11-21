// SPDX-License-Identifier: Apache-2.0
import assert from 'node:assert/strict';
import test from 'node:test';
import { getDocumentSize } from 'convex/values';
import { moduleUrl } from './convex-module.mjs';
import { state } from './hosted-fixture.mjs';

const { references } = await import(moduleUrl('../convex/projectRetention.ts'));
const { authorizedKeys, purgeAuthority } = await import(moduleUrl('../convex/projectPurgeAuthority.ts'));
const { removeExclusive } = await import(moduleUrl('../convex/projectStorage.ts'));
const { projectPrefix } = await import(moduleUrl('../convex/r2Operations.ts'));
const projectId = 'project-a';
const project = { _id: projectId, _creationTime: 1, removal: 'deleted', owner: 'first-owner' };
const foreignId = 'project-z';
const prefix = projectPrefix(projectId);

function fixture() {
  const s = state([]);
  const insert = (table, id, fields) => {
    s.tables[table].set(id, { _id: id, _creationTime: s.tables[table].size + 1, ...fields });
  };
  insert('hostedProjects', projectId, project);
  insert('hostedProjects', foreignId, { owner: 'second-owner' });
  return { ...s, insert };
}

/** Count the database documents and queries the in-process provider returned. */
function reader(ctx) {
  let documentsRead, documentBytes, databaseQueries;
  const meter = rows => {
    databaseQueries++;
    documentsRead += rows.length;
    documentBytes += rows.reduce((bytes, row) => bytes + getDocumentSize(row), 0);
  };
  const db = {
    system: { normalizeId: ctx.db.normalizeId },
    get: async id => {
      const row = await ctx.db.get(id);
      meter(row ? [row] : []);
      return row;
    },
    query: table => ({
      withIndex: (index, range) => {
        const query = ctx.db.query(table).withIndex(index, range);
        return {
          take: async n => {
            const rows = await query.take(n);
            meter(rows);
            return rows;
          },
          paginate: async opts => {
            // This one-shot fixture uses offset cursors. Mirror the provider's
            // byte cap, which can include the row that crosses the threshold.
            const result = await query.paginate(opts);
            let count = 0,
              bytes = 0;
            for (const row of result.page) {
              if (count >= opts.maximumRowsRead || bytes >= opts.maximumBytesRead) break;
              count++;
              bytes += getDocumentSize(row);
            }
            const page = result.page.slice(0, count);
            meter(page);
            return count === result.page.length
              ? result
              : { page, isDone: false, continueCursor: String(Number(opts.cursor ?? 0) + count) };
          },
        };
      },
    }),
  };
  const meta = {
    getTransactionMetrics: async () => ({
      bytesRead: { used: documentBytes },
      documentsRead: { used: documentsRead },
      databaseQueries: { used: databaseQueries },
    }),
  };
  return async args => {
    documentsRead = documentBytes = databaseQueries = 0;
    return references._handler({ ...ctx, db, meta }, { projectId, ...args });
  };
}

async function pages(read) {
  const results = [];
  let next;
  do {
    const page = await read(next ? { next } : {});
    results.push(page);
    next = page.next;
  } while (next && results.length < 30);
  assert.equal(next, null);
  return results;
}

test('operator preflight finds foreign legacy file owners behind same-project duplicates and preserves the existing cleanup skip', async t => {
  const s = fixture();
  for (let i = 0; i < 5; i++)
    s.insert('projectObjects', `same-${i}`, { projectId, storageId: 'shared-file' });
  s.insert('projectObjects', 'foreign-object', { projectId: foreignId, storageId: 'shared-file' });
  s.insert('projectObjects', 'owner-only', { projectId, storageId: 'private-file' });
  s.insert('projectObjects', 'owner-no-storage', { projectId });
  s.insert('projectBackups', 'original', {
    projectId,
    storageId: 'external-file',
    archiveReceipt: { storageId: 'archive-file' },
  });
  s.insert('projectBackups', 'other-archive', {
    projectId: foreignId,
    archiveReceipt: { storageId: 'archive-file' },
  });
  s.insert('projectProposals', 'other-selection', {
    projectId: foreignId,
    storageId: 'private-file-with-foreign-owner',
  });
  s.insert('projectProposals', 'owner-selection', {
    projectId,
    storageId: 'private-file-with-foreign-owner',
  });
  s.insert('importArtifacts', 'external', { artifactKey: 'external-file' });
  s.file('shared-file', new Blob(['synthetic file']));

  const read = reader(s.ctx);
  const result = await pages(read);
  const found = result.flatMap(page => page.references);
  assert.deepEqual(
    new Map(found.map(({ key, table }) => [key, table])),
    new Map([
      ['shared-file', 'projectObjects'],
      ['external-file', 'importArtifacts'],
      ['archive-file', 'projectBackups'],
      ['private-file-with-foreign-owner', 'projectProposals'],
    ]),
  );
  const fromForeign = await pages(args => read({ ...args, projectId: foreignId }));
  assert.ok(
    fromForeign.flatMap(page => page.references).some(ref => ref.key === 'shared-file'),
    'the foreign record can sort on either side of the selected project',
  );
  assert.ok(result.filter(page => page.section === 'objects').length > 1);
  assert.ok(
    result.some(
      page => page.section === 'fileChecks' && page.references.some(ref => ref.key === 'shared-file'),
    ),
  );
  assert.ok(result.every(page => page.databaseQueries <= 50 && page.documentBytes <= 13 * 1024 * 1024));
  assert.deepEqual(s.scheduled, []);
  assert.equal(await removeExclusive(s.ctx, 'shared-file', 'same-0'), false);
  assert.ok(s.files.has('shared-file'));
  t.diagnostic(
    JSON.stringify({
      pages: result.length,
      maxDatabaseQueries: Math.max(...result.map(page => page.databaseQueries)),
      maxDocumentBytes: Math.max(...result.map(page => page.documentBytes)),
      documentBytes: result.reduce((total, page) => total + page.documentBytes, 0),
    }),
  );
});

test('R2 prefix pages report another project’s exact key references while prefix authorization remains independent', async () => {
  const s = fixture();
  const shared = prefix + 'o/shared';
  const ownerOnly = prefix + 'o/private';
  const foreignKey = projectPrefix(foreignId) + 'o/foreign';
  const similarPrefix = projectPrefix(projectId + '0') + 'o/other';
  s.insert('projectObjects', 'own-r2', { projectId, r2Key: shared });
  s.insert('projectObjects', 'foreign-r2', { projectId: foreignId, r2Key: shared });
  s.insert('projectObjects', 'own-exclusive', { projectId, r2Key: ownerOnly });
  s.insert('projectObjects', 'other-r2', { projectId: foreignId, r2Key: similarPrefix });
  s.insert('projectBackups', 'foreign-backup', {
    projectId: foreignId,
    r2Key: prefix + 'backup',
    archiveReceipt: { r2Key: prefix + 'archive' },
  });
  s.insert('projectProposals', 'foreign-proposal', { projectId: foreignId, r2Key: prefix + 'proposal' });
  s.insert('projectUploadCleanup', 'foreign-upload', { projectId: foreignId, r2Key: prefix + 'upload' });
  s.insert('artifactBlobs', 'foreign-blob', {
    namespace: projectPrefix(foreignId) + 'archive',
    r2Key: projectPrefix(foreignId) + 'archive/a/other',
  });
  s.insert('artifactBlobs', 'own-blob', {
    namespace: prefix + 'archive',
    r2Key: prefix + 'archive/a/linked',
  });
  s.insert('imports', 'external-import', { artifactKey: 'r2blob:own-blob' });
  s.insert('imports', 'foreign-import', { artifactKey: 'r2blob:foreign-blob' });

  const result = await pages(reader(s.ctx));
  assert.deepEqual(
    result.flatMap(page => page.references),
    [
      { key: shared, table: 'projectObjects' },
      { key: prefix + 'backup', table: 'projectBackups' },
      { key: prefix + 'archive', table: 'projectBackups' },
      { key: prefix + 'proposal', table: 'projectProposals' },
      { key: prefix + 'upload', table: 'projectUploadCleanup' },
      { key: prefix + 'archive/a/linked', table: 'imports' },
    ],
  );
  const grant = purgeAuthority({
    ...project,
    removal: 'deleting',
    purge: { reason: 'owner', operationId: 'op' },
  });
  assert.deepEqual(authorizedKeys(grant, projectId, [shared]), [shared]);
  assert.throws(() => authorizedKeys(grant, projectId, [foreignKey]), { code: 'R2_PURGE_UNAUTHORIZED' });
  assert.deepEqual(s.scheduled, []);
});

test('a byte-limited R2 page resumes at a large document without calling the purge', async t => {
  const s = fixture();
  for (let i = 0; i < 3; i++)
    s.insert('projectObjects', `large-${i}`, {
      projectId: foreignId,
      r2Key: prefix + i,
      stateTree: '∑'.repeat(220_000),
    });
  const read = reader(s.ctx);
  const first = await read({ next: { section: 'objectKeys', side: 'gt', cursor: null } });
  const second = await read({ next: first.next });
  const third = await read({ next: second.next });
  assert.deepEqual(
    [first, second, third].map(page => page.references[0]?.key),
    [0, 1, 2].map(i => prefix + i),
  );
  assert.ok([first, second, third].every(page => page.documentBytes < 700_000 && page.databaseQueries === 2));
  t.diagnostic(JSON.stringify([first, second, third].map(page => page.documentBytes)));
});

test('a large-aliased file batch carries unprobed ids into the next read', async t => {
  const s = fixture();
  const keys = Array.from({ length: 8 }, (_, i) => `file-${i}`);
  for (const key of keys)
    s.insert('projectObjects', `foreign-${key}`, {
      projectId: foreignId,
      storageId: key,
      stateTree: 'x'.repeat(900_000),
    });
  for (let i = 0; i < keys.length; i += 2)
    s.insert('projectBackups', `backup-${i}`, {
      projectId,
      storageId: keys[i],
      archiveReceipt: { storageId: keys[i + 1] },
    });
  const read = reader(s.ctx);
  const first = await read({ next: { section: 'backups', cursor: null } });
  assert.equal(first.next.section, 'fileChecks');
  assert.equal(first.references.length, 5);
  const second = await read({ next: first.next });
  assert.equal(second.next.section, 'proposals');
  assert.deepEqual(
    [...first.references, ...second.references].map(ref => ref.key),
    keys,
  );
  t.diagnostic(JSON.stringify([first, second].map(page => [page.databaseQueries, page.documentBytes])));
});

test('the internal preflight rejects unknown retained projects and non-storage alias keys', async () => {
  assert.equal(references.isInternal, true);
  assert.equal(references.isPublic, undefined);
  const read = reader(fixture().ctx);
  await assert.rejects(read({ projectId: 'missing' }), { code: 'PROJECT_UNAVAILABLE' });
  await assert.rejects(
    read({ next: { section: 'fileChecks', remaining: [projectId], aliases: [], resume: null } }),
    { code: 'BAD_ARGUMENT' },
  );
});
