// SPDX-License-Identifier: Apache-2.0
import { workRecordRows } from './hosted-fixture.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { gunzipSync, gzipSync } from 'node:zlib';
import { pagedFixture } from './github-import-pages-fixture.mjs';
import { moduleUrl } from './convex-module.mjs';
import { tarEntries } from '../dist/github-tar.js';
import { readObjectRecipe } from '../dist/object-chunks.js';
import { readFileSync } from 'node:fs';
import { githubArchiveFiles, listGithubTree as streamListing } from '../dist/github-archive-source.js';
import { wantedBlobResponse } from './github-blob-pack-fixture.mjs';
import {
  decodeListingIndex,
  ImportedPins,
  ListingPageWriter,
  ListingPages,
} from '../dist/github-listing-codec.js';
import { TreeRows, readTreeReply } from '../dist/github-tree-split.js';
import { CatalogTable } from '../dist/import-catalog-table.js';
import { importStateFiles } from '../dist/import-state-scan.js';
import { assertColumnRetention, tableRetention } from './archive-table-retention.mjs';
import { getFunctionName } from 'convex/server';
import { startFakeR2, fakeR2Config } from './fake-r2.mjs';
const schema = (await import(moduleUrl('../convex/schema.ts'))).default;
const agent = await import(moduleUrl('../convex/projectHostedAgent.ts'));
const channels = await import(moduleUrl('../convex/projectHostedChannels.ts'));
const start = await import(moduleUrl('../convex/projectHostedStart.ts'));
const birth = await import(moduleUrl('../convex/projectHostedBirth.ts'));
const { findObject } = await import(moduleUrl('../convex/projectObjectFind.ts'));
const gitSha = bytes => createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex');
const hex = (n, width = 40) => n.toString(16).padStart(width, '0');
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');

function listingPages() {
  const pages = new Map();
  const writer = new ListingPageWriter(async page => {
    const sha256 = createHash('sha256').update(page).digest('hex');
    pages.set(sha256, Buffer.from(page));
    return { sha256, size: page.length };
  });
  return {
    writer,
    read: async (pin, span) => {
      const page = pages.get(pin.sha256);
      return (span ? page?.subarray(span.offset, span.offset + span.size) : page) ?? null;
    },
  };
}

async function listGithubTree(repository, tree, token, request) {
  const { writer, read } = listingPages();
  const totals = await streamListing(repository, tree, token, request, writer);
  if (!totals) return null;
  const index = await writer.finish(tree, totals);
  return ListingPages.open(index, read);
}

async function listedEntries(listing) {
  const entries = [];
  for await (const page of listing.pages())
    for (let row = 0; row < page.length; row++) entries.push(page.entry(row));
  return entries;
}

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
  bodies.set(gitSha(large), large);
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

