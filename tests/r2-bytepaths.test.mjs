// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { getFunctionName } from 'convex/server';
import { setup, pinOf } from './r2-harness.mjs';
import { backupPreview } from './project-backup-fixture.mjs';
import { moduleUrl } from './convex-module.mjs';
import { putR2 } from '../dist/exchange-blobs.js';
import { downloadArchiveFile } from '../dist/archive-download-file.js';
import { digest, graphIdentity } from '../dist/hash.js';
import { fixture, git } from './helpers.mjs';
import { capture } from '../dist/snapshot.js';
import { analyze } from '../dist/analyze.js';
import { encodeHostedArtifact } from '../dist/hosted-artifact.js';
import { hostedQuery } from '../dist/hosted-query.js';
const transfer = await import(moduleUrl('../convex/backupTransfer.ts'));
const backups = await import(moduleUrl('../convex/projectBackups.ts'));
const actions = await import(moduleUrl('../convex/projectBackupActions.ts'));
const proposalStore = await import(moduleUrl('../convex/projectProposals.ts'));
const proposals = await import(moduleUrl('../convex/projectProposalActions.ts'));
const { indexedHostedQuery } = await import(moduleUrl('../convex/hostedQueryIndex.ts'));
const { blobStore } = await import(moduleUrl('../convex/blobStore.ts'));
const derived = await import(moduleUrl('../convex/derivedArtifacts.ts'));
const { derivedArtifact } = await import(moduleUrl('../convex/derivedArtifactActions.ts'));
const { snapshotDownload } = await import(moduleUrl('../web/src/snapshot.ts'));
const lifecycle = await import(moduleUrl('../convex/lifecycleActions.ts'));
const { job, providers } = await import('./hosted-fixture.mjs');
const code = expected => e => (e.data?.code ?? e.code) === expected;
function seed(s, pin) {
  const run = s.ctx.runQuery;
  s.ctx.runQuery = (ref, args) =>
    getFunctionName(ref).startsWith('projectProposals:')
      ? proposalStore[getFunctionName(ref).split(':')[1]]._handler(s.ctx, args)
      : run(ref, args);
  s.tables.projectBackups.set('backup', {
    _id: 'backup',
    _creationTime: 1,
    projectId: 'project',
    operationId: 'original',
    status: 'uploading',
    previous: null,
    preview: backupPreview(),
    nonce: 'original',
    request: 'original',
    ...pin,
  });
  s.ctx.storage.store = () => assert.fail('new archives never write Convex bytes');
  s.ctx.storage.generateUploadUrl = () => assert.fail('new archives never issue Convex upload URLs');
}

