// SPDX-License-Identifier: Apache-2.0
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { moduleUrl } from './convex-module.mjs';
import { benchIndexes } from '../scripts/lib/legacy-storage-bench-definition.mjs';
import { benchPage } from '../scripts/lib/legacy-storage-bench-query.mjs';
import { recordPages, purgeBench } from '../scripts/lib/legacy-storage-bench.mjs';
import { requirePreparedBodies } from '../scripts/lib/legacy-storage-reference-proof.mjs';
const scope = await import(moduleUrl('../convex/legacyStorageBenchScope.ts'));
const backend = await import(moduleUrl('../convex/projectLegacyStorageBenchCleanup.ts'));
const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const pin = row => ({
  id: row._id,
  ownerProjectId: row.projectId ?? row._id,
  bytes: Buffer.byteLength(JSON.stringify(row)),
  sha256: hash(row),
});
test('approved 58-table schema has exactly one required project owner, and parsed indexes match deployed descriptions', async () => {
  assert.equal(scope.benchTables.length, 58);
  assert.equal(
    Object.values(scope.approvedBenchCounts).reduce((a, b) => a + b, 0),
    155012,
  );
  const indexes = await benchIndexes(new URL('..', import.meta.url).pathname, scope.benchTables);
  const described = await backend.describe._handler({}, {});
  for (const d of described) {
    assert.equal(d.ownerField, d.table === 'hostedProjects' ? '_id' : 'projectId');
    assert.equal(d.index, indexes[d.table], d.table);
  }
});
test('readonly ownership pages hash exact rows, filter foreign rows during unindexed scans, and reject an active root', async () => {
  const rows = [
    { _id: 'own', projectId: 'bench', value: 'x' },
    { _id: 'foreign', projectId: 'forge', value: 'y' },
  ];
  const q = { order: () => q, paginate: async () => ({ page: rows, isDone: true, continueCursor: '' }) };
  const ctx = { db: { query: () => q, get: async () => ({ _id: 'bench', removal: 'active' }) } };
  const result = await benchPage(ctx, 'projectSourceTasks', 'bench', null, null);
  assert.deepEqual(result.rows, [pin(rows[0])]);
  assert.equal(result.scannedDocuments, 2);
  await assert.rejects(benchPage(ctx, 'hostedProjects', 'bench', null, null), /BENCH_PROJECT_NOT_DELETED/);
});
function fixture() {
  const tables = new Map([
    ['hostedProjects', new Map([['bench', { _id: 'bench', removal: 'deleted' }]])],
    [
      'projectObjects',
      new Map([
        ['own', { _id: 'own', projectId: 'bench', value: 'x' }],
        ['foreign', { _id: 'foreign', projectId: 'forge', value: 'y' }],
      ]),
    ],
    ['legacyStorageCleanupPages', new Map()],
    ['projectFinishReadRows', new Map()],
  ]);
  if (process.env.FORGE_LEGACY_STORAGE_PAUSE) {
    const configured = JSON.parse(process.env.FORGE_LEGACY_STORAGE_PAUSE);
    tables.set(
      'legacyStorageCleanupWindows',
      new Map([['window', { ...configured, _id: 'window', active: true }]]),
    );
  }
  let deletes = 0;
  const ctx = {
    db: {
      get: async id => [...tables.values()].map(m => m.get(id)).find(Boolean) ?? null,
      normalizeId: (table, id) => (tables.get(table)?.has(id) ? id : null),
      delete: async id => {
        for (const t of tables.values()) if (t.delete(id)) deletes++;
      },
      insert: async (table, row) => {
        const id = 'receipt-' + tables.get(table).size;
        tables.get(table).set(id, { ...row, _id: id });
        return id;
      },
      query: table => ({
        withIndex: (_, cb) => {
          const fields = {};
          const index = {
            eq: (k, v) => {
              fields[k] = v;
              return index;
            },
          };
          cb(index);
          return {
            unique: async () =>
              [...tables.get(table).values()].find(r =>
                Object.entries(fields).every(([k, v]) => r[k] === v),
              ) ?? null,
          };
        },
      }),
    },
  };
  const args = {
    operationId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    part: 'bench-0',
    projectId: 'bench',
    manifestSha256: 'b'.repeat(64),
    table: 'projectObjects',
    backup: {
      run: 41887010710,
      successful: true,
      includeFileStorage: true,
      checkedAt: new Date().toISOString(),
    },
    pins: [pin(tables.get('projectObjects').get('own'))],
  };
  return { ctx, tables, args, deletes: () => deletes };
}
async function withPause(work) {
  const keys = ['CONVEX_CLOUD_URL', 'FORGE_LEGACY_STORAGE_PAUSE', 'FORGE_R2_MAINTENANCE'],
    old = Object.fromEntries(keys.map(k => [k, process.env[k]]));
  const now = Date.now();
  process.env.CONVEX_CLOUD_URL = 'https://fixture.convex.cloud';
  process.env.FORGE_R2_MAINTENANCE = '1';
  process.env.FORGE_LEGACY_STORAGE_PAUSE = JSON.stringify({
    deployment: 'dev:fixture',
    operationId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    startedAt: now,
    expiresAt: now + 1800000,
  });
  try {
    await work();
  } finally {
    for (const k of keys) {
      if (old[k] === undefined) delete process.env[k];
      else process.env[k] = old[k];
    }
  }
}
test('record pages delete only exact sole-owner pins, replay after pause without repeating, and reject changed/foreign rows', async () =>
  withPause(async () => {
    const s = fixture(),
      result = await backend.deletePage._handler(s.ctx, s.args);
    assert.deepEqual(result, { deleted: 1, jsonBytes: s.args.pins[0].bytes });
    assert.equal(s.tables.get('projectObjects').has('foreign'), true);
    delete process.env.FORGE_LEGACY_STORAGE_PAUSE;
    assert.deepEqual(await backend.deletePage._handler(s.ctx, s.args), result);
    assert.equal(s.deletes(), 1);
    await assert.rejects(
      backend.deletePage._handler(s.ctx, { ...s.args, manifestSha256: 'c'.repeat(64) }),
      e => e.code === 'OPERATION_REUSED',
    );
  }));
