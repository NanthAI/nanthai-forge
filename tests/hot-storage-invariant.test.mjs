// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import ts from 'typescript';
import { moduleUrl } from './convex-module.mjs';
import { fakeSourceR2 } from './convex-source-r2-fixture.mjs';
import { digest } from '../dist/hash.js';
const { storeSourceBytes } = await import(moduleUrl('../convex/projectSourceBytes.ts'));
const { mirrorSource } = await import(moduleUrl('../convex/projectGithubMirror.ts'));
const { blobStore } = await import(moduleUrl('../convex/blobStore.ts'));

// The one guard for "bytes go to R2; Convex holds records" (docs/data-placement.md).
// Each entry permits exactly `count` uses of one kind in one convex/ file, with an
// owner reason and an expiry date. New uses, expired entries and stale counts fail.
//   write  storage.store / generateUploadUrl (Convex file-storage writes)
//   read   storage.get / storage.getUrl (Convex file-storage byte reads)
//   handle a ctx.storage handle passed on, which could write or read elsewhere
//   field  v.id('_storage') (a record that names a Convex file)
const legacy =
  'Convex file storage cleanup (Issue 40dad5e0): legacy Convex copies stay readable until moved and deleted.';
const storageAllowlist = {
  'blobStore.ts handle': [
    1,
    'Blob reader: legacy ids read Convex storage; every write goes to R2.',
    '2027-01-31',
  ],
  'blobStore.ts read': [2, legacy, '2027-01-31'],
  'projectConvexSource.ts read': [1, legacy, '2027-01-31'],
  'projectConvexSourceStorage.ts read': [1, legacy, '2027-01-31'],
  'projectGithubMirror.ts read': [1, legacy, '2027-01-31'],
  'projectR2Backfill.ts read': [
    1,
    'Backfill signs a download of each legacy Convex copy it moves to R2.',
    '2027-01-31',
  ],
  'projectWorkIndexRetry.ts read': [2, legacy, '2027-01-31'],
  'projectWorkIndexRetry.ts handle': [
    1,
    'Wraps the storage reader with retry for legacy Work index reads.',
    '2027-01-31',
  ],
  'storageMeter.ts read': [1, 'Meters legacy Convex byte reads (Convex File Storage egress).', '2027-01-31'],
  'storageMeter.ts handle': [1, 'Wraps the storage reader to meter legacy reads.', '2027-01-31'],
  'projectBackupActions.ts field': [1, legacy, '2027-01-31'],
  'projectBackups.ts field': [2, legacy, '2027-01-31'],
  'projectBootstrapStore.ts field': [
    1,
    'Legacy storageId result beside r2Key; nothing new writes it.',
    '2027-01-31',
  ],
  'projectExchange.ts field': [1, legacy, '2027-01-31'],
  'projectGithubImportBatch.ts field': [
    1,
    'Legacy storageId import receipts beside R2 keys; nothing new writes them.',
    '2027-01-31',
  ],
  'projectGithubImportObjects.ts field': [
    1,
    'Legacy storageId import receipts beside R2 keys; nothing new writes them.',
    '2027-01-31',
  ],
  'projectHostedActionsPlan.ts field': [2, legacy, '2027-01-31'],
  'projectHostedFinishDriver.ts field': [1, legacy, '2027-01-31'],
  'projectLifecycle.ts field': [1, legacy, '2027-01-31'],
  'projectObjectFields.ts field': [1, legacy, '2027-01-31'],
  'projectProposalActions.ts field': [1, legacy, '2027-01-31'],
  'projectProposals.ts field': [3, legacy, '2027-01-31'],
  'projectR2Backfill.ts field': [1, 'Backfill maps each legacy Convex id to its moved R2 row.', '2027-01-31'],
  'projectSourceStepFields.ts field': [1, legacy, '2027-01-31'],
  'projectWorkIndexFields.ts field': [2, legacy, '2027-01-31'],
  'r2BackfillFields.ts field': [1, 'Backfill pins name the legacy Convex id they move.', '2027-01-31'],
  'schema.ts field': [3, legacy, '2027-01-31'],
};
const storageCalls = { store: 'write', generateUploadUrl: 'write', get: 'read', getUrl: 'read' };
const isStorage = node =>
  (ts.isPropertyAccessExpression(node) && node.name.text === 'storage') ||
  (ts.isIdentifier(node) && node.text === 'storage') ||
  (ts.isNonNullExpression(node) && isStorage(node.expression));
