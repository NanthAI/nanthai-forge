// SPDX-License-Identifier: Apache-2.0
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { auditPage, pageSource } from '../scripts/lib/legacy-storage-query.mjs';
import { classifyStorage, costEstimate } from '../scripts/lib/legacy-storage-report.mjs';
import { audit, plan, parseAudit } from '../scripts/legacy-storage-audit.mjs';
import { listR2 } from '../scripts/lib/legacy-storage-reader.mjs';
const hash = 'a'.repeat(64);
const ref = {
  storageId: 'legacy',
  table: 'projectObjects',
  document: 'doc',
  project: 'p',
  field: 'storageId',
  digest: hash,
  size: 7,
  r2Key: 'key',
  location: 'r2',
  committed: true,
};

test('every nested/JSON legacy reference is found, without per-file gets or secret/body output', async () => {
  const rows = [
    {
      _id: 'doc',
      projectId: 'p',
      storageId: 'legacy',
      digest: hash,
      size: 7,
      archiveReceipt: { storageId: 'legacy2', size: 4 },
      cursor: JSON.stringify({ id: 'legacy3' }),
      secret: 'private text',
      unicode: 'é🦊',
    },
  ];
  const q = {
    order: () => q,
    paginate: async opts => {
      assert.equal(opts.numItems, 512);
      return { page: rows, isDone: true, continueCursor: '' };
    },
  };
  const page = await auditPage(
    { db: { query: () => q, system: { normalizeId: (_, v) => (v.startsWith('legacy') ? v : null) } } },
    'imports',
    null,
  );
  assert.deepEqual(
    page.references.map(r => r.storageId),
    ['legacy', 'legacy2', 'legacy3'],
  );
  assert.equal(page.jsonBytes, Buffer.byteLength(JSON.stringify(rows[0])));
  assert.equal(JSON.stringify(page).includes('private text'), false);
  assert.match(pageSource('imports', null, 512), /maximumBytesRead/);
  assert.throws(() => pageSource('x);evil', null, 512));
});

test('planner counts physical bytes once, documents once, and never treats a location flag as verification', () => {
  const storage = [
    { _id: 'legacy', size: 7 },
    { _id: 'orphan', size: 11, contentType: 'application/gzip' },
  ];
  let report = classifyStorage(storage, [ref, { ...ref, field: 'nested.storageId' }]);
  assert.equal(report.total.bytes, 18);
  assert.equal(report.total.referencingDocuments, 1);
  assert.equal(report.files[0].verified, 'unknown');
  report = classifyStorage(storage, [ref], new Map([['key', 7]]));
  assert.equal(report.files[0].action, 'delete duplicate');
  assert.equal(report.files[1].action, 'investigate');
  assert.equal(classifyStorage(storage, [ref], new Map()).files[0].action, 'migrate to R2 then delete');
  assert.equal(classifyStorage(storage, [ref], new Map([['key', 8]])).files[0].verified, 'mismatch');
  assert.equal(classifyStorage([], [ref], new Map()).unresolvedIdCandidates.length, 1);
  assert.equal(classifyStorage([], [ref], new Map()).total.referencingDocuments, 0);
});

