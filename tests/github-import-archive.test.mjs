// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { gzipSync } from 'node:zlib';
import { pagedFixture } from './github-import-pages-fixture.mjs';
import { moduleUrl } from './convex-module.mjs';
import { tarEntries } from '../dist/github-tar.js';
import { readObjectRecipe } from '../dist/object-chunks.js';
import { readFileSync } from 'node:fs';
import { listGithubTree } from '../dist/github-archive-source.js';
import { getFunctionName } from 'convex/server';
import { startFakeR2, fakeR2Config } from './fake-r2.mjs';
const schema = (await import(moduleUrl('../convex/schema.ts'))).default;
const agent = await import(moduleUrl('../convex/projectHostedAgent.ts'));
const channels = await import(moduleUrl('../convex/projectHostedChannels.ts'));
const start = await import(moduleUrl('../convex/projectHostedStart.ts'));
const birth = await import(moduleUrl('../convex/projectHostedBirth.ts'));
const { findObject } = await import(moduleUrl('../convex/projectObjectFind.ts'));
const gitSha = bytes => createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex');
const hex = n => n.toString(16).padStart(40, '0');

/** Minimal GitHub-shaped tarball: pax global comment, one root, pax paths when long. */
function header(name, size, type, linkname = '') {
  const block = Buffer.alloc(512);
  block.write(name.slice(0, 100), 0);
  block.write('0000644\0', 100);
  block.write('0000000\0', 108);
  block.write('0000000\0', 116);
  block.write(size.toString(8).padStart(11, '0') + '\0', 124);
  block.write('00000000000\0', 136);
  block.write(type, 156);
  block.write(linkname, 157);
  block.write('ustar\0' + '00', 257);
  block.fill(32, 148, 156);
  let sum = 0;
  for (const byte of block) sum += byte;
  block.write(sum.toString(8).padStart(6, '0') + '\0 ', 148);
  return block;
}
const pad = n => Buffer.alloc((512 - (n % 512)) % 512);
function paxRecord(key, value) {
  const body = ` ${key}=${value}\n`;
  let length = body.length + 1;
  while (String(length).length + body.length !== length) length = String(length).length + body.length;
  return `${length}${body}`;
}
export function tarball(members, root = 'fixture-arch-aaaaaaa') {
  const parts = [];
  const meta = (type, records) => {
    const body = Buffer.from(records);
    parts.push(header('pax_global_header', body.length, type), body, pad(body.length));
  };
  meta('g', paxRecord('comment', 'a'.repeat(40)));
  parts.push(header(`${root}/`, 0, '5'));
  for (const m of members) {
    const name = `${root}/${m.path}`,
      bytes = m.bytes ?? Buffer.alloc(0);
    if (Buffer.byteLength(name) > 100) meta('x', paxRecord('path', name));
    parts.push(header(name, m.type === '2' ? 0 : bytes.length, m.type ?? '0', m.linkname ?? ''));
    if (m.type !== '2' && m.type !== '5') parts.push(bytes, pad(bytes.length));
  }
  parts.push(Buffer.alloc(1024));
  return gzipSync(Buffer.concat(parts), { level: 1 });
}

/** Synthetic repository; `omit` models export-ignore, `rewrite` export-subst. */
function repository({ files = 30, directories = 3, submodules = 1 } = {}) {
  const tree = [],
    members = [],
    bodies = new Map();
  for (let d = 0; d < directories; d++)
    tree.push({ path: `dir-${d}`, mode: '040000', type: 'tree', sha: hex(d + 2) });
  for (let i = 0; i < files; i++) {
    const path = `dir-${i % directories}/${i % 7 === 0 ? 'x'.repeat(90) + '-' : ''}file-${i}`;
    const link = i % 5 === 1,
      bytes = Buffer.from(link ? `target-${i}` : `synthetic source ${i}\n`);
    const mode = link ? '120000' : i % 3 === 0 ? '100755' : '100644';
    tree.push({ path, mode, type: 'blob', sha: gitSha(bytes), size: bytes.length });
    bodies.set(gitSha(bytes), bytes);
    members.push(link ? { path, type: '2', linkname: bytes.toString() } : { path, bytes });
  }
  const large = Buffer.alloc(2 * 1024 * 1024 + 3, 7);
  tree.push({ path: 'large.bin', mode: '100644', type: 'blob', sha: gitSha(large), size: large.length });
  members.push({ path: 'large.bin', bytes: large });
  const omitted = Buffer.from('export-ignore keeps this out of archives\n'),
    rewritten = Buffer.from('$Format:%H$ expands in archives only\n');
  for (const [path, bytes] of [
    ['omitted.txt', omitted],
    ['rewritten.txt', rewritten],
  ]) {
    tree.push({ path, mode: '100644', type: 'blob', sha: gitSha(bytes), size: bytes.length });
    bodies.set(gitSha(bytes), bytes);
  }
  members.push({ path: 'rewritten.txt', bytes: Buffer.alloc(rewritten.length, 120) });
  for (let i = 0; i < submodules; i++)
    tree.push({ path: `vendor-${i}`, mode: '160000', type: 'commit', sha: hex(90000 + i) });
  return { tree, archive: tarball(members), bodies, files: files + 3 + submodules };
}

