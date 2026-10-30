// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { getFunctionName } from 'convex/server';
import { setup, client } from './r2-harness.mjs';
import { modules } from './project-exchange-fixture.mjs';
import { moduleUrl } from './convex-module.mjs';
import { ObjectDownloadReader } from '../dist/blob-download.js';
import { digest } from '../dist/hash.js';
import { buildObjectRecipe } from '../dist/object-chunks.js';
import { workArchiveMetadata } from '../dist/work-archive-metadata.js';
const { readBrowserSource, browserObjects } = await import(moduleUrl('../web/src/browser-source.ts'));
const { downloadObjectArchive } = await import(moduleUrl('../web/src/object-archive.ts'));
const { read: publicReview } = await import(moduleUrl('../convex/projectSourceReview.ts'));
const pin = bytes => ({ sha256: digest(bytes), size: bytes.length });
const code = expected => error => (error.data?.code ?? error.code) === expected;
const rawRow = (s, id) => [...s.tables.projectObjects.values()].find(row => row.digest === id);
function browser(s) {
  const calls = [];
  return {
    calls,
    async mutation(ref, args) {
      const [name, method] = getFunctionName(ref).split(':');
      calls.push({ name, method, args });
      return modules[name][method]._handler(s.ctx, args);
    },
  };
}
async function upload(s, bytes, r2 = true) {
  if (r2) process.env.FORGE_BLOBS = 'r2';
  else delete process.env.FORGE_BLOBS;
  const value = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes);
  await client(s).uploadBatch([{ pin: pin(value), bytes: value }]);
  return pin(value);
}
async function sourceFixture(t, locations = [true, false]) {
  const { s, fake } = await setup(t);
  const before = await upload(s, 'export const value = 1;\n', locations[0]),
    after = await upload(s, 'export const value = 2;\n', locations[1]);
  const state = blob =>
    Buffer.from(
      JSON.stringify({
        schema: 1,
        kind: 'forge-source-state',
        files: [{ path: 'a.ts', blob: blob.sha256, mode: 'file' }],
        parents: [],
        message: 'synthetic',
        at: '2026-01-01T00:00:00.000Z',
      }),
    );
  const base = await upload(s, state(before)),
    head = await upload(s, state(after));
  const work = await upload(s, '{}', false);
  const manifest = {
    schema: 1,
    kind: 'forge-native-work-backup',
    id: randomUUID(),
    head: head.sha256,
    revision: 0,
    coverage: 'Synthetic fixture',
    unavailable: [],
    files: [
      { path: 'work.json', ...work },
      ...[before, after, base, head].map(pin => ({ path: `objects/${pin.sha256}`, ...pin })),
    ],
  };
  const manifestBytes = Buffer.from(JSON.stringify(manifest)),
    root = await upload(s, manifestBytes);
  s.tables.projectBackups.set('backup', {
    _id: 'backup',
    projectId: 'project',
    status: 'stored',
    transport: 'objects',
    digest: root.sha256,
    size: root.size,
    operationId: manifest.id,
    preview: { format: 'native', manifestDigest: root.sha256, head: head.sha256 },
  });
  return {
    s,
    fake,
    before,
    after,
    base,
    head,
    manifest,
    manifestBytes,
    input: { projectId: 'project', backupId: 'backup', base: base.sha256, head: head.sha256 },
    browser: browser(s),
  };
}