test('fully pages beyond 8192, every table, one call/page, private resumable evidence and offline dry-run plan', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'forge-storage-audit-'));
  try {
    let calls = 0;
    const command = {
      operation: 'inventory',
      deployment: 'dev:example',
      out: join(dir, 'report.json'),
      withR2: false,
    };
    const report = await audit(command, {
      tables: async () => ['projectObjects', 'projectSourceSteps', 'imports'],
      page: async source => {
        const args = /\(ctx,("[^"]+"),(null|"[^"]*"),1024/.exec(source);
        const table = JSON.parse(args[1]),
          cursor = JSON.parse(args[2]);
        calls++;
        const offset = Number(cursor ?? 0),
          count = table === '_storage' ? Math.min(1024, 9300 - offset) : 0;
        return {
          documents: count,
          jsonBytes: count * 100,
          groups: {},
          references: [],
          projects: [],
          storage: Array.from({ length: count }, (_, i) => ({ _id: `f${offset + i}`, size: 1 })),
          isDone: table !== '_storage' || offset + count === 9300,
          cursor: String(offset + count),
        };
      },
    });
    assert.equal(report.total.files, 9300);
    assert.equal(calls, 13);
    assert.equal(report.metrics.calls, calls);
    assert.equal((await plan(command.out)).writes, 0);
    assert.equal(JSON.parse(await readFile(command.out + '.state.json')).complete, true);
    assert.ok(costEstimate({ calls: 4500, jsonBytes: 2e9, r2Lists: 1000 }) < 1);
    await assert.rejects(audit({ ...command, resume: true }, {}), /AUDIT_STATE_INVALID/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('rejects execution and production flags, incomplete evidence, and non-advancing cursors', async () => {
  for (const flag of ['--execute', '--apply', '--prod'])
    assert.throws(() => parseAudit(['plan', '--out', '/tmp/private.json', flag]));
  assert.throws(() =>
    parseAudit(['inventory', '--deployment', 'prod:example', '--out', '/tmp/private.json']),
  );
  const dir = await mkdtemp(join(tmpdir(), 'forge-storage-audit-'));
  try {
    await assert.rejects(
      audit(
        { deployment: 'dev:example', out: join(dir, 'r') },
        {
          tables: async () => [],
          page: async () => ({ documents: 0, references: [], isDone: false, cursor: null }),
        },
      ),
      /AUDIT_PAGE_INVALID/,
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('R2 listing verifies size in bounded pages, never downloads file bodies, rejects repeated cursors', async () => {
  const found = [],
    methods = [];
  const metrics = await listR2(
    { R2_ACCOUNT_ID: 'fake', R2_BUCKET: 'fake', R2_ACCESS_KEY_ID: 'fake', R2_SECRET_ACCESS_KEY: 'fake' },
    (...v) => found.push(v),
    async (url, options) => {
      methods.push(options.method ?? 'GET');
      assert.ok(new URL(url).searchParams.has('list-type'));
      return new Response(
        '<ListBucketResult><Contents><Key>v1%2Fp%2Fx</Key><Size>7</Size></Contents><IsTruncated>false</IsTruncated></ListBucketResult>',
      );
    },
  );
  assert.deepEqual(found, [['v1/p/x', 7]]);
  assert.equal(metrics.pages, 1);
  assert.deepEqual(methods, ['GET']);
});

test('a size-matched object still needs pointer migration when readers use Convex; unreferenced hash copies stay investigate', () => {
  const storage = [{ _id: 'legacy', size: 7, sha256: hash }];
  const r2 = new Map([
    ['key', 7],
    [`v1/p/p/o/${hash}`, 7],
  ]);
  const report = classifyStorage(storage, [{ ...ref, location: 'convex' }], r2);
  assert.equal(report.files[0].verified, 'yes-size');
  assert.equal(report.files[0].action, 'migrate to R2 then delete');
  const orphan = classifyStorage(storage, [], r2).files[0];
  assert.equal(orphan.verified, 'yes-size');
  assert.equal(orphan.action, 'investigate');
});

test('interrupted page retains attempt count and resumes without recounting previous pages', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'forge-storage-audit-'));
  const command = { deployment: 'dev:example', out: join(dir, 'audit'), withR2: false };
  const empty = {
    documents: 0,
    jsonBytes: 0,
    groups: {},
    references: [],
    projects: [],
    storage: [],
    cursor: '',
    isDone: true,
  };
  try {
    let count = 0;
    await assert.rejects(
      audit(command, {
        tables: async () => ['imports'],
        page: async () => {
          if (++count === 2) throw new Error('NETWORK');
          return empty;
        },
      }),
      /NETWORK/,
    );
    const state = JSON.parse(await readFile(command.out + '.state.json'));
    assert.equal(state.metrics.calls, 2);
    assert.equal(state.tableIndex, 1);
    const report = await audit({ ...command, resume: true }, { page: async () => empty });
    assert.equal(report.metrics.calls, 3);
    assert.equal(report.coverage.fullyPaged, true);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('R2 inventory continues beyond 1000 pages and stops only at the requested spend budget', async () => {
  const config = {
    R2_ACCOUNT_ID: 'fake',
    R2_BUCKET: 'fake',
    R2_ACCESS_KEY_ID: 'fake',
    R2_SECRET_ACCESS_KEY: 'fake',
  };
  let pages = 0;
  const result = await listR2(
    config,
    () => {},
    async () => {
      pages++;
      return new Response(
        `<ListBucketResult><IsTruncated>${pages < 1001}</IsTruncated><NextContinuationToken>${pages}</NextContinuationToken></ListBucketResult>`,
      );
    },
  );
  assert.equal(result.pages, 1001);
  await assert.rejects(
    listR2(
      config,
      () => {},
      async () => {
        assert.fail('budget must stop before network');
      },
      0,
    ),
    /AUDIT_ESTIMATE_EXCEEDED/,
  );
});

test('normalization calls depend on observed ID lengths, not large Work strings, and nested errors propagate', async () => {
  let normalizations = 0;
  const data = [
    { _id: 'doc', value: JSON.stringify({ text: 'x'.repeat(1_000_000), digest: hash, cursor: 'legacy' }) },
  ];
  const q = { order: () => q, paginate: async () => ({ page: data, isDone: true, continueCursor: '' }) };
  const ctx = {
    db: {
      query: () => q,
      system: {
        normalizeId: (_, value) => {
          normalizations++;
          return value === 'legacy' ? value : null;
        },
      },
    },
  };
  const page = await auditPage(ctx, 'projectWorkRecords', null, 1024, [6]);
  assert.equal(page.references.length, 1);
  assert.equal(normalizations, 1);
  ctx.db.system.normalizeId = () => {
    throw new Error('NORMALIZE_FAILED');
  };
  await assert.rejects(auditPage(ctx, 'projectWorkRecords', null, 1024, [6]), /NORMALIZE_FAILED/);
});