const r2Env = {
  R2_ACCOUNT_ID: fakeR2Config.accountId,
  R2_BUCKET: fakeR2Config.bucket,
  R2_ACCESS_KEY_ID: fakeR2Config.accessKeyId,
  R2_SECRET_ACCESS_KEY: fakeR2Config.secretAccessKey,
  FORGE_BLOBS: 'r2',
};
/** Tree replies for a repository whose recursive root listing GitHub truncates (entry count or reply
 * size): the root, its directories and optionally one directory that is itself still truncated. */
function splitTreeReply(repo, sha, recursive, truncatedChild) {
  const dirs = new Map(repo.tree.filter(e => e.type === 'tree').map(e => [e.sha, e.path]));
  if (sha === hex(1) && recursive) return { sha, truncated: true, tree: repo.tree.slice(0, 3) };
  if (sha === hex(1)) return { sha, truncated: false, tree: repo.tree.filter(e => !e.path.includes('/')) };
  const dir = dirs.get(sha);
  const inside = repo.tree
    .filter(e => e.path.startsWith(`${dir}/`))
    .map(e => ({ ...e, path: e.path.slice(dir.length + 1) }));
  if (recursive && sha === truncatedChild) return { sha, truncated: true, tree: inside.slice(0, 2) };
  return { sha, truncated: false, tree: inside };
}
/** Synthetic GitHub plus a strict fake R2 bucket (create-only, checksummed PUTs). */
async function serve(t, repo, counts) {
  const saved = Object.fromEntries(Object.keys(r2Env).map(name => [name, process.env[name]]));
  Object.assign(process.env, r2Env);
  const native = globalThis.fetch,
    bucket = await startFakeR2(),
    restore = bucket.install(),
    old = globalThis.fetch;
  t.after(async () => {
    globalThis.fetch = old;
    restore();
    globalThis.fetch = native;
    for (const [name, value] of Object.entries(saved))
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    await bucket.close();
  });
  globalThis.fetch = async (url, options = {}) => {
    if (new URL(url).hostname.endsWith('.r2.cloudflarestorage.com')) return old(url, options);
    const u = new URL(url),
      path = u.pathname;
    if (u.host === bucket.host) return old(url, options);
    const count = name => (counts[name] = (counts[name] ?? 0) + 1);
    if (u.hostname === 'codeload.github.com') {
      count('archive');
      assert.equal(options.headers?.Authorization, undefined, 'credential never follows the redirect');
      return new Response(repo.archive);
    }
    if (path === '/repos/fixture/arch')
      return Response.json({
        full_name: 'fixture/arch',
        private: false,
        default_branch: 'main',
        html_url: 'https://github.com/fixture/arch',
        license: null,
      });
    if (path.includes('/commits/'))
      return Response.json({ sha: 'a'.repeat(40), commit: { tree: { sha: hex(1) } } });
    if (repo.split && path.includes('/git/trees/')) {
      const recursive = u.searchParams.get('recursive') === '1';
      count(recursive ? 'treesRecursive' : 'treesFlat');
      return Response.json(
        splitTreeReply(repo, path.split('/').at(-1), recursive, repo.split.truncatedChild),
      );
    }
    if (path.endsWith(`/git/trees/${hex(1)}`)) {
      count('trees');
      assert.equal(u.searchParams.get('recursive'), '1');
      return Response.json({ sha: hex(1), truncated: false, tree: repo.tree });
    }
    if (path.includes('/tarball/')) {
      count('tarball');
      assert.equal(options.redirect, 'manual');
      return new Response(null, {
        status: 302,
        headers: { location: 'https://codeload.github.com/fixture/arch/legacy.tar.gz/' + 'a'.repeat(40) },
      });
    }
    if (path.includes('/git/blobs/')) {
      count('blobs');
      return new Response(repo.bodies.get(path.split('/').at(-1)));
    }
    if (u.hostname === 'github.com' && path === '/fixture/arch.git/info/lfs/objects/batch') {
      count('lfsBatch');
      assert.equal(options.headers?.Authorization, undefined, 'public LFS reads are anonymous');
      const body = JSON.parse(options.body);
      assert.equal(body.operation, 'download');
      return Response.json({
        objects: body.objects.map(({ oid, size }) =>
          repo.lfs?.has(oid)
            ? { oid, size, actions: { download: { href: `https://lfs.example.test/${oid}`, header: {} } } }
            : { oid, size, error: { code: 404, message: 'Object does not exist' } },
        ),
      });
    }
    if (u.hostname === 'lfs.example.test') {
      count('lfsDownload');
      return new Response(repo.lfs.get(path.slice(1)));
    }
    throw Error(`Unexpected synthetic request ${path}`);
  };
  return bucket;
}
async function importArchive(s, options = {}, expect = 'ready') {
  const id = await s.modules.projectGithubImport.start._handler(s.ctx, {
    operationId: randomUUID(),
    url: 'fixture/arch',
    ...options,
  });
  for (let i = 0; i < 5 && !['ready', 'error'].includes(s.tables.projectGithubImports.get(id).phase); i++)
    await s.worker(id);
  const job = s.tables.projectGithubImports.get(id);
  assert.equal(job.phase, expect, JSON.stringify(job.error));
  if (expect === 'ready') await drainPurge(s);
  return job;
}
/** Ready schedules the byte-bounded inventory purge; run its chain like the scheduler would. */
async function drainPurge(s) {
  const next = () =>
    s.scheduled.findIndex(task => getFunctionName(task.fn) === 'projectGithubImportCatalog:purge');
  for (let run = 0; run < 200 && next() >= 0; run++) {
    const [task] = s.scheduled.splice(next(), 1);
    await s.modules.projectGithubImportCatalog.purge._handler(s.ctx, task.args);
  }
}
/** Exact accepted main State and a byte reader for its objects. */
async function mainFiles(s, bucket, projectId) {
  const read = async pin => {
    const object = await findObject(s.ctx, projectId, pin.sha256);
    const bytes = bucket.objects.get(bucket.key(object.r2Key));
    return object.pack ? bytes.subarray(object.pack.offset, object.pack.offset + object.size) : bytes;
  };
  const bytesOf = async sha256 => {
    const row = await findObject(s.ctx, projectId, sha256),
      chunks = [];
    if (!row.recipe) return Buffer.from(await read({ sha256 }));
    for await (const chunk of readObjectRecipe(JSON.parse(await read({ sha256: row.recipe.digest })), read))
      chunks.push(chunk);
    return Buffer.concat(chunks);
  };
  const main = JSON.parse(await channels.current._handler(s.ctx, { projectId }));
  const state = JSON.parse(await bytesOf(main.head));
  return { files: new Map(state.files.map(file => [file.path, file])), bytesOf };
}
const pointer = bytes =>
  Buffer.from(
    `version https://git-lfs.github.com/spec/v1\noid sha256:${createHash('sha256').update(bytes).digest('hex')}\nsize ${bytes.length}\n`,
  );