test('the exempt bench writer removes only the approved root and its finish projection in the same transaction', async () =>
  withPause(async () => {
    const s = fixture();
    const { finishReadProjection } = await import(moduleUrl('../convex/projectFinishReadProjection.ts'));
    const root = s.tables.get('hostedProjects').get('bench');
    const projections = s.tables.get('projectFinishReadRows');
    projections.set('projection', { ...finishReadProjection('hostedProjects', root), _id: 'projection' });
    projections.set('foreign-projection', {
      _id: 'foreign-projection',
      kind: 'hostedProjects',
      sourceId: 'forge',
      value: '{}',
    });
    const args = { ...s.args, table: 'hostedProjects', pins: [pin(root)] };
    const result = await backend.deletePage._handler(s.ctx, args);
    assert.deepEqual(result, { deleted: 1, jsonBytes: args.pins[0].bytes });
    assert.equal(s.tables.get('hostedProjects').has('bench'), false);
    assert.equal(projections.has('projection'), false);
    assert.equal(projections.has('foreign-projection'), true);
    assert.equal(s.deletes(), 2); // One approved source row and its derived read model.
    delete process.env.FORGE_LEGACY_STORAGE_PAUSE;
    assert.deepEqual(await backend.deletePage._handler(s.ctx, args), result);
    assert.equal(s.deletes(), 2);
  }));
test('foreign ownership, changed bytes, active root, stale backup and mixed pages fail before deleting any row', async () =>
  withPause(async () => {
    for (const change of [
      s => s.args.pins.push(pin(s.tables.get('projectObjects').get('foreign'))),
      s => (s.tables.get('projectObjects').get('own').value = 'changed'),
      s => (s.tables.get('hostedProjects').get('bench').removal = 'active'),
      s => (s.args.backup.checkedAt = new Date(Date.now() - 360000).toISOString()),
    ]) {
      const s = fixture();
      change(s);
      await assert.rejects(backend.deletePage._handler(s.ctx, s.args));
      assert.equal(s.deletes(), 0);
    }
  }));
