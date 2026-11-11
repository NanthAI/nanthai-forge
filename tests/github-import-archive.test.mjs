// SPDX-License-Identifier: Apache-2.0
import { workRecordRows } from './hosted-fixture.mjs';
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
import { wantedBlobResponse } from './github-blob-pack-fixture.mjs';
import { ListingBuilder, ListingTable } from '../dist/github-listing-codec.js';
import { TreeRows, readTreeReply } from '../dist/github-tree-split.js';
import { CatalogTable } from '../dist/import-catalog-table.js';
import { importStateFiles } from '../dist/import-state-scan.js';
import { setFlagsFromString } from 'node:v8';
import { runInNewContext } from 'node:vm';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { childEnv } from '../scripts/child-env.mjs';
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
async function serve(t, repo, counts, hooks = {}) {
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
    const count = name => {
      counts[name] = (counts[name] ?? 0) + 1;
      hooks[name]?.(counts[name]);
    };
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
    if (u.hostname === 'github.com' && path === '/fixture/arch.git/git-upload-pack') {
      count('blobPacks');
      return wantedBlobResponse(options, repo.bodies);
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
  // Both omitted/rewritten files share one bounded Git pack fetch.
  assert.deepEqual(counts, { trees: 1, tarball: 1, archive: 1, blobPacks: 1 });
  // Issue ed088358: the whole archive import is 6 REST requests (start: repository, commit,
  // tree; run: repository, tarball; publication: repository). Git fetch consumes no REST quota. The run reads the tree
  // listing start stored (Issue e5be6ef3). With no App or deployment token configured here,
  // none of them uses an importer credential.
  assert.deepEqual(job.githubRequests, { user: 0, app: 0, server: 0, anonymous: 6 });
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
    [...workRecordRows(s.tables)].filter(r => r.collection === 'sourceBlobs').length <= 1,
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
  const mode = path => listing.mode(listing.index(path));
  assert.equal(mode('vendor-1'), '160000');
  assert.equal(mode('dir-1/file-1'), '120000');
  assert.equal(mode('dir-0/' + 'x'.repeat(90) + '-file-0'), '100755');
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
  const paths = Array.from({ length: listing.length }, (_, i) => listing.path(i));
  assert.deepEqual(
    paths,
    reference.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0)),
  );
  assert.ok(paths.some(path => path.startsWith('dir-copy/')));
  // Root recursive, root flat, dir-1 recursive + flat (truncated), dir-0/2/3 recursive; dir-copy reuses dir-0's reply.
  assert.deepEqual(counts, { recursive: 1 + 4, flat: 2 });
  assert.equal(listing.mode(listing.index('dir-1/vendor-nested')), '160000');
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
  // One listing: the truncated root, 3 directories recursive, the root and the still-truncated directory
  // flat. Start lists it; the archive run reads the stored table (Issue e5be6ef3).
  assert.deepEqual(counts, { treesRecursive: 4, treesFlat: 2, tarball: 1, archive: 1, blobPacks: 1 });
  assert.equal(
    job.githubRequests.anonymous,
    2 + 6 + 2 + 1,
    'start: repository and commit; 1 listing of 6; run: repository, tarball; publication: repository',
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

test('Issue 6a0dd2e8: a Git path that is not UTF-8 is refused by name at import, never decoded into another name', async () => {
  // Archive member names carry Git's raw path bytes: one Latin-1 byte (0xE9) in place of X.
  const raw = (await import('node:zlib')).gunzipSync(
    tarball([{ path: 'src/cafX.py', bytes: Buffer.from('LATIN1 = 1\n') }]),
  );
  const at = raw.indexOf('cafX.py'),
    block = raw.subarray(at - (at % 512), at - (at % 512) + 512);
  raw[at + 3] = 0xe9;
  block.fill(32, 148, 156);
  let sum = 0;
  for (const byte of block) sum += byte;
  block.write(sum.toString(8).padStart(6, '0') + '\0 ', 148);
  const read = async () => {
    for await (const entry of tarEntries(
      (async function* () {
        yield raw;
      })(),
    ))
      void entry;
  };
  await assert.rejects(
    read(),
    error =>
      error.code === 'GITHUB_SOURCE_UNSUPPORTED' &&
      error.message.includes('src/caf\\xE9.py') &&
      error.message.includes('git mv'),
  );
  // GitHub's tree API shows such bytes as U+FFFD: every listed one is named in one refusal.
  const id = n => n.toString(16).padStart(40, '0');
  await assert.rejects(
    listGithubTree('fixture/arch', id(1), undefined, async () =>
      Response.json({
        sha: id(1),
        truncated: false,
        tree: [
          { path: 'src', mode: '040000', type: 'tree', sha: id(2) },
          { path: 'src/caf\uFFFD.py', mode: '100644', type: 'blob', sha: id(3), size: 1 },
          { path: 'src/ok.py', mode: '100644', type: 'blob', sha: id(4), size: 1 },
          { path: 'na\uFFFDve.md', mode: '100644', type: 'blob', sha: id(5), size: 1 },
        ],
      }),
    ),
    error =>
      error.code === 'GITHUB_SOURCE_UNSUPPORTED' &&
      error.message.includes('2 paths') &&
      error.message.includes('src/caf\\uFFFD.py') &&
      error.message.includes('na\\uFFFDve.md') &&
      !error.message.includes('src/ok.py'),
  );
});

test('Git LFS paths import as their object bytes, fetched once per oid; other pointers keep their bytes', async t => {
  const repo = lfsRepository(),
    counts = {},
    s = pagedFixture();
  const bucket = await serve(t, repo, counts);
  const job = await importArchive(s);
  // One batch request; one download per unique oid (model.bin and copy.bin share one).
  assert.deepEqual(counts, { trees: 1, tarball: 1, archive: 1, lfsBatch: 1, lfsDownload: 2 });
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
    { archive: 1, tarball: 1, trees: 1 },
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

test('Issue c6426ee9: an archive import hands publication lazily produced rows; a 100,000-file run held 190 MB of JSON rows and ran out of its 512 MB action', () => {
  const source = readFileSync(new URL('../convex/projectGithubImportArchive.ts', import.meta.url), 'utf8');
  assert.ok(!/rows\.(?:imported|blobs)\.push/.test(source), 'build rows while publication pages them');
  assert.match(source, /\*\[Symbol\.iterator\]/);
});

/** Archive steps stop at a wall-clock budget; this moves the importer's clock instead of waiting.
 * Presigned URLs carry the real issue time, so the fake bucket's clock follows the same jump. */
function skewClock(t) {
  const real = Date.now;
  let skew = 0;
  const clock = {
    bucket: null,
    jump(minutes) {
      skew += minutes * 60_000;
      clock.bucket.clockSkew = -skew;
    },
  };
  Date.now = () => real() + skew;
  t.after(() => {
    Date.now = real;
  });
  return clock;
}
const listingKeys = bucket => [...bucket.objects.keys()].filter(key => key.includes('/import/'));
const listingGets = bucket =>
  bucket.requests.filter(request => request.method === 'GET' && request.path.includes('/import/')).length;

test('Issue e5be6ef3: a multi-step archive import lists the tree once; every step reads the stored table', async t => {
  const repo = {
      ...repository({ files: 60, directories: 3, submodules: 1 }),
      split: { truncatedChild: hex(3) },
    },
    counts = {},
    s = pagedFixture(),
    clock = skewClock(t);
  // The first archive stream passes its time budget as soon as it opens: one file, then a continuation.
  const bucket = await serve(t, repo, counts, { archive: n => n === 1 && clock.jump(7) });
  clock.bucket = bucket;
  const job = await importArchive(s);
  assert.equal(job.step, 1, 'two archive runs');
  assert.equal(job.completed, repo.files);
  // 4 recursive + 2 flat reads are the one listing (start); both runs streamed the archive.
  assert.deepEqual(counts, { treesRecursive: 4, treesFlat: 2, tarball: 2, archive: 2, blobPacks: 1 });
  assert.equal(
    job.githubRequests.anonymous,
    2 + 6 + 2 + 2 + 1,
    'start: repository, commit, 1 listing of 6; run 1: repository, tarball; run 2: repository, tarball; publication: repository',
  );
  assert.equal(listingGets(bucket), 2, 'each run read the stored table from R2');
  assert.deepEqual(listingKeys(bucket), [], 'the scratch table is deleted once main is published');
});

test('Issue e5be6ef3: a run that stored the last file at its time budget publishes in that run, with no second pass over the archive', async t => {
  const repo = repository({ files: 20, directories: 2, submodules: 1 }),
    counts = {},
    s = pagedFixture(),
    clock = skewClock(t);
  // The omitted and rewritten files are fetched after the stream ends; the budget passes during them.
  clock.bucket = await serve(t, repo, counts, { blobPacks: n => n === 1 && clock.jump(7) });
  const job = await importArchive(s);
  assert.equal(job.step, 0, 'no continuation step');
  assert.equal(job.completed, repo.files);
  assert.deepEqual(counts, { trees: 1, tarball: 1, archive: 1, blobPacks: 1 });
});

for (const damage of ['gone', 'altered'])
  test(`Issue e5be6ef3: a stored listing that is ${damage} is listed again, never trusted`, async t => {
    const repo = repository({ files: 12, directories: 2, submodules: 0 }),
      counts = {},
      s = pagedFixture();
    const bucket = await serve(t, repo, counts);
    const id = await s.modules.projectGithubImport.start._handler(s.ctx, {
      operationId: randomUUID(),
      url: 'fixture/arch',
    });
    assert.equal(listingKeys(bucket).length, 1, 'start stored the table');
    for (const key of listingKeys(bucket))
      if (damage === 'gone') bucket.objects.delete(key);
      else bucket.objects.set(key, Buffer.from('{"schema":1}'));
    for (let i = 0; i < 5 && !['ready', 'error'].includes(s.tables.projectGithubImports.get(id).phase); i++)
      await s.worker(id);
    const job = s.tables.projectGithubImports.get(id);
    assert.equal(job.phase, 'ready', JSON.stringify(job.error));
    assert.equal(counts.trees, 2, 'start listed, the run listed again');
    assert.equal(job.completed, repo.files);
  });

test('Issue 96f164ce: the stored file table round-trips as columns; a lookup finds every listed path and nothing else', () => {
  const files = [
    { path: '.gitattributes', sha: hex(1), size: 3, mode: '100644' },
    { path: 'a/b', sha: hex(2), size: 0, mode: '100755' },
    { path: 'a/b.c', sha: hex(3), size: 70_000_000, mode: '100644' },
    { path: 'link', sha: hex(4), size: 6, mode: '120000' },
    { path: 'vendor/sub', sha: hex(5), size: 0, mode: '160000' },
    { path: 'z/caf\u00e9/\u6587\u4ef6 "q".txt', sha: hex(6), size: 9, mode: '100644' },
  ];
  const table = ListingTable.from({ files, totalBytes: 70_000_018, submodules: 1 });
  const back = ListingTable.decode(table.encode(hex(9)), hex(9));
  assert.equal(back.length, files.length);
  assert.deepEqual([back.totalBytes, back.submodules], [70_000_018, 1]);
  files.forEach((file, index) => {
    assert.deepEqual(back.entry(index), file);
    assert.equal(back.index(file.path), index);
  });
  for (const absent of ['', 'a', 'a/b/', 'link2', 'zz']) assert.equal(back.index(absent), -1, absent);
  assert.equal(ListingTable.decode(table.encode(hex(9)), hex(8)), null, 'another tree');
  assert.equal(ListingTable.decode(table.encode(hex(9)).subarray(0, 80), hex(9)), null, 'truncated');
  assert.equal(
    ListingTable.decode(Buffer.from(JSON.stringify({ schema: 1, tree: hex(9), files })), hex(9)),
    null,
    'a schema-1 JSON table from an earlier deployment is listed again',
  );
  const sha256 = ListingTable.from({
    files: [{ ...files[0], sha: 'b'.repeat(64) }],
    totalBytes: 3,
    submodules: 0,
  });
  assert.equal(ListingTable.decode(sha256.encode(hex(9)), hex(9)).sha(0), 'b'.repeat(64));
  assert.equal(
    ListingTable.from({ files: [files[1], files[0]], totalBytes: 3, submodules: 0 }),
    null,
    'unsorted',
  );
  assert.equal(
    ListingTable.from({ files: [files[0], files[0]], totalBytes: 6, submodules: 0 }),
    null,
    'duplicate',
  );
});

test('Issue 96f164ce: a listing is built from reply columns in any order; malformed entries keep their own error', async () => {
  const id = n => n.toString(16).padStart(40, '0');
  const rows = TreeRows.from([
    { path: 'b/two', mode: '100755', type: 'blob', sha: id(2), size: 9, url: 'https://api.github.com/x' },
    { path: 'b', mode: '040000', type: 'tree', sha: id(3) },
    { path: 'a', mode: '100755', type: 'blob', sha: 'not-a-sha', size: 1 },
    { path: 'v', mode: '100666', type: 'blob', sha: id(4), size: 1 },
  ]);
  assert.deepEqual(rows.entry(0), { path: 'b/two', mode: '100755', type: 'blob', sha: id(2), size: 9 });
  assert.deepEqual(rows.entry(1), { path: 'b', mode: '040000', type: 'tree', sha: id(3) });
  assert.equal(rows.entry(2).sha, 'not-a-sha');
  assert.equal(rows.entry(3).mode, '100666');
  const builder = new ListingBuilder();
  for (const [path, n] of [
    ['é', 1],
    ['b/two', 2],
    ['B', 3],
    ['a', 4],
  ])
    assert.equal(builder.push(path, id(n), n, '100644'), true);
  assert.equal(builder.push('bad', 'xyz', 1, '100644'), false);
  assert.equal(builder.push('bad', id(5), 1, '040000'), false);
  const table = builder.finish(10, 0);
  assert.deepEqual(
    Array.from({ length: table.length }, (_, i) => table.path(i)),
    ['B', 'a', 'b/two', 'é'],
  );
  assert.equal(table.sha(table.index('b/two')), id(2));
  assert.equal(table.size(table.index('é')), 1);
  const twice = new ListingBuilder();
  twice.push('same', id(1), 1, '100644');
  twice.push('same', id(2), 1, '100644');
  assert.equal(twice.finish(2, 0), null);
  const reply = tree => async () => Response.json({ sha: id(1), truncated: false, tree });
  await assert.rejects(
    listGithubTree(
      'fixture/arch',
      id(1),
      undefined,
      reply([{ path: 'v', mode: '100666', type: 'blob', sha: id(4), size: 1 }]),
    ),
    /GITHUB_SOURCE_UNSUPPORTED|mode 100666/,
  );
  await assert.rejects(
    listGithubTree(
      'fixture/arch',
      id(1),
      undefined,
      reply([
        { path: 'd', mode: '040000', type: 'tree', sha: id(3) },
        { path: 'd', mode: '100644', type: 'blob', sha: id(4), size: 1 },
      ]),
    ),
    /GITHUB_RESPONSE|outside its listed directories/,
  );
});

test('Issue 96f164ce: a tree reply is scanned into columns with the entries JSON.parse reads, and a truncated one is not read', () => {
  const id = (n, bytes = 20) => n.toString(16).padStart(bytes * 2, '0');
  const entries = reply => Array.from({ length: reply.rows.length }, (_, i) => reply.rows.entry(i));
  const parsed = text => {
    const json = JSON.parse(text);
    return {
      sha: json.sha,
      truncated: json.truncated !== false,
      entries: entries({ rows: TreeRows.from(json.tree) }),
    };
  };
  const tree = [
    {
      path: 'a "quoted"\\path é/日本.txt',
      mode: '100644',
      type: 'blob',
      sha: id(1),
      size: 12,
      url: 'https://x/"y"',
    },
    { path: 'dir', mode: '040000', type: 'tree', sha: id(2), url: 'u' },
    { path: 'link', mode: '120000', type: 'blob', sha: id(3), size: 0 },
    { path: 'mod', mode: '160000', type: 'commit', sha: id(4) },
    { path: 'odd-mode', mode: '100666', type: 'blob', sha: id(5), size: 1 },
    { path: 'upper', mode: '100644', type: 'blob', sha: id(6).toUpperCase(), size: 1 },
    { path: 'sha256', mode: '100644', type: 'blob', sha: id(7, 32), size: 1 },
    { path: 'fraction', mode: '100644', type: 'blob', sha: id(8), size: 1.5 },
    { path: 'nullsize', mode: '100644', type: 'blob', sha: id(9), size: null },
    { path: 7, mode: '100644', type: 'blob', sha: id(10), size: 1 },
  ];
  const replies = [
    JSON.stringify({ sha: id(99), url: 'u', tree, truncated: false }),
    JSON.stringify({ sha: id(99), url: 'u', tree, truncated: false }, null, 2),
    JSON.stringify({ truncated: false, tree, sha: id(99) }),
    JSON.stringify({ sha: id(99), tree }),
    '{"sha":"' +
      id(99) +
      '","tree":[{"path":"p","path":"q","mode":"100644","type":"blob","sha":"' +
      id(1) +
      '","size":1e1}],"truncated":false}',
    '{"sha":"' +
      id(99) +
      '","tree":[{"path":"\\u0070","mode":"\\u0031" ,"type":"blob","sha":"' +
      id(1) +
      '","size":-0}],"truncated":false}',
    // Not flat: read by JSON.parse instead.
    JSON.stringify({ sha: id(99), tree: [{ ...tree[0], extra: { nested: true } }], truncated: false }),
  ];
  for (const text of replies) {
    const scanned = readTreeReply(Buffer.from(text));
    assert.deepEqual(
      { sha: scanned.sha, truncated: scanned.truncated, entries: entries(scanned) },
      parsed(text),
      text.slice(0, 80),
    );
  }
  // GitHub's truncated layout: sha first, truncated last; nothing in the tree is read.
  const cut = readTreeReply(
    Buffer.from(JSON.stringify({ sha: id(99), url: 'u', tree: [{ bad: 1 }], truncated: true }, null, 2)),
  );
  assert.deepEqual([cut.sha, cut.truncated, cut.rows.length], [id(99), true, 0]);
  assert.throws(() => readTreeReply(Buffer.from('{"sha":"x","tree":7}')), /another tree/);
  assert.throws(() => readTreeReply(Buffer.from('{"sha":')), SyntaxError);
});

test('Issue 96f164ce: the stored-object table answers has/get/set/values like the Map it replaces, and sorts by digest', () => {
  const sha = n => createHash('sha256').update(String(n)).digest('hex');
  const table = new CatalogTable(),
    map = new Map();
  const put = entry => {
    table.set(entry.digest, entry);
    map.set(entry.digest, entry);
  };
  for (let i = 0; i < 5000; i++)
    put({
      digest: sha(i),
      size: i,
      ...(i % 7 === 0 ? { pack: { digest: sha(`pack-${i % 3}`), size: 1e9, offset: i * 10 } } : {}),
      ...(i % 11 === 0 ? { recipe: { digest: sha(`recipe-${i}`), size: 99 } } : {}),
      ...(i % 13 === 0 ? { stateGeneration: 2 } : {}),
    });
  put({ digest: sha(7), size: 70 }); // a digest stored again replaces its row, pack and all
  assert.equal(table.size, map.size);
  for (const [digest, entry] of map) assert.deepEqual(table.get(digest), entry);
  for (const digest of [sha('absent'), 'A'.repeat(64), 'short', ''])
    assert.deepEqual([table.has(digest), table.get(digest)], [false, undefined], digest);
  assert.deepEqual([...table.values()], [...map.values()]);
  assert.deepEqual(
    [...table.sorted()].map(entry => entry.digest),
    [...map.keys()].sort(),
  );
  assert.throws(() => table.set('x', { digest: 'x', size: 1 }), TypeError);
});

test('Issue 96f164ce: a publication retry reads the stored State one file at a time, escaped paths exact', () => {
  const files = [
    { path: 'plain.txt', blob: 'a'.repeat(64), mode: 'file' },
    { path: 'quote " and \\ back\\slash', blob: 'b'.repeat(64), mode: 'executable' },
    { path: 'caf\u00e9/\u6587\u4ef6\n\u0001', blob: 'c'.repeat(64), mode: 'symlink' },
    { path: 'vendor/sub', blob: 'd'.repeat(64), mode: 'gitlink' },
  ];
  const state = files =>
    Buffer.from(
      `{"schema":1,"kind":"forge-source-state","parents":[],"files":[${files.map(file => JSON.stringify(file)).join(',')}],"message":"m","at":"t"}`,
    );
  assert.deepEqual([...importStateFiles(state(files))], files);
  assert.deepEqual([...importStateFiles(state([]))], []);
  const bytes = state(files).toString();
  for (const damaged of [
    bytes.replace('"mode":"file"', '"mode":"tree"'),
    bytes.replace('a'.repeat(64), 'A'.repeat(64)),
    bytes.replace('"schema":1', '"schema":2'),
    bytes.slice(0, bytes.length / 2),
  ])
    assert.throws(() => [...importStateFiles(Buffer.from(damaged))], { code: 'INVALID_WORK_BACKUP' });
});

test('Issue 96f164ce: an archive step keeps file pins in columns, under 300 bytes of heap per file from listing to archive-complete (150,612 files peaked at 494 of 512 MB)', async t => {
  if (process.env.FORGE_ARCHIVE_HEAP_WORKER !== '1') {
    // Earlier archive cases change V8's retained caches and heap baseline. Measure this
    // per-file contract in a fresh process, with the same finite heap as the Node action.
    let stdout;
    try {
      ({ stdout } = await promisify(execFile)(
        process.execPath,
        [
          '--max-old-space-size=512',
          '--import',
          './tests/check-runtime.mjs',
          '--test',
          '--test-reporter=tap',
          '--test-name-pattern=^Issue 96f164ce: an archive step keeps file pins',
          fileURLToPath(import.meta.url),
        ],
        {
          env: childEnv({
            allow: ['FORGE_TEST_PRECOMPILED', 'FORGE_TEST_MODULE_DIRECTORY'],
            extra: { FORGE_ARCHIVE_HEAP_WORKER: '1' },
          }),
          maxBuffer: 1024 * 1024,
        },
      ));
    } catch (error) {
      const output = `${error.stdout ?? ''}\n${error.stderr ?? ''}`;
      const measured = output.match(/\d+ heap bytes per file between listing and archive-complete/);
      if (output.trim()) t.diagnostic(output.slice(-8000));
      throw new Error(`Archive heap worker failed: ${measured?.[0] ?? error.message}`, { cause: error });
    }
    // A successful process that selected no test is not memory evidence.
    const measured = stdout.match(/\d+ heap bytes per file between listing and archive-complete/);
    assert(measured, 'the isolated archive import reported its per-file heap measurement');
    t.diagnostic(measured[0]);
    return;
  }
  setFlagsFromString('--expose-gc');
  const gc = runInNewContext('gc');
  // Warm several receipt windows and table growth, not only the first page. Fixed
  // initialization belongs in the baseline; the measured 30,000-file import stays the same.
  const repo = repository({ files: 2000, directories: 200, submodules: 0 }),
    counts = {};
  await serve(t, repo, counts);
  await importArchive(pagedFixture());
  Object.assign(repo, repository({ files: 30_000, directories: 2_000, submodules: 0 }));
  const s = pagedFixture(),
    heap = {},
    log = console.log;
  t.after(() => {
    console.log = log;
  });
  console.log = (...args) => {
    const phase =
      typeof args[0] === 'string' && args[0].match(/^FORGE_IMPORT_METRIC .*"phase":"([a-z-]+)"/)?.[1];
    if (phase === 'listing' || phase === 'archive-complete' || phase === 'ready') {
      gc();
      heap[phase] = process.memoryUsage().heapUsed;
    }
    if (!phase) log(...args);
  };
  const job = await importArchive(s);
  console.log = log;
  assert.equal(job.completed, repo.files);
  const perFile = Math.round((heap['archive-complete'] - heap.listing) / repo.files);
  t.diagnostic(`${perFile} heap bytes per file between listing and archive-complete`);
  // Before (a path Map of pin objects plus a Map of catalog entry objects): 500 bytes here.
  assert.ok(perFile < 300, `${perFile} heap bytes per file between listing and archive-complete`);
});

test('import REST calls stay bounded by tree pages when every small archive member is omitted', async t => {
  for (const files of [10, 210]) {
    await t.test(`${files} omitted files`, async t => {
      const repo = repository({ files, directories: 1, submodules: 0 }),
        counts = {},
        s = pagedFixture();
      repo.tree = repo.tree.filter(e => e.path !== 'large.bin');
      repo.files--;
      repo.archive = tarball([]);
      await serve(t, repo, counts);
      const job = await importArchive(s);
      assert.equal(job.completed, repo.files);
      assert.equal(counts.blobs ?? 0, 0, 'no per-member REST blob requests');
      assert.equal(counts.blobPacks, Math.ceil(repo.files / 100), 'one Git fetch per bounded blob page');
      assert.equal(job.githubRequests.anonymous, 6, 'REST calls do not grow with omitted files');
    });
  }
});