/** GitHub's archive keeps LFS pointers (the default); objects live behind the batch API. */
function lfsRepository() {
  const model = Buffer.alloc(300 * 1024, 3),
    big = Buffer.alloc(2 * 1024 * 1024 + 5, 9),
    untracked = Buffer.from('an object nobody tracks\n');
  const files = [
    [
      '.gitattributes',
      Buffer.from(
        '*.bin filter=lfs diff=lfs merge=lfs -text\nassets/** filter=lfs\nassets/keep.txt -filter\n',
      ),
    ],
    ['model.bin', pointer(model)],
    ['copy.bin', pointer(model)],
    ['assets/big.dat', pointer(big)],
    ['assets/keep.txt', pointer(untracked)],
    ['docs/pointer-example.txt', pointer(untracked)],
    ['README.md', Buffer.from('# LFS fixture\n')],
  ];
  const tree = [
    { path: 'assets', mode: '040000', type: 'tree', sha: hex(2) },
    { path: 'docs', mode: '040000', type: 'tree', sha: hex(3) },
  ];
  for (const [path, bytes] of files)
    tree.push({ path, mode: '100644', type: 'blob', sha: gitSha(bytes), size: bytes.length });
  const digestOf = bytes => createHash('sha256').update(bytes).digest('hex');
  return {
    tree,
    archive: tarball(files.map(([path, bytes]) => ({ path, bytes }))),
    bodies: new Map(),
    files: files.length,
    lfs: new Map([model, big].map(bytes => [digestOf(bytes), bytes])),
    model,
    big,
    untracked,
  };
}
const calls = s => [...s.calls.values()].reduce((a, b) => a + b, 0) + 1;