function inputFor(s, pin) {
  const project = s.tables.hostedProjects.get('project'),
    row = s.tables.projectBackups.get('backup');
  const p = {
    manifestDigest: 'a'.repeat(64),
    head: 'b'.repeat(64),
    format: 'native',
    revision: 0,
    intents: 0,
    lanes: 0,
    views: 0,
    runs: 0,
    files: 0,
    unavailable: 0,
    channels: [],
  };
  const input = {
    key: project.key,
    name: project.name,
    operationId: randomUUID(),
    previous: null,
    ...pin,
    preview: p,
  };
  row.operationId = input.operationId;
  row.preview = p;
  row.request = digest(
    JSON.stringify([
      input.key,
      input.name,
      input.operationId,
      null,
      input.digest,
      input.size,
      p.manifestDigest,
      p.head,
      p.format,
      p.revision,
      p.intents,
      p.lanes,
      p.views,
      p.runs,
      p.files,
      p.unavailable,
      [],
    ]),
  );
  return input;
}
test('R2 backup upload, unknown commit reply reconciliation and browser/native restore use exact bytes without Convex storage', async t => {
  const { s, fake } = await setup(t, { optIn: false }),
    bytes = Buffer.alloc(3 * 1024 * 1024 + 7, 'x'),
    pin = pinOf(bytes);
  seed(s, pin);
  const input = inputFor(s, pin),
    { target } = await transfer.prepare._handler(s.ctx, input);
  const complete = () => transfer.complete._handler(s.ctx, { id: 'backup', projectId: 'project', ...pin });
  assert.equal(target.kind, 'r2');
  await assert.rejects(complete(), code('R2_OBJECT_MISSING'));
  await putR2(target, bytes);
  const overwrite = await fetch(target.url, { method: 'PUT', headers: target.headers, body: bytes });
  assert.equal(overwrite.status, 412);
  const mutation = s.ctx.runMutation;
  let lost = true;
  s.ctx.runMutation = async (ref, args) => {
    const result = await mutation(ref, args);
    if (lost && getFunctionName(ref) === 'projectBackups:completeR2') {
      lost = false;
      throw Error('lost commit reply');
    }
    return result;
  };
  await assert.rejects(complete(), code('HOSTED_REQUEST_FAILED'));
  assert.equal((await actions.reconcileUpload._handler(s.ctx, { id: 'backup' })).status, 'stored');
  s.ctx.db.system.query = () => assert.fail('R2 reconciliation never scans _storage');
  await actions.reconcileUpload._handler(s.ctx, { id: 'backup' });
  let calls = 0;
  const read = _offset => {
    calls++;
    return transfer.sign._handler(s.ctx, { id: 'backup', digest: pin.digest });
  };
  const browser = await snapshotDownload(async offset => ({
    ...(await read(offset)),
    contentType: 'application/gzip',
    repository: 'fixture',
    head: 'a'.repeat(64),
  }));
  assert.equal(calls, 1);
  assert.deepEqual(Buffer.from(await browser.blob.arrayBuffer()), bytes);
  const directory = mkdtempSync(join(tmpdir(), 'forge-r2-archive-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  calls = 0;
  await downloadArchiveFile({ sha256: pin.digest, size: bytes.length }, join(directory, 'archive'), read);
  assert.equal(calls, 1);
  assert.deepEqual(readFileSync(join(directory, 'archive')), bytes);
  const key = s.tables.projectBackups.get('backup').r2Key;
  fake.corrupt.add(fake.key(key));
  await assert.rejects(
    snapshotDownload(async offset => ({
      ...(await read(offset)),
      contentType: 'application/gzip',
      repository: 'fixture',
      head: 'a'.repeat(64),
    })),
    /integrity/,
  );
  await assert.rejects(
    downloadArchiveFile({ sha256: pin.digest, size: pin.size }, join(directory, 'corrupt'), read),
    code('INVALID_WORK_BACKUP'),
  );
  assert.equal(s.files.size, 0);
  assert.equal(s.scheduled.length, 0);
  s.caller('outsider');
  await assert.rejects(read(0), code('PROJECT_UNAVAILABLE'));
  await assert.rejects(transfer.prepare._handler(s.ctx, input), code('ARCHIVE_TRANSPORT_RETIRED'));
  await assert.rejects(complete(), code('PROJECT_UNAVAILABLE'));
});

test('500 MiB archives sign in constant calls with 32000 unrelated objects, no body allocation and no legacy sweep', async t => {
  const { s, fake } = await setup(t),
    pin = { digest: 'a'.repeat(64), size: 500 * 1024 * 1024 };
  seed(s, pin);
  for (let n = 0; n < 32000; n++)
    s.tables.projectObjects.set(`unrelated-${n}`, {
      _id: `unrelated-${n}`,
      projectId: 'other',
      digest: String(n),
    });
  let documentsRead = 0,
    documentsWritten = 0;
  const getDoc = s.ctx.db.get,
    insertDoc = s.ctx.db.insert,
    patchDoc = s.ctx.db.patch,
    queryDocs = s.ctx.db.query;
  s.ctx.db.get = async (...args) => {
    const row = await getDoc(...args);
    if (row) documentsRead++;
    return row;
  };
  s.ctx.db.insert = (...args) => {
    documentsWritten++;
    return insertDoc(...args);
  };
  s.ctx.db.patch = (...args) => {
    documentsWritten++;
    return patchDoc(...args);
  };
  s.ctx.db.query = (...args) => {
    const builder = queryDocs(...args),
      unique = builder.unique,
      take = builder.take;
    builder.unique = async (...input) => {
      const row = await unique(...input);
      if (row) documentsRead++;
      return row;
    };
    builder.take = async (...input) => {
      const rows = await take(...input);
      documentsRead += rows.length;
      return rows;
    };
    return builder;
  };
  const before = process.memoryUsage(),
    started = performance.now();
  let calls = 0,
    bodyReads = 0;
  const query = s.ctx.runQuery,
    mutation = s.ctx.runMutation;
  s.ctx.runQuery = (...args) => {
    calls++;
    return query(...args);
  };
  s.ctx.runMutation = (...args) => {
    calls++;
    return mutation(...args);
  };
  s.ctx.storage.get = () => {
    bodyReads++;
    assert.fail('archive body must bypass actions');
  };
  s.ctx.db.system.query = () => assert.fail('no _storage scans for R2 archives');
  const input = inputFor(s, pin);
  await transfer.prepare._handler(s.ctx, input);
  const complete = () => transfer.complete._handler(s.ctx, { id: 'backup', projectId: 'project', ...pin });
  const row = s.tables.projectBackups.get('backup');
  const fetch = globalThis.fetch;
  globalThis.fetch = async (url, init) =>
    init?.method === 'HEAD'
      ? new Response(null, {
          headers: {
            'content-length': String(pin.size),
            'x-amz-checksum-sha256': Buffer.from(pin.digest, 'hex').toString('base64'),
          },
        })
      : fetch(url, init);
  t.after(() => {
    globalThis.fetch = fetch;
  });
  await complete();
  const signed = await transfer.sign._handler(s.ctx, { id: 'backup', digest: pin.digest });
  assert.equal(signed.direct, true);
  assert.equal(signed.data.byteLength, 0);
  assert.equal(bodyReads, 0);
  assert.equal(
    calls,
    2,
    'HEAD action resolves and commits once; prepare/sign authorize in their own transactions',
  );
  assert.equal(s.scheduled.length, 0);
  assert.equal(fake.requests.length, 0, 'synthetic HEAD fixture moves no archive body');
  assert.equal(row.r2Committed, true);
  assert(documentsRead < 40 && documentsWritten < 10, 'constant document budget at dogfood scale');
  const memory = process.memoryUsage();
  assert(memory.arrayBuffers - before.arrayBuffers < 8 * 1024 * 1024);
  t.diagnostic(
    JSON.stringify({
      archiveBytes: pin.size,
      clientOperations: 3,
      totalFunctionCalls: 3 + calls,
      nestedCalls: calls,
      documentsRead,
      documentsWritten,
      convexBodyBytes: 0,
      arrayBufferGrowth: memory.arrayBuffers - before.arrayBuffers,
      wallMs: Math.round(performance.now() - started),
    }),
  );
});

test('archive HEAD refuses wrong size/checksum and a proposal download signs its committed archive', async t => {
  const { s, fake } = await setup(t),
    pin = pinOf('original bytes');
  seed(s, pin);
  const target = await backups.uploadUrl._handler(s.ctx, { id: 'backup', owner: 'owner' }),
    row = s.tables.projectBackups.get('backup');
  fake.objects.set(fake.key(row.r2Key), Buffer.from('short'));
  await assert.rejects(actions.complete._handler(s.ctx, { id: 'backup' }), code('R2_OBJECT_SIZE_MISMATCH'));
  fake.objects.set(fake.key(row.r2Key), Buffer.from('different byte'));
  await assert.rejects(
    actions.complete._handler(s.ctx, { id: 'backup' }),
    code('R2_OBJECT_CHECKSUM_MISMATCH'),
  );
  fake.objects.delete(fake.key(row.r2Key));
  await putR2(target, Buffer.from('original bytes'));
  await actions.complete._handler(s.ctx, { id: 'backup' });
  s.tables.projectProposals.set('proposal', { ...row, _id: 'proposal', status: 'stored', actor: 'owner' });
  const part = await proposals.downloadPart._handler(s.ctx, {
    id: 'proposal',
    offset: 0,
    digest: pin.digest,
  });
  assert.equal(part.direct, true);
  assert.equal(digest(Buffer.from(await (await fetch(part.url)).arrayBuffer())), pin.digest);
  await assert.rejects(
    proposals.downloadPart._handler(s.ctx, { id: 'proposal', offset: 0, digest: 'wrong' }),
    code('PROJECT_CHANGED'),
  );
});

test('import archives sign R2 bytes and preserve a legacy storage row without new writes', async t => {
  const { s } = await setup(t),
    bytes = Buffer.from('archive bytes');
  const ref = await blobStore(s.ctx).store(new Blob([bytes], { type: 'application/gzip' }), {
    r2Namespace: 'v1/i/own/g/1',
  });
  s.tables.imports.set('own', { ...job(), artifactKey: ref });
  t.after(providers());
  const part = await lifecycle.downloadPart._handler(s.ctx, { id: 'own', offset: 0 });
  assert.equal(part.direct, true);
  assert.deepEqual(Buffer.from(await (await fetch(part.url)).arrayBuffer()), bytes);
  s.file('legacy', new Blob([bytes], { type: 'application/gzip' }));
  s.tables.imports.get('own').artifactKey = 'legacy';
  const legacy = await lifecycle.downloadPart._handler(s.ctx, { id: 'own', offset: 0 });
  assert.equal(legacy.direct, undefined);
  assert.deepEqual(Buffer.from(legacy.data), bytes);
});

test('new R2 derivatives remove without scheduling a storage sweep; legacy manual sweep stays bounded', async t => {
  const { s } = await setup(t);
  s.file('original', new Blob(['original']));
  const value = await derivedArtifact(
    s.ctx,
    'original',
    'zone-export-v1',
    '',
    async () => new Blob(['export']),
    async () => {},
  );
  await derived.removeDerived(s.ctx, 'original');
  assert(
    s.scheduled.every(entry =>
      getFunctionName(entry.ref ?? entry.handler ?? entry.fn).includes('artifactStorage'),
    ),
  );
  assert.equal(s.tables.derivedArtifacts.get(value._id).removed, true);
});

test('2800-file import index decodes the original once across different endpoints and verifies selected source ranges', async t => {
  const { s, fake } = await setup(t);
  const files = Object.fromEntries(
    Array.from({ length: 2800 }, (_, i) => [`f${i}.ts`, `export const value${i} = ${i};\n`]),
  );
  const root = fixture(t, files);
  git(root, ['add', '.']);
  git(root, ['commit', '-qm', 'Synthetic import index']);
  const snapshot = capture(root),
    templateRoot = fixture(t, { 'f0.ts': files['f0.ts'] }),
    template = analyze(capture(templateRoot)),
    body = {
      ...template,
      source: snapshot.source,
      nodes: snapshot.source.files.flatMap(file =>
        template.nodes.map((node, i) => ({
          ...node,
          id: `${file.path}:${i}`,
          locator: { ...node.locator, file: file.path, digest: file.digest },
        })),
      ),
      imports: [],
      references: [],
      issues: [],
    };
  delete body.id;
  const artifact = {
    pack: { ...body, id: graphIdentity(body) },
    content: Object.fromEntries(snapshot.content),
    documents: {},
    repository: {
      full_name: 'example/project',
      private: true,
      html_url: 'https://github.com/example/project',
      default_branch: 'main',
      license: null,
    },
  };
  s.file('original', await encodeHostedArtifact(artifact));
  const get = s.ctx.storage.get;
  let originalReads = 0,
    checks = 0,
    calls = 0;
  s.ctx.storage.get = id => {
    if (id === 'original') originalReads++;
    return get(id);
  };
  const run = s.ctx.runQuery,
    mutate = s.ctx.runMutation,
    act = s.ctx.runAction;
  s.ctx.runQuery = (...args) => {
    calls++;
    return run(...args);
  };
  s.ctx.runMutation = (...args) => {
    calls++;
    return mutate(...args);
  };
  s.ctx.runAction = (...args) => {
    calls++;
    return act(...args);
  };
  const started = performance.now(),
    actionMemory = process.memoryUsage();
  for (const endpoint of [
    'files?limit=10',
    'graph?limit=20',
    'source?file=f10.ts&start=1&end=1',
    'declarations?file=f20.ts',
  ]) {
    const actual = await indexedHostedQuery(
      s.ctx,
      'original',
      endpoint,
      snapshot.source.gitHead,
      artifact.repository,
      async () => {
        checks++;
      },
    );
    assert.deepEqual(actual, hostedQuery(artifact, endpoint, snapshot.source.gitHead));
  }
  assert.equal(originalReads, 1);
  assert(
    process.memoryUsage().heapUsed - actionMemory.heapUsed < 128 * 1024 * 1024,
    'index action allocations stay bounded',
  );
  assert(performance.now() - started < 60_000, 'index action completes within its budget');
  assert(checks >= 4);
  assert(calls < 70, `bounded index calls, observed ${calls}`);
  const ranges = fake.requests.filter(r => r.method === 'GET' && r.status === 206);
  assert.equal(ranges.length, 1);
  t.diagnostic(
    JSON.stringify({
      files: 2800,
      calls,
      originalReads,
      wallMs: Math.round(performance.now() - started),
      peakRssBytes: process.resourceUsage().maxRSS * 1024,
      indexBytes: [...s.tables.derivedArtifacts.values()].find(r => r.kind === 'hosted-query-index-v1').size,
    }),
  );
  await assert.rejects(
    indexedHostedQuery(
      s.ctx,
      'original',
      'source?file=__proto__',
      snapshot.source.gitHead,
      artifact.repository,
      async () => {},
    ),
    code('SOURCE_NOT_INDEXED'),
  );
  const contentRecord = [...s.tables.derivedArtifacts.values()].find(
    row => row.kind === 'hosted-query-content-v1',
  );
  const contentBlob = s.tables.artifactBlobs.get(contentRecord.storageId.slice(7));
  fake.corrupt.add(fake.key(contentBlob.r2Key));
  await assert.rejects(
    indexedHostedQuery(
      s.ctx,
      'original',
      'source?file=f0.ts&start=1&end=1',
      snapshot.source.gitHead,
      artifact.repository,
      async () => {},
    ),
    code('ARTIFACT_INTEGRITY'),
  );
});

test('native recovery signs once and streams a verified R2 archive without a range action', async t => {
  const priorToken = process.env.FORGE_AUTH_TOKEN;
  process.env.FORGE_AUTH_TOKEN = 'synthetic-r2-recovery';
  t.after(() => {
    if (priorToken === undefined) delete process.env.FORGE_AUTH_TOKEN;
    else process.env.FORGE_AUTH_TOKEN = priorToken;
  });
  const { recoveryTransport } = await import('../dist/recovery-transport.js');
  const { s } = await setup(t),
    bytes = Buffer.from('native recovery archive'),
    pin = pinOf(bytes);
  seed(s, pin);
  const input = inputFor(s, pin),
    prepared = await transfer.prepare._handler(s.ctx, input);
  await putR2(prepared.target, bytes);
  await transfer.complete._handler(s.ctx, { id: 'backup', projectId: 'project', ...pin });
  const transport = recoveryTransport({
    url: 'https://example.convex.cloud',
    projectId: 'project',
    operationId: randomUUID(),
  });
  let signs = 0;
  transport.client = {
    mutation: (ref, args) => {
      assert.equal(getFunctionName(ref), 'backupTransfer:sign');
      signs++;
      return transfer.sign._handler(s.ctx, args);
    },
    action: () => assert.fail('R2 archive recovery must not call a range action'),
  };
  const directory = mkdtempSync(join(tmpdir(), 'forge-native-r2-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  await transport.archive(
    { backupId: 'backup', checkpointSha256: pin.digest, checkpointSize: pin.size },
    join(directory, 'archive'),
  );
  assert.equal(signs, 1);
  assert.deepEqual(readFileSync(join(directory, 'archive')), bytes);
});

test('the retained legacy derived sweep reads one 100-file metadata page without a continuation task', async t => {
  const { s } = await setup(t),
    uploadType = 'application/x-forge-derived-legacy';
  const id = await s.ctx.db.insert('derivedArtifacts', {
    original: 'old',
    kind: 'export',
    pin: '',
    originalDigest: digest('old'),
    originalSize: 3,
    digest: digest('bound'),
    size: 5,
    removed: true,
    uploadType,
    contentType: 'application/gzip',
  });
  for (let n = 0; n < 150; n++) {
    s.file(`legacy-${n}`, new Blob(['unrelated'], { type: 'application/gzip' }));
    s.files.get(`legacy-${n}`).metadata._creationTime = Date.now() + n + 100;
  }
  const query = s.ctx.db.system.query;
  let pages = 0,
    scanned = 0;
  s.ctx.db.system.query = (...args) => {
    const result = query(...args),
      order = result.order;
    result.order = (...input) => {
      const ordered = order(...input),
        paginate = ordered.paginate;
      ordered.paginate = async options => {
        assert.equal(options.numItems, 100);
        pages++;
        const page = await paginate(options);
        scanned += page.page.length;
        return page;
      };
      return ordered;
    };
    return result;
  };
  const result = await derived.sweep._handler(s.ctx, { id, cursor: null, followup: false });
  assert.equal(pages, 1);
  assert.equal(scanned, 100);
  assert.equal(result.isDone, false);
  assert.equal(s.scheduled.length, 0);
});
