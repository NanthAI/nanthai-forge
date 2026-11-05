// SPDX-License-Identifier: Apache-2.0
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { moduleUrl } from './convex-module.mjs';
import { maintenanceWindow } from '../scripts/legacy-storage-cleanup.mjs';
import { boundedPages, deletionPlan } from '../scripts/lib/legacy-storage-cleanup.mjs';
const pause = await import(moduleUrl('../convex/legacyStoragePause.ts'));
const server = await import(moduleUrl('../convex/server.ts'));
function enable() {
  const now = Date.now();
  process.env.CONVEX_CLOUD_URL = 'https://fixture.convex.cloud';
  process.env.FORGE_LEGACY_STORAGE_PAUSE = JSON.stringify({
    deployment: 'dev:fixture',
    operationId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    startedAt: now,
    expiresAt: now + 1800000,
  });
}
test('absent pause preserves synchronous returns, exact throws and promise identity without context or DB access', async () => {
  const previous = process.env.FORGE_LEGACY_STORAGE_PAUSE;
  let accesses = 0;
  const ctx = new Proxy(
    {},
    {
      get(_target, key) {
        accesses++;
        assert.fail(`unflagged wrapper accessed context.${String(key)}`);
      },
    },
  );
  try {
    delete process.env.FORGE_LEGACY_STORAGE_PAUSE;
    for (const builder of [server.mutation, server.internalMutation]) {
      for (const objectForm of [false, true]) {
        const register = handler => builder(objectForm ? { args: {}, handler } : handler);
        const args = {};
        const value = {};
        const events = [];
        const sync = register((_ctx, input) => {
          assert.equal(input, args);
          events.push('handler');
          return value;
        });
        assert.equal(sync._handler(ctx, args), value);
        events.push('returned');
        assert.deepEqual(events, ['handler', 'returned']);
        const error = Error('synthetic exact handler failure');
        const throws = register(() => {
          events.push('throw');
          throw error;
        });
        assert.throws(
          () => throws._handler(ctx, args),
          actual => actual === error,
        );
        events.push('caught');
        assert.deepEqual(events.slice(-2), ['throw', 'caught']);
        const promise = Promise.resolve(value);
        assert.equal(register(() => promise)._handler(ctx, args), promise);
        const rejected = Promise.reject(error);
        const result = register(() => rejected)._handler(ctx, args);
        assert.equal(result, rejected);
        await assert.rejects(result, actual => actual === error);
      }
    }
    assert.equal(accesses, 0);
  } finally {
    if (previous === undefined) delete process.env.FORGE_LEGACY_STORAGE_PAUSE;
    else process.env.FORGE_LEGACY_STORAGE_PAUSE = previous;
  }
});
test('synthetic pause blocks ordinary/internal writes, leaves queries available, resumes and expires', async () => {
  const previous = { cloud: process.env.CONVEX_CLOUD_URL, pause: process.env.FORGE_LEGACY_STORAGE_PAUSE };
  let writes = 0;
  try {
    enable();
    for (const builder of [server.mutation, server.internalMutation]) {
      const fn = builder({
        args: {},
        handler: async ctx => {
          await ctx.db.insert('fixture', {});
          return null;
        },
      });
      await assert.rejects(
        fn._handler(
          {
            db: {
              insert: async () => {
                writes++;
              },
            },
            storage: {},
            scheduler: {},
          },
          {},
        ),
        /temporarily paused/,
      );
    }
    const read = server.query({ args: {}, handler: async () => 42 });
    assert.equal(await read._handler({}, {}), 42);
    const signedRead = server.mutation({ args: {}, handler: ctx => ctx.db.get('fixture') });
    assert.equal(
      await signedRead._handler({ db: { get: async () => 42 }, storage: {}, scheduler: {} }, {}),
      42,
    );
    assert.equal(writes, 0);
    assert.equal(pause.activeStoragePause(Date.now() + 1800001), null);
    for (const invalid of ['null', '42', '[]', '{}', 'invalid']) {
      process.env.FORGE_LEGACY_STORAGE_PAUSE = invalid;
      assert.equal(pause.activeStoragePause(), null);
    }
    delete process.env.FORGE_LEGACY_STORAGE_PAUSE;
    const fn = server.internalMutation({ args: {}, handler: async () => ++writes });
    assert.equal(await fn._handler({}, {}), 1);
  } finally {
    for (const [k, v] of [
      ['CONVEX_CLOUD_URL', previous.cloud],
      ['FORGE_LEGACY_STORAGE_PAUSE', previous.pause],
    ]) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
});
test('pause keeps context ports lazy and preserves capability detection while refusing writes', async () => {
  const previous = { cloud: process.env.CONVEX_CLOUD_URL, pause: process.env.FORGE_LEGACY_STORAGE_PAUSE };
  let reads = 0;
  const db = {
    get: async () => 42,
    normalizeId: () => null,
    patch: async () => assert.fail('paused write reached its port'),
  };
  const ctx = {
    get db() {
      reads++;
      return db;
    },
    get storage() {
      assert.fail('unused storage accessor was evaluated');
    },
    get scheduler() {
      assert.fail('unused scheduler accessor was evaluated');
    },
  };
  try {
    enable();
    const retired = server.internalMutation({ args: {}, handler: () => 'retired' });
    assert.equal(await retired._handler(ctx, {}), 'retired');
    assert.equal(reads, 0);
    const signedRead = server.internalMutation({
      args: {},
      handler: async context => {
        assert.equal(context.db, context.db);
        assert.equal('patch' in context.db, true);
        await assert.rejects(context.db.patch('fixture', {}), /temporarily paused/);
        return context.db.get('fixture');
      },
    });
    assert.equal(await signedRead._handler(ctx, {}), 42);
    assert.equal(reads, 1);
  } finally {
    for (const [k, v] of [
      ['CONVEX_CLOUD_URL', previous.cloud],
      ['FORGE_LEGACY_STORAGE_PAUSE', previous.pause],
    ]) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
});
test('mechanical guard: all production mutation builders use the pause boundary, with only reviewed cleanup exceptions', () => {
  const maintenance = new Set([
    'projectLegacyStorageCleanup.ts',
    'projectLegacyStorageBenchCleanup.ts',
    'projectLegacyStorageWindow.ts',
  ]);
  function files(directory = '') {
    return readdirSync(new URL('../convex/' + directory, import.meta.url), { withFileTypes: true }).flatMap(
      entry => {
        const path = directory + entry.name;
        return entry.isDirectory()
          ? entry.name === '_generated'
            ? []
            : files(path + '/')
          : /\.(?:ts|js)$/.test(path) && !path.endsWith('.d.ts')
            ? [path]
            : [];
      },
    );
  }
  for (const name of files()) {
    const source = readFileSync(new URL('../convex/' + name, import.meta.url), 'utf8');
    if (name === 'server.ts') continue; // The sole generated-builder factory.
    assert.equal(
      /(?:import|export)\s*{[^}]*\b(?:mutation|internalMutation)\b[^}]*}\s*from\s*['"][.\/]*_generated\/server(?:\.js)?['"]/s.test(
        source,
      ),
      false,
      name,
    );
    assert.equal(/\b(?:mutationGeneric|internalMutationGeneric)\b/.test(source), false, name);
    if (/\bmaintenanceInternalMutation\b/.test(source)) {
      assert(maintenance.has(name), name + ' uses an unreviewed pause exemption');
      assert.match(source, /maintenanceInternalMutation as internalMutation[^}]*}\s*from '\.\/server'/);
    }
  }
  const windowSource = readFileSync(
    new URL('../convex/projectLegacyStorageWindow.ts', import.meta.url),
    'utf8',
  );
  assert.deepEqual(
    [...windowSource.matchAll(/export const (\w+) = internalMutation/g)].map(m => m[1]).sort(),
    ['begin', 'end'],
  );
  const cleanupSource = readFileSync(
    new URL('../convex/projectLegacyStorageCleanup.ts', import.meta.url),
    'utf8',
  );
  assert.deepEqual(
    [...cleanupSource.matchAll(/export const (\w+) = internalMutation/g)].map(m => m[1]).sort(),
    ['deletePage', 'migrateCursors'],
  );
  const benchSource = readFileSync(
    new URL('../convex/projectLegacyStorageBenchCleanup.ts', import.meta.url),
    'utf8',
  );
  assert.deepEqual(
    [...benchSource.matchAll(/export const (\w+) = internalMutation/g)].map(m => m[1]),
    ['deletePage'],
  );
});
test('failure resumes both flags before returning; successful synthetic window records end and names only', async () => {
  for (const fail of [false, true]) {
    const dir = await mkdtemp(join(tmpdir(), 'forge-pause-'));
    const flags = new Set(),
      events = [];
    const io = {
      beginWindow: async () => ({ active: true }),
      endWindow: async () => {
        events.push('fence-ended');
        return { ended: true };
      },
      flagsAbsent: async () => flags.size === 0,
      setFlag: async n => {
        flags.add(n);
        events.push('set:' + n);
      },
      unsetFlag: async n => {
        flags.delete(n);
        events.push('unset:' + n);
      },
    };
    try {
      const run = maintenanceWindow(
        { out: dir, deployment: 'dev:fixture', operationId: 'op', leadGo: 'synthetic go' },
        async () => {
          events.push('work');
          if (fail) throw new Error('synthetic failure');
          return 42;
        },
        io,
      );
      if (fail) await assert.rejects(run, /synthetic failure/);
      else assert.equal(await run, 42);
      assert.equal(flags.size, 0);
      assert.equal(events.filter(e => e.startsWith('unset')).length, 2);
      assert.ok(events.indexOf('fence-ended') < events.findIndex(e => e.startsWith('unset')));
      const receipt = JSON.parse(await readFile(join(dir, 'window.json')));
      assert.equal(receipt.flagsAbsent, true);
      assert.ok(receipt.endedAt >= receipt.startedAt);
      await assert.rejects(
        maintenanceWindow(
          { out: dir, deployment: 'dev:fixture', operationId: 'op2', leadGo: 'synthetic second go' },
          async () => 42,
          io,
        ),
        /CLEANUP_WINDOW_ALREADY_USED/,
      );
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }
});
test('failure stops additional pages and joins all in-flight mutations before resumption', async () => {
  let active = 0,
    peak = 0,
    calls = 0;
  await assert.rejects(
    boundedPages(
      Array(100).fill([]),
      async (_, index) => {
        active++;
        calls++;
        peak = Math.max(peak, active);
        await new Promise(r => setImmediate(r));
        active--;
        if (index === 0) throw new Error('fail');
        return {};
      },
      4,
    ),
    /CLEANUP_PAGE_FAILED/,
  );
  assert.equal(active, 0);
  assert.equal(peak, 4);
  assert.equal(calls, 4);
});
test('plan excludes unverified files, source/task/Work references, and class 4 regardless of digest result', () => {
  const hash = 'a'.repeat(64),
    base = {
      bytes: 1,
      sha256: hash,
      references: [
        {
          table: 'projectObjects',
          field: 'storageId',
          location: 'r2',
          committed: true,
          digest: hash,
          size: 1,
          r2Key: 'v1/p/p/o/' + hash,
        },
      ],
      matchingCopies: [{ key: 'v1/p/p/o/' + hash, size: 1 }],
    };
  const a = {
    deployment: 'dev:x',
    coverage: { fullyPaged: true },
    files: [
      { ...base, storageId: 'ok' },
      { ...base, storageId: 'bad' },
      { ...base, storageId: 'keep', references: [], matchingCopies: [] },
      { ...base, storageId: 'held-class3', references: [] },
    ],
  };
  a.files = a.files.map(f => ({
    ...f,
    references: f.references.map(r => ({ ...r, storageId: f.storageId })),
  }));
  const v = {
    complete: true,
    deployment: 'dev:x',
    results: [
      {
        storageId: 'ok',
        fullDigest: true,
        sha256: hash,
        bytes: 1,
        keys: ['v1/p/p/o/' + hash],
        verifiedAt: new Date().toISOString(),
      },
    ],
  };
  assert.deepEqual(
    deletionPlan(a, v).pins.map(p => p.storageId),
    ['ok'],
  );
  assert.equal(
    deletionPlan(a, v).excluded.find(r => r.storageId === 'held-class3').code,
    'MISSING_BENCH_CURSOR_BODIES',
  );
  assert.equal(
    deletionPlan(a, v, {
      references: [{ storageId: 'ok', table: 'projectSourceTasks', field: 'progress.id' }],
    }).pins.length,
    0,
  );
});
const backend = await import(moduleUrl('../convex/projectLegacyStorageCleanup.ts'));
const windowBackend = await import(moduleUrl('../convex/projectLegacyStorageWindow.ts'));
const schema = (await import(moduleUrl('../convex/schema.ts'))).default;
function backendFixture() {
  const tables = Object.fromEntries(Object.keys(schema.tables).map(t => [t, new Map()]));
  if (process.env.FORGE_LEGACY_STORAGE_PAUSE) {
    const configured = JSON.parse(process.env.FORGE_LEGACY_STORAGE_PAUSE);
    tables.legacyStorageCleanupWindows.set('window', { ...configured, _id: 'window', active: true });
  }
  const file = { _id: 'file', size: 7, sha256: 'a'.repeat(64) },
    key = 'v1/p/project/o/' + file.sha256;
  const objects = {
    _id: 'object',
    projectId: 'project',
    storageId: 'file',
    digest: file.sha256,
    size: 7,
    location: 'r2',
    r2Committed: true,
    r2Key: key,
    r2BackfilledAt: Date.now() - 5000,
  };
  tables.projectObjects.set('object', objects);
  tables.projectBackups.set('backup', { ...objects, _id: 'backup' });
  const files = new Map([['file', file]]);
  let deletes = 0;
  const query = table => {
    let rows = [...tables[table].values()];
    const q = {
      withIndex: (_, fn) => {
        const builder = {
          eq: (field, value) => {
            rows = rows.filter(r => field.split('.').reduce((v, k) => v?.[k], r) === value);
            return builder;
          },
        };
        fn(builder);
        return q;
      },
      take: async n => rows.slice(0, n),
      unique: async () => rows[0] ?? null,
    };
    return q;
  };
  const ctx = {
    db: {
      query,
      normalizeId: (table, id) => (tables[table]?.has(id) ? id : null),
      delete: async id => {
        for (const table of Object.values(tables)) table.delete(id);
      },
      get: async id =>
        Object.values(tables)
          .map(t => t.get(id))
          .find(Boolean) ?? null,
      patch: async (id, fields) => {
        const t = Object.values(tables).find(t => t.has(id));
        Object.assign(t.get(id), fields);
      },
      replace: async (id, fields) => {
        const table = Object.values(tables).find(t => t.has(id));
        table.set(id, { ...fields, _id: id });
      },
      insert: async (table, row) => {
        const id = table + '-' + tables[table].size;
        tables[table].set(id, { ...row, _id: id });
        return id;
      },
      system: { get: async id => files.get(id) ?? null },
    },
    storage: {
      delete: async id => {
        files.delete(id);
        deletes++;
      },
    },
  };
  const now = Date.now();
  const args = {
    operationId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    part: 'delete-0',
    scopeSha256: 'b'.repeat(64),
    scan: {
      pauseOperationId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      startedAt: new Date(now).toISOString(),
      finishedAt: new Date(now).toISOString(),
      fullyPaged: true,
      tables: Object.keys(tables),
      sha256: 'c'.repeat(64),
      bodyCoverage: {
        complete: true,
        sha256: 'd'.repeat(64),
        catalogDigest: 'e'.repeat(64),
        rootDigest: 'f'.repeat(64),
        checkedAt: new Date(now).toISOString(),
      },
    },
    backup: {
      run: 41887010710,
      successful: true,
      includeFileStorage: true,
      checkedAt: new Date(now).toISOString(),
    },
    pins: [
      {
        storageId: 'file',
        digest: file.sha256,
        size: 7,
        class: 1,
        verifiedAt: new Date(now).toISOString(),
        recheckedAt: new Date(now).toISOString(),
        fullDigest: true,
        keys: [key],
        owners: [
          { table: 'projectObjects', id: 'object' },
          { table: 'projectBackups', id: 'backup' },
        ],
      },
    ],
  };
  return { ctx, tables, files, args, deletes: () => deletes };
}
test('ordinary server writers maintain finish projections and the pause blocks the tracked source write', async () => {
  const previous = { cloud: process.env.CONVEX_CLOUD_URL, pause: process.env.FORGE_LEGACY_STORAGE_PAUSE };
  try {
    delete process.env.FORGE_LEGACY_STORAGE_PAUSE;
    const s = backendFixture();
    const create = server.internalMutation({
      args: {},
      handler: ctx => ctx.db.insert('hostedProjects', { owner: 'owner', visibility: 'private', name: 'old' }),
    });
    const id = await create._handler(s.ctx, {});
    const projection = () =>
      [...s.tables.projectFinishReadRows.values()].find(
        r => r.sourceId === id && r.kind === 'hostedProjects',
      );
    assert.equal(JSON.parse(projection().value).name, 'old');
    const rename = server.internalMutation({
      args: {},
      handler: ctx => ctx.db.patch(id, { name: 'new' }),
    });
    enable();
    await assert.rejects(rename._handler(s.ctx, {}), /temporarily paused/);
    assert.equal(s.tables.hostedProjects.get(id).name, 'old');
    assert.equal(JSON.parse(projection().value).name, 'old');
    delete process.env.FORGE_LEGACY_STORAGE_PAUSE;
    await rename._handler(s.ctx, {});
    assert.equal(JSON.parse(projection().value).name, 'new');
  } finally {
    for (const [k, v] of [
      ['CONVEX_CLOUD_URL', previous.cloud],
      ['FORGE_LEGACY_STORAGE_PAUSE', previous.pause],
    ]) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
});
test('joint backup/object delete is atomic and retry identity reconciles an unknown reply without repeating', async () => {
  const before = { ...process.env };
  try {
    enable();
    process.env.FORGE_R2_MAINTENANCE = '1';
    const s = backendFixture();
    const r = await backend.deletePage._handler(s.ctx, s.args);
    assert.equal(r.deleted, 1);
    assert.equal(r.bytes, 7);
    assert.equal(r.changedRows, 2);
    delete process.env.FORGE_LEGACY_STORAGE_PAUSE;
    assert.deepEqual(await backend.deletePage._handler(s.ctx, s.args), r);
    assert.equal(s.deletes(), 1);
    await assert.rejects(
      backend.deletePage._handler(s.ctx, { ...s.args, scopeSha256: 'd'.repeat(64) }),
      e => e.code === 'OPERATION_REUSED',
    );
  } finally {
    for (const k of ['CONVEX_CLOUD_URL', 'FORGE_LEGACY_STORAGE_PAUSE', 'FORGE_R2_MAINTENANCE']) {
      if (before[k] === undefined) delete process.env[k];
      else process.env[k] = before[k];
    }
  }
});
test('foreign refs, changed owners, missing table coverage, stale backup and wrong pause refuse deletion', async () => {
  const before = { ...process.env };
  try {
    enable();
    process.env.FORGE_R2_MAINTENANCE = '1';
    for (const change of [
      s => s.tables.importArtifacts.set('foreign', { _id: 'foreign', artifactKey: 'file' }),
      s => s.tables.imports.set('foreign', { _id: 'foreign', artifactKey: 'file' }),
      s => s.tables.projectObjects.set('foreign', { _id: 'foreign', storageId: 'file' }),
      s => s.tables.projectBackups.set('foreign', { _id: 'foreign', storageId: 'file' }),
      s => s.tables.projectBackups.set('foreign', { _id: 'foreign', archiveReceipt: { storageId: 'file' } }),
      s => s.tables.projectProposals.set('foreign', { _id: 'foreign', storageId: 'file' }),
      s => (s.tables.projectObjects.get('object').r2Committed = false),
    ]) {
      const s = backendFixture();
      change(s);
      const r = await backend.deletePage._handler(s.ctx, s.args);
      assert.equal(r.deleted, 0);
      assert.equal(r.excluded.length, 1);
      assert.equal(s.deletes(), 0);
    }
    for (const change of [
      s => s.args.scan.tables.pop(),
      s => (s.args.scan.bodyCoverage.complete = false),
      s => (s.args.scan.bodyCoverage.checkedAt = new Date(0).toISOString()),
      s => (s.args.backup.checkedAt = new Date(Date.now() - 360000).toISOString()),
      s => (s.args.operationId = 'wrong'),
    ]) {
      const s = backendFixture();
      change(s);
      await assert.rejects(backend.deletePage._handler(s.ctx, s.args));
      assert.equal(s.deletes(), 0);
    }
  } finally {
    for (const k of ['CONVEX_CLOUD_URL', 'FORGE_LEGACY_STORAGE_PAUSE', 'FORGE_R2_MAINTENANCE']) {
      if (before[k] === undefined) delete process.env[k];
      else process.env[k] = before[k];
    }
  }
});

test('complete synthetic dry-run / pause / full scan / delete / resume deletes covered class 3 and preserves class 4 and records physical before-after', async () => {
  const { cleanup } = await import('../scripts/legacy-storage-cleanup.mjs');
  const { createHash } = await import('node:crypto');
  const { writeFile } = await import('node:fs/promises');
  const dir = await mkdtemp(join(tmpdir(), 'forge-cleanup-rehearsal-'));
  const before = { ...process.env },
    fetcher = globalThis.fetch;
  try {
    process.env.CONVEX_CLOUD_URL = 'https://fixture.convex.cloud';
    delete process.env.FORGE_LEGACY_STORAGE_PAUSE;
    delete process.env.FORGE_R2_MAINTENANCE;
    const s = backendFixture(),
      hash = 'a'.repeat(64),
      key = 'v1/p/project/o/' + hash;
    s.files.set('orphan', { _id: 'orphan', size: 7, sha256: hash });
    s.files.set('keep', { _id: 'keep', size: 9, sha256: 'b'.repeat(64) });
    const files = [
      {
        storageId: 'file',
        bytes: 7,
        sha256: hash,
        matchingCopies: [{ key, size: 7 }],
        references: ['projectObjects', 'projectBackups'].map((table, i) => ({
          storageId: 'file',
          table,
          field: 'storageId',
          document: i ? 'backup' : 'object',
          project: 'project',
          digest: hash,
          size: 7,
          r2Key: key,
          location: 'r2',
          committed: true,
        })),
      },
      { storageId: 'orphan', bytes: 7, sha256: hash, references: [], matchingCopies: [{ key, size: 7 }] },
      { storageId: 'keep', bytes: 9, sha256: 'b'.repeat(64), references: [], matchingCopies: [] },
    ];
    const audit = { deployment: 'dev:fixture', coverage: { fullyPaged: true }, files };
    const raw = JSON.stringify(audit);
    await writeFile(join(dir, 'audit.json'), raw);
    await writeFile(
      join(dir, 'verification.json'),
      JSON.stringify({
        complete: true,
        deployment: 'dev:fixture',
        auditSha256: createHash('sha256').update(raw).digest('hex'),
        results: files.slice(0, 2).map(f => ({
          storageId: f.storageId,
          bytes: f.bytes,
          sha256: hash,
          keys: [key],
          verifiedAt: new Date().toISOString(),
          fullDigest: true,
        })),
      }),
    );
    const readQuery = table => {
      const rows = table === '_storage' ? [...s.files.values()] : [...s.tables[table].values()];
      const q = { order: () => q, paginate: async () => ({ page: rows, isDone: true, continueCursor: '' }) };
      return q;
    };
    const reader = {
      tables: async () => Object.keys(s.tables),
      r2Config: async () => ({
        R2_ACCOUNT_ID: 'synthetic',
        R2_BUCKET: 'bucket',
        R2_ACCESS_KEY_ID: 'synthetic',
        R2_SECRET_ACCESS_KEY: 'synthetic',
      }),
      page: async source => {
        const ctx = {
          db: {
            query: readQuery,
            system: { query: readQuery, normalizeId: (_, id) => (s.files.has(id) ? id : null) },
          },
        };
        return new (Object.getPrototypeOf(async function () {}).constructor)('ctx', source)(ctx);
      },
    };
    let rpc = 0;
    const io = {
      beginWindow: operationId => windowBackend.begin._handler(s.ctx, { operationId }),
      endWindow: operationId => windowBackend.end._handler(s.ctx, { operationId }),
      reader,
      flagsAbsent: async () => !process.env.FORGE_LEGACY_STORAGE_PAUSE && !process.env.FORGE_R2_MAINTENANCE,
      setFlag: async (n, v) => {
        process.env[n] = v;
      },
      unsetFlag: async n => {
        delete process.env[n];
      },
      backup: async () => ({
        run: 41887010710,
        successful: true,
        includeFileStorage: true,
        checkedAt: new Date().toISOString(),
      }),
      call: async (name, args) => {
        rpc++;
        return backend[name.split(':')[1]]._handler(s.ctx, args);
      },
    };
    globalThis.fetch = async (_, args) => {
      assert.equal(args.method, 'HEAD');
      return new Response(null, {
        headers: {
          'content-length': '7',
          'x-amz-checksum-sha256': Buffer.from(hash, 'hex').toString('base64'),
        },
      });
    };
    const { closeBodies } = await import('../scripts/lib/legacy-storage-closure.mjs');
    await closeBodies(
      audit,
      { references: [], durableReferences: [] },
      reader,
      {},
      join(dir, 'body-proof.json'),
    );
    const command = {
      bodyCoverage: join(dir, 'body-proof.json'),
      mode: 'dry-run',
      deployment: 'dev:fixture',
      audit: join(dir, 'audit.json'),
      verification: join(dir, 'verification.json'),
      out: join(dir, 'run'),
      operationId: s.args.operationId,
      leadGo: 'synthetic lead go',
    };
    const dry = await cleanup(command, io);
    assert.equal(dry.deleted, 0);
    assert.equal(s.files.size, 3);
    const result = await cleanup({ ...command, mode: 'apply' }, io);
    assert.equal(result.before.files, 3);
    assert.equal(result.before.bytes, 23);
    assert.equal(result.after.files, 1);
    assert.equal(result.after.bytes, 9);
    assert.equal(result.after.retainedClass4Verified, 1);
    assert.equal(result.summary.classes[1].deleted, 1);
    assert.equal(result.summary.classes[3].deleted, 1);
    assert.equal(result.summary.classes[3].excluded, 0);
    assert.equal(result.summary.changedRows, 2);
    assert.equal(rpc, 3);
    assert.equal(await io.flagsAbsent(), true);
    const original = JSON.parse(await readFile(join(dir, 'run', 'request-0.json')));
    assert.equal((await backend.deletePage._handler(s.ctx, original)).deleted, 2);
    assert.equal(s.deletes(), 2);
  } finally {
    globalThis.fetch = fetcher;
    for (const k of ['CONVEX_CLOUD_URL', 'FORGE_LEGACY_STORAGE_PAUSE', 'FORGE_R2_MAINTENANCE']) {
      if (before[k] === undefined) delete process.env[k];
      else process.env[k] = before[k];
    }
    await rm(dir, { recursive: true, force: true });
  }
});

test('a failed frozen reference scan stops all table workers within their current page', async () => {
  const { frozenScan } = await import('../scripts/lib/legacy-storage-cleanup.mjs');
  const dir = await mkdtemp(join(tmpdir(), 'forge-scan-failure-'));
  let calls = 0;
  try {
    const reader = {
      tables: async () => Array.from({ length: 100 }, (_, i) => 'table' + i),
      page: async () => {
        const index = calls++;
        await new Promise(r => setImmediate(r));
        if (index === 0) throw new Error('synthetic scan failure');
        return { documents: 0, jsonBytes: 0, references: [], cursor: 'next', isDone: false };
      },
    };
    await assert.rejects(frozenScan(reader, 'synthetic-op', dir, [32]), /CLEANUP_SCAN_FAILED/);
    assert.equal(calls, 4);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('cursor migration pins the current row and metadata, retains Convex bytes, and reconciles replay', async () => {
  const before = { ...process.env };
  try {
    enable();
    const s = backendFixture();
    s.tables.projectSourceSteps.set('cursor', { _id: 'cursor', projectId: 'project', cursor: 'file' });
    const args = {
      operationId: s.args.operationId,
      part: 'cursors',
      pins: [
        {
          id: 'cursor',
          storageId: 'file',
          digest: 'a'.repeat(64),
          size: 7,
          key: 'v1/p/project/o/' + 'a'.repeat(64),
          verifiedAt: new Date().toISOString(),
        },
      ],
    };
    const result = await backend.migrateCursors._handler(s.ctx, args);
    assert.equal(result.changedRows, 1);
    assert.equal(s.tables.projectSourceSteps.get('cursor').cursor, 'r2source:' + 'a'.repeat(64) + ':7');
    assert.equal(s.files.has('file'), true);
    delete process.env.FORGE_LEGACY_STORAGE_PAUSE;
    assert.deepEqual(await backend.migrateCursors._handler(s.ctx, args), result);
    enable();
    const fresh = backendFixture();
    fresh.tables.projectSourceSteps.set('cursor', {
      _id: 'cursor',
      projectId: 'project',
      cursor: 'newer-progress',
    });
    await assert.rejects(
      backend.migrateCursors._handler(fresh.ctx, args),
      e => e.code === 'LEGACY_STORAGE_CURSOR_CHANGED',
    );
    assert.equal(fresh.tables.projectSourceSteps.get('cursor').cursor, 'newer-progress');
  } finally {
    for (const k of ['CONVEX_CLOUD_URL', 'FORGE_LEGACY_STORAGE_PAUSE']) {
      if (before[k] === undefined) delete process.env[k];
      else process.env[k] = before[k];
    }
  }
});

test('revocation closes the transaction fence before writes resume, refuses new cleanup and cannot reopen the same window', async () => {
  const before = { cloud: process.env.CONVEX_CLOUD_URL, pause: process.env.FORGE_LEGACY_STORAGE_PAUSE };
  try {
    enable();
    const s = backendFixture();
    assert.deepEqual(await windowBackend.begin._handler(s.ctx, { operationId: s.args.operationId }), {
      active: true,
    });
    assert.equal(s.tables.legacyStorageCleanupWindows.size, 1);
    assert.deepEqual(await windowBackend.end._handler(s.ctx, { operationId: s.args.operationId }), {
      ended: true,
    });
    assert.equal(s.tables.legacyStorageCleanupWindows.get('window').active, false);
    await assert.rejects(
      backend.deletePage._handler(s.ctx, s.args),
      e => e.code === 'LEGACY_STORAGE_WINDOW_ENDED',
    );
    await assert.rejects(
      windowBackend.begin._handler(s.ctx, { operationId: s.args.operationId }),
      e => e.code === 'LEGACY_STORAGE_WINDOW_ENDED',
    );
    assert.equal(s.deletes(), 0);
  } finally {
    for (const [k, v] of [
      ['CONVEX_CLOUD_URL', before.cloud],
      ['FORGE_LEGACY_STORAGE_PAUSE', before.pause],
    ]) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
});
test('ordinary writes use zero DB reads without a pause flag; an expired configured window closes its fence before the handler', async () => {
  const before = { cloud: process.env.CONVEX_CLOUD_URL, pause: process.env.FORGE_LEGACY_STORAGE_PAUSE };
  let reads = 0,
    patches = 0,
    handled = 0;
  try {
    delete process.env.FORGE_LEGACY_STORAGE_PAUSE;
    const fn = server.mutation({ args: {}, handler: async () => ++handled });
    assert.equal(
      await fn._handler(
        {
          db: new Proxy(
            {},
            {
              get() {
                throw Error('unexpected DB call');
              },
            },
          ),
        },
        {},
      ),
      1,
    );
    const now = Date.now();
    process.env.CONVEX_CLOUD_URL = 'https://fixture.convex.cloud';
    process.env.FORGE_LEGACY_STORAGE_PAUSE = JSON.stringify({
      deployment: 'dev:fixture',
      operationId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      startedAt: now - 1800001,
      expiresAt: now - 1,
    });
    const marker = { _id: 'window', active: true };
    const ctx = {
      db: {
        query: () => ({
          withIndex: () => ({
            unique: async () => {
              reads++;
              return marker;
            },
          }),
        }),
        patch: async (_, p) => {
          patches++;
          Object.assign(marker, p);
        },
      },
    };
    const resumed = server.mutation({
      args: {},
      handler: async () => {
        assert.equal(marker.active, false);
        return ++handled;
      },
    });
    assert.equal(await resumed._handler(ctx, {}), 2);
    assert.equal(reads, 1);
    assert.equal(patches, 1);
  } finally {
    for (const [k, v] of [
      ['CONVEX_CLOUD_URL', before.cloud],
      ['FORGE_LEGACY_STORAGE_PAUSE', before.pause],
    ]) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
});

test('paused read-only mutation contexts preserve DB/blob reads and deny storage deletes and scheduling; legacy action deletes are also paused', async () => {
  const before = { cloud: process.env.CONVEX_CLOUD_URL, pause: process.env.FORGE_LEGACY_STORAGE_PAUSE };
  const { blobStore } = await import(moduleUrl('../convex/blobStore.ts'));
  let writes = 0;
  try {
    enable();
    const ctx = {
      db: { get: async () => 42 },
      storage: {
        get: async () => new Blob(['read']),
        getUrl: async () => '/fixture',
        delete: async () => {
          writes++;
        },
      },
      scheduler: {
        runAfter: async () => {
          writes++;
        },
      },
    };
    const read = server.mutation({
      args: {},
      handler: async ctx => [await ctx.db.get('row'), await ctx.storage.getUrl('file')],
    });
    assert.deepEqual(await read._handler(ctx, {}), [42, '/fixture']);
    for (const handler of [
      ctx => ctx.storage.delete('file'),
      ctx => ctx.scheduler.runAfter(0, 'fixture', {}),
    ])
      await assert.rejects(
        server.internalMutation({ args: {}, handler })._handler(ctx, {}),
        /temporarily paused/,
      );
    const blobs = blobStore({ storage: ctx.storage });
    assert.equal(await (await blobs.get('file')).text(), 'read');
    await assert.rejects(blobs.delete('file'), /temporarily paused/);
    const { presign } = await import(moduleUrl('../convex/presign.ts'));
    const signing = {
      host: 'fixture.invalid',
      path: '/bucket/object',
      accessKeyId: 'synthetic',
      secretAccessKey: 'synthetic',
    };
    for (const method of ['GET', 'HEAD'])
      assert.equal(typeof (await presign({ ...signing, method })), 'string');
    assert.throws(() => presign({ ...signing, method: 'PUT' }), /temporarily paused/);
    assert.equal(writes, 0);
  } finally {
    for (const [k, v] of [
      ['CONVEX_CLOUD_URL', before.cloud],
      ['FORGE_LEGACY_STORAGE_PAUSE', before.pause],
    ]) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
});

test('cursor full-content mismatch is recorded per file before any reference mutation', async () => {
  const { migrateVerifiedCursors } = await import('../scripts/lib/legacy-storage-cursors.mjs');
  const dir = await mkdtemp(join(tmpdir(), 'forge-cursor-mismatch-')),
    oldFetch = globalThis.fetch;
  let mutations = 0;
  try {
    globalThis.fetch = async () => new Response('mismatch');
    const pin = {
      storageId: 'cursor',
      bytes: 8,
      sha256: 'a'.repeat(64),
      fullDigest: true,
      verifiedAt: new Date().toISOString(),
    };
    const audit = {
      files: [
        {
          storageId: 'cursor',
          references: [
            { table: 'projectSourceSteps', field: 'cursor', project: 'project', document: 'step' },
          ],
        },
      ],
    };
    const io = {
      reader: {
        r2Config: async () => ({
          R2_ACCOUNT_ID: 'synthetic',
          R2_BUCKET: 'bucket',
          R2_ACCESS_KEY_ID: 'synthetic',
          R2_SECRET_ACCESS_KEY: 'synthetic',
        }),
      },
      call: async () => {
        mutations++;
      },
    };
    await assert.rejects(
      migrateVerifiedCursors(
        audit,
        { results: [pin] },
        { heads: { excluded: [] } },
        { out: dir, operationId: 'op' },
        io,
      ),
      /CLEANUP_MIGRATION_UNVERIFIED/,
    );
    assert.equal(mutations, 0);
    const exclusion = JSON.parse(await readFile(join(dir, 'excluded-cursor-cursor.json')));
    assert.equal(exclusion.class, 2);
    assert.equal(exclusion.storageId, 'cursor');
    assert.equal(exclusion.code, 'VERIFY_DIGEST_MISMATCH');
  } finally {
    globalThis.fetch = oldFetch;
    await rm(dir, { recursive: true, force: true });
  }
});

test('cursor migration hashes complete R2 bytes before and after the CAS and verifies the resulting references', async () => {
  const { migrateVerifiedCursors } = await import('../scripts/lib/legacy-storage-cursors.mjs');
  const { createHash } = await import('node:crypto');
  const dir = await mkdtemp(join(tmpdir(), 'forge-cursor-verified-')),
    oldFetch = globalThis.fetch,
    bytes = 'cursor',
    digest = createHash('sha256').update(bytes).digest('hex'),
    events = [];
  let current = 'legacy';
  try {
    globalThis.fetch = async () => {
      events.push('GET');
      return new Response(bytes);
    };
    const file = {
      storageId: 'legacy',
      references: [{ table: 'projectSourceSteps', field: 'cursor', project: 'project', document: 'step' }],
    };
    const verification = {
      results: [
        {
          storageId: 'legacy',
          bytes: 6,
          sha256: digest,
          fullDigest: true,
          verifiedAt: new Date().toISOString(),
        },
      ],
    };
    const io = {
      reader: {
        r2Config: async () => ({
          R2_ACCOUNT_ID: 'synthetic',
          R2_BUCKET: 'bucket',
          R2_ACCESS_KEY_ID: 'synthetic',
          R2_SECRET_ACCESS_KEY: 'synthetic',
        }),
        page: async () => {
          events.push('rows');
          return [{ cursor: current }];
        },
      },
      call: async (name, args) => {
        events.push('mutation');
        assert.equal(name, 'projectLegacyStorageCleanup:migrateCursors');
        assert.equal(args.pins[0].digest, digest);
        current = `r2source:${digest}:6`;
        return { changedRows: 1 };
      },
    };
    const result = await migrateVerifiedCursors(
      { files: [file] },
      verification,
      { heads: { excluded: [] } },
      { out: dir, operationId: 'op' },
      io,
    );
    assert.deepEqual(events, ['GET', 'mutation', 'rows', 'GET']);
    assert.equal(result.verified, true);
    assert.equal(result.changedRows, 1);
    assert.equal(result.metrics.r2Gets, 2);
    assert.equal(result.metrics.r2Bytes, 12);
  } finally {
    globalThis.fetch = oldFetch;
    await rm(dir, { recursive: true, force: true });
  }
});

test('a maximum file page keeps all six indexed guards within the read budget; oversized pages delete nothing', async () => {
  const before = {
    cloud: process.env.CONVEX_CLOUD_URL,
    pause: process.env.FORGE_LEGACY_STORAGE_PAUSE,
    maintenance: process.env.FORGE_R2_MAINTENANCE,
  };
  try {
    enable();
    process.env.FORGE_R2_MAINTENANCE = '1';
    const s = backendFixture();
    s.tables.projectObjects.clear();
    s.tables.projectBackups.clear();
    s.files.clear();
    const original = s.ctx.db.query;
    let queries = 0;
    s.ctx.db.query = (...args) => {
      queries++;
      return original(...args);
    };
    const pins = Array.from({ length: 100 }, (_, i) => ({
      ...s.args.pins[0],
      storageId: 'file-' + i,
      class: 3,
      owners: [],
    }));
    for (const pin of pins)
      s.files.set(pin.storageId, { _id: pin.storageId, size: pin.size, sha256: pin.digest });
    const result = await backend.deletePage._handler(s.ctx, { ...s.args, pins });
    assert.equal(result.deleted, 100);
    assert.equal(result.bytes, 700);
    assert.equal(s.deletes(), 100);
    assert.ok(queries <= 602, `indexed query budget: ${queries}`);
    const fresh = backendFixture();
    await assert.rejects(
      backend.deletePage._handler(fresh.ctx, {
        ...fresh.args,
        pins: [...pins, { ...pins[0], storageId: 'overflow' }],
      }),
      e => e.code === 'BAD_ARGUMENT',
    );
    assert.equal(fresh.deletes(), 0);
  } finally {
    for (const [k, v] of [
      ['CONVEX_CLOUD_URL', before.cloud],
      ['FORGE_LEGACY_STORAGE_PAUSE', before.pause],
      ['FORGE_R2_MAINTENANCE', before.maintenance],
    ]) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
});