test('a 28,905-file tree imports through one archive stream within an O(pages) budget, agent-writable on arrival', async t => {
  const repo = repository({ files: 28905, directories: 4089, submodules: 2 }),
    counts = {},
    s = pagedFixture();
  const bucket = await serve(t, repo, counts);
  const started = performance.now();
  const job = await importArchive(s);
  const executions = calls(s),
    stats = s.stats();
  assert.equal(job.protocol, 3);
  assert.equal(job.completed, repo.files);
  // Only the archive-omitted and archive-rewritten files cost a blob request.
  assert.deepEqual(counts, { trees: 2, tarball: 1, archive: 1, blobs: 2 });
  // Issue 2ccd3bae: the whole archive import is 9 REST requests (start: repository, commit,
  // tree; run: repository, tree, tarball, 2 blobs; publication: repository). With no App or
  // deployment token configured here, none of them uses an importer credential.
  assert.deepEqual(job.githubRequests, { user: 0, app: 0, server: 0, anonymous: 9 });
  // Issue 7cbb881c line 3: no per-file row survives ready; documents are O(pages).
  const catalogRows = [...s.tables.projectObjectCatalog.values()].filter(r => r.projectId === job.projectId);
  const catalogued = catalogRows.reduce((sum, row) => sum + row.sizes.length, 0);
  assert.equal(s.tables.projectGithubImportInventory.size, 0, 'import progress rows are deleted at ready');
  assert.equal(
    [...s.tables.projectObjects.values()].filter(r => r.projectId === job.projectId).length,
    0,
    'no per-object rows',
  );
  assert.equal(catalogRows.length, Math.ceil(catalogued / 256));
  assert.ok(catalogued >= repo.files - 10, `${catalogued} catalogued objects`);
  assert.ok(
    [...s.tables.projectWorkRecords.values()].filter(r => r.collection === 'sourceBlobs').length <= 1,
    'catalog-backed generation keeps no per-blob record (only the State header row)',
  );
  assert.ok(stats.documentsWritten < 1000, `${stats.documentsWritten} documents written`);
  assert.ok(executions <= 5 * Math.ceil(repo.files / 1000) + 10, `${executions} executions`);
  const puts = bucket.requests.filter(request => request.method === 'PUT').length;
  assert.ok(puts <= 80, `${puts} R2 PUTs for a t3code-size import; bytes must travel in packs`);
  t.diagnostic(
    JSON.stringify({
      files: repo.files,
      archiveBytes: repo.archive.length,
      githubRequests: counts,
      executions,
      ...stats,
      inventoryRows: s.tables.projectGithubImportInventory.size,
      catalogRows: catalogRows.length,
      r2Objects: bucket.objects.size,
      r2Puts: puts,
      ms: Math.round(performance.now() - started),
      rss: process.memoryUsage().rss,
    }),
  );
  const project = s.tables.hostedProjects.get(job.projectId),
    backup = s.tables.projectBackups.get(project.currentBackup);
  assert.deepEqual(project.sourceAuthority, { mode: 'server', epoch: 1 });
  const caps = JSON.parse(
    await agent.capabilities._handler(s.ctx, { projectId: project._id, clientVersion: '9.9.9' }),
  );
  assert.equal(caps.mainReady, true);
  assert.ok(caps.actions.includes('start') && caps.actions.length > 5);
  const main = JSON.parse(await channels.current._handler(s.ctx, { projectId: project._id }));
  assert.equal(main.head, backup.preview.head);
  const read = async pin => {
    const object = await findObject(s.ctx, project._id, pin.sha256);
    const bytes = bucket.objects.get(bucket.key(object.r2Key));
    return object.pack ? bytes.subarray(object.pack.offset, object.pack.offset + object.size) : bytes;
  };
  const row = await findObject(s.ctx, project._id, main.head),
    chunks = [];
  if (row.recipe)
    for await (const chunk of readObjectRecipe(JSON.parse(await read({ sha256: row.recipe.digest })), read))
      chunks.push(chunk);
  const state = JSON.parse(row.recipe ? Buffer.concat(chunks) : await read({ sha256: main.head }));
  assert.equal(state.files.length, repo.files);
  assert.equal(row.stateGeneration, 1, 'snapshot import derives its root generation during publication');
  const byPath = new Map(state.files.map(f => [f.path, f]));
  assert.equal(byPath.get('vendor-0').mode, 'gitlink');
  assert.equal(byPath.get('dir-1/file-1').mode, 'symlink');
  assert.equal(byPath.get('dir-0/' + 'x'.repeat(90) + '-file-0').mode, 'executable');
  const digestOf = bytes => createHash('sha256').update(bytes).digest('hex');
  assert.equal(
    byPath.get('rewritten.txt').blob,
    digestOf(repo.bodies.get(gitSha(Buffer.from('$Format:%H$ expands in archives only\n')))),
  );
});