test('Code, exact State, diff and map read R2, Convex and mixed file rows directly', async t => {
  for (const locations of [
    [true, true],
    [false, false],
    [true, false],
  ]) {
    const f = await sourceFixture(t, locations),
      b = f.browser;
    const result = JSON.parse(await readBrowserSource(b, { ...f.input, file: 'a.ts', line: 1 }));
    assert.equal(result.before.text, 'export const value = 1;\n');
    assert.equal(result.after.text, 'export const value = 2;\n');
    assert.equal(result.source.startLine, 1);
    assert.deepEqual(
      result.comparison.hunks[0].lines.map(line => line.kind),
      ['removed', 'added', 'context'],
    );
    const exact = JSON.parse(await readBrowserSource(b, { ...f.input, base: f.head.sha256, file: 'a.ts' }));
    assert.equal(exact.before.text, exact.after.text);
    const map = JSON.parse(await readBrowserSource(b, { ...f.input, map: true }));
    assert.equal(map.map.nodes[0].id, 'a.ts');
    assert(
      b.calls.every(call => !call.name.includes('Actions')),
      'no server byte actions used',
    );
  }
});

test('a checksum mismatch rejects the browser render, and bad bytes never enter the cache', async t => {
  const f = await sourceFixture(t, [true, true]);
  const key = f.fake.key(`v1/p/project/o/${f.after.sha256}`);
  f.fake.corrupt.add(key);
  await assert.rejects(
    readBrowserSource(f.browser, { ...f.input, file: 'a.ts' }),
    code('BLOB_DIGEST_MISMATCH'),
  );
  f.fake.corrupt.delete(key);
  assert.equal(
    JSON.parse(await readBrowserSource(f.browser, { ...f.input, file: 'a.ts' })).after.text,
    'export const value = 2;\n',
  );
});

test('expired URLs refresh once, including CORS-masked network errors, then fail explicitly', async t => {
  const { s, fake } = await setup(t),
    p = await upload(s, 'expiring');
  const b = browser(s),
    reader = browserObjects(b, 'project');
  fake.forbidGets = 1;
  assert.equal(new TextDecoder().decode((await reader.read([p]))[0]), 'expiring');
  assert.equal(b.calls.filter(call => call.method === 'signDownloads').length, 2);
  const other = browser(s);
  fake.forbidGets = 10;
  await assert.rejects(browserObjects(other, 'project').read([p]), code('EXCHANGE_DOWNLOAD_DENIED'));
  assert.equal(other.calls.filter(call => call.method === 'signDownloads').length, 2);
  fake.forbidGets = 0;
  let attempts = 0,
    signs = 0;
  const masked = new ObjectDownloadReader({
    describe: ids =>
      modules.projectObjectDownloads.describe._handler(s.ctx, { projectId: 'project', digests: ids }),
    sign: ids => {
      signs++;
      return modules.projectObjectDownloads.signDownloads._handler(s.ctx, {
        projectId: 'project',
        digests: ids,
      });
    },
    fetch: async (...args) => {
      if (++attempts === 1) throw new TypeError('Failed to fetch');
      return fetch(...args);
    },
  });
  await masked.read([p]);
  assert.equal(attempts, 2);
  assert.equal(signs, 2);
});

test('revoked members are denied on cache hits and during a GET; public anonymous reads work', async t => {
  const { s } = await setup(t),
    p = await upload(s, 'guarded'),
    b = browser(s),
    reader = browserObjects(b, 'project');
  s.tables.projectReaders.set('grant', { projectId: 'project', reader: 'member' });
  s.caller('member');
  await reader.read([p]);
  s.tables.projectReaders.delete('grant');
  await assert.rejects(reader.read([p]), code('PROJECT_UNAVAILABLE'));
  s.tables.projectReaders.set('grant', { projectId: 'project', reader: 'member' });
  const read = new ObjectDownloadReader({
    describe: ids =>
      modules.projectObjectDownloads.describe._handler(s.ctx, { projectId: 'project', digests: ids }),
    sign: ids =>
      modules.projectObjectDownloads.signDownloads._handler(s.ctx, { projectId: 'project', digests: ids }),
    fetch: async (...args) => {
      const response = await fetch(...args);
      s.tables.projectReaders.delete('grant');
      return response;
    },
  });
  await assert.rejects(read.read([p]), code('PROJECT_UNAVAILABLE'));
  s.caller(null);
  await assert.rejects(reader.read([p]), code('PROJECT_UNAVAILABLE'));
  s.tables.hostedProjects.get('project').visibility = 'public';
  assert.equal(new TextDecoder().decode((await reader.read([p]))[0]), 'guarded');
});