function storageUses(name, source) {
  const uses = [];
  const visit = (node, parent) => {
    if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)) {
      const method = node.expression.name.text,
        receiver = node.expression.expression,
        literal = node.arguments[0];
      if (method === 'generateUploadUrl' || (isStorage(receiver) && storageCalls[method]))
        uses.push(method === 'generateUploadUrl' ? 'write' : storageCalls[method]);
      else if (method === 'id' && ts.isIdentifier(receiver) && receiver.text === 'v' && literal)
        if (ts.isStringLiteralLike(literal) && literal.text === '_storage') uses.push('field');
    }
    // Any other `x.storage` value (argument, spread, alias) is a handle that can escape this guard.
    if (
      ts.isPropertyAccessExpression(node) &&
      node.name.text === 'storage' &&
      !(parent && ts.isPropertyAccessExpression(parent) && parent.expression === node) &&
      !(parent && ts.isNonNullExpression(parent))
    )
      uses.push('handle');
    ts.forEachChild(node, child => visit(child, node));
  };
  visit(ts.createSourceFile(name, source, ts.ScriptTarget.Latest), undefined);
  return uses;
}
function storageFindings(files, allowlist = storageAllowlist, today = new Date().toISOString().slice(0, 10)) {
  const counts = {};
  for (const [name, source] of files)
    for (const kind of storageUses(name, source))
      counts[`${name} ${kind}`] = (counts[`${name} ${kind}`] ?? 0) + 1;
  const findings = [];
  for (const [key, count] of Object.entries(counts)) {
    const entry = allowlist[key];
    if (!entry) findings.push(`${key}: ${count} unlisted; bytes go to R2 (docs/data-placement.md)`);
    else if (count !== entry[0]) findings.push(`${key}: ${count} found, allowlist says ${entry[0]}`);
  }
  for (const [key, [count, reason, expires]] of Object.entries(allowlist)) {
    if (!(key in counts)) findings.push(`${key}: allowlisted but unused; remove it`);
    if (
      !Number.isSafeInteger(count) ||
      count < 1 ||
      !reason?.trim() ||
      !/^\d{4}-\d{2}-\d{2}$/.test(expires ?? '')
    )
      findings.push(`${key}: entry needs a count, a reason and an expiry date`);
    else if (expires < today)
      findings.push(`${key}: expired ${expires}; remove the use or renew it with a reason`);
  }
  return findings;
}
const convexFiles = () =>
  readdirSync(new URL('../convex', import.meta.url))
    .filter(x => x.endsWith('.ts'))
    .map(name => [name, readFileSync(new URL(`../convex/${name}`, import.meta.url), 'utf8')]);

test('Convex file storage is reached only through dated allowlist entries', () => {
  assert.deepEqual(storageFindings(convexFiles()), []);
});

test('the storage guard fails on a new write, read, handle or field and on expired entries', () => {
  const fixture = [
    'export async function leak(ctx) {',
    '  await ctx.storage.store(new Blob([]));',
    '  await ctx.storage.generateUploadUrl();',
    '  await ctx.storage.get(id);',
    '  const alias = ctx.storage;',
    "  return v.id('_storage');",
    '}',
  ].join('\n');
  assert.deepEqual(storageFindings([['leak.ts', fixture]], {}), [
    'leak.ts write: 2 unlisted; bytes go to R2 (docs/data-placement.md)',
    'leak.ts read: 1 unlisted; bytes go to R2 (docs/data-placement.md)',
    'leak.ts handle: 1 unlisted; bytes go to R2 (docs/data-placement.md)',
    'leak.ts field: 1 unlisted; bytes go to R2 (docs/data-placement.md)',
  ]);
  assert.deepEqual(
    storageFindings(
      [['seam.ts', 'storage.store(b)']],
      { 'seam.ts write': [1, 'Reason.', '2026-01-01'] },
      '2026-10-31',
    ),
    ['seam.ts write: expired 2026-01-01; remove the use or renew it with a reason'],
  );
  assert.deepEqual(storageFindings([['seam.ts', 'storage.store(b)']], { 'seam.ts write': [1, 'Reason.'] }), [
    'seam.ts write: entry needs a count, a reason and an expiry date',
  ]);
  assert.deepEqual(storageFindings([], { 'gone.ts read': [1, 'Reason.', '2099-01-01'] }), [
    'gone.ts read: allowlisted but unused; remove it',
  ]);
  // A Lane-local durable seam named something else is not Convex storage.
  assert.deepEqual(storageFindings([['ok.ts', 'durable.store(bytes); r2.get(key)']], {}), []);
});