const treeFetch = (repo, counts, truncatedChild) => async url => {
  const u = new URL(url),
    recursive = u.searchParams.get('recursive') === '1';
  counts[recursive ? 'recursive' : 'flat'] = (counts[recursive ? 'recursive' : 'flat'] ?? 0) + 1;
  return Response.json(splitTreeReply(repo, u.pathname.split('/').at(-1), recursive, truncatedChild));
};
const wholeFetch = repo => async () => Response.json({ sha: hex(1), truncated: false, tree: repo.tree });

test('Issue c6426ee9: a root truncated by entry count lists as the complete tree from one read per directory, gitlinks and modes exact', async () => {
  const repo = repository({ files: 40, directories: 4, submodules: 2 }),
    counts = {};
  const listing = await listGithubTree('fixture/arch', hex(1), undefined, treeFetch(repo, counts));
  const whole = await listGithubTree('fixture/arch', hex(1), undefined, wholeFetch(repo));
  assert.deepEqual(listing, whole);
  // The truncated recursive root, the root without recursion, then each of the 4 directories once.
  assert.deepEqual(counts, { recursive: 1 + 4, flat: 1 });
  assert.equal(listing.submodules, 2);
  assert.equal(listing.files.find(f => f.path === 'vendor-1').mode, '160000');
  assert.equal(listing.files.find(f => f.path === 'dir-1/file-1').mode, '120000');
  assert.equal(listing.files.find(f => f.path === 'dir-0/' + 'x'.repeat(90) + '-file-0').mode, '100755');
});

test('Issue c6426ee9: a directory still truncated by reply size is split again; a nested gitlink and identical subtrees survive', async () => {
  const repo = repository({ files: 40, directories: 4, submodules: 0 });
  // dir-copy repeats dir-0 byte for byte (one tree object id); dir-1 holds a nested submodule.
  repo.tree.push(
    { path: 'dir-1/vendor-nested', mode: '160000', type: 'commit', sha: hex(77) },
    { path: 'dir-copy', mode: '040000', type: 'tree', sha: hex(2) },
    ...repo.tree
      .filter(e => e.path.startsWith('dir-0/'))
      .map(e => ({ ...e, path: e.path.replace('dir-0/', 'dir-copy/') })),
  );
  const counts = {};
  const listing = await listGithubTree('fixture/arch', hex(1), undefined, treeFetch(repo, counts, hex(3)));
  const reference = repo.tree.filter(e => e.type !== 'tree').map(e => e.path);
  assert.deepEqual(
    listing.files.map(f => f.path),
    reference.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0)),
  );
  assert.ok(listing.files.some(f => f.path.startsWith('dir-copy/')));
  // Root recursive, root flat, dir-1 recursive + flat (truncated), dir-0/2/3 recursive; dir-copy reuses dir-0's reply.
  assert.deepEqual(counts, { recursive: 1 + 4, flat: 2 });
  assert.equal(listing.files.find(f => f.path === 'dir-1/vendor-nested').mode, '160000');
  assert.equal(listing.submodules, 1);
});

test('Issue c6426ee9: a single directory above the reply limit has no smaller read and falls back to paged acquisition', async () => {
  const request = async url => {
    const u = new URL(url);
    return Response.json({ sha: u.pathname.split('/').at(-1), truncated: true, tree: [] });
  };
  assert.equal(await listGithubTree('fixture/arch', hex(1), undefined, request), null);
});