const { accessKeyId, secretAccessKey } = fakeR2Config;
const r2Env = {
  R2_ACCOUNT_ID: fakeR2Config.accountId,
  R2_BUCKET: fakeR2Config.bucket,
  R2_ACCESS_KEY_ID: accessKeyId,
  R2_SECRET_ACCESS_KEY: secretAccessKey,
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
    const count = (name, input) => {
      counts[name] = (counts[name] ?? 0) + 1;
      hooks[name]?.(counts[name], input);
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
    if ((repo.split || repo.treeReply) && path.includes('/git/trees/')) {
      const recursive = u.searchParams.get('recursive') === '1';
      count(recursive ? 'treesRecursive' : 'treesFlat');
      const sha = path.split('/').at(-1);
      return Response.json(
        repo.treeReply
          ? repo.treeReply(sha, recursive)
          : splitTreeReply(repo, sha, recursive, repo.split.truncatedChild),
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
      count('blobPacks', options);
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
function startArchive(s, options) {
  return s.modules.projectGithubImport.start._handler(s.ctx, {
    operationId: randomUUID(),
    url: 'fixture/arch',
    ...options,
  });
}
async function startAcquisition(s) {
  const id = await startArchive(s);
  await s.worker(id);
  assert.ok(s.tables.projectGithubImports.get(id).listing);
  return id;
}
async function importArchive(s, options = {}, expect = 'ready') {
  const id = await startArchive(s, options);
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
    bodies: new Map(files.map(([, bytes]) => [gitSha(bytes), bytes])),
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
  // Start: repository and commit. Listing: repository and tree. Acquisition:
  // repository and tarball. Publication: repository. Git fetch consumes no REST quota.
  // With no App or deployment token configured here,
  // none of them uses an importer credential.
  assert.deepEqual(job.githubRequests, { user: 0, app: 0, server: 0, anonymous: 7 });
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
      peakRssKiB: process.resourceUsage().maxRSS,
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
  assert.deepEqual(
    row.stateSize,
    { fileCount: repo.files, manifestBytes: row.size },
    'streaming import records logical State size on the final catalog write',
  );
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
  assert.deepEqual(await listedEntries(listing), await listedEntries(whole));
  // The truncated recursive root, the root without recursion, then each of the 4 directories once.
  assert.deepEqual(counts, { recursive: 1 + 4, flat: 1 });
  assert.equal(listing.submodules, 2);
  const mode = async path => (await listing.lookup(path)).mode;
  assert.equal(await mode('vendor-1'), '160000');
  assert.equal(await mode('dir-1/file-1'), '120000');
  assert.equal(await mode('dir-0/' + 'x'.repeat(90) + '-file-0'), '100755');
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
  const paths = (await listedEntries(listing)).map(entry => entry.path);
  assert.deepEqual(
    paths,
    reference.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0)),
  );
  assert.ok(paths.some(path => path.startsWith('dir-copy/')));
  // Root recursive, root flat, dir-1 recursive + flat (truncated), dir-0/2/3 recursive; dir-copy reuses dir-0's reply.
  assert.deepEqual(counts, { recursive: 1 + 4, flat: 2 });
  assert.equal((await listing.lookup('dir-1/vendor-nested')).mode, '160000');
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
  // flat. The listing step pins it; the archive run reads the stored table (Issue e5be6ef3).
  assert.deepEqual(counts, { treesRecursive: 4, treesFlat: 2, tarball: 1, archive: 1, blobPacks: 1 });
  assert.equal(
    job.githubRequests.anonymous,
    2 + 1 + 6 + 2 + 1,
    'one repository read per step, one commit, one listing of 6, one tarball',
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
  const same = { path: 'same\uFFFD', mode: '100644', type: 'blob', sha: id(3), size: 1 };
  await assert.rejects(
    listGithubTree('fixture/arch', id(1), undefined, async () =>
      Response.json({ sha: id(1), truncated: false, tree: [same, same] }),
    ),
    error =>
      error.code === 'GITHUB_SOURCE_UNSUPPORTED' &&
      error.message.includes('2 paths') &&
      error.message.includes('same\\uFFFD, same\\uFFFD'),
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
  assert.deepEqual(listingKeys(bucket), [], 'publication retry deletes listing and pin scratch');
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
const packWants = init =>
  [
    ...Buffer.from(init.body)
      .toString()
      .matchAll(/want ([0-9a-f]{40})/g),
  ].map(match => match[1]);

/** A deadline after the first 1,000 verified members, with a second upload
 * window, fallback pack, streamed large blob and every supported file mode. */
function deadlineRepository() {
  const tree = [],
    members = [],
    bodies = new Map();
  const append = (path, bytes, mode = '100644', archived = bytes) => {
    const sha = gitSha(bytes);
    tree.push({ path, sha, type: 'blob', mode, size: bytes.length });
    bodies.set(sha, bytes);
    if (archived !== null)
      members.push(
        mode === '120000' ? { path, type: '2', linkname: bytes.toString() } : { path, bytes: archived },
      );
  };
  for (let i = 0; i < 2_400; i++) {
    const bytes = createHash('shake256', { outputLength: 4096 }).update(String(i)).digest();
    append('source-' + String(i).padStart(4, '0'), bytes, i === 0 ? '100755' : '100644');
  }
  append('link', Buffer.from('source-0001'), '120000');
  append('large', Buffer.alloc(2 * 1024 * 1024 + 5, 15));
  append('omitted', Buffer.from('actual omitted'), '100644', null);
  append('rewritten', Buffer.from('actual version'), '100644', Buffer.from('export version'));
  tree.push({ path: 'vendor', sha: hex(2), type: 'commit', mode: '160000' });
  return { tree, archive: tarball(members), bodies };
}

test('Issue e165787c: the 1,001st archive member hits the deadline and blob packs finish the exact import', async t => {
  const repo = deadlineRepository();
  let control;
  for (const resume of [false, true]) {
    await t.test(resume ? 'deadline and continuation' : 'one-step control', async t => {
      const s = pagedFixture(),
        counts = {},
        packs = [];
      const clock = skewClock(t);
      const bucket = await serve(t, repo, counts, { blobPacks: (_n, init) => packs.push(packWants(init)) });
      clock.bucket = bucket;
      if (resume) {
        const run = s.ctx.runMutation;
        s.ctx.runMutation = async (ref, input) => {
          const result = await run(ref, input);
          if (
            getFunctionName(ref) === 'projectGithubImportStore:archiveProgress' &&
            input.completed === 1_000 &&
            input.objects.length
          )
            clock.jump(7);
          return result;
        };
      }
      const started = performance.now();
      const id = await startAcquisition(s);
      await s.worker(id);
      let job = s.tables.projectGithubImports.get(id);
      const perFileInventory = () =>
        [...s.tables.projectGithubImportInventory.values()].filter(
          row => row.part === 'files' || row.part === 'imported',
        );
      if (resume) {
        assert.equal(job.phase, 'importing', JSON.stringify(job.error));
        assert.equal(job.step, 2);
        assert.equal(job.completed, 1_000);
        assert.equal(job.bytes, 4_096_000);
        assert.equal(s.tables.hostedProjects.get(job.projectId).currentBackup, null);
        assert.equal(counts.tarball, 1);
        assert.equal(counts.blobPacks, undefined);
        assert.equal(listingKeys(bucket).length, 3, 'one page, its index, and one pin checkpoint');
        assert.equal(perFileInventory().length, 0);
        await s.worker(id);
        job = s.tables.projectGithubImports.get(id);
        assert.deepEqual(
          new Set(packs.flat()),
          new Set(
            repo.tree
              .slice(1_000)
              .filter(row => row.mode !== '160000')
              .map(row => row.sha),
          ),
          'continuation wants only unpinned Git blobs',
        );
      }
      assert.equal(job.phase, 'ready', JSON.stringify(job.error));
      assert.equal(job.completed, 2_405);
      assert.equal(counts.tarball, 1, 'step 2 never opens the tarball');
      assert.equal(counts.archive, 1, 'step 2 never opens the archive body');
      assert.equal(perFileInventory().length, 0);
      assert.deepEqual(listingKeys(bucket), [], 'publication deletes listing and pin scratch');
      const main = await mainFiles(s, bucket, job.projectId);
      for (const path of ['large', 'omitted', 'rewritten', 'link', 'vendor']) {
        const row = repo.tree.find(row => row.path === path);
        const bytes = row.mode === '160000' ? Buffer.from(row.sha) : repo.bodies.get(row.sha);
        assert.deepEqual(await main.bytesOf(main.files.get(path).blob), bytes, path);
      }
      await drainPurge(s);
      const stats = s.stats();
      if (resume) {
        assert.ok(control, 'one-step control completed');
        assert.deepEqual(main.files, control.files, 'all digests, lengths and modes match');
        assert.ok(stats.documentsWritten <= Math.min(72, control.writes) + 8, JSON.stringify(stats));
      } else {
        assert.equal(JSON.parse(job.cursor).pins, undefined);
        control = { files: main.files, writes: stats.documentsWritten };
      }
      t.diagnostic(
        JSON.stringify({
          ...counts,
          ...stats,
          calls: calls(s),
          puts: bucket.requests.filter(request => request.method === 'PUT').length,
          ms: Math.round(performance.now() - started),
        }),
      );
    });
  }
});

for (const damage of ['missing', 'altered', 'wrong tree', 'wrong listing', 'missing catalog entry'])
  test(`Issue e165787c: ${damage} pins are reacquired from Git without opening the archive`, async t => {
    const repo = repository({ files: 12, directories: 2, submodules: 0 });
    const s = pagedFixture(),
      counts = {},
      wants = [];
    const clock = skewClock(t);
    const bucket = await serve(t, repo, counts, {
      archive: n => n === 1 && clock.jump(7),
      blobPacks: (_n, init) => wants.push(...packWants(init)),
    });
    clock.bucket = bucket;
    const id = await startAcquisition(s);
    await s.worker(id);
    let job = s.tables.projectGithubImports.get(id);
    assert.equal(job.phase, 'importing', JSON.stringify(job.error));
    assert.equal(job.completed, 1);
    const cursor = JSON.parse(job.cursor);
    const key = listingKeys(bucket).find(key => key.endsWith(cursor.pins.sha256));
    assert.ok(key);
    if (damage === 'missing') bucket.objects.delete(key);
    else if (damage === 'altered') bucket.objects.set(key, Buffer.alloc(cursor.pins.size));
    else if (damage === 'missing catalog entry') {
      for (const row of s.tables.projectGithubImportInventory.values())
        if (row.jobId === id && row.part === 'objects') await s.ctx.db.delete(row._id);
    } else {
      const original = ImportedPins.decode(
        bucket.objects.get(key),
        cursor.tree,
        job.listing.sha256,
        repo.files,
      );
      assert.equal(original.count, 1);
      const bytes = original.encode(
        damage === 'wrong tree' ? hex(1_000) : cursor.tree,
        damage === 'wrong listing' ? 'f'.repeat(64) : job.listing.sha256,
        Buffer.alloc(16),
      );
      cursor.pins = { sha256: sha256(bytes), size: bytes.length };
      bucket.objects.delete(key);
      bucket.objects.set(key.replace(/[^/]+$/, cursor.pins.sha256), bytes);
      await s.ctx.db.patch(id, { cursor: JSON.stringify(cursor) });
    }
    await s.worker(id);
    job = s.tables.projectGithubImports.get(id);
    assert.equal(job.phase, 'ready', JSON.stringify(job.error));
    assert.equal(job.completed, repo.files);
    assert.deepEqual(
      new Set(wants),
      new Set(repo.tree.filter(row => row.type === 'blob').map(row => row.sha)),
    );
    assert.equal(counts.tarball, 1);
    assert.deepEqual(listingKeys(bucket), []);
  });

test('Issue e165787c: LFS-only continuation imports object bytes after its source-pack deadline', async t => {
  const repo = lfsRepository();
  // The only regular remaining file is removed so holding pointers at the
  // deadline cannot look like progress.
  const readme = repo.tree.findIndex(row => row.path === 'README.md');
  repo.tree.splice(readme, 1);
  const members = repo.tree
    .filter(row => row.type === 'blob')
    .map(row => ({ path: row.path, bytes: repo.bodies.get(row.sha) }));
  repo.archive = tarball(members);
  const s = pagedFixture(),
    counts = {},
    packs = [];
  const clock = skewClock(t);
  const bucket = await serve(t, repo, counts, {
    archive: n => n === 1 && clock.jump(7),
    blobPacks: (n, init) => {
      packs.push(packWants(init));
      if (n === 2) clock.jump(7);
    },
  });
  clock.bucket = bucket;
  const job = await importArchive(s);
  assert.equal(job.step, 2);
  assert.equal(counts.tarball, 1);
  assert.equal(counts.lfsDownload, 2);
  assert.deepEqual(packs[0], [repo.tree.find(row => row.path === '.gitattributes').sha]);
  const { files, bytesOf } = await mainFiles(s, bucket, job.projectId);
  assert.deepEqual(await bytesOf(files.get('model.bin').blob), repo.model);
  assert.deepEqual(await bytesOf(files.get('assets/big.dat').blob), repo.big);
  assert.deepEqual(await bytesOf(files.get('assets/keep.txt').blob), pointer(repo.untracked));
});

for (const kind of ['failed advance', 'lost advance reply'])
  test(`Issue e165787c: ${kind} keeps one selected checkpoint and publication removes it`, async t => {
    const repo = repository({ files: 14, directories: 2, submodules: 1 });
    const s = pagedFixture(),
      counts = {};
    const clock = skewClock(t);
    const bucket = await serve(t, repo, counts, {
      archive: n => n === 1 && clock.jump(7),
      blobPacks: n => kind === 'failed advance' && n === 1 && clock.jump(7),
    });
    clock.bucket = bucket;
    const run = s.ctx.runMutation;
    let fault = true;
    s.ctx.runMutation = async (ref, input) => {
      if (getFunctionName(ref) !== 'projectGithubImportStore:advance' || !fault) return run(ref, input);
      fault = false;
      if (kind === 'lost advance reply') await run(ref, input);
      throw Error('synthetic advance connection error');
    };
    const id = await startAcquisition(s);
    await s.worker(id);
    let job = s.tables.projectGithubImports.get(id);
    assert.equal(job.phase, kind === 'failed advance' ? 'error' : 'importing');
    assert.equal(job.completed, 1);
    const pins = JSON.parse(job.cursor).pins;
    assert.equal(listingKeys(bucket).length, 3);
    assert.ok(listingKeys(bucket).some(key => key.endsWith(pins.sha256)));
    if (job.phase === 'error')
      await s.modules.projectGithubImportStore.resume._handler(s.ctx, { id, actor: 'owner' });
    await s.worker(id);
    job = s.tables.projectGithubImports.get(id);
    if (kind === 'failed advance') {
      assert.equal(job.phase, 'importing', JSON.stringify(job.error));
      assert.equal(listingKeys(bucket).length, 3, 'advance replaces the previous checkpoint');
      assert.ok(!listingKeys(bucket).some(key => key.endsWith(pins.sha256)));
      await s.worker(id);
      job = s.tables.projectGithubImports.get(id);
    }
    assert.equal(job.phase, 'ready', JSON.stringify(job.error));
    assert.equal(counts.tarball, 1);
    assert.deepEqual(listingKeys(bucket), []);
  });

test('Issue e165787c: a failed first step leaves durable pins for retry without a second archive', async t => {
  const repo = repository({ files: 15, directories: 3, submodules: 1 });
  const s = pagedFixture(),
    counts = {};
  const bucket = await serve(t, repo, counts, {
    blobPacks: n => {
      if (n === 1) throw Error('synthetic Git pack disconnect');
    },
  });
  const id = await startAcquisition(s);
  await s.worker(id);
  const failed = s.tables.projectGithubImports.get(id);
  assert.equal(failed.phase, 'error');
  assert.equal(failed.step, 1);
  assert.equal(failed.completed, repo.files - 2, 'verified archive members reached the durable catalog');
  assert.ok(JSON.parse(failed.cursor).pins);
  assert.equal(listingKeys(bucket).length, 3);
  await s.modules.projectGithubImportStore.resume._handler(s.ctx, { id, actor: 'owner' });
  await s.worker(id);
  const job = s.tables.projectGithubImports.get(id);
  assert.equal(job.phase, 'ready', JSON.stringify(job.error));
  assert.equal(job.completed, repo.files);
  assert.equal(counts.tarball, 1);
  assert.deepEqual(listingKeys(bucket), []);
});

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
  assert.equal(job.step, 2, 'listing and two archive runs');
  assert.equal(job.completed, repo.files);
  // 4 recursive + 2 flat reads complete the listing.
  assert.deepEqual(counts, { treesRecursive: 4, treesFlat: 2, tarball: 1, archive: 1, blobPacks: 2 });
  assert.equal(
    job.githubRequests.anonymous,
    2 + 1 + 6 + 2 + 1 + 1,
    'one repository read per step, one commit, one listing of 6, one tarball',
  );
  assert.equal(listingGets(bucket), 5, 'each archive step reads index and page, continuation reads pins');
  assert.deepEqual(listingKeys(bucket), [], 'scratch is deleted once main is published');
});

test('Issue e5be6ef3: a run that stored the last file at its time budget publishes in that run, with no second pass over the archive', async t => {
  const repo = repository({ files: 20, directories: 2, submodules: 1 }),
    counts = {},
    s = pagedFixture(),
    clock = skewClock(t);
  // The omitted and rewritten files are fetched after the stream ends; the budget passes during them.
  clock.bucket = await serve(t, repo, counts, { blobPacks: n => n === 1 && clock.jump(7) });
  const job = await importArchive(s);
  assert.equal(job.step, 1, 'listing, then one archive step');
  assert.equal(job.completed, repo.files);
  assert.deepEqual(counts, { trees: 1, tarball: 1, archive: 1, blobPacks: 1 });
  assert.equal(JSON.parse(job.cursor).pins, undefined, 'one step writes no checkpoint');
});

for (const legacy of [false, true])
  test(`Issue e165787c: ${legacy ? 'a job stuck without a listing or task resumes' : 'start schedules listing without requesting it'}`, async t => {
    const s = pagedFixture(),
      counts = {};
    const repo = repository({ files: 12 });
    const bucket = await serve(t, repo, counts);
    const operationId = randomUUID();
    const id = await startArchive(s, { operationId });
    const started = structuredClone(s.tables.projectGithubImports.get(id));
    assert.ok(started.task);
    assert.equal(started.listing, undefined);
    assert.equal(started.totalKnown, false);
    assert.deepEqual(counts, {});
    assert.deepEqual(listingKeys(bucket), []);
    if (legacy) {
      await s.ctx.db.patch(id, { task: undefined, total: repo.files, totalKnown: true, phase: 'importing' });
      assert.equal(await startArchive(s, { operationId }), id);
      assert.notEqual(s.tables.projectGithubImports.get(id).task, started.task);
      assert.equal(s.tables.hostedProjects.size, 1);
      assert.deepEqual(counts, {});
    }
    await s.worker(id);
    const listed = s.tables.projectGithubImports.get(id);
    assert.ok(listed.listing && listed.task !== started.task);
    assert.equal(listed.total, repo.files);
    assert.equal(listed.completed, 0);
    assert.deepEqual(counts, { trees: 1 });
    const writes = bucket.requests.filter(request => request.method === 'PUT');
    assert.equal(writes.length, 2, 'one page plus its index');
    assert.equal(s.tables.projectGithubImportInventory.size, 0);
  });

test('Issue e165787c: a late unsplittable directory switches to paged discovery and drops partial listing pages', async t => {
  const dir = (path, n) => ({ path, mode: '040000', type: 'tree', sha: hex(n) });
  const repo = {
    treeReply(sha, recursive) {
      if (sha === hex(1))
        return { sha, truncated: recursive, tree: recursive ? [] : [dir('a', 2), dir('b', 3), dir('c', 4)] };
      if (sha === hex(4)) return { sha, truncated: true, tree: [] };
      return {
        sha,
        truncated: false,
        tree: Array.from({ length: 33_000 }, (_, i) => ({
          path: 'file-' + String(i).padStart(5, '0'),
          mode: '100644',
          type: 'blob',
          sha: hex(i + 5),
          size: 3,
        })),
      };
    },
  };
  const s = pagedFixture(),
    counts = {};
  const bucket = await serve(t, repo, counts);
  const id = await startArchive(s, { lfsLimitBytes: 0 });
  await s.worker(id);
  const job = s.tables.projectGithubImports.get(id);
  assert.equal(job.protocol, 2);
  assert.equal(job.phase, 'discovering');
  assert.equal(JSON.parse(job.cursor).lfsLimitBytes, 0);
  assert.equal(s.tables.projectGithubImportInventory.size, 1, 'one directory seeds paged discovery');
  assert.equal(
    bucket.requests.filter(request => request.method === 'PUT').length,
    1,
    'one page flushed before refusal',
  );
  assert.deepEqual(listingKeys(bucket), []);
});

test('Issue e165787c: tree lookahead stops at the existing request cap', async () => {
  let requests = 0;
  const count = 1501;
  const totals = await streamListing(
    'fixture/arch',
    hex(1),
    undefined,
    async raw => {
      requests++;
      const url = new URL(raw);
      const sha = url.pathname.split('/').at(-1);
      const rec = url.searchParams.has('recursive');
      const root = sha === hex(1);
      const tree =
        root && !rec
          ? Array.from({ length: count }, (_, i) => ({
              path: 'd-' + String(i).padStart(4, '0'),
              mode: '040000',
              type: 'tree',
              sha: hex(i + 2),
            }))
          : [];
      return Response.json({ sha, truncated: root && rec, tree });
    },
    { append() {} },
  );
  assert.equal(totals, null);
  assert.equal(requests, 1500);
});

test('Issue e165787c: many names for one subtree take linear listing work', async t => {
  const siblings = 4096;
  let requests = 0,
    probes = 0;
  const isDirectory = TreeRows.prototype.isDirectory;
  TreeRows.prototype.isDirectory = function (index) {
    probes++;
    return isDirectory.call(this, index);
  };
  t.after(() => {
    TreeRows.prototype.isDirectory = isDirectory;
  });
  const totals = await streamListing(
    'fixture/arch',
    hex(1),
    undefined,
    async raw => {
      requests++;
      const url = new URL(raw);
      const sha = url.pathname.split('/').at(-1);
      const root = sha === hex(1);
      const truncated = root && url.searchParams.has('recursive');
      const tree = truncated
        ? []
        : root
          ? Array.from({ length: siblings }, (_, i) => ({
              path: String(i).padStart(4, '0'),
              mode: '040000',
              type: 'tree',
              sha: hex(2),
            }))
          : [{ path: 'file', mode: '100644', type: 'blob', sha: hex(3), size: 1 }];
      return Response.json({ sha, truncated, tree });
    },
    { append() {} },
  );
  assert.equal(totals.files, siblings);
  assert.equal(requests, 3);
  assert.ok(probes <= 8 * siblings, `${probes} directory probes for ${siblings} siblings`);
});

test('Issue e165787c: a complete large acquisition hands off publication once', async t => {
  const s = pagedFixture(),
    counts = {};
  const repo = repository({ files: 65_536, directories: 2_000, submodules: 0 });
  const bucket = await serve(t, repo, counts);
  const id = await startAcquisition(s);
  await s.worker(id);
  const acquired = s.tables.projectGithubImports.get(id);
  assert.equal(acquired.phase, 'importing');
  assert.equal(acquired.completed, repo.files);
  assert.equal(acquired.step, 2);
  assert.ok(JSON.parse(acquired.cursor).pins);
  assert.equal(s.tables.hostedProjects.get(acquired.projectId).currentBackup, null);
  const before = { ...counts };
  bucket.failDeletes = 1;
  await s.worker(id);
  const job = s.tables.projectGithubImports.get(id);
  assert.equal(job.phase, 'ready', JSON.stringify(job.error));
  assert.equal(job.step, 2, 'publication does not hand off again at the same file count');
  assert.deepEqual(counts, before, 'publication downloads no GitHub trees, archives or blobs');
  assert.deepEqual(listingKeys(bucket), []);
  assert.equal((await mainFiles(s, bucket, job.projectId)).files.size, repo.files);
});

for (const damage of [
  'missing index',
  'altered index',
  'missing page',
  'altered page',
  'other tree',
  'schema 2',
])
  test(`Issue e165787c: ${damage} causes a verified replacement listing`, async t => {
    const repo = repository({ files: 12, directories: 2, submodules: 0 }),
      counts = {},
      s = pagedFixture();
    const bucket = await serve(t, repo, counts);
    const id = await startAcquisition(s);
    const before = structuredClone(s.tables.projectGithubImports.get(id));
    const keys = listingKeys(bucket);
    assert.equal(keys.length, 2, 'listing pins one page and its index');
    const indexKey = keys.find(key => key.endsWith(before.listing.sha256));
    const pageKey = keys.find(key => key !== indexKey);
    const target = damage.endsWith('page') ? pageKey : indexKey;
    if (damage.startsWith('missing')) bucket.objects.delete(target);
    else if (damage.startsWith('altered')) {
      const altered = Buffer.from(bucket.objects.get(target));
      altered[altered.length - 1] ^= 255;
      bucket.objects.set(target, altered);
    } else {
      const index = JSON.parse(bucket.objects.get(indexKey));
      if (damage === 'other tree') index.tree = hex(2);
      else index.schema = 2;
      const bytes = Buffer.from(JSON.stringify(index));
      const sha = sha256(bytes);
      bucket.objects.set(indexKey.replace(before.listing.sha256, sha), bytes);
      await s.ctx.db.patch(id, { listing: { sha256: sha, size: bytes.length } });
    }
    await s.worker(id);
    assert.equal(counts.trees, 2, 'the bad listing forces a new walk before acquisition');
    assert.equal(counts.tarball, undefined);
    if (damage.startsWith('altered')) {
      assert.notEqual(s.tables.projectGithubImports.get(id).listing.sha256, before.listing.sha256);
      assert.ok(bucket.objects.has(target), 'the replacement preserves the create-only key until cleanup');
    }
    await s.worker(id);
    const job = s.tables.projectGithubImports.get(id);
    assert.equal(job.phase, 'ready', JSON.stringify(job.error));
    assert.equal(job.completed, repo.files);
    assert.deepEqual(listingKeys(bucket), []);
  });

test('Issue 96f164ce: a stored listing lookup finds every listed path and nothing else', async () => {
  const files = [
    { path: '.gitattributes', sha: hex(1), size: 3, mode: '100644' },
    { path: 'a/b', sha: hex(2), size: 0, mode: '100755' },
    { path: 'a/b.c', sha: hex(3), size: 70_000_000, mode: '100644' },
    { path: 'link', sha: hex(4), size: 6, mode: '120000' },
    { path: 'vendor/sub', sha: hex(5), size: 0, mode: '160000' },
    { path: 'z/caf\u00e9/\u6587\u4ef6 "q".txt', sha: hex(6), size: 9, mode: '100644' },
  ];
  const { writer, read } = listingPages();
  for (const file of files) await writer.append(file);
  const index = await writer.finish(hex(9), { files: files.length, totalBytes: 70_000_018, submodules: 1 });
  const encoded = Buffer.from(JSON.stringify(index));
  const back = await ListingPages.open(decodeListingIndex(encoded, hex(9)), read);
  assert.equal(back.length, files.length);
  assert.deepEqual([back.totalBytes, back.submodules], [70_000_018, 1]);
  const expected = files.map((file, row) => ({ ...file, row }));
  assert.deepEqual(await listedEntries(back), expected);
  for (const file of expected) assert.deepEqual(await back.lookup(file.path), file);
  for (const absent of ['', 'a', 'a/b/', 'link2', 'zz'])
    assert.equal(await back.lookup(absent), undefined, absent);
  assert.equal(decodeListingIndex(encoded, hex(8)), null, 'another tree');
  assert.equal(decodeListingIndex(encoded.subarray(0, 80), hex(9)), null, 'truncated');
  assert.equal(decodeListingIndex(Buffer.from(JSON.stringify({ ...index, schema: 1 })), hex(9)), null);
  assert.equal(await ListingPages.open(index, async () => null), null, 'page unavailable');
  for (const badPath of ['0', files.at(-1).path])
    assert.throws(() => writer.append({ ...files[0], path: badPath }), { code: 'GITHUB_RESPONSE' });
});

test('Issue e165787c: interleaved archive members retain their pin rows and read bounded local blocks', async () => {
  const { writer, read } = listingPages();
  const path = row => `path/${row.toString().padStart(6, '0')}`;
  const size = row => 1 + (row % 3);
  const files = 65_568;
  let totalBytes = 0;
  for (let row = 0; row < files; row++) {
    totalBytes += size(row);
    const pending = writer.append({ path: path(row), sha: hex(row), size: size(row), mode: '100644' });
    if (pending) await pending;
  }
  const index = await writer.finish(hex(9), {
    files,
    totalBytes,
    submodules: 0,
  });
  assert.equal(index.pages.length, 2);
  let readBytes = 0;
  const listing = await ListingPages.open(index, async (page, span) => {
    const bytes = await read(page, span);
    readBytes += bytes.length;
    return bytes;
  });
  readBytes = 0;
  const wanted = Array.from({ length: 32 }, (_, i) => i).flatMap(i => [65_536 + i, 65_535 - i]);
  const members = wanted.map(row => ({ path: path(row), bytes: Buffer.alloc(size(row)) }));
  const archive = (async function* () {
    yield gunzipSync(tarball(members));
  })();
  const found = [];
  for await (const { entry } of githubArchiveFiles(archive, listing, 1024)) {
    found.push(entry);
  }
  assert.deepEqual(
    found,
    wanted.map(row => ({ row, path: path(row), sha: hex(row), size: size(row), mode: '100644' })),
  );
  assert.ok(readBytes <= wanted.length * 8192, `archive lookups read ${readBytes} listing bytes`);
  assert.equal(await listing.lookup(path(65_535) + 'a'), undefined);
  const corrupt = { ...index, pages: [index.pages[0], { ...index.pages[1], first: path(65_535) }] };
  assert.equal(await ListingPages.open(corrupt, read), null);
});

test('Issue e165787c: whole, nested and split 64-digit trees emit the same ordered rows and page digest', async () => {
  const id = n => hex(n, 64);
  const dir = (path, n) => ({ path, sha: id(n), mode: '040000', type: 'tree' });
  const blob = (path, n, mode = '100644') => ({ path, sha: id(n), mode, type: 'blob', size: n });
  const root = [
    dir('a', 2),
    blob('a-b', 3),
    dir('z', 4),
    dir('z-copy', 4),
    blob('😀', 5, '120000'),
    blob('＿', 6, '100755'),
    { path: 'vendor', sha: id(7), mode: '160000', type: 'commit' },
  ];
  const a = [blob('＿', 6), dir('deep', 8), blob('😀', 5)];
  const deep = [blob('leaf', 9)];
  const z = [blob('file', 10)];
  const prefixed = (prefix, rows) => rows.map(row => ({ ...row, path: `${prefix}/${row.path}` }));
  const whole = [
    ...root,
    ...prefixed('a', a),
    ...prefixed('a/deep', deep),
    ...prefixed('z', z),
    ...prefixed('z-copy', z),
  ];
  const reference = whole
    .filter(row => row.type !== 'tree')
    .sort((a, b) => (a.path < b.path ? -1 : 1))
    .map(({ path, sha, size = 0, mode }) => ({ path, sha, size, mode }));
  const results = [];
  for (const split of [false, true]) {
    const reads = [];
    const request = async raw => {
      const url = new URL(raw);
      const sha = url.pathname.split('/').at(-1);
      const rec = url.searchParams.has('recursive');
      reads.push(sha);
      const truncated = split && rec && (sha === id(1) || sha === id(2));
      const tree = truncated
        ? []
        : sha === id(1)
          ? split
            ? root
            : whole
          : sha === id(2)
            ? a
            : sha === id(8)
              ? deep
              : z;
      return Response.json({ sha, truncated, tree });
    };
    const { writer, read } = listingPages();
    const totals = await streamListing('fixture/arch', id(1), undefined, request, writer);
    const index = await writer.finish(id(1), totals);
    const table = await ListingPages.open(index, read);
    assert.equal(index.shaBytes, 32);
    assert.deepEqual(
      await listedEntries(table),
      reference.map((entry, row) => ({ ...entry, row })),
    );
    if (split)
      assert.equal(reads.filter(sha => sha === id(4)).length, 1, 'identical small tree reuses its reply');
    results.push(sha256(JSON.stringify(index)));
  }
  assert.equal(results[0], results[1]);
});

test('Issue e165787c: malformed trees fail before a listing can be selected', async t => {
  const blob = { path: 'x', mode: '100644', type: 'blob', sha: hex(4), size: 1 };
  const dir = { path: 'x', mode: '040000', type: 'tree', sha: hex(3) };
  for (const [label, rows, code, root = hex(1)] of [
    ['duplicate file', [blob, blob], 'GITHUB_RESPONSE'],
    ['duplicate directory', [dir, dir], 'GITHUB_RESPONSE'],
    ['missing parent', [{ ...blob, path: 'undeclared/x' }], 'GITHUB_RESPONSE'],
    ['file and directory', [dir, blob], 'GITHUB_RESPONSE'],
    ['bad id', [{ ...blob, sha: 'bad' }], 'GITHUB_RESPONSE'],
    ['bad mode', [{ ...blob, mode: '100666' }], 'GITHUB_SOURCE_UNSUPPORTED'],
    ['negative size', [{ ...blob, size: -1 }], 'GITHUB_RESPONSE'],
    ['fractional size', [{ ...blob, size: 1.2 }], 'GITHUB_RESPONSE'],
    ['large blob', [{ ...blob, size: 100 * 1024 * 1024 + 1 }], 'GITHUB_BLOB_LIMIT'],
    ['Git metadata', [{ ...dir, path: '.GIT' }], 'INVALID_NATIVE_SOURCE'],
    ['Forge metadata', [{ ...dir, path: '.forge' }], 'INVALID_NATIVE_SOURCE'],
    ['wrong tree', [blob], 'GITHUB_RESPONSE', hex(2)],
  ])
    await t.test(label, async () => {
      await assert.rejects(
        listGithubTree('fixture/arch', hex(1), undefined, async () =>
          Response.json({ sha: root, truncated: false, tree: rows }),
        ),
        { code },
      );
    });
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

test('Issue c448ff99 / 96f164ce: a 30,000-file archive retains column storage; the old per-file Maps fail the same guard', async t => {
  const repo = repository({ files: 30_000, directories: 2_000, submodules: 0 }),
    s = pagedFixture();
  await serve(t, repo, {});
  let pins, catalog, retained, legacy, completed, catalogSize;
  const pinSet = ImportedPins.prototype.set,
    catalogSet = CatalogTable.prototype.set;
  // Observe the actual action's tables rather than constructing an unrelated compact fixture.
  // Restore automatically even when the worker or assertion fails.
  t.mock.method(ImportedPins.prototype, 'set', function (...args) {
    pins = this;
    return pinSet.apply(this, args);
  });
  t.mock.method(CatalogTable.prototype, 'set', function (...args) {
    catalog = this;
    return catalogSet.apply(this, args);
  });
  const log = console.log;
  t.after(() => {
    console.log = log;
  });
  console.log = (...args) => {
    if (typeof args[0] === 'string' && args[0].startsWith('FORGE_IMPORT_METRIC ')) {
      const metric = JSON.parse(args[0].slice('FORGE_IMPORT_METRIC '.length));
      if (metric.phase === 'archive-complete') {
        completed = pins?.count;
        catalogSize = catalog?.size;
        retained = tableRetention(pins, catalog);
        if (!pins || !catalog) return;
        // The previous layout retained a path Map of {blob,size} and a digest Map
        // of {digest,size,pack}. Reconstruct those exact data records from this import.
        const paths = repo.tree
          .filter(entry => entry.type !== 'tree')
          .map(entry => entry.path)
          .sort();
        const oldPins = new Map();
        for (let i = 0; i < pins.length; i++)
          oldPins.set(paths[i], { blob: pins.blob(i), size: pins.size(i) });
        const oldCatalog = new Map([...catalog.values()].map(entry => [entry.digest, entry]));
        legacy = tableRetention(oldPins, oldCatalog);
      }
    } else log(...args);
  };
  const job = await importArchive(s);
  console.log = log;
  assert.equal(job.completed, repo.files);
  assert.ok(retained, 'the action reached the archive-complete measurement boundary');
  assert.equal(completed, repo.files, 'every file was recorded in the observed pins');
  assert.ok(catalogSize >= repo.files, 'the observed catalog contains every stored object');
  // Assert outside the action: its error boundary would otherwise recode this test failure.
  assertColumnRetention(retained, repo.files);
  assert.ok(legacy, 'the old-layout control was measured');
  assert.throws(() => assertColumnRetention(legacy, repo.files), /per-file objects returned/);
  t.diagnostic(JSON.stringify({ files: repo.files, retained, legacy }));
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
      assert.equal(job.githubRequests.anonymous, 7, 'REST calls do not grow with omitted files');
    });
  }
});