test('docs/data-placement.md lists every allowlisted file and every Convex table', () => {
  const doc = readFileSync(new URL('../docs/data-placement.md', import.meta.url), 'utf8');
  for (const key of Object.keys(storageAllowlist)) {
    const file = key.split(' ')[0];
    assert(doc.includes(`convex/${file}`), `docs/data-placement.md must name convex/${file}`);
  }
  const tables = convexFiles().flatMap(([, source]) =>
    [...source.matchAll(/^\s+(\w+): defineTable\(/gm)].map(match => match[1]),
  );
  assert(tables.length > 100);
  for (const table of tables)
    assert(doc.includes(`\`${table}\``), `docs/data-placement.md must list ${table}`);
});

test('no deployment falls back to Convex storage, self-host included', async t => {
  const names = [
    'CONVEX_CLOUD_URL',
    'R2_ACCOUNT_ID',
    'R2_BUCKET',
    'R2_ACCESS_KEY_ID',
    'R2_SECRET_ACCESS_KEY',
  ];
  const saved = names.map(name => process.env[name]);
  t.after(() =>
    names.forEach((name, i) =>
      saved[i] === undefined ? delete process.env[name] : (process.env[name] = saved[i]),
    ),
  );
  for (const name of names) delete process.env[name];
  const storage = {
    store: () => assert.fail('Convex storage.store'),
    generateUploadUrl: () => assert.fail('Convex generateUploadUrl'),
  };
  const code = expected => error => (error.data?.code ?? error.code) === expected;
  // A native self-hosted backend (loopback origin) has no Convex byte mode either.
  for (const origin of [
    undefined,
    'https://benevolent-wildebeest-974.convex.cloud',
    'https://forge.example.com',
    'http://127.0.0.1:3210',
  ]) {
    if (origin) process.env.CONVEX_CLOUD_URL = origin;
    await assert.rejects(blobStore({ storage }).store(new Blob(['x'])), code('R2_REQUIRED'));
    const bytes = Buffer.from('x');
    await assert.rejects(
      storeSourceBytes({ storage }, 'project', bytes, { sha256: digest(bytes), size: 1 }),
      code('R2_NOT_CONFIGURED'),
    );
  }
});

test('R2 check selections are reused by digest without another upload or Convex store', async t => {
  const r2 = fakeSourceR2(t),
    bytes = Buffer.from(JSON.stringify({ tests: ['test-a', 'test-b'] }));
  const pin = { sha256: digest(bytes), size: bytes.length },
    ctx = {
      storage: {
        store() {
          assert.fail('R2 check plan called storage.store');
        },
      },
    };
  const first = await storeSourceBytes(ctx, 'project', bytes, pin, true);
  assert.deepEqual(await storeSourceBytes(ctx, 'project', bytes, pin, true), first);
  assert.equal(r2.requests.filter(x => x === 'PUT').length, 1);
  assert.equal(r2.objects.size, 1);
});

test('a backfilled mirror object never reads the retained Convex copy', async t => {
  const r2 = fakeSourceR2(t),
    bytes = Buffer.from('mirror source'),
    sha256 = digest(bytes),
    key = `v1/p/project/o/${sha256}`;
  r2.objects.set(`/synthetic/${key}`, bytes);
  const ctx = {
    storage: {
      get() {
        assert.fail('R2 mirror read Convex bytes');
      },
    },
    async runQuery() {
      return JSON.stringify([
        {
          descriptor: { object: { sha256, size: bytes.length }, recipe: null },
          storageId: 'retained-legacy-copy',
          url: `https://synthetic.r2.cloudflarestorage.com/synthetic/${key}`,
        },
      ]);
    },
  };
  const [blob] = await mirrorSource(ctx, { jobId: 'job', step: 0 }).blobs([sha256]);
  assert.deepEqual(await blob.read(), bytes);
});

test('R2_ENDPOINT accepts only an https origin or a loopback http origin', async t => {
  const { r2Config, r2Endpoint, presignGet } = await import(moduleUrl('../convex/r2.ts'));
  const saved = process.env.R2_ENDPOINT;
  t.after(() => (saved === undefined ? delete process.env.R2_ENDPOINT : (process.env.R2_ENDPOINT = saved)));
  delete process.env.R2_ENDPOINT;
  assert.equal(r2Endpoint(r2Config()).host, `${process.env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com`);
  process.env.R2_ENDPOINT = 'http://127.0.0.1:9000';
  assert.match(await presignGet(r2Config(), 'k'), /^http:\/\/127\.0\.0\.1:9000\//);
  process.env.R2_ENDPOINT = 'https://objects.example.com';
  assert.deepEqual(r2Config().endpoint, { scheme: 'https', host: 'objects.example.com' });
  for (const bad of [
    'http://objects.example.com',
    'https://x.example.com/path',
    'https://u:p@x.example.com',
    'nope',
  ])
    assert.throws(
      () => {
        process.env.R2_ENDPOINT = bad;
        r2Config();
      },
      e => e.code === 'R2_NOT_CONFIGURED',
      bad,
    );
});