test('Issue c6426ee9: a root truncated by count imports through the archive stream, not per-blob acquisition', async t => {
  const repo = {
      ...repository({ files: 60, directories: 3, submodules: 1 }),
      split: { truncatedChild: hex(3) },
    },
    counts = {},
    s = pagedFixture();
  await serve(t, repo, counts);
  const job = await importArchive(s);
  assert.equal(job.protocol, 3, 'archive path, not protocol 2');
  assert.equal(job.completed, repo.files);
  // Per listing: the truncated root, 3 directories recursive, the root and the still-truncated directory flat.
  // Start lists once and the archive run lists again.
  assert.deepEqual(counts, { treesRecursive: 8, treesFlat: 4, tarball: 1, archive: 1, blobs: 2 });
  assert.equal(
    job.githubRequests.anonymous,
    2 + 12 + 4 + 1,
    'start: repository and commit; 2 listings of 6; run: repository, tarball, 2 blobs; publication: repository',
  );
});

test('incident replay: an imported project starts a hosted Lane with no native owner ever created', async t => {
  const repo = repository({ files: 5, directories: 1, submodules: 0 }),
    s = pagedFixture();
  await serve(t, repo, {});
  const job = await importArchive(s);
  for (const table of Object.keys(schema.tables)) s.tables[table] ??= new Map();
  const main = JSON.parse(await channels.current._handler(s.ctx, { projectId: job.projectId }));
  const reply = JSON.parse(
    await start.start._handler(s.ctx, {
      projectId: job.projectId,
      operationId: randomUUID(),
      authorityEpoch: main.authority.epoch,
      expectedMain: { head: main.head, receiptId: main.receipt.id },
      intent: { kind: 'new', outcome: 'First agent change on an imported project' },
    }),
  );
  assert.equal(reply.lane.base.head, main.head);
  assert.equal(s.tables.projectWorkHeads.size, 0, 'no native owner journal');
});

test('make-editable converts an existing native-owner import once, owner only, unchanged source only', async t => {
  const s = pagedFixture();
  await serve(t, repository({ files: 3, directories: 1, submodules: 0 }), {});
  const job = await importArchive(s),
    projectId = job.projectId;
  for (const table of Object.keys(schema.tables)) s.tables[table] ??= new Map();
  // Rewind to the legacy shape every import had before birth hosting.
  for (const table of ['projectHostedChannels', 'projectSourceCutovers'])
    for (const [id, row] of s.tables[table]) if (row.projectId === projectId) s.tables[table].delete(id);
  const legacy = s.tables.hostedProjects.get(projectId);
  delete legacy.sourceAuthority;
  delete legacy.sourceCutover;
  const caps = JSON.parse(await agent.capabilities._handler(s.ctx, { projectId }));
  assert.deepEqual(caps.actions, ['capabilities']);
  const operationId = randomUUID();
  s.caller('intruder');
  await assert.rejects(birth.makeEditable._handler(s.ctx, { projectId, operationId }));
  s.caller('owner');
  const receipt = await birth.makeEditable._handler(s.ctx, { projectId, operationId });
  assert.equal(JSON.parse(receipt).origin, 'make-editable');
  assert.equal(
    await birth.makeEditable._handler(s.ctx, { projectId, operationId }),
    receipt,
    'retry replays',
  );
  assert.deepEqual(s.tables.hostedProjects.get(projectId).sourceAuthority, { mode: 'server', epoch: 1 });
  await assert.rejects(
    birth.makeEditable._handler(s.ctx, { projectId, operationId: randomUUID() }),
    /already/,
  );
});

test('tar reader rejects corrupted headers and early ends', async () => {
  const bytes = tarball([{ path: 'a', bytes: Buffer.from('x') }]);
  const raw = (await import('node:zlib')).gunzipSync(bytes);
  const read = async buffer => {
    const out = [];
    for await (const entry of tarEntries(
      (async function* () {
        yield buffer;
      })(),
    ))
      out.push(entry.path);
    return out;
  };
  assert.deepEqual(await read(raw), ['fixture-arch-aaaaaaa/', 'fixture-arch-aaaaaaa/a']);
  const corrupt = Buffer.from(raw);
  corrupt[1024 + 10] ^= 1;
  await assert.rejects(read(corrupt), /checksum/);
  await assert.rejects(read(raw.subarray(0, 1024 + 512 + 100)), /ended early/);
});