test('public anonymous Code reads retain exact checkpoint selection', async t => {
  const f = await sourceFixture(t);
  f.s.caller(null);
  f.s.tables.hostedProjects.get('project').visibility = 'public';
  assert.equal(
    JSON.parse(await readBrowserSource(f.browser, { ...f.input, file: 'a.ts' })).after.text,
    'export const value = 2;\n',
  );
});

test('recipe reads verify full R2 leaves and the complete logical hash, and support mixed leaves', async t => {
  const { s, fake } = await setup(t),
    bytes = Buffer.alloc(2 * 1024 * 1024 + 31);
  for (let i = 0; i < bytes.length; i++) bytes[i] = (i * 31 + (i >> 11)) & 255;
  const built = buildObjectRecipe(bytes);
  let index = 0;
  for (const content of built.objects.values()) await upload(s, content, index++ % 2 === 0);
  const recipe = await upload(s, built.bytes);
  await modules.projectObjectRecipes.complete._handler(s.ctx, {
    projectId: 'project',
    digest: digest(bytes),
    size: bytes.length,
    recipeDigest: recipe.sha256,
    recipeSize: recipe.size,
  });
  const b = browser(s),
    before = fake.requests.length,
    reader = browserObjects(b, 'project');
  assert.deepEqual(Buffer.from((await reader.read([pin(bytes)]))[0]), bytes);
  assert(
    fake.requests
      .slice(before)
      .filter(request => request.method === 'GET')
      .every(request => request.status === 200),
    'full leaf GETs avoid compressed byte ranges in browsers',
  );
  assert.deepEqual(Buffer.from(await reader.range(pin(bytes), 123, 900)), bytes.subarray(123, 1023));
  const direct = await modules.projectExchangeActions.downloadPart._handler(s.ctx, {
    projectId: 'project',
    digest: digest(bytes),
    offset: 0,
  });
  assert.deepEqual(direct, { direct: true, digest: digest(bytes), size: bytes.length });
});

test('signing is batched at 100, byte cache expires lazily, and idle readers make no calls', async t => {
  const { s } = await setup(t),
    values = Array.from({ length: 101 }, (_, i) => Buffer.from(`synthetic ${i}`));
  await client(s).uploadBatch(values.map(bytes => ({ pin: pin(bytes), bytes })));
  const b = browser(s);
  let now = 0;
  const reader = new ObjectDownloadReader({
    now: () => now,
    describe: digests => b.mutation({ _name: 'unused' }, { digests }),
    sign: async () => [],
  });
  assert.equal(b.calls.length, 0, 'construction is inert');
  void reader;
  const cached = new ObjectDownloadReader({
    now: () => now,
    describe: digests =>
      modules.projectObjectDownloads.describe._handler(s.ctx, { projectId: 'project', digests }),
    sign: digests => {
      b.calls.push(digests.length);
      return modules.projectObjectDownloads.signDownloads._handler(s.ctx, { projectId: 'project', digests });
    },
  });
  await cached.read(values.map(pin));
  assert.deepEqual(b.calls, [100, 1]);
  await cached.read([pin(values[0])]);
  assert.deepEqual(b.calls, [100, 1]);
  now = 60_001;
  await cached.read([pin(values[0])]);
  assert.deepEqual(b.calls, [100, 1, 1]);
  const calls = b.calls.length;
  await new Promise(resolve => setTimeout(resolve, 25));
  assert.equal(b.calls.length, calls, 'no signing timer while idle');
});