test('row batching is bounded by count and bytes, root is last, and missing-body preparation is scoped to approved bench only', async () => {
  const root = { id: 'bench', ownerProjectId: 'bench', bytes: 100, sha256: 'a'.repeat(64) };
  const manifest = {
    projectId: 'bench',
    tables: [
      {
        table: 'projectObjects',
        index: 'by_project',
        jsonBytes: 2002000,
        rows: Array.from({ length: 2002 }, (_, i) => ({
          id: String(i),
          ownerProjectId: 'bench',
          bytes: 1000,
          sha256: 'a'.repeat(64),
        })),
      },
      { table: 'hostedProjects', index: null, jsonBytes: 100, rows: [root] },
    ],
    sha256: 'b'.repeat(64),
  };
  const p = recordPages(manifest);
  assert.deepEqual(
    p.pages.map(p => p.pins.length),
    [1000, 1000, 2],
  );
  assert.equal(p.root.table, 'hostedProjects');
  manifest.sourceReferenceProof = {
    missingRootRefsAccounted: true,
    bodyCoverageSha256: 'proof',
    missingRoots: 1,
  };
  const missing = {
    sha256: 'proof',
    complete: false,
    failures: [{ code: 'CLOSURE_BODY_MISSING', node: { kind: 'r2', project: 'bench' } }],
  };
  assert.doesNotThrow(() => requirePreparedBodies(missing, manifest));
  assert.throws(
    () =>
      requirePreparedBodies(
        { ...missing, failures: [{ ...missing.failures[0], node: { kind: 'r2', project: 'forge' } }] },
        manifest,
      ),
    /CLEANUP_BODY_COVERAGE_REQUIRED/,
  );
  assert.throws(() => requirePreparedBodies(missing, null), /CLEANUP_BODY_COVERAGE_REQUIRED/);
  const dir = await mkdtemp(join(tmpdir(), 'forge-bench-purge-'));
  const events = [];
  try {
    const result = await purgeBench(
      manifest,
      { operationId: 'op', out: dir },
      {
        backup: async () => ({ checkedAt: new Date().toISOString() }),
        call: async (_, a) => {
          events.push(a.table);
          return { deleted: a.pins.length, jsonBytes: a.pins.reduce((n, p) => n + p.bytes, 0) };
        },
        reader: { page: async () => ({ rows: [], isDone: true }) },
      },
    );
    assert.equal(events.at(-1), 'hostedProjects');
    assert.equal(result.deletedRows, 2003);
    assert.equal(
      result.tables.every(t => t.afterRows === 0),
      true,
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('qualification rejects a missing root whose referring row is outside the approved manifest', async () => {
  const { qualifyBenchReferences } = await import('../scripts/lib/legacy-storage-bench.mjs');
  const manifest = {
    projectId: 'bench',
    sha256: 'old',
    tables: [{ table: 'projectSourceTasks', rows: [{ id: 'approved' }] }],
  };
  const scan = {
    sha256: 'scan',
    references: [],
    durableReferences: [{ table: 'projectSourceTasks', document: 'approved', project: 'bench', ref: 'root' }],
  };
  const proof = {
    sha256: 'body',
    failures: [{ code: 'CLOSURE_BODY_MISSING', node: { kind: 'r2', project: 'bench', ref: 'root' } }],
  };
  const qualified = qualifyBenchReferences(manifest, scan, proof);
  assert.equal(qualified.sourceReferenceProof.referencedRows, 1);
  assert.equal(qualified.sourceReferenceProof.missingRootRefsAccounted, true);
  assert.throws(
    () =>
      qualifyBenchReferences(
        manifest,
        { ...scan, durableReferences: [{ ...scan.durableReferences[0], document: 'unapproved' }] },
        proof,
      ),
    /CLEANUP_BENCH_REFERENCES_UNAPPROVED/,
  );
  assert.throws(
    () =>
      qualifyBenchReferences(manifest, scan, {
        ...proof,
        failures: [{ ...proof.failures[0], node: { kind: 'r2', project: 'bench', ref: 'other' } }],
      }),
    /CLEANUP_BENCH_REFERENCE_PROOF_INVALID/,
  );
});
test('failed record removal resumes both flags before return and prevents the following file stage', async () => {
  const { maintenanceWindow } = await import('../scripts/lib/legacy-storage-window.mjs');
  const dir = await mkdtemp(join(tmpdir(), 'forge-bench-unwind-')),
    flags = new Set();
  let fileStage = 0;
  const manifest = {
    projectId: 'bench',
    sha256: 'a'.repeat(64),
    tables: [
      {
        table: 'projectObjects',
        index: 'by_project',
        jsonBytes: 3,
        rows: [{ id: 'row', bytes: 3, ownerProjectId: 'bench', sha256: 'b'.repeat(64) }],
      },
      {
        table: 'hostedProjects',
        index: null,
        jsonBytes: 3,
        rows: [{ id: 'bench', bytes: 3, ownerProjectId: 'bench', sha256: 'c'.repeat(64) }],
      },
    ],
  };
  const io = {
    beginWindow: async () => ({ active: true }),
    endWindow: async () => ({ ended: true }),
    flagsAbsent: async () => flags.size === 0,
    setFlag: async n => {
      flags.add(n);
    },
    unsetFlag: async n => {
      flags.delete(n);
    },
    backup: async () => ({ checkedAt: new Date().toISOString() }),
    call: async () => {
      throw Error('synthetic row failure');
    },
  };
  const command = { out: dir, deployment: 'dev:fixture', operationId: 'op', leadGo: 'synthetic go' };
  try {
    await assert.rejects(
      maintenanceWindow(
        command,
        async () => {
          await purgeBench(manifest, command, io);
          fileStage++;
        },
        io,
      ),
      /CLEANUP_PAGE_FAILED/,
    );
    assert.equal(flags.size, 0);
    assert.equal(fileStage, 0);
    const bytePages = recordPages({
      ...manifest,
      tables: [
        {
          ...manifest.tables[0],
          rows: Array.from({ length: 3 }, (_, i) => ({
            ...manifest.tables[0].rows[0],
            id: String(i),
            bytes: 750001,
          })),
        },
        manifest.tables[1],
      ],
    });
    assert.deepEqual(
      bytePages.pages.map(p => p.pins.length),
      [2, 1],
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