test('Git LFS paths import as their object bytes, fetched once per oid; other pointers keep their bytes', async t => {
  const repo = lfsRepository(),
    counts = {},
    s = pagedFixture();
  const bucket = await serve(t, repo, counts);
  const job = await importArchive(s);
  // One batch request; one download per unique oid (model.bin and copy.bin share one).
  assert.deepEqual(counts, { trees: 2, tarball: 1, archive: 1, lfsBatch: 1, lfsDownload: 2 });
  const digestOf = bytes => createHash('sha256').update(bytes).digest('hex');
  const { files, bytesOf } = await mainFiles(s, bucket, job.projectId);
  assert.equal(files.get('model.bin').blob, digestOf(repo.model), 'pointer-only import fails here');
  assert.equal(files.get('copy.bin').blob, digestOf(repo.model));
  assert.deepEqual(await bytesOf(files.get('model.bin').blob), repo.model);
  // A large object streams through a chunk recipe under its oid.
  assert.equal(files.get('assets/big.dat').blob, digestOf(repo.big));
  assert.deepEqual(await bytesOf(files.get('assets/big.dat').blob), repo.big);
  // -filter and untracked paths keep the committed pointer, as Git would.
  assert.equal(files.get('assets/keep.txt').blob, digestOf(pointer(repo.untracked)));
  assert.equal(files.get('docs/pointer-example.txt').blob, digestOf(pointer(repo.untracked)));
  assert.equal(job.completed, repo.files);
});