test('public source and object download endpoints return no R2 file bytes or server GETs', async t => {
  const f = await sourceFixture(t, [true, true]),
    before = f.fake.requests.length;
  const plan = JSON.parse(await publicReview._handler(f.s.ctx, { ...f.input, file: 'a.ts' }));
  assert.equal(plan.transport, 'objects');
  assert.equal(plan.before, undefined);
  assert.equal(plan.comparison, undefined);
  const batch = await modules.projectExchangeActions.downloadBatch._handler(f.s.ctx, {
    projectId: 'project',
    digests: [f.before.sha256],
  });
  const part = await modules.projectExchangeActions.downloadPart._handler(f.s.ctx, {
    projectId: 'project',
    digest: f.before.sha256,
    offset: 0,
  });
  assert.deepEqual(batch, [{ direct: true, digest: f.before.sha256, size: f.before.size }]);
  assert.equal(part.data, undefined);
  assert.equal(part.direct, true);
  assert.equal(f.fake.requests.length, before, 'metadata endpoints never fetch R2 bytes');
});

test('object archive download retains exact member bytes and reports a new container digest', async t => {
  const f = await sourceFixture(t),
    archive = await downloadObjectArchive(f.browser, 'project', 'backup');
  const metadata = await workArchiveMetadata(archive.blob);
  assert.deepEqual(Buffer.from(metadata.manifest), f.manifestBytes);
  assert.equal(Buffer.from(metadata.work).toString(), '{}');
  assert.equal(digest(Buffer.from(await archive.blob.arrayBuffer())), archive.digest);
  assert.notEqual(archive.digest, digest(f.manifestBytes));
});

test('source mismatch and non-retained file identities never silently choose another State', async t => {
  const f = await sourceFixture(t);
  await assert.rejects(
    readBrowserSource(f.browser, { ...f.input, head: 'f'.repeat(64) }),
    code('SOURCE_UNAVAILABLE'),
  );
  await assert.rejects(readBrowserSource(f.browser, { ...f.input, file: 'missing.ts' }), code('NOT_FOUND'));
  rawRow(f.s, f.head.sha256).removed = true;
  await assert.rejects(readBrowserSource(f.browser, f.input), code('INVALID_WORK_BACKUP'));
});

test('record-based Work is reconstructed byte-for-byte in browser archives', async t => {
  const f = await sourceFixture(t),
    work = Buffer.from('{\n  "schema": 1,\n  "items": [\n    {"id":"synthetic"}\n  ]\n}');
  const record = await upload(f.s, '    {"id":"synthetic"}');
  const recordRoot = await upload(
    f.s,
    JSON.stringify({
      kind: 'forge-work-records',
      schema: 2,
      work: pin(work),
      fields: [
        { name: 'schema', value: 1 },
        { name: 'items', records: [{ ...record, key: 'synthetic', refs: [] }] },
      ],
    }),
  );
  f.manifest.files[0] = { path: 'work.json', ...pin(work) };
  const manifestBytes = Buffer.from(JSON.stringify(f.manifest)),
    manifest = await upload(f.s, manifestBytes);
  const tree = p => ({ ...p, tree: { ...p, height: 0, length: p.size } });
  const root = await upload(
    f.s,
    JSON.stringify({
      kind: 'forge-native-exchange',
      schema: 2,
      manifest: tree(manifest),
      work: pin(work),
      records: tree(recordRoot),
    }),
  );
  const backup = f.s.tables.projectBackups.get('backup');
  backup.digest = root.sha256;
  backup.size = root.size;
  backup.preview.manifestDigest = manifest.sha256;
  const archive = await downloadObjectArchive(f.browser, 'project', 'backup'),
    result = await workArchiveMetadata(archive.blob);
  assert.deepEqual(Buffer.from(result.work), work);
  assert.deepEqual(Buffer.from(result.manifest), manifestBytes);
});