test('Git LFS objects over the import limit refuse before any download; 0 keeps pointers', async t => {
  const repo = lfsRepository(),
    counts = {},
    s = pagedFixture();
  const bucket = await serve(t, repo, counts);
  const refused = await importArchive(s, { lfsLimitBytes: 1024 * 1024 }, 'error');
  assert.equal(refused.error.code, 'GITHUB_LFS_LIMIT');
  assert.match(refused.error.message, /2 Git LFS objects total .* over this import's 1\.00 MiB LFS limit/);
  assert.match(refused.error.message, /largest: assets\/big\.dat/);
  assert.equal(counts.lfsBatch, undefined, 'nothing was requested from GitHub LFS');
  await assert.rejects(
    s.modules.projectGithubImport.start._handler(s.ctx, {
      operationId: randomUUID(),
      url: 'fixture/arch',
      lfsLimitBytes: 9 * 1024 ** 3,
    }),
    /8 GiB/,
  );
  const kept = await importArchive(s, { lfsLimitBytes: 0 });
  const { files } = await mainFiles(s, bucket, kept.projectId);
  const digestOf = bytes => createHash('sha256').update(bytes).digest('hex');
  assert.equal(files.get('model.bin').blob, digestOf(pointer(repo.model)));
  assert.equal(counts.lfsBatch, undefined);
});

/** Fail one named mutation once with the uncoded error a Convex limit raises inside it. */
function failOnce(s, name, message) {
  const run = s.ctx.runMutation,
    state = { failed: 0, running: false };
  s.ctx.runMutation = async (ref, args) => {
    if (getFunctionName(ref) !== name) return run(ref, args);
    if (!state.failed++) throw new Error(message);
    return run(ref, args);
  };
  return state;
}

test('a publication failure is coded, not an interrupted worker, and the retry publishes without streaming again', async t => {
  const repo = repository({ files: 40, directories: 4, submodules: 1 }),
    counts = {},
    s = pagedFixture();
  const bucket = await serve(t, repo, counts);
  const operationId = randomUUID();
  failOnce(s, 'projectGithubImportPublication:finish', 'Too many bytes read in a single function execution');
  const id = await s.modules.projectGithubImport.start._handler(s.ctx, { operationId, url: 'fixture/arch' });
  for (let i = 0; i < 5 && !['ready', 'error'].includes(s.tables.projectGithubImports.get(id).phase); i++)
    await s.worker(id);
  const failed = s.tables.projectGithubImports.get(id);
  assert.equal(failed.phase, 'error');
  assert.equal(failed.error.code, 'GITHUB_IMPORT_PUBLICATION_FAILED');
  assert.notEqual(failed.error.code, 'GITHUB_IMPORT_INTERRUPTED');
  assert.match(failed.error.message, /Retry the original operation: it resumes publication/);
  assert.match(failed.error.message, /Too many bytes read/);
  assert.ok(failed.stateObject, 'the stored State is pinned on the job');
  assert.deepEqual(
    { archive: counts.archive, tarball: counts.tarball, trees: counts.trees },
    { archive: 1, tarball: 1, trees: 2 },
  );
  const before = { ...counts };
  // Original-operation retry: no listing, tarball or archive request, and the same main.
  assert.equal(
    await s.modules.projectGithubImport.start._handler(s.ctx, { operationId, url: 'fixture/arch' }),
    id,
  );
  for (let i = 0; i < 5 && !['ready', 'error'].includes(s.tables.projectGithubImports.get(id).phase); i++)
    await s.worker(id);
  const job = s.tables.projectGithubImports.get(id);
  assert.equal(job.phase, 'ready', JSON.stringify(job.error));
  assert.deepEqual(counts, before, 'the retry made no GitHub archive, tree, tarball or blob request');
  await drainPurge(s);
  assert.equal(s.tables.projectGithubImportInventory.size, 0);
  const { files } = await mainFiles(s, bucket, job.projectId);
  assert.equal(files.size, repo.files);
  assert.equal(files.get('vendor-0').mode, 'gitlink');
  assert.equal(
    files.get('rewritten.txt').blob,
    createHash('sha256')
      .update(repo.bodies.get(gitSha(Buffer.from('$Format:%H$ expands in archives only\n'))))
      .digest('hex'),
  );
});

test('a publication failure before the catalog is written resumes from the stored State too', async t => {
  const repo = repository({ files: 12, directories: 2, submodules: 0 }),
    counts = {},
    s = pagedFixture();
  await serve(t, repo, counts);
  const operationId = randomUUID();
  failOnce(s, 'projectGithubImportCatalog:publish', 'Too many documents read in a single function execution');
  const id = await s.modules.projectGithubImport.start._handler(s.ctx, { operationId, url: 'fixture/arch' });
  for (let i = 0; i < 5 && !['ready', 'error'].includes(s.tables.projectGithubImports.get(id).phase); i++)
    await s.worker(id);
  assert.equal(s.tables.projectGithubImports.get(id).error.code, 'GITHUB_IMPORT_PUBLICATION_FAILED');
  const before = { ...counts };
  await s.modules.projectGithubImport.start._handler(s.ctx, { operationId, url: 'fixture/arch' });
  await s.worker(id);
  assert.equal(s.tables.projectGithubImports.get(id).phase, 'ready');
  assert.deepEqual(counts, before);
});

test('finish scans no inventory: the scheduled purge deletes the progress rows', async t => {
  const repo = repository({ files: 6, directories: 1, submodules: 0 }),
    s = pagedFixture();
  await serve(t, repo, {});
  const scans = [];
  let inFinish = false;
  const run = s.ctx.runMutation,
    query = s.ctx.db.query;
  s.ctx.runMutation = async (ref, args) => {
    if (getFunctionName(ref) !== 'projectGithubImportPublication:finish') return run(ref, args);
    inFinish = true;
    try {
      return await run(ref, args);
    } finally {
      inFinish = false;
    }
  };
  s.ctx.db.query = table => {
    if (inFinish) scans.push(table);
    return query(table);
  };
  const job = await importArchive(s);
  assert.equal(job.phase, 'ready');
  assert.ok(scans.length > 0, 'the probe saw finish run');
  assert.ok(!scans.includes('projectGithubImportInventory'), `finish read: ${[...new Set(scans)]}`);
  assert.equal(
    s.tables.projectGithubImportInventory.size,
    0,
    'the scheduled purge removed every progress row',
  );
});

test('class guard: publication-path mutations never page a repository-sized collection by row count', () => {
  const modules = ['Publication', 'Catalog', 'Inventory', 'Store', 'Batch', 'Objects', 'Upload', 'Publish'];
  const allowed = /^(?:[0-9]|1[0-9]|20|purgePageBudget\.chunk)$/;
  for (const name of modules) {
    const source = readFileSync(new URL(`../convex/projectGithubImport${name}.ts`, import.meta.url), 'utf8');
    assert.ok(!/\.collect\(\)/.test(source), `projectGithubImport${name} must not collect a collection`);
    for (const [, count] of source.matchAll(/\.take\(([^)]*)\)/g))
      assert.match(
        count.trim(),
        allowed,
        `projectGithubImport${name}: .take(${count}) pages by row count. Rows here grow with repository size (an inventory window is ~135 KB): bound the page by bytes like purgeInventory, or keep it at most 20.`,
      );
  }
});