test('browser logs follow direct pins, redact before paging and recheck the generation', async t => {
  const { readBrowserLog } = await import(moduleUrl('../web/src/browser-log.ts'));
  const { s } = await setup(t),
    bytes = Buffer.from('Retained /workspace/synthetic/private/file.txt\n' + 'x'.repeat(20000)),
    p = await upload(s, bytes),
    b = browser(s);
  let actions = 0;
  const c = {
    mutation: b.mutation,
    action: async () => {
      actions++;
      return JSON.stringify({ direct: p, backupId: 'backup', generationId: 'generation', offset: 0 });
    },
  };
  const source = c.mutation;
  c.mutation = (ref, args) =>
    getFunctionName(ref).endsWith(':source') ? JSON.stringify({ backupId: 'backup' }) : source(ref, args);
  const result = JSON.parse(
    await readBrowserLog(c, {
      projectId: 'project',
      generationId: 'generation',
      runId: randomUUID(),
      stream: 'stdout',
      offset: 0,
    }),
  );
  assert(!result.text.includes('/workspace/'));
  assert.match(result.text, /\[local path\]/);
  assert.equal(result.nextOffset, 16384);
  assert(result.more);
  assert.equal(actions, 2);
  c.action = async () =>
    JSON.stringify({ direct: p, backupId: 'backup', generationId: `changed-${++actions}` });
  await assert.rejects(
    readBrowserLog(c, {
      projectId: 'project',
      generationId: 'generation',
      runId: randomUUID(),
      stream: 'stdout',
      offset: 0,
    }),
    code('WORK_STALE'),
  );
});

test('a cached hit stays usable when signing a neighbour crosses its expiry boundary', async t => {
  const { s } = await setup(t),
    a = await upload(s, 'cached neighbour'),
    b = await upload(s, 'uncached neighbour');
  let now = 0,
    cross = false;
  const reader = new ObjectDownloadReader({
    now: () => now,
    describe: digests =>
      modules.projectObjectDownloads.describe._handler(s.ctx, { projectId: 'project', digests }),
    sign: digests => {
      if (cross) now = 60_001;
      return modules.projectObjectDownloads.signDownloads._handler(s.ctx, { projectId: 'project', digests });
    },
  });
  await reader.read([a]);
  now = 59_999;
  cross = true;
  const values = await reader.read([a, b]);
  assert.deepEqual(
    values.map(value => new TextDecoder().decode(value)),
    ['cached neighbour', 'uncached neighbour'],
  );
});

test('browser Code and Now read gitlink pointers and gitmodules through the authorized object reader', async t => {
  const f = await sourceFixture(t);
  const commit = 'a'.repeat(40),
    modules = '[submodule "lib"]\npath=vendor/lib\nurl=../lib.git\n';
  const pointer = await upload(f.s, commit),
    config = await upload(f.s, modules);
  const state = await upload(
    f.s,
    JSON.stringify({
      schema: 1,
      kind: 'forge-source-state',
      parents: [],
      message: 'gitlinks',
      at: '2026-01-01T00:00:00.000Z',
      files: [
        { path: '.gitmodules', blob: config.sha256, mode: 'file' },
        { path: 'vendor/lib', blob: pointer.sha256, mode: 'gitlink' },
      ],
    }),
  );
  const manifest = {
    ...f.manifest,
    head: state.sha256,
    files: [
      ...f.manifest.files,
      ...[pointer, config, state].map(pin => ({ path: `objects/${pin.sha256}`, ...pin })),
    ],
  };
  const root = await upload(f.s, JSON.stringify(manifest));
  Object.assign(f.s.tables.projectBackups.get('backup'), {
    digest: root.sha256,
    size: root.size,
    preview: { format: 'native', head: state.sha256, manifestDigest: root.sha256 },
  });
  const input = { ...f.input, base: state.sha256, head: state.sha256 };
  const code = JSON.parse(await readBrowserSource(f.browser, { ...input, file: 'vendor/lib' }));
  assert.deepEqual(code.submodule, { path: 'vendor/lib', commit, url: '../lib.git' });
  assert.equal(code.file.after.mode, 'gitlink');
  const now = JSON.parse(await readBrowserSource(f.browser, { ...input, submodules: true }));
  assert.deepEqual(now.pointers, [code.submodule]);
});
