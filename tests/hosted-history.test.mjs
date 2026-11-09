// SPDX-License-Identifier: Apache-2.0
// Imported Git history (Issue e103bacf): GitHub's pack bytes go to R2 unchanged, one
// row per pack, and Lane reads (log, blame, file at a commit) equal plain git on the
// source repository. Synthetic repository, fake GitHub and the in-memory R2 bucket.
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile, execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { promisify } from 'node:util';
import { gzipSync } from 'node:zlib';
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { getFunctionName } from 'convex/server';
import { moduleUrl } from './convex-module.mjs';
import { checkReturns } from './convex-args.mjs';
import { state } from './hosted-fixture.mjs';
import { defaultR2Config, defaultR2Objects, interceptDefaultR2 } from './default-r2.mjs';
import {
  FetchResponseParser,
  PackVerifier,
  fetchGitPack,
  fetchRequest,
  pktLine,
} from '../dist/git-upload-pack.js';
import { hostedHistory } from '../dist/hosted-history-cli.js';
import { hostedHistoryCli } from '../dist/hosted-history-output.js';
import { cachedPacks, ensureHistoryRepository, indexPack } from '../dist/history-git.js';

const modules = {};
for (const name of [
  'projectHistoryStore',
  'projectHistoryImport',
  'projectHistoryRead',
  'gitServeStore',
  'gitServeInflate',
  'gitServeLane',
  'gitServeLaneStore',
  'gitServeMain',
  'gitServeMainStore',
  'gitServeWorkerStore',
  'gitServeFrame',
  'gitServeTrees',
])
  modules[name] = await import(moduleUrl(`../convex/${name}.ts`));

const gitServe = await import(moduleUrl('../convex/gitServe.ts'));
const protocol = await import('../dist/git-serve-protocol.js');

function scratch(t, prefix) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
  t.after(() => rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }));
  return root;
}
const env = {
  ...process.env,
  GIT_CONFIG_NOSYSTEM: '1',
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_AUTHOR_NAME: 'Synthetic Author',
  GIT_AUTHOR_EMAIL: 'author@example.invalid',
  GIT_COMMITTER_NAME: 'Synthetic Committer',
  GIT_COMMITTER_EMAIL: 'committer@example.invalid',
};
const git = (repo, args, input) =>
  execFileSync('git', ['-C', repo, ...args], { env, input, maxBuffer: 64 << 20 });
let clock = 1_700_000_000;
function commit(repo, files, message) {
  for (const [path, text] of Object.entries(files)) {
    if (text === null) git(repo, ['rm', '-q', path]);
    else {
      mkdirSync(join(repo, path, '..'), { recursive: true });
      writeFileSync(join(repo, path), text);
      git(repo, ['add', path]);
    }
  }
  clock += 3600;
  const date = `${clock} +0000`;
  execFileSync('git', ['-C', repo, 'commit', '-q', '-m', message], {
    env: { ...env, GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date },
  });
  return git(repo, ['rev-parse', 'HEAD']).toString().trim();
}
/** History with edits, a rename, a merge and a binary file. */
function sourceRepository(t) {
  const repo = scratch(t, 'forge-history-source-');
  git(repo, ['init', '-q', '-b', 'main']);
  const lines = n => Array.from({ length: n }, (_, i) => `line ${i + 1}\n`).join('');
  commit(repo, { 'src/app.go': lines(12), 'README.md': '# demo\n' }, 'Initial commit');
  commit(repo, { 'src/app.go': lines(12).replace('line 3\n', 'line three\n') }, 'Name line three');
  commit(repo, { 'data.bin': Buffer.from([0, 1, 2, 255]) }, 'Add binary');
  git(repo, ['checkout', '-q', '-b', 'side']);
  commit(repo, { 'docs/guide.md': 'guide\n' }, 'Side guide');
  git(repo, ['checkout', '-q', 'main']);
  commit(repo, { 'src/app.go': lines(12).replace('line 3\n', 'line three\n') + 'line 13\n' }, 'Append');
  clock += 3600;
  execFileSync('git', ['-C', repo, 'merge', '-q', '--no-ff', '-m', 'Merge side', 'side'], {
    env: { ...env, GIT_AUTHOR_DATE: `${clock} +0000`, GIT_COMMITTER_DATE: `${clock} +0000` },
  });
  git(repo, ['mv', 'README.md', 'docs/README.md']);
  const last = commit(repo, {}, 'Move readme');
  return { repo, head: last };
}
/** A v2 fetch reply for want/have, packed by git itself (no thin pack). */
function uploadPack(repo, body) {
  const text = Buffer.from(body).toString('latin1');
  const want = /want ([0-9a-f]{40})/.exec(text)[1];
  const haves = [...text.matchAll(/have ([0-9a-f]{40})/g)].map(match => match[1]);
  const pack = git(
    repo,
    ['pack-objects', '--revs', '--stdout', '-q'],
    [want, ...haves.map(h => `^${h}`)].join('\n') + '\n',
  );
  const parts = [Buffer.from(pktLine('packfile\n'))];
  for (let at = 0; at < pack.length; at += 1000) {
    const band = Buffer.concat([Buffer.from([1]), pack.subarray(at, at + 1000)]);
    parts.push(Buffer.from((band.length + 4).toString(16).padStart(4, '0')), band);
  }
  parts.push(Buffer.from('0000'));
  return { reply: Buffer.concat(parts), pack, want, haves };
}

function fixture(t, source, { visibility = 'public' } = {}) {
  const s = state([]);
  s.tables.projectGithubMirrors ??= new Map();
  const original = s.ctx.runQuery;
  s.ctx.runAction =
    s.ctx.runMutation =
    s.ctx.runQuery =
      async (ref, args) => {
        const [name, fn] = getFunctionName(ref).split(':');
        if (!modules[name]) return original(ref, args);
        // Returns are validated as Convex does: a field the validator lacks fails the call.
        const value = await modules[name][fn]._handler(s.ctx, args);
        checkReturns(modules[name][fn], value, `${name}:${fn}`);
        return value;
      };
  const previous = globalThis.fetch;
  const fetches = [];
  globalThis.fetch = async (url, options) => {
    const parsed = new URL(url);
    if (parsed.hostname.endsWith('.r2.cloudflarestorage.com')) return previous(url, options);
    if (parsed.hostname === 'api.github.com' && parsed.pathname === '/repos/example/repo')
      return Response.json({
        id: 7,
        full_name: 'example/repo',
        private: false,
        default_branch: 'main',
        html_url: 'https://github.com/example/repo',
        license: null,
      });
    if (url === 'https://github.com/example/repo.git/git-upload-pack') {
      assert.equal(options.headers['git-protocol'], 'version=2');
      const served = uploadPack(source.repo, options.body);
      fetches.push(served);
      return new Response(served.reply);
    }
    throw Error(`unexpected fetch ${url}`);
  };
  t.after(() => (globalThis.fetch = previous));
  const cache = scratch(t, 'forge-history-cache-');
  const previousCache = process.env.FORGE_HISTORY_CACHE;
  process.env.FORGE_HISTORY_CACHE = cache;
  t.after(() =>
    previousCache === undefined
      ? delete process.env.FORGE_HISTORY_CACHE
      : (process.env.FORGE_HISTORY_CACHE = previousCache),
  );
  return { s, fetches, visibility, previousFetch: previous };
}
async function importedProject(f, commit) {
  const projectId = await f.s.ctx.db.insert('hostedProjects', {
    key: 'synthetic',
    name: 'Synthetic',
    currentBackup: null,
    revision: 0,
    owner: 'owner',
    visibility: 'private',
    sourceAuthority: { mode: 'server', epoch: 1 },
  });
  await f.s.transaction(() =>
    modules.projectHistoryStore.beginHistory(
      f.s.ctx,
      { projectId, repository: 'example/repo', visibility: f.visibility, owner: 'owner', commit },
      'c'.repeat(64),
    ),
  );
  return projectId;
}
const historyRow = (s, projectId) =>
  [...s.tables.projectHistory.values()].find(row => row.projectId === projectId);
const historyPacks = (s, projectId) =>
  [...s.tables.projectHistoryPacks.values()].filter(row => row.projectId === projectId);
/** Transport counting each server call, routed to the real handlers. */
function transport(s, projectId) {
  const calls = [];
  return {
    calls,
    action: async (name, args) => {
      calls.push(name);
      const [module, fn] = name.split(':');
      return JSON.parse(await modules[module][fn]._handler(s.ctx, { ...args, projectId }));
    },
    mutation: async (name, args) => {
      calls.push(name);
      const [module, fn] = name.split(':');
      return JSON.parse(
        await s.transaction(() => modules[module][fn]._handler(s.ctx, { ...args, projectId })),
      );
    },
  };
}
const address = projectId => ({ url: 'https://example.convex.cloud', projectId });

test('pkt-lines, fetch request and side-band parsing follow the Git v2 protocol', () => {
  assert.equal(Buffer.from(pktLine('done\n')).toString(), '0009done\n');
  const want = 'a'.repeat(40),
    have = 'b'.repeat(40);
  assert.equal(
    Buffer.from(fetchRequest(want, [have, have, want])).toString(),
    `0012command=fetch\n0010agent=forge\n0001000eofs-delta\n0010no-progress\n0032want ${want}\n0032have ${have}\n0009done\n0000`,
  );
  assert.throws(
    () => fetchRequest('HEAD', []),
    e => e.code === 'BAD_ARGUMENT',
  );
  const data = [];
  const parser = new FetchResponseParser(part => data.push(part));
  const reply = Buffer.concat([
    Buffer.from(pktLine('packfile\n')),
    Buffer.from('0008\x02hi\n'),
    Buffer.from('0008\x01abc'),
    Buffer.from('0000'),
  ]);
  for (const byte of reply) parser.push(Buffer.from([byte])); // any split
  parser.end();
  assert.equal(Buffer.concat(data).toString(), 'abc');
  const refused = new FetchResponseParser(() => {});
  assert.throws(
    () => refused.push(Buffer.from(pktLine('ERR upload-pack: not our ref\n'))),
    e => e.code === 'GIT_FETCH_REFUSED',
  );
  const fatal = new FetchResponseParser(() => {});
  assert.throws(
    () => fatal.push(Buffer.concat([Buffer.from(pktLine('packfile\n')), Buffer.from('0008\x03bad')])),
    e => e.code === 'GIT_FETCH_REFUSED',
  );
  const empty = new FetchResponseParser(() => {});
  assert.throws(
    () => empty.push(Buffer.from('0000')),
    e => e.code === 'GIT_PROTOCOL',
  );
  const verifier = new PackVerifier();
  verifier.update(Buffer.from('PACK\0\0\0\x02\0\0\0\0'));
  verifier.update(Buffer.alloc(20));
  assert.throws(
    () => verifier.finish(),
    e => e.code === 'GIT_PACK_INVALID',
  );
});

test('fetchGitPack streams the exact pack, verifies its trailer and stops at the limit', async t => {
  const source = sourceRepository(t);
  const serve = async (url, options) => new Response(uploadPack(source.repo, options.body).reply);
  const parts = [];
  const receipt = await fetchGitPack(
    { url: 'https://github.com/example/repo', want: source.head, limitBytes: 1 << 30, fetch: serve },
    async part => void parts.push(part),
  );
  const pack = Buffer.concat(parts);
  assert.equal(receipt.bytes, pack.length);
  assert.equal(receipt.packSha1, pack.subarray(-20).toString('hex'));
  await assert.rejects(
    fetchGitPack(
      { url: 'https://github.com/example/repo', want: source.head, limitBytes: 100, fetch: serve },
      async () => {},
    ),
    e => e.code === 'HISTORY_OVER_LIMIT',
  );
  await assert.rejects(
    fetchGitPack(
      {
        url: 'https://github.com/example/repo',
        want: source.head,
        limitBytes: 1 << 30,
        fetch: async () => new Response('', { status: 404 }),
      },
      async () => {},
    ),
    e => e.code === 'GIT_FETCH_UNAUTHORIZED',
  );
});

test('import stores GitHub history in R2 once and Lane log, blame and file-at-commit equal git', async t => {
  const source = sourceRepository(t),
    f = fixture(t, source),
    { s } = f;
  const projectId = await importedProject(f, source.head);
  const task = s.scheduled.find(entry => getFunctionName(entry.fn) === 'projectHistoryImport:run');
  assert.ok(task, 'the import schedules one history run');
  await modules.projectHistoryImport.run._handler(s.ctx, task.args);
  const row = historyRow(s, projectId);
  assert.equal(row.status, 'ready');
  const packs = [...s.tables.projectHistoryPacks.values()];
  assert.equal(packs.length, 1, 'one row per pack, never per commit');
  assert.equal(f.fetches.length, 1);
  const stored = Buffer.concat(
    packs[0].chunks.map(chunk =>
      defaultR2Objects.get(`forge-test-blobs/v1/p/${projectId}/o/${chunk.sha256}`),
    ),
  );
  assert.ok(stored.equals(f.fetches[0].pack), 'R2 holds GitHub pack bytes unchanged');
  assert.equal(row.bytes, stored.length);
  // A replayed run records nothing new.
  await modules.projectHistoryImport.run._handler(s.ctx, task.args);
  assert.equal(s.tables.projectHistoryPacks.size, 1);

  const io = transport(s, projectId);
  const read = command => hostedHistory(address(projectId), command, io, f.previousFetch);
  const log = await read({ op: 'log', limit: 100 });
  const expected = git(source.repo, ['log', '--format=%H %P|%an|%aI|%s', source.head])
    .toString()
    .trim()
    .split('\n')
    .map(line => line.replace(' |', '|'));
  assert.deepEqual(
    log.entries.map(
      entry =>
        `${[entry.commit, ...entry.parents].join(' ')}|${entry.author}|${entry.authoredAt}|${entry.subject}`,
    ),
    expected,
  );
  assert.equal(log.commit, source.head);
  assert.ok(log.downloadedBytes > 0);
  const old = git(source.repo, ['rev-list', '--reverse', source.head]).toString().split('\n')[1];
  const fileLog = await read({ op: 'log', path: 'src/app.go' });
  assert.deepEqual(
    fileLog.entries.map(entry => entry.commit),
    git(source.repo, ['log', '--format=%H', source.head, '--', 'src/app.go']).toString().trim().split('\n'),
  );
  const blame = await read({ op: 'blame', path: 'src/app.go' });
  const lineCommits = git(source.repo, ['blame', '--porcelain', source.head, '--', 'src/app.go'])
    .toString()
    .split('\n')
    .filter(line => /^[0-9a-f]{40} \d+ \d+/.test(line))
    .map(line => line.split(' ')[0]);
  assert.deepEqual(
    blame.ranges.flatMap(range => Array.from({ length: range.end - range.start + 1 }, () => range.commit)),
    lineCommits,
  );
  assert.equal(blame.commits[blame.ranges[0].commit].author, 'Synthetic Author');
  const atOld = await read({ op: 'show', path: 'src/app.go', commit: old.slice(0, 12) });
  assert.ok(atOld.bytes.equals(git(source.repo, ['show', `${old}:src/app.go`])));
  assert.equal(atOld.commit, old);
  await assert.rejects(
    read({ op: 'show', path: 'docs/README.md', commit: old }),
    e => e.code === 'NOT_FOUND',
  );
  await assert.rejects(read({ op: 'log', commit: 'f'.repeat(40) }), e => e.code === 'NOT_FOUND');
  await assert.rejects(read({ op: 'log', commit: 'HEAD~1' }), /ZodError|Invalid/);
  // Cached on this machine: one server call per read, no download, nothing presigned.
  const before = io.calls.length;
  const again = await read({ op: 'log', limit: 1 });
  assert.equal(io.calls.length - before, 1);
  assert.equal(again.downloadedBytes, 0);
  assert.equal(f.fetches.length, 1, 'reads never refetch from GitHub while main has not moved');
});

test('history reads check current access and a moved mirror adds one coalesced catch-up pack', async t => {
  const source = sourceRepository(t),
    f = fixture(t, source),
    { s } = f;
  const imported = source.head;
  const projectId = await importedProject(f, imported);
  await modules.projectHistoryImport.run._handler(s.ctx, { projectId, attempt: 1 });
  s.caller('stranger');
  await assert.rejects(
    modules.projectHistoryRead.open._handler(s.ctx, { projectId }),
    e => e.data?.code === 'PROJECT_UNAVAILABLE',
  );
  s.caller('owner');
  // Two Forge landings mirrored to GitHub after the import.
  commit(source.repo, { 'src/new.go': 'package main\n' }, 'Forge landing one');
  const tip = commit(source.repo, { 'src/new.go': 'package main\n// two\n' }, 'Forge landing two');
  await s.ctx.db.insert('projectGithubMirrors', {
    projectId,
    repository: 'example/repo',
    activeId: null,
    mapping: JSON.stringify({
      operationId: crypto.randomUUID(),
      state: 'd'.repeat(64),
      acceptanceId: crypto.randomUUID(),
      viewId: crypto.randomUUID(),
      commit: tip,
      parent: '',
      tree: 'e'.repeat(40),
      message: 'Forge landing two',
      author: { name: 'Forge', email: 'forge@example.invalid' },
      committer: { name: 'Forge', email: 'forge@example.invalid' },
      seconds: clock,
    }),
  });
  const io = transport(s, projectId);
  const read = command => hostedHistory(address(projectId), command, io, f.previousFetch);
  const log = await read({ op: 'log', limit: 3 });
  assert.deepEqual(
    log.entries.map(entry => entry.subject),
    ['Forge landing two', 'Forge landing one', 'Move readme'],
  );
  assert.equal(log.head, tip);
  assert.equal(log.headState, 'd'.repeat(64));
  assert.equal(f.fetches.length, 2);
  assert.deepEqual(f.fetches[1].haves, [imported], 'catch-up asks only for what is missing');
  assert.equal(s.tables.projectHistoryPacks.size, 2);
  await read({ op: 'blame', path: 'src/new.go' });
  assert.equal(f.fetches.length, 2, 'the catch-up pack is fetched once');
  assert.equal(s.tables.projectHistoryPacks.size, 2);
});

test('over the limit no pack is recorded; owner raises the limit and retries', async t => {
  const source = sourceRepository(t),
    f = fixture(t, source),
    { s } = f;
  const projectId = await importedProject(f, source.head);
  const row = historyRow(s, projectId);
  s.tables.projectHistory.set(row._id, { ...row, limitBytes: 64 });
  await modules.projectHistoryImport.run._handler(s.ctx, { projectId, attempt: 1 });
  assert.equal(historyRow(s, projectId).status, 'over-limit');
  assert.equal(s.tables.projectHistoryPacks.size, 0);
  const io = transport(s, projectId);
  const read = command => hostedHistory(address(projectId), command, io, f.previousFetch);
  assert.equal((await read({ op: 'status' })).status, 'over-limit');
  // CLI form: explicit url/projectId addressing is accepted; a bad op is BAD_ARGUMENT.
  const cli = command => hostedHistoryCli('/unused', command, address(projectId), io);
  assert.equal(
    (await cli({ ...address(projectId), action: 'history', op: 'status' })).result.status,
    'over-limit',
  );
  await assert.rejects(
    cli({ op: 'nope' }),
    e => e.code === 'BAD_ARGUMENT' && /history takes/.test(e.message),
  );
  await assert.rejects(read({ op: 'log' }), e => e.code === 'HISTORY_OVER_LIMIT');
  s.caller('stranger');
  await assert.rejects(read({ op: 'limit', bytes: 1 << 30 }), e => e.data?.code === 'PROJECT_UNAVAILABLE');
  s.caller('owner');
  await assert.rejects(read({ op: 'limit', bytes: 2 ** 40 }), e => e.data?.code === 'BAD_ARGUMENT');
  assert.equal((await read({ op: 'limit', bytes: 1 << 30 })).limitBytes, 1 << 30);
  assert.deepEqual(await read({ op: 'retry' }), { status: 'pending', attempt: 2 });
  await assert.rejects(read({ op: 'log' }), e => e.code === 'HISTORY_PENDING');
  // The first (stale) attempt can no longer record.
  await modules.projectHistoryImport.run._handler(s.ctx, { projectId, attempt: 1 });
  assert.equal(s.tables.projectHistoryPacks.size, 0);
  await modules.projectHistoryImport.run._handler(s.ctx, { projectId, attempt: 2 });
  assert.equal(historyRow(s, projectId).status, 'ready');
  assert.equal((await read({ op: 'log', limit: 1 })).entries[0].subject, 'Move readme');
});

test('large packs split into bounded R2 chunks and a tampered chunk never reaches the cache', async t => {
  const source = sourceRepository(t),
    f = fixture(t, source),
    { s } = f;
  const projectId = await importedProject(f, source.head);
  const { pack } = await modules.projectHistoryImport.storeHistoryPack(
    s.ctx,
    projectId,
    { repository: 'example/repo', want: source.head, haves: [], token: null, limitBytes: 1 << 30 },
    1024,
  );
  assert.ok(pack.chunks.length > 1 && pack.chunks.every(chunk => chunk.size <= 1024));
  const repo = join(process.env.FORGE_HISTORY_CACHE, 'tampered.git');
  ensureHistoryRepository(repo);
  async function* chunks(tamper) {
    for (const [index, chunk] of pack.chunks.entries()) {
      const bytes = Buffer.from(defaultR2Objects.get(`forge-test-blobs/v1/p/${projectId}/o/${chunk.sha256}`));
      if (tamper && index === 1) bytes[0] ^= 1;
      yield { bytes, ...chunk };
    }
  }
  await assert.rejects(indexPack(repo, pack.packSha1, chunks(true)), e => e.code === 'SOURCE_HASH_MISMATCH');
  assert.deepEqual(cachedPacks(repo), []);
  await assert.rejects(indexPack(repo, 'f'.repeat(40), chunks(false)), e => e.code === 'GIT_PACK_INVALID');
  await indexPack(repo, pack.packSha1, chunks(false));
  assert.deepEqual(cachedPacks(repo), [pack.packSha1]);
});

test('chunks of a fetch that stops over the limit are deleted; a failed delete is retried once', async t => {
  const source = sourceRepository(t),
    f = fixture(t, source),
    { s } = f;
  const projectId = await importedProject(f, source.head);
  const key = sha => `forge-test-blobs/v1/p/${projectId}/o/${sha}`;
  // The in-memory bucket is shared by this process's fixtures: count only keys this test adds.
  const baseline = new Set(defaultR2Objects.keys());
  const projectKeys = () =>
    [...defaultR2Objects.keys()].filter(k => k.includes(`/v1/p/${projectId}/`) && !baseline.has(k));
  const input = { repository: 'example/repo', want: source.head, haves: [], token: null };
  const store = (limitBytes, chunkBytes = 512) =>
    modules.projectHistoryImport.storeHistoryPack(s.ctx, projectId, { ...input, limitBytes }, chunkBytes);
  // Three full chunks stored (1000-byte packets, 512-byte chunks), then the limit stops the stream: both are deleted.
  const puts = [];
  let restore = interceptDefaultR2((request, init, serve) => {
    if ((init?.method ?? 'GET') === 'PUT') puts.push(new URL(request).pathname);
    return serve(request, init);
  });
  await assert.rejects(store(2050), e => e.code === 'HISTORY_OVER_LIMIT');
  restore();
  assert.equal(puts.length, 3, 'three full chunks reached R2 before the limit');
  assert.deepEqual(projectKeys(), [], 'no partial chunk stays in R2');
  assert.equal(s.tables.projectHistoryPacks.size, 0);

  // The first delete fails: one cleanup run is scheduled and removes the chunk.
  let failing = true;
  restore = interceptDefaultR2((request, init, serve) =>
    (init?.method ?? 'GET') === 'DELETE' && failing
      ? new Response(null, { status: 503 })
      : serve(request, init),
  );
  await assert.rejects(store(1100), e => e.code === 'HISTORY_OVER_LIMIT');
  assert.equal(projectKeys().length, 1, 'the failed delete left one chunk');
  const retries = s.scheduled.filter(task => getFunctionName(task.fn) === 'projectHistoryImport:cleanup');
  assert.equal(retries.length, 1);
  assert.deepEqual(retries[0].args.sha256s.map(key), projectKeys());
  // A retry that fails again is not rescheduled (one retry only).
  await modules.projectHistoryImport.cleanup._handler(s.ctx, retries[0].args);
  assert.equal(
    s.scheduled.filter(task => getFunctionName(task.fn) === 'projectHistoryImport:cleanup').length,
    1,
  );
  failing = false;
  await modules.projectHistoryImport.cleanup._handler(s.ctx, retries[0].args);
  restore();
  assert.deepEqual(projectKeys(), []);

  // An unrecorded (stale) pack is deleted; chunks a recorded pack pins are never deleted.
  const stale = await store(1 << 30);
  assert.equal(
    await modules.projectHistoryImport.recordHistoryPack(
      s.ctx,
      projectId,
      stale,
      { tip: source.head, haves: [], source: 'import' },
      { historyBytes: 0, attempt: 99 },
    ),
    'stale',
  );
  assert.deepEqual(projectKeys(), []);
  const kept = await store(1 << 30);
  assert.equal(
    await modules.projectHistoryImport.recordHistoryPack(
      s.ctx,
      projectId,
      kept,
      { tip: source.head, haves: [], source: 'import' },
      { historyBytes: 0, attempt: 1 },
    ),
    'recorded',
  );
  const pinned = projectKeys().length;
  assert.equal(pinned, kept.pack.chunks.length);
  const result = await modules.projectHistoryImport.discardHistoryChunks(s.ctx, projectId, kept.created);
  assert.equal(result.deleted, 0);
  assert.equal(projectKeys().length, pinned);
});

test('concurrent reads after a mirror move fetch the catch-up pack once and later reads reuse it', async t => {
  const source = sourceRepository(t),
    f = fixture(t, source),
    { s } = f;
  const projectId = await importedProject(f, source.head);
  await modules.projectHistoryImport.run._handler(s.ctx, { projectId, attempt: 1 });
  const tip = commit(source.repo, { 'src/two.go': 'package main\n' }, 'Forge landing');
  await s.ctx.db.insert('projectGithubMirrors', {
    projectId,
    repository: 'example/repo',
    activeId: null,
    mapping: JSON.stringify({
      operationId: crypto.randomUUID(),
      state: 'd'.repeat(64),
      acceptanceId: crypto.randomUUID(),
      viewId: crypto.randomUUID(),
      commit: tip,
      parent: '',
      tree: 'e'.repeat(40),
      message: 'Forge landing',
      author: { name: 'Forge', email: 'forge@example.invalid' },
      committer: { name: 'Forge', email: 'forge@example.invalid' },
      seconds: clock,
    }),
  });
  // Convex runs mutations one at a time; the in-memory fixture does not, so serialize them here.
  const direct = s.ctx.runMutation;
  let queue = Promise.resolve();
  s.ctx.runMutation = (ref, args) => {
    const run = queue.then(() => direct(ref, args));
    queue = run.catch(() => {});
    return run;
  };
  s.caller('owner');
  const open = () => modules.projectHistoryRead.open._handler(s.ctx, { projectId });
  const replies = (await Promise.all([open(), open(), open()])).map(reply => JSON.parse(reply));
  assert.equal(f.fetches.length, 2, 'one import fetch and one catch-up fetch for three concurrent reads');
  assert.equal(s.tables.projectHistoryPacks.size, 2);
  const waiting = replies.filter(reply => reply.catchUp?.code === 'HISTORY_CATCH_UP_RUNNING');
  assert.equal(waiting.length, 2, 'the other two reads were told a fetch is already running');
  assert.equal(historyRow(s, projectId).catchUp, undefined, 'the lease ends with the recorded pack');
  const later = JSON.parse(await open());
  assert.equal(later.catchUp, undefined);
  assert.equal(f.fetches.length, 2, 'a later read reuses the stored pack');
});

// Hosted Git serving (Issue 09367fb2): plain git clone/fetch from Forge's HTTP endpoint.
const run = promisify(execFile);
const gitEnv = { ...env, GIT_TERMINAL_PROMPT: '0', GIT_ASKPASS: '', SSH_ASKPASS: '' };
const client = (args, cwd) =>
  run('git', ['-c', 'credential.helper=', ...args], { env: gitEnv, cwd, maxBuffer: 64 << 20 });
const refused = async (args, pattern) => {
  const error = await client(args).then(
    () => assert.fail(`git ${args[0]} should fail`),
    e => e,
  );
  assert.match(String(error.stderr), pattern);
};
/** Serves the HTTP action on a local port and counts every Convex call it makes. */
async function gitHost(t, s) {
  const counts = { http: 0, query: 0, mutation: 0, action: 0 };
  for (const [kind, key] of [
    ['query', 'runQuery'],
    ['mutation', 'runMutation'],
    ['action', 'runAction'],
  ]) {
    const inner = s.ctx[key];
    s.ctx[key] = (ref, args) => {
      counts[kind]++;
      return inner(ref, args);
    };
  }
  const server = createServer(async (req, res) => {
    counts.http++;
    const body = [];
    for await (const part of req) body.push(part);
    const headers = new Headers(Object.entries(req.headers).filter(([, value]) => typeof value === 'string'));
    // A throwing HTTP action answers 500, as Convex does, so git never waits on it.
    let response;
    try {
      response = await gitServe.serve._handler(
        s.ctx,
        new Request(`https://forge.example${req.url}`, {
          method: req.method,
          headers,
          ...(req.method === 'POST' ? { body: Buffer.concat(body) } : {}),
        }),
      );
    } catch (error) {
      console.error('git serve threw', error);
      response = new Response(String(error), { status: 500 });
    }
    res.writeHead(response.status, Object.fromEntries(response.headers));
    if (response.body) for await (const part of response.body) res.write(part);
    res.end();
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => server.close());
  const base = `http://127.0.0.1:${server.address().port}`;
  const snapshot = () => ({ ...counts });
  const since = before =>
    Object.fromEntries(Object.keys(counts).map(key => [key, counts[key] - before[key]]));
  const handle = (path, init = {}) =>
    gitServe.serve._handler(s.ctx, new Request(`https://forge.example${path}`, init));
  return { base, counts, snapshot, since, handle };
}
const mirrorAt = (s, projectId, tip, message = 'Forge landing') =>
  s.ctx.db.insert('projectGithubMirrors', {
    projectId,
    repository: 'example/repo',
    activeId: null,
    mapping: JSON.stringify({
      operationId: crypto.randomUUID(),
      state: 'd'.repeat(64),
      acceptanceId: crypto.randomUUID(),
      viewId: crypto.randomUUID(),
      commit: tip,
      parent: '',
      tree: 'e'.repeat(40),
      message,
      author: { name: 'Forge', email: 'forge@example.invalid' },
      committer: { name: 'Forge', email: 'forge@example.invalid' },
      seconds: clock,
    }),
  });
const publish = (s, projectId) => {
  const row = s.tables.hostedProjects.get(projectId);
  s.tables.hostedProjects.set(projectId, { ...row, visibility: 'public' });
};
const log = (repo, ref = 'HEAD') => git(repo, ['log', '--format=%H %s', ref]).toString();

test('stock git clones and fetches a public project from Forge with GitHub commit ids, constant calls', async t => {
  const source = sourceRepository(t),
    f = fixture(t, source),
    { s } = f;
  const projectId = await importedProject(f, source.head);
  publish(s, projectId);
  await modules.projectHistoryImport.run._handler(s.ctx, { projectId, attempt: 1 });
  const host = await gitHost(t, s);
  const url = `${host.base}/git/${projectId}.git`;
  const work = scratch(t, 'forge-git-clone-');
  let before = host.snapshot();
  await client(['clone', '-q', url, join(work, 'one')]);
  assert.equal(log(join(work, 'one')), log(source.repo), 'same commits, same ids as the source');
  // Anonymous clone: info/refs, ls-refs, fetch; one query each, no mutation or action.
  assert.deepEqual(host.since(before), { http: 3, query: 3, mutation: 0, action: 0 });
  before = host.snapshot();
  const noop = await client(['fetch', '-v'], join(work, 'one'));
  assert.match(String(noop.stderr), /up to date/);
  assert.deepEqual(host.since(before), { http: 2, query: 2, mutation: 0, action: 0 });
  const listed = (await client(['ls-remote', url])).stdout.trim().split('\n');
  assert.deepEqual(
    listed,
    [`${source.head}\tHEAD`, `${source.head}\trefs/heads/main`],
    'no Lane or other refs',
  );

  // Main moves on GitHub's mirror: the next fetch adds one catch-up pack and gets only it.
  commit(source.repo, { 'src/new.go': 'package main\n' }, 'Forge landing one');
  const tip = commit(source.repo, { 'src/new.go': 'package main\n// two\n' }, 'Forge landing two');
  await mirrorAt(s, projectId, tip);
  before = host.snapshot();
  await client(['fetch', '-q'], join(work, 'one'));
  assert.equal(git(join(work, 'one'), ['rev-parse', 'origin/main']).toString().trim(), tip);
  assert.equal(f.fetches.length, 2);
  assert.deepEqual(f.fetches[1].haves, [source.head]);
  assert.equal(host.since(before).http, 3);
  before = host.snapshot();
  await client(['fetch', '-q'], join(work, 'one'));
  assert.deepEqual(host.since(before), { http: 2, query: 2, mutation: 0, action: 0 }, 'catch-up runs once');

  // A fresh clone joins both stored packs into one verified pack; v0 clients work too.
  await client(['clone', '-q', url, join(work, 'two')]);
  assert.equal(log(join(work, 'two')), log(source.repo, tip));
  await client(['fsck', '--full'], join(work, 'two'));
  await client(['-c', 'protocol.version=0', 'clone', '-q', url, join(work, 'v0')]);
  assert.equal(log(join(work, 'v0')), log(source.repo, tip));
  writeFileSync(join(work, 'two', 'local.txt'), 'x\n');
  git(join(work, 'two'), ['add', 'local.txt']);
  git(join(work, 'two'), ['commit', '-q', '-m', 'local']);
  await client(['-c', 'protocol.version=0', 'fetch', '-q'], join(work, 'two'));
  // Handle/slug URLs resolve like the web route; shallow clones and pushes are refused.
  await refused(['clone', '--depth', '1', url, join(work, 'shallow')], /shallow|full clones/);
  await refused(['-C', join(work, 'two'), 'push', 'origin', 'HEAD:main'], /pushes go through Lanes/i);
  await s.ctx.db.insert('accountHandles', { owner: 'owner', handle: 'synthetic-owner' });
  await s.ctx.db.insert('projectSlugs', { owner: 'owner', slug: 'synthetic', projectId });
  const named = (await client(['ls-remote', `${host.base}/git/Synthetic-Owner/synthetic.git`])).stdout;
  assert.match(named, new RegExp(`^${tip}\tHEAD`));
  const unknown = await host.handle('/git/nobody/nothing.git/info/refs?service=git-upload-pack');
  assert.equal(unknown.status, 401);
  assert.match(unknown.headers.get('www-authenticate'), /^Basic /);
});

test('private projects need a current Forge login; non-members learn nothing and Lane refs never list', async t => {
  const source = sourceRepository(t),
    f = fixture(t, source, { visibility: 'private' }),
    { s } = f;
  const projectId = await importedProject(f, source.head);
  await modules.projectHistoryImport.run._handler(s.ctx, { projectId, attempt: 1 });
  const host = await gitHost(t, s);
  const token = (credentialId, owner, extra = {}) => {
    const encode = value => Buffer.from(JSON.stringify(value)).toString('base64url');
    const value = `${encode({ alg: 'RS256' })}.${encode({ sub: owner, forgeCredential: credentialId })}.sig`;
    s.ctx.db.insert('cliCredentials', {
      owner,
      name: 'Synthetic CLI',
      scope: 'cli',
      credentialId,
      tokenHash: createHash('sha256').update(value).digest('hex'),
      issuedAt: Date.now(),
      expiresAt: Date.now() + 60_000,
      revoked: false,
      ...extra,
    });
    return value;
  };
  const owner = token('cred-owner', 'owner'),
    stranger = token('cred-stranger', 'stranger'),
    revoked = token('cred-revoked', 'owner', { revoked: true }),
    coordination = token('cred-coord', 'owner', { scope: 'coordination' });
  const refs = `/git/${projectId}.git/info/refs?service=git-upload-pack`;
  const basic = value => ({ authorization: `Basic ${Buffer.from(`git:${value}`).toString('base64')}` });
  const anonymous = await host.handle(refs);
  assert.equal(anonymous.status, 401);
  assert.match(anonymous.headers.get('www-authenticate'), /^Basic realm="Forge"/);
  const foreign = await host.handle(refs, { headers: basic(stranger) });
  assert.equal(foreign.status, 404, 'a signed-in non-member gets "not found", never the refs');
  assert.doesNotMatch(await foreign.text(), new RegExp(source.head));
  for (const value of [revoked, coordination, 'not-a-token', owner.replace(/sig$/, 'forged')])
    assert.equal((await host.handle(refs, { headers: basic(value) })).status, 401);
  const forged = await host.handle(`/git/${projectId}.git/git-upload-pack`, {
    method: 'POST',
    headers: { 'git-protocol': 'version=2', ...basic(stranger) },
    body: protocol.concatBytes([
      protocol.pkt('command=fetch\n'),
      protocol.delimPkt,
      protocol.pkt(`want ${source.head}\n`),
      protocol.pkt('done\n'),
      protocol.flushPkt,
    ]),
  });
  assert.equal(forged.status, 404, 'a direct fetch is checked like the ref listing');
  const work = scratch(t, 'forge-git-private-');
  await refused(
    ['clone', `${host.base}/git/${projectId}.git`, join(work, 'anon')],
    /Username|401|Authentication/i,
  );
  const authed = `${host.base.replace('http://', `http://git:${owner}@`)}/git/${projectId}.git`;
  await client(['clone', '-q', authed, join(work, 'owner')]);
  assert.equal(log(join(work, 'owner')), log(source.repo));
  const listed = (await client(['ls-remote', authed])).stdout;
  assert.doesNotMatch(listed, /refs\/forge|lanes/);
  assert.equal(listed.trim().split('\n').length, 2);
});

test('a mirrored project without imported history seeds it once from the mirror; no history is a named error', async t => {
  const source = sourceRepository(t),
    f = fixture(t, source),
    { s } = f;
  const projectId = await s.ctx.db.insert('hostedProjects', {
    key: 'born',
    name: 'Born',
    currentBackup: null,
    revision: 0,
    owner: 'owner',
    visibility: 'public',
    sourceAuthority: { mode: 'server', epoch: 1 },
  });
  const host = await gitHost(t, s);
  const work = scratch(t, 'forge-git-seed-');
  const url = `${host.base}/git/${projectId}.git`;
  await refused(['clone', url, join(work, 'none')], /GIT_HISTORY_UNAVAILABLE/);
  await mirrorAt(s, projectId, source.head);
  await client(['clone', '-q', url, join(work, 'seeded')]);
  assert.equal(log(join(work, 'seeded')), log(source.repo));
  const row = historyRow(s, projectId);
  assert.equal(row.status, 'ready');
  assert.equal(row.importCommit, source.head);
  assert.equal(row.visibility, 'public', 'a public project seeds only from a public repository');
  assert.equal(f.fetches.length, 1);
  await client(['clone', '-q', url, join(work, 'again')]);
  assert.equal(f.fetches.length, 1, 'seeded once');
});

test('pack selection, joining, gzip requests and the main gap are explicit', async t => {
  const packs = [
    { tip: 'a'.repeat(40), bytes: 100, objects: 3 },
    { tip: 'b'.repeat(40), bytes: 50, objects: 1 },
    { tip: 'c'.repeat(40), bytes: 60, objects: 2 },
  ];
  assert.deepEqual(protocol.selectPacks(packs, ['c'.repeat(40)], []), { from: 0, to: 2, common: null });
  assert.deepEqual(protocol.selectPacks(packs, ['c'.repeat(40)], ['f'.repeat(40), 'a'.repeat(40)]), {
    from: 1,
    to: 2,
    common: 'a'.repeat(40),
  });
  assert.throws(
    () => protocol.selectPacks(packs, ['d'.repeat(40)], []),
    e => e.code === 'GIT_NOT_OUR_REF',
  );
  assert.equal(new protocol.PackJoiner(packs).bytes, 12 + (100 + 50 + 60 - 96) + 20);
  const { chunkParts } = await import('../dist/git-worker-plan.js');
  // A pack body without its 12-byte header and 20-byte trailer, across three chunks.
  assert.deepEqual(chunkParts([10, 30, 5], 12, 25), [{ chunk: 1, start: 2, end: 15, whole: false }]);
  assert.deepEqual(
    chunkParts([10, 30, 5], 0, 45).map(part => part.whole),
    [true, true, true],
  );
  assert.deepEqual(chunkParts([40, 10], 12, 30), [{ chunk: 0, start: 12, end: 30, whole: false }]);
  // v2 framed copies: header and trailer in frames of their own, full frames between, for any
  // push sizes; equal to side-band framing of the three regions (Issue 7c36abfb).
  const { PackFramer, framedBytes, framedHead, framedTail } = await import('../dist/git-worker-plan.js');
  for (const size of [32, 33, 32 + 65515, 32 + 65516, 200_000]) {
    const pack = Uint8Array.from({ length: size }, (_, i) => (i * 7) % 251);
    const expected = Buffer.concat([
      protocol.sideband(1, pack.subarray(0, 12)),
      protocol.sideband(1, pack.subarray(12, size - 20)),
      protocol.sideband(1, pack.subarray(size - 20)),
    ]);
    for (const step of [1, 7, 4096, size]) {
      const framer = new PackFramer(size),
        out = [];
      for (let at = 0; at < size; at += step) out.push(...framer.push(pack.subarray(at, at + step)));
      framer.end();
      const framed = Buffer.concat(out);
      assert.ok(framed.equals(expected), `framed ${size} in steps of ${step}`);
      assert.equal(framed.length, framedBytes(size));
      assert.equal(framed.subarray(0, framedHead).toString('latin1', 0, 5), '0011\x01');
      assert.equal(framed.subarray(framed.length - framedTail).toString('latin1', 0, 5), '0019\x01');
    }
    assert.throws(() => new PackFramer(size).end(), /shorter/);
    assert.throws(() => new PackFramer(size).push(new Uint8Array(size + 1)), /longer/);
  }
  assert.throws(
    () => protocol.parseFetchArgs(['want ' + 'a'.repeat(40), 'ofs-delta', 'deepen 1']),
    e => e.code === 'GIT_UNSUPPORTED',
  );
  const loaded = gap => ({
    status: 'ok',
    projectId: 'p',
    mainHead: gap ? 'f'.repeat(64) : 'd'.repeat(64),
    history: {
      row: {
        status: 'ready',
        repository: 'example/repo',
        importCommit: 'a'.repeat(40),
        importState: 'c'.repeat(64),
      },
      packs,
    },
    mirror: null,
  });
  assert.match(gitServe.servedRefs(loaded(true)).gap, /not yet published as Git commits/);
  assert.equal(gitServe.servedRefs(loaded(true)).refs.main, 'c'.repeat(40));

  const source = sourceRepository(t),
    f = fixture(t, source),
    { s } = f;
  const projectId = await importedProject(f, source.head);
  publish(s, projectId);
  await modules.projectHistoryImport.run._handler(s.ctx, { projectId, attempt: 1 });
  const host = await gitHost(t, s);
  const haves = Array.from({ length: 40 }, (_, i) =>
    protocol.pkt(`have ${i.toString(16).padStart(40, '0')}\n`),
  );
  const body = protocol.concatBytes([
    protocol.pkt('command=fetch\n'),
    protocol.delimPkt,
    protocol.pkt('ofs-delta\n'),
    protocol.pkt(`want ${source.head}\n`),
    ...haves,
    protocol.flushPkt,
  ]);
  assert.ok(body.length > 1024);
  const before = host.snapshot();
  const reply = await host.handle(`/git/${projectId}.git/git-upload-pack`, {
    method: 'POST',
    headers: { 'git-protocol': 'version=2', 'content-encoding': 'gzip' },
    body: gzipSync(body),
  });
  const bytes = Buffer.from(await reply.arrayBuffer());
  assert.match(bytes.subarray(0, 40).toString('latin1'), /acknowledgments\n.*NAK\n/s);
  assert.ok(bytes.includes(Buffer.from('PACK')));
  assert.deepEqual(host.since(before), { http: 0, query: 1, mutation: 0, action: 1 }, 'one gunzip action');
});

/** The Cloudflare Worker (dist/git-byte-worker.js) on a local port, with a bucket binding over
 * the in-memory R2 bucket; it forwards to the local Convex host like the deployed one. */
async function byteWorker(t, convexBase) {
  const worker = (await import('../dist/git-byte-worker.js')).default;
  const reads = [];
  const bucket = {
    async get(key, options = {}) {
      const bytes = defaultR2Objects.get(`forge-test-blobs/${key}`);
      if (!bytes) return null;
      const range = options.range;
      reads.push({ key, ...(range ?? {}) });
      return {
        body: new Response(range ? bytes.subarray(range.offset, range.offset + range.length) : bytes).body,
      };
    },
  };
  const hop = new Set(['transfer-encoding', 'content-length', 'connection', 'keep-alive']);
  const server = createServer(async (req, res) => {
    const body = [];
    for await (const part of req) body.push(part);
    const headers = new Headers(Object.entries(req.headers).filter(([, value]) => typeof value === 'string'));
    const response = await worker.fetch(
      new Request(`http://worker.example${req.url}`, {
        method: req.method,
        headers,
        ...(req.method === 'POST' ? { body: Buffer.concat(body) } : {}),
      }),
      { FORGE_CONVEX_SITE: convexBase, FORGE_R2: bucket },
      { waitUntil: () => {} },
    );
    res.writeHead(
      response.status,
      Object.fromEntries([...response.headers].filter(([name]) => !hop.has(name))),
    );
    if (response.body) for await (const part of response.body) res.write(part);
    res.end();
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => server.close());
  return { base: `http://127.0.0.1:${server.address().port}`, reads, worker };
}
const withEnv = (t, values) => {
  const previous = Object.fromEntries(Object.keys(values).map(name => [name, process.env[name]]));
  Object.assign(process.env, values);
  t.after(() => {
    for (const [name, value] of Object.entries(previous))
      value === undefined ? delete process.env[name] : (process.env[name] = value);
  });
};

test('clones over the response limit go through the Worker: v2 framed once, v0 raw, capped, joined trailer cached', async t => {
  const source = sourceRepository(t),
    f = fixture(t, source),
    { s } = f;
  const projectId = await importedProject(f, source.head);
  publish(s, projectId);
  const host = await gitHost(t, s);
  // The Worker reaches the local Convex host; the fixture's fetch refuses other hosts.
  const fixtureFetch = globalThis.fetch;
  globalThis.fetch = (url, init) =>
    new URL(url).hostname === '127.0.0.1' ? f.previousFetch(url, init) : fixtureFetch(url, init);
  t.after(() => (globalThis.fetch = f.previousFetch));
  const worker = await byteWorker(t, host.base);
  // Threshold 1 byte: every clone of this small repository takes the large-pack path.
  withEnv(t, { FORGE_GIT_WORKER_URL: worker.base, FORGE_GIT_WORKER_MIN_BYTES: '1' });
  // Recording a pack the Worker serves schedules its v2 preparation: no clone waits for it.
  await modules.projectHistoryImport.run._handler(s.ctx, { projectId, attempt: 1 });
  const prepare = s.scheduled.filter(task => getFunctionName(task.fn) === 'gitServeFrame:prepare');
  assert.deepEqual(
    prepare.map(task => task.args),
    [{ projectId }],
  );
  await modules.gitServeFrame.prepare._handler(s.ctx, prepare[0].args);
  const url = `${host.base}/git/${projectId}.git`;
  const work = scratch(t, 'forge-git-worker-');
  let before = host.snapshot();
  const cloned = await client(['clone', url, join(work, 'one')]);
  assert.match(String(cloned.stderr), /redirecting to http:\/\/127\.0\.0\.1:\d+\/gitw\//);
  assert.equal(log(join(work, 'one')), log(source.repo), 'same commits and ids as the source');
  await client(['fsck', '--full'], join(work, 'one'));
  // Protocol v2, as from GitHub: the clone keeps the pack (index-pack), even under
  // transfer.unpackLimit objects, where a v0 clone explodes it into loose objects.
  assert.equal(
    git(join(work, 'one'), ['count-objects', '-v'])
      .toString()
      .match(/^packs: (\d+)/m)[1],
    '1',
  );
  // Redirect (1 query), ls-refs (1 query), fetch (1 query + reserve); the Worker answers the
  // v2 advertisement. The pack was framed when it was recorded.
  assert.deepEqual(host.since(before), { http: 3, query: 3, mutation: 1, action: 0 });
  const [pack] = historyPacks(s, projectId);
  assert.ok(pack.framed?.length, 'the framed copy is recorded on the pack row');
  assert.deepEqual(
    worker.reads,
    pack.framed.map(chunk => ({ key: `v1/p/${projectId}/o/${chunk.sha256}` })),
  );
  const { v2Advertisement } = await import('../dist/git-byte-worker.js');
  assert.equal(v2Advertisement, Buffer.from(protocol.advertiseV2()).toString('latin1'));
  // A pack without a framed copy (recorded before this, or preparation failed) is framed on
  // its first v2 fetch, once: 1 action + 1 mutation, then never again.
  await s.ctx.db.patch(pack._id, { framed: undefined });
  worker.reads.length = 0;
  before = host.snapshot();
  await client(['clone', '-q', url, join(work, 'lazy')]);
  assert.equal(log(join(work, 'lazy')), log(source.repo));
  assert.deepEqual(host.since(before), { http: 3, query: 3, mutation: 2, action: 1 });
  worker.reads.length = 0;
  before = host.snapshot();
  await client(['clone', '-q', url, join(work, 'again')]);
  assert.deepEqual(host.since(before), { http: 3, query: 3, mutation: 1, action: 0 }, 'framed once');
  // A v0 client gets the raw stored chunks, untouched.
  worker.reads.length = 0;
  before = host.snapshot();
  await client(['-c', 'protocol.version=0', 'clone', '-q', url, join(work, 'v0')]);
  assert.equal(log(join(work, 'v0')), log(source.repo));
  await client(['fsck', '--full'], join(work, 'v0'));
  assert.deepEqual(host.since(before), { http: 3, query: 3, mutation: 1, action: 0 });
  assert.deepEqual(
    worker.reads,
    pack.chunks.map(chunk => ({ key: `v1/p/${projectId}/o/${chunk.sha256}` })),
  );
  const usage = [...s.tables.gitWorkerUsage.values()];
  assert.deepEqual(usage.map(row => [row.scope, row.packs, row.bytes]).sort(), [
    ['*', 4, 4 * pack.bytes],
    [projectId, 4, 4 * pack.bytes],
  ]);

  // A mirror move adds a catch-up pack; a fetch takes only it, a fresh clone joins both.
  commit(source.repo, { 'src/new.go': 'package main\n' }, 'Forge landing one');
  const tip = commit(source.repo, { 'src/new.go': 'package main\n// two\n' }, 'Forge landing two');
  await mirrorAt(s, projectId, tip);
  await client(['fetch', '-q'], join(work, 'one'));
  assert.equal(git(join(work, 'one'), ['rev-parse', 'origin/main']).toString().trim(), tip);
  assert.equal(
    s.scheduled.filter(task => getFunctionName(task.fn) === 'gitServeFrame:prepare').length,
    2,
    'a recorded catch-up pack schedules preparation too',
  );
  worker.reads.length = 0;
  before = host.snapshot();
  await client(['clone', '-q', url, join(work, 'two')]);
  assert.equal(log(join(work, 'two')), log(source.repo, tip));
  await client(['fsck', '--full'], join(work, 'two'));
  assert.ok(
    worker.reads.every(read => read.length !== undefined),
    'joined packs drop headers and trailers',
  );
  assert.ok(historyRow(s, projectId).joined?.sha1, 'the joined trailer is cached on the history row');
  assert.equal(host.since(before).mutation, 2, 'reserve + trailer cache');
  before = host.snapshot();
  await client(['clone', '-q', url, join(work, 'three')]);
  assert.equal(log(join(work, 'three')), log(source.repo, tip));
  assert.deepEqual(host.since(before), { http: 3, query: 3, mutation: 1, action: 0 }, 'cached trailer');

  // Caps are checked before the redirect; a forged or expired session is refused.
  const [row] = [...s.tables.gitWorkerUsage.values()].filter(row => row.scope === projectId);
  s.tables.gitWorkerUsage.set(row._id, {
    ...row,
    packs: modules.gitServeWorkerStore.workerCaps.project.packs,
  });
  await refused(['clone', url, join(work, 'capped')], /GIT_BYTE_LIMIT/);
  for (const path of [
    `/gitw/forged.token/${projectId}.git/info/refs?service=git-upload-pack`,
    `/gitw/x/${projectId}.git/info/refs?service=git-upload-pack`,
  ])
    assert.equal((await host.handle(path)).status, 403);
  const plans = [
    { head: '', tail: '', parts: [{ key: 'v1/p/other/o/../secret' }] },
    { head: '', tail: '', parts: [{ key: `v1/p/${projectId}/o/${'a'.repeat(64)}`, offset: -1, length: 4 }] },
    { head: '', tail: '', parts: Array.from({ length: 901 }, () => ({ key: `v1/p/p/o/${'a'.repeat(64)}` })) },
  ];
  const { checkedPlan } = await import('../dist/git-byte-worker.js');
  // The plan is a plain Response with its own type (Response.json is retyped by Convex).
  assert.doesNotMatch(
    readFileSync(new URL('../convex/gitServeWorker.ts', import.meta.url), 'utf8'),
    /Response\.json\(plan/,
  );
  for (const plan of plans) assert.equal(checkedPlan(plan), null);
  assert.equal(
    (await worker.worker.fetch(new Request('http://worker.example/anything'), {}, {})).status,
    404,
  );
});

test('a Worker session rechecks the credential and current access on every request', async t => {
  const source = sourceRepository(t),
    f = fixture(t, source, { visibility: 'private' }),
    { s } = f;
  const projectId = await importedProject(f, source.head);
  await modules.projectHistoryImport.run._handler(s.ctx, { projectId, attempt: 1 });
  const host = await gitHost(t, s);
  withEnv(t, { FORGE_GIT_WORKER_URL: 'https://worker.example', FORGE_GIT_WORKER_MIN_BYTES: '1' });
  const plan = await import('../dist/git-worker-plan.js');
  const key = plan.workerTokenKey(process.env.R2_SECRET_ACCESS_KEY);
  const refs = token => `/gitw/${token}/${projectId}.git/info/refs?service=git-upload-pack`;
  const sign = (c, e = Date.now() + 60_000) => plan.signWorkerToken({ p: projectId, c, e }, key);
  const encode = value => Buffer.from(JSON.stringify(value)).toString('base64url');
  const login = `${encode({ alg: 'RS256' })}.${encode({ sub: 'owner', forgeCredential: 'cred-owner' })}.sig`;
  await s.ctx.db.insert('cliCredentials', {
    owner: 'owner',
    name: 'Synthetic CLI',
    scope: 'cli',
    credentialId: 'cred-owner',
    tokenHash: createHash('sha256').update(login).digest('hex'),
    issuedAt: Date.now(),
    expiresAt: Date.now() + 60_000,
    revoked: false,
  });
  // The redirect carries a signed session naming the credential, never the login itself.
  const redirect = await host.handle(`/git/${projectId}.git/info/refs?service=git-upload-pack`, {
    headers: { authorization: `Bearer ${login}` },
  });
  assert.equal(redirect.status, 302);
  const location = new URL(redirect.headers.get('location'));
  assert.equal(location.origin, 'https://worker.example');
  assert.ok(!location.href.includes(login) && !location.href.includes('sig'));
  const [, , token] = location.pathname.split('/');
  assert.equal(plan.verifyWorkerToken(token, key).c, 'cred-owner');
  const ok = await host.handle(refs(sign('cred-owner')));
  assert.equal(ok.status, 200);
  const advertised = Buffer.from(await ok.arrayBuffer()).toString('latin1');
  assert.match(advertised, new RegExp(`${source.head} HEAD`));
  assert.doesNotMatch(advertised, /side-band/, 'raw pack: the Worker never frames bytes');
  assert.equal((await host.handle(refs(sign('')))).status, 404, 'anonymous session on a private project');
  assert.equal((await host.handle(refs(sign('cred-owner', Date.now() - 1)))).status, 403, 'expired');
  const other = plan.signWorkerToken({ p: 'another', c: 'cred-owner', e: Date.now() + 60_000 }, key);
  assert.equal((await host.handle(refs(other))).status, 403, 'a session names one project');
  // Protocol v2: the Worker answers the fixed advertisement; ls-refs rechecks like any request.
  const lsRefs = token =>
    host.handle(`/gitw/${token}/${projectId}.git/git-upload-pack`, {
      method: 'POST',
      headers: { 'git-protocol': 'version=2', 'content-type': 'application/x-git-upload-pack-request' },
      body: Buffer.concat([protocol.pkt('command=ls-refs\n'), protocol.delimPkt, protocol.flushPkt]),
    });
  const listed = await lsRefs(sign('cred-owner'));
  assert.match(Buffer.from(await listed.arrayBuffer()).toString('latin1'), new RegExp(`${source.head} HEAD`));
  assert.equal((await lsRefs(sign(''))).status, 404, 'v2 anonymous session on a private project');
  const [credential] = [...s.tables.cliCredentials.values()];
  s.tables.cliCredentials.set(credential._id, { ...credential, revoked: true });
  assert.equal((await host.handle(refs(sign('cred-owner')))).status, 403, 'revocation applies at once');
  assert.equal((await lsRefs(sign('cred-owner'))).status, 403, 'and to v2 requests');
});

// Lane refs (Issue 09367fb2 line 3): a member's fetch of refs/forge/lanes/<laneId> builds one
// deterministic commit for the saved head on main's mirror commit, cached per Lane.
/** Stores bytes as a committed R2 project object, as a save does. */
function storeObject(s, projectId, bytes) {
  const digest = createHash('sha256').update(bytes).digest('hex');
  const key = `v1/p/${projectId}/o/${digest}`;
  defaultR2Objects.set(`${defaultR2Config.bucket}/${key}`, Buffer.from(bytes));
  if (
    ![...s.tables.projectObjects.values()].some(row => row.projectId === projectId && row.digest === digest)
  )
    s.ctx.db.insert('projectObjects', {
      projectId,
      digest,
      size: bytes.length,
      nonce: '',
      location: 'r2',
      r2Key: key,
      r2Committed: true,
      removed: false,
      sourceReferenced: true,
    });
  return digest;
}
/** A Forge State with the files of a Git commit, plus edits ({path: text | null | [text, mode]}). */
function storeState(s, projectId, repo, commit, edits = {}, message = 'main') {
  const files = new Map();
  for (const line of git(repo, ['ls-tree', '-r', commit]).toString().trim().split('\n')) {
    const [meta, path] = line.split('\t');
    const [mode, , sha] = meta.split(' ');
    const kind = mode === '100755' ? 'executable' : mode === '120000' ? 'symlink' : 'file';
    files.set(path, {
      path,
      mode: kind,
      blob: storeObject(s, projectId, git(repo, ['cat-file', 'blob', sha])),
    });
  }
  for (const [path, edit] of Object.entries(edits)) {
    if (edit === null) files.delete(path);
    else {
      const [text, mode] = Array.isArray(edit) ? edit : [edit, 'file'];
      files.set(path, { path, mode, blob: storeObject(s, projectId, Buffer.from(text)) });
    }
  }
  const value = {
    schema: 1,
    kind: 'forge-source-state',
    parents: [],
    files: [...files.values()].sort((a, b) => (a.path < b.path ? -1 : 1)),
    message,
    at: '2026-11-09T07:00:00.000Z',
  };
  return storeObject(s, projectId, Buffer.from(JSON.stringify(value)));
}
function credentialFor(s, credentialId, owner) {
  const encode = value => Buffer.from(JSON.stringify(value)).toString('base64url');
  const value = `${encode({ alg: 'RS256' })}.${encode({ sub: owner, forgeCredential: credentialId })}.sig`;
  s.ctx.db.insert('cliCredentials', {
    owner,
    name: 'Synthetic CLI',
    scope: 'cli',
    credentialId,
    tokenHash: createHash('sha256').update(value).digest('hex'),
    issuedAt: Date.now(),
    expiresAt: Date.now() + 60_000,
    revoked: false,
  });
  return value;
}

test('members fetch Lane refs as built commits; git diff main...lane equals the Lane; strangers never see them', async t => {
  const source = sourceRepository(t),
    f = fixture(t, source),
    { s } = f;
  for (const table of ['projectGithubMirrorJobs', 'projectHostedOverlapLanes', 'projectGitLaneCommits'])
    s.tables[table] ??= new Map();
  const projectId = await importedProject(f, source.head);
  publish(s, projectId);
  await modules.projectHistoryImport.run._handler(s.ctx, { projectId, attempt: 1 });
  await mirrorAt(s, projectId, source.head);
  const base = storeState(s, projectId, source.repo, source.head);
  const tree = git(source.repo, ['rev-parse', `${source.head}^{tree}`])
    .toString()
    .trim();
  const job = (receiptId, state, mapping) =>
    s.ctx.db.insert('projectGithubMirrorJobs', {
      projectId,
      receiptId,
      sequence: 1,
      repository: 'example/repo',
      authorityEpoch: 1,
      status: 'done',
      state,
      step: 2,
      cursor: null,
      mapping: JSON.stringify({
        publication: 'tracked',
        operationId: crypto.randomUUID(),
        state,
        acceptanceId: receiptId,
        viewId: crypto.randomUUID(),
        commit: source.head,
        parent: '',
        tree,
        message: 'main',
        author: { name: 'Forge', email: 'forge@example.invalid' },
        committer: { name: 'Forge', email: 'forge@example.invalid' },
        seconds: clock,
        ...mapping,
      }),
    });
  const mainReceipt = crypto.randomUUID(),
    otherReceipt = crypto.randomUUID();
  await job(mainReceipt, base);
  const laneId = crypto.randomUUID();
  const edits = {
    'src/app.go': 'package main // edited in the Lane\n',
    'src/lane.go': 'package main\n',
    'docs/guide.md': null,
    'scripts/run.sh': ['#!/bin/sh\necho run\n', 'executable'],
    'private-artifacts/notes.md': 'Forge metadata: never published\n',
    '.gitattributes': '*.psd filter=lfs diff=lfs merge=lfs -text\n',
    'art/logo.psd': 'binary layers\n',
  };
  const head = storeState(s, projectId, source.repo, source.head, edits, 'Lane save: edit app');
  const lane = await s.ctx.db.insert('projectHostedOverlapLanes', {
    projectId,
    laneId,
    intentId: crypto.randomUUID(),
    actor: 'owner',
    agent: 'cosmic-toucan',
    intent: 'Synthetic Lane',
    head,
    baseHead: base,
    baseReceiptId: mainReceipt,
    baseSequence: 1,
    recordVersion: 2,
    open: true,
    changes: '[]',
    complete: false,
  });
  await s.ctx.db.insert('forgeAccounts', { owner: 'owner', handle: 'synthetic-owner' });
  const owner = credentialFor(s, 'cred-owner', 'owner'),
    stranger = credentialFor(s, 'cred-stranger', 'stranger');
  const host = await gitHost(t, s);
  const url = token => `${host.base.replace('http://', `http://git:${token}@`)}/git/${projectId}.git`;
  const ref = `refs/forge/lanes/${laneId}`;
  const work = scratch(t, 'forge-git-lane-');
  const repo = join(work, 'member');

  await client(['clone', '-q', url(owner), repo]);
  let before = host.snapshot();
  await client(['fetch', '-q', 'origin', `${ref}:refs/remotes/origin/lane`], repo);
  // info/refs, ls-refs (401: git then sends the token), ls-refs with the build, fetch.
  const first = host.since(before);
  assert.equal(first.http, 4);
  assert.equal(first.action, 1, 'one build');
  assert.equal(first.mutation, 1, 'one record');
  const diff = git(repo, ['diff', '--name-status', 'origin/main...origin/lane']).toString();
  assert.equal(
    diff,
    'A\t.gitattributes\nA\tart/logo.psd\nD\tdocs/guide.md\nA\tscripts/run.sh\nM\tsrc/app.go\nA\tsrc/lane.go\n',
  );
  // An LFS path holds its pointer, as the mirror publishes it; the bytes stay in Forge.
  const logo = createHash('sha256').update('binary layers\n').digest('hex');
  assert.equal(
    git(repo, ['cat-file', 'blob', 'origin/lane:art/logo.psd']).toString(),
    `version https://git-lfs.github.com/spec/v1\noid sha256:${logo}\nsize 14\n`,
  );
  assert.equal(git(repo, ['show', 'origin/lane:src/app.go']).toString(), edits['src/app.go']);
  assert.match(git(repo, ['ls-tree', 'origin/lane', 'scripts/run.sh']).toString(), /^100755 blob /);
  assert.equal(
    git(repo, ['rev-parse', 'origin/lane^']).toString().trim(),
    source.head,
    'parent = main commit',
  );
  const commitText = git(repo, ['cat-file', 'commit', 'origin/lane']).toString();
  assert.match(
    commitText,
    /^author synthetic-owner\/cosmic-toucan <synthetic-owner@users\.noreply\.forge> /m,
  );
  assert.match(
    commitText,
    new RegExp(`Lane save: edit app\n\nForge-Lane: ${laneId}\nForge-State: ${head}\n$`),
  );
  await client(['fsck', '--full', '--strict'], repo);
  const built = [...s.tables.projectGitLaneCommits.values()];
  assert.equal(built.length, 1);
  const commit = git(repo, ['rev-parse', 'origin/lane']).toString().trim();
  assert.equal(built[0].commit, commit);
  assert.equal(built[0].pack.objects, 1 + 5 + 5, 'commit, root/art/docs/src/scripts trees, five new blobs');

  // Cached: the same head is listed and fetched with no build; a strict fresh clone needs no duplicates.
  // Anonymous reads of a public project send no token: a listing sends it when told to.
  const member = ['-c', `http.extraHeader=Authorization: Bearer ${owner}`];
  const remote = `${host.base}/git/${projectId}.git`;
  before = host.snapshot();
  const listed = (await client([...member, 'ls-remote', remote])).stdout;
  assert.match(listed, new RegExp(`^${commit}\t${ref}$`, 'm'));
  await client(['fetch', '-q', 'origin', ref], repo);
  const cached = host.since(before);
  // At most one query per request (the 401 that asks git for the token costs none), no build.
  assert.ok(cached.query <= cached.http && cached.query >= cached.http - 1);
  assert.deepEqual([cached.mutation, cached.action], [0, 0]);
  const strict = join(work, 'strict');
  await client(['-c', 'transfer.fsckObjects=true', 'clone', '-q', url(owner), strict]);
  await client(['-c', 'transfer.fsckObjects=true', 'fetch', '-q', 'origin', ref], strict);
  const empty = join(work, 'empty');
  git(work, ['init', '-q', empty]);
  await client(['fetch', '-q', url(owner), `${ref}:refs/heads/lane`], empty);
  assert.equal(git(empty, ['rev-parse', 'lane']).toString().trim(), commit, 'history and Lane in one pack');
  await client(['fsck', '--full'], empty);

  // Strangers and anonymous readers of this public project get main only, never the Lane.
  for (const token of [stranger, null]) {
    const remote = token ? url(token) : `${host.base}/git/${projectId}.git`;
    assert.doesNotMatch((await client(['ls-remote', remote])).stdout, /refs\/forge|lanes/);
    // A stranger signs in and finds no such ref; an anonymous reader is asked to sign in.
    await refused(
      ['-C', repo, 'fetch', remote, ref],
      token ? /couldn't find remote ref/ : /Username|Authentication/,
    );
  }
  const direct = await host.handle(`/git/${projectId}.git/git-upload-pack`, {
    method: 'POST',
    headers: {
      'git-protocol': 'version=2',
      authorization: `Basic ${Buffer.from(`git:${stranger}`).toString('base64')}`,
    },
    body: protocol.concatBytes([
      protocol.pkt('command=fetch\n'),
      protocol.delimPkt,
      protocol.pkt('ofs-delta\n'),
      protocol.pkt(`want ${commit}\n`),
      protocol.pkt('done\n'),
      protocol.flushPkt,
    ]),
  });
  assert.match(Buffer.from(await direct.arrayBuffer()).toString('latin1'), /ERR GIT_NOT_OUR_REF/);

  // The large-pack Worker route (Issue 3bd4a8e9 line 2): members list and fetch the same Lane
  // refs, signed in up front (session login) or after the 401 a Lane-naming listing answers on
  // an anonymous session; strangers and anonymous readers get main only.
  const fixtureFetch = globalThis.fetch;
  globalThis.fetch = (target, init) =>
    new URL(target).hostname === '127.0.0.1' ? f.previousFetch(target, init) : fixtureFetch(target, init);
  const worker = await byteWorker(t, host.base);
  const env = { FORGE_GIT_WORKER_URL: worker.base, FORGE_GIT_WORKER_MIN_BYTES: '1' };
  Object.assign(process.env, env);
  try {
    const history = () => [...s.tables.projectHistory.values()].find(row => row.projectId === projectId);
    const viaWorker = join(work, 'worker');
    const cloned = await client(['clone', url(owner), viaWorker]);
    assert.match(String(cloned.stderr), /redirecting to http:\/\/127\.0\.0\.1:\d+\/gitw\//);
    const joined = history().joined;
    // Session login: the listing names the built Lane; a fetch into an empty repository joins
    // history and the Lane pack (its framed copy) without replacing the clone's cached trailer.
    for (const version of ['2', '0']) {
      const config = [...member, '-c', `protocol.version=${version}`];
      assert.match(
        (await client([...config, 'ls-remote', remote])).stdout,
        new RegExp(`^${commit}\t${ref}$`, 'm'),
      );
      const fresh = join(work, `worker-empty-v${version}`);
      git(work, ['init', '-q', fresh]);
      worker.reads.length = 0;
      await client(
        [...config, '-c', 'transfer.fsckObjects=true', 'fetch', '-q', remote, `${ref}:refs/heads/lane`],
        fresh,
      );
      assert.equal(git(fresh, ['rev-parse', 'lane']).toString().trim(), commit);
      await client(['fsck', '--full'], fresh);
      const lanePack = [...s.tables.projectGitLaneCommits.values()][0].pack;
      const laneKeys = (version === '2' ? lanePack.framed : lanePack.chunks).map(
        chunk => `v1/p/${projectId}/o/${chunk.sha256}`,
      );
      assert.ok(
        worker.reads.some(read => laneKeys.includes(read.key)),
        `v${version}: the Lane pack streams from R2`,
      );
    }
    assert.deepEqual(history().joined, joined, "a set with a Lane pack never replaces the clone's trailer");
    // Anonymous session: the Lane-naming listing answers 401; git sends the login, the Worker
    // forwards it and the backend checks it as on the direct route. Only the Lane pack comes.
    worker.reads.length = 0;
    await client(['fetch', '-q', 'origin', `${ref}:refs/remotes/origin/lane`], viaWorker);
    assert.equal(git(viaWorker, ['rev-parse', 'origin/lane']).toString().trim(), commit);
    assert.equal(git(viaWorker, ['show', 'origin/lane:src/app.go']).toString(), edits['src/app.go']);
    for (const token of [stranger, null]) {
      const target = token ? url(token) : `${host.base}/git/${projectId}.git`;
      assert.doesNotMatch((await client(['ls-remote', target])).stdout, /refs\/forge|lanes/);
      await refused(
        ['-C', viaWorker, 'fetch', target, ref],
        token ? /couldn't find remote ref/ : /Username|Authentication/,
      );
    }
    // A signed session for a stranger never takes another login from the request.
    const plan = await import('../dist/git-worker-plan.js');
    const session = plan.signWorkerToken(
      { p: projectId, c: 'cred-stranger', e: Date.now() + 60_000 },
      plan.workerTokenKey(process.env.R2_SECRET_ACCESS_KEY),
    );
    const named = await host.handle(`/gitw/${session}/${projectId}.git/git-upload-pack`, {
      method: 'POST',
      headers: {
        'git-protocol': 'version=2',
        authorization: `Basic ${Buffer.from(`git:${owner}`).toString('base64')}`,
      },
      body: protocol.concatBytes([
        protocol.pkt('command=ls-refs\n'),
        protocol.delimPkt,
        protocol.pkt(`ref-prefix ${ref}\n`),
        protocol.flushPkt,
      ]),
    });
    assert.equal(named.status, 200);
    assert.doesNotMatch(Buffer.from(await named.arrayBuffer()).toString('latin1'), /refs\/forge/);
  } finally {
    for (const name of Object.keys(env)) delete process.env[name];
    globalThis.fetch = fixtureFetch;
  }

  // A new save moves the ref: the next fetch builds a new commit and drops the old pack.
  const oldPack = built[0].pack.chunks[0].sha256;
  const moved = storeState(s, projectId, source.repo, source.head, {
    ...edits,
    'src/lane.go': 'package lane\n',
  });
  await s.ctx.db.patch(lane, { head: moved });
  assert.doesNotMatch(
    (await client([...member, 'ls-remote', remote])).stdout,
    /refs\/forge/,
    'a moved head is not listed until built',
  );
  await client(['fetch', '-q', 'origin', `+${ref}:refs/remotes/origin/lane`], repo);
  assert.equal(git(repo, ['show', 'origin/lane:src/lane.go']).toString(), 'package lane\n');
  assert.equal(defaultR2Objects.has(`${defaultR2Config.bucket}/v1/p/${projectId}/o/${oldPack}`), false);
  await s.ctx.db.patch(lane, { open: false });
  assert.doesNotMatch(
    (await client([...member, 'ls-remote', remote])).stdout,
    /refs\/forge/,
    'closed Lanes are not listed',
  );

  // A base main never published, or a base tree that differs from the mirror's, is a named error.
  const other = crypto.randomUUID();
  await s.ctx.db.insert('projectHostedOverlapLanes', {
    projectId,
    laneId: other,
    intentId: crypto.randomUUID(),
    actor: 'owner',
    intent: 'Unpublished base',
    head,
    baseHead: head,
    baseReceiptId: otherReceipt,
    baseSequence: 2,
    recordVersion: 1,
    open: true,
    changes: '[]',
    complete: false,
  });
  await refused(['-C', repo, 'fetch', 'origin', `refs/forge/lanes/${other}`], /GIT_LANE_BASE_UNPUBLISHED/);
  await job(otherReceipt, head, { tree: 'e'.repeat(40) });
  await refused(['-C', repo, 'fetch', 'origin', `refs/forge/lanes/${other}`], /GIT_LANE_TREE/);
});

// Fast first build (Issue 3bd4a8e9 line 1): the parent commit's trees come from the stored
// history packs, so a first build reads only the files the Lane changed.
const packTrees = await import('../dist/git-pack-trees.js');
function wideRepository(t) {
  const repo = scratch(t, 'forge-history-wide-');
  git(repo, ['init', '-q', '-b', 'main']);
  const files = {};
  for (let i = 0; i < 48; i++) files[`pkg/m${i % 6}/file${i}.txt`] = `file ${i}\n`.repeat(20);
  files['art/a.psd'] = 'layers\n';
  files['README.md'] = '# wide\n';
  commit(repo, files, 'Wide tree');
  commit(repo, { 'pkg/m1/file1.txt': 'changed\n', 'pkg/m2/new.txt': 'new\n' }, 'Edit');
  const head = commit(repo, { 'README.md': '# wide, edited\n' }, 'Readme');
  return { repo, head };
}

test('pack scans read a chunk as parallel ranges in order and refuse a tampered chunk', async t => {
  const bytes = Buffer.from(Array.from({ length: 10_000 }, (_, i) => (i * 7) % 251));
  const sha256 = createHash('sha256').update(bytes).digest('hex');
  const key = `${defaultR2Config.bucket}/v1/p/scan-project/o/${sha256}`;
  defaultR2Objects.set(key, bytes);
  t.after(() => defaultR2Objects.delete(key));
  const ranges = [];
  let inFlight = 0,
    most = 0;
  t.after(
    interceptDefaultR2(async (request, init, serve) => {
      ranges.push(new Headers(init.headers).get('range'));
      most = Math.max(most, ++inFlight);
      await new Promise(resolve => setTimeout(resolve, 5));
      inFlight--;
      return serve(request, init);
    }),
  );
  const { chunkParts, rangesAhead } = modules.gitServeTrees;
  const read = async () => {
    const parts = [];
    for await (const part of chunkParts('scan-project', { sha256, size: bytes.length }, 1000))
      parts.push(part);
    return parts;
  };
  const parts = await read();
  assert.equal(parts.length, 10);
  assert.ok(Buffer.concat(parts.map(part => part.bytes)).equals(bytes), 'ranges arrive in order');
  assert.deepEqual(
    parts.map(part => part.last),
    [...Array(9).fill(false), true],
  );
  assert.equal(ranges.length, 10);
  assert.ok(ranges.includes('bytes=9000-9999'));
  assert.ok(most > 1 && most <= rangesAhead, `ranges overlap, at most ${rangesAhead} at a time (${most})`);
  // The digest is checked when the last range arrives: a tampered chunk ends in null.
  defaultR2Objects.set(key, Buffer.concat([bytes.subarray(0, 9999), Buffer.from([0])]));
  const tampered = await read();
  assert.equal(tampered.length, 10);
  assert.equal(tampered.at(-1), null);
});

test('pack trees list a commit tree from ofs- and ref-delta packs fed in small parts', t => {
  const { repo, head } = wideRepository(t);
  const tree = git(repo, ['rev-parse', `${head}^{tree}`])
    .toString()
    .trim();
  const expected = new Map(
    git(repo, ['ls-tree', '-r', head])
      .toString()
      .trim()
      .split('\n')
      .map(line => {
        const [meta, path] = line.split('\t');
        const [mode, , sha] = meta.split(' ');
        return [path, { mode, sha }];
      }),
  );
  for (const flags of [['--delta-base-offset'], []]) {
    const pack = git(repo, ['pack-objects', '--revs', '--stdout', '-q', ...flags], `${head}\n`);
    const scan = new packTrees.PackTrees(1 << 20);
    scan.startPack();
    let listing = null;
    for (let at = 0; at < pack.length && !listing; at += 7) {
      assert.equal(scan.push(pack.subarray(at, at + 7), at + 7 >= pack.length), true);
      listing = packTrees.listTree(scan, tree);
    }
    assert.deepEqual(listing, expected, flags.join() || 'ref-delta');
    assert.equal(packTrees.listTree(scan, 'f'.repeat(40)), null, 'unknown tree');
    // The tree index: the same trees (whole or deltas), loaded without the pack.
    const index = scan.treeIndex();
    const loaded = new packTrees.PackTrees(1 << 20);
    assert.equal(loaded.loadIndex(index), true);
    assert.deepEqual(packTrees.listTree(loaded, tree), expected, 'the index lists the same tree');
    assert.equal(
      new packTrees.PackTrees(1 << 20).loadIndex(index.subarray(0, -1)),
      false,
      'a cut index fails',
    );
    assert.equal(new packTrees.PackTrees(16).loadIndex(index), false, 'an index over budget fails');
    const tight = new packTrees.PackTrees(64);
    tight.startPack();
    assert.equal(tight.push(pack, true), false, 'over budget stops the scan');
    const cut = new packTrees.PackTrees(1 << 20);
    cut.startPack();
    assert.equal(cut.push(pack.subarray(0, pack.length - 30), true), false, 'a truncated pack fails');
  }
});

test('a first Lane build lists the parent tree from the history packs and reads only changed files', async t => {
  const source = wideRepository(t),
    f = fixture(t, source),
    { s } = f;
  for (const table of ['projectGithubMirrorJobs', 'projectHostedOverlapLanes', 'projectGitLaneCommits'])
    s.tables[table] ??= new Map();
  const projectId = await importedProject(f, source.head);
  publish(s, projectId);
  await modules.projectHistoryImport.run._handler(s.ctx, { projectId, attempt: 1 });
  await mirrorAt(s, projectId, source.head);
  const base = storeState(s, projectId, source.repo, source.head);
  const receiptId = crypto.randomUUID();
  await s.ctx.db.insert('projectGithubMirrorJobs', {
    projectId,
    receiptId,
    sequence: 1,
    repository: 'example/repo',
    authorityEpoch: 1,
    status: 'done',
    state: base,
    step: 2,
    cursor: null,
    mapping: JSON.stringify({
      publication: 'tracked',
      operationId: crypto.randomUUID(),
      state: base,
      acceptanceId: receiptId,
      viewId: crypto.randomUUID(),
      commit: source.head,
      parent: '',
      tree: git(source.repo, ['rev-parse', `${source.head}^{tree}`])
        .toString()
        .trim(),
      message: 'main',
      author: { name: 'Forge', email: 'forge@example.invalid' },
      committer: { name: 'Forge', email: 'forge@example.invalid' },
      seconds: clock,
    }),
  });
  // The Lane edits one file, adds one, and makes an unchanged file an LFS path.
  const head = storeState(
    s,
    projectId,
    source.repo,
    source.head,
    {
      'pkg/m3/file3.txt': 'lane edit\n',
      'pkg/lane.txt': 'added\n',
      '.gitattributes': '*.psd filter=lfs diff=lfs merge=lfs -text\n',
    },
    'Lane save',
  );
  const laneId = crypto.randomUUID();
  await s.ctx.db.insert('projectHostedOverlapLanes', {
    projectId,
    laneId,
    intentId: crypto.randomUUID(),
    actor: 'owner',
    intent: 'Wide Lane',
    head,
    baseHead: base,
    baseReceiptId: receiptId,
    baseSequence: 1,
    recordVersion: 1,
    open: true,
    changes: '[]',
    complete: false,
  });
  const metrics = [];
  const log = console.log;
  console.log = (...args) =>
    String(args[0]).startsWith('FORGE_GIT_LANE_METRIC ')
      ? metrics.push(JSON.parse(String(args[0]).slice(22)))
      : log(...args);
  t.after(() => (console.log = log));
  const plan = await modules.gitServeLaneStore.plan._handler(s.ctx, { projectId, laneId });
  assert.equal(plan.packs.length, 1);
  const fast = await modules.gitServeLane.buildLane(s.ctx, projectId, laneId, plan);
  assert.equal(metrics[0].listing, 1, 'tree listed from the pack');
  // .gitattributes, the edited and added files, and the file that became an LFS path.
  assert.equal(metrics[0].readBlobs, 4);
  // The same commit as a build that hashes every file (no packs, no aliases).
  const slow = await modules.gitServeLane.buildLane(s.ctx, projectId, laneId, {
    ...plan,
    aliases: null,
    packs: [],
  });
  assert.equal(slow, fast);
  assert.equal(metrics[1].listing, 0);
  assert.ok(metrics[1].readBlobs > 50, 'the fallback reads every file');
  // The next build uses the alias object the last one stored: no pack scan; it reads only
  // .gitattributes and the two new files its pack holds.
  const again = await modules.gitServeLane.buildLane(
    s.ctx,
    projectId,
    laneId,
    await modules.gitServeLaneStore.plan
      ._handler(s.ctx, { projectId, laneId })
      .then(p => (p.status === 'cached' ? { ...plan, aliases: historyRow(s, projectId).laneAliases } : p)),
  );
  assert.equal(again, fast);
  assert.deepEqual([metrics[2].listing, metrics[2].packScanned, metrics[2].readBlobs], [0, 0, 3]);
  assert.equal(s.tables.projectGitLaneCommits.size, 1);

  // Recording the import scheduled its tree index; once built, a first build reads the index
  // (trees only) instead of scanning the pack, and makes the same commit.
  const index = s.scheduled.filter(task => getFunctionName(task.fn) === 'gitServeTrees:indexPacks');
  assert.equal(index.length, 1, 'one index run per recorded pack');
  await modules.gitServeTrees.indexPacks._handler(s.ctx, index[0].args);
  const [row] = historyPacks(s, projectId);
  assert.ok(row.trees && row.trees.size < row.bytes, 'the index holds trees only');
  const cold = { ...plan, aliases: null, packs: [{ chunks: row.chunks, trees: row.trees }] };
  assert.equal(await modules.gitServeLane.buildLane(s.ctx, projectId, laneId, cold), fast);
  assert.deepEqual(
    [metrics[3].listing, metrics[3].packIndexed, metrics[3].packScanned, metrics[3].readBlobs],
    [1, 1, row.trees.size, 4],
  );
  // A second run finds nothing to index.
  const before = s.tables.projectHistoryPacks.get(row._id).trees;
  await modules.gitServeTrees.indexPacks._handler(s.ctx, index[0].args);
  assert.deepEqual(s.tables.projectHistoryPacks.get(row._id).trees, before);
});

// Forge-built main commits (Issue 3bd4a8e9 line 3): an imported project without a mirror serves
// its landings as Git commits on top of the imported history, built on the first Git request.
const { hostedAcceptanceSchema } = await import('../dist/hosted-acceptance.js');
let landingSequence = 0;
function land(s, projectId, previous, state, message, extra = {}) {
  landingSequence++;
  const id = crypto.randomUUID();
  const hash = 'a'.repeat(64);
  const receipt = hostedAcceptanceSchema.parse({
    schema: 1,
    id,
    projectId,
    channel: 'main',
    submissionId: crypto.randomUUID(),
    operationId: crypto.randomUUID(),
    attemptId: crypto.randomUUID(),
    at: new Date(Date.UTC(2026, 10, 9, 8, landingSequence)).toISOString(),
    authorityEpoch: 1,
    previous: { head: previous, receiptId: crypto.randomUUID() },
    candidate: {
      id: crypto.randomUUID(),
      digest: hash,
      head: state,
      inputs: { sha256: hash, size: 1 },
      dependencies: { sha256: hash, size: 1 },
      algorithm: 'synthetic',
    },
    message,
    actor: { id: 'owner', kind: 'person' },
    agentRun: 'quiet-otter',
    policyDigest: hash,
    check: null,
    snapshot: { id, previousId: 'main-0', revision: landingSequence },
    completion: { root: hash, pages: 0, lanes: 0, enabled: false },
    automatic: false,
    undo: { kind: 'revert', receiptId: id },
    ...extra,
  });
  s.ctx.db.insert('projectHostedAcceptances', {
    projectId,
    receiptId: id,
    submissionId: receipt.submissionId,
    attemptId: receipt.attemptId,
    sequence: landingSequence,
    value: JSON.stringify(receipt),
  });
  setMain(s, projectId, state);
  return id;
}
function setMain(s, projectId, head) {
  for (const [key, row] of s.tables.projectHostedChannels)
    if (row.projectId === projectId) s.tables.projectHostedChannels.delete(key);
  s.ctx.db.insert('projectHostedChannels', {
    projectId,
    name: 'main',
    operationId: crypto.randomUUID(),
    selection: JSON.stringify({
      schema: 2,
      projectId,
      snapshotId: 'seed',
      sourceRevision: 0,
      channel: 'main',
      head,
      authority: { mode: 'server', epoch: 1 },
      receipt: { id: 'main-0', kind: 'server', previousHead: null, previousReceiptId: null },
    }),
  });
}

test('an unmirrored project serves its landings as Git commits on the imported history, built once', async t => {
  const source = sourceRepository(t),
    f = fixture(t, source),
    { s } = f;
  for (const table of ['projectHostedChannels', 'projectHostedAcceptances']) s.tables[table] ??= new Map();
  const projectId = await importedProject(f, source.head);
  publish(s, projectId);
  await modules.projectHistoryImport.run._handler(s.ctx, { projectId, attempt: 1 });
  const imported = storeState(s, projectId, source.repo, source.head);
  historyRow(s, projectId).importState = imported;
  s.ctx.db.insert('forgeAccounts', { owner: 'owner', handle: 'synthetic-owner' });
  setMain(s, projectId, imported);
  const host = await gitHost(t, s);
  const remote = `${host.base}/git/${projectId}.git`;
  const work = scratch(t, 'forge-git-main-');

  // Two landings: an edit, then a new file plus restoring an imported-era file (no duplicate).
  const first = storeState(s, projectId, source.repo, source.head, {
    'src/app.go': 'package main // landed\n',
  });
  land(s, projectId, imported, first, 'Edit app on Forge');
  const old = git(source.repo, ['show', `${source.head}~5:src/app.go`]).toString();
  const second = storeState(s, projectId, source.repo, source.head, {
    'src/app.go': old,
    'src/forge.go': 'package forge\n',
  });
  land(s, projectId, first, second, 'Add forge.go, restore app');
  let before = host.snapshot();
  const one = join(work, 'one');
  const cloned = await client(['-c', 'transfer.fsckObjects=true', 'clone', url(host, projectId), one]);
  assert.doesNotMatch(cloned.stderr, /not yet published/, 'no gap once built');
  const built = host.since(before);
  assert.equal(built.action, 1, 'one build');
  const subjects = log(one).trim().split('\n');
  assert.match(subjects[0], / Add forge\.go, restore app$/);
  assert.match(subjects[1], / Edit app on Forge$/);
  assert.equal(git(one, ['rev-parse', 'HEAD~2']).toString().trim(), source.head, 'on the imported history');
  assert.equal(git(one, ['show', 'HEAD:src/app.go']).toString(), old);
  assert.equal(git(one, ['show', 'HEAD~1:src/app.go']).toString(), 'package main // landed\n');
  assert.equal(git(one, ['diff', '--name-only', 'HEAD~2', 'HEAD']).toString(), 'src/app.go\nsrc/forge.go\n');
  // The restored blob is in the imported pack already: the Forge pack never repeats it (the strict
  // clone above rejects duplicates).
  const forgePack = historyPacks(s, projectId).find(row => row.source === 'forge');
  assert.equal(forgePack.objects, 2 + 3 + 3, 'two commits; root+src trees twice less one; two new blobs');
  const commitText = git(one, ['cat-file', 'commit', 'HEAD']).toString();
  assert.match(commitText, /^author synthetic-owner\/quiet-otter <synthetic-owner@users\.noreply\.forge> /m);
  assert.match(commitText, new RegExp(`Forge-State: ${second}\n`));
  await client(['fsck', '--full', '--strict'], one);
  const tip = git(one, ['rev-parse', 'HEAD']).toString().trim();

  // Cached: the next clone builds nothing and gets the same ids.
  before = host.snapshot();
  const two = join(work, 'two');
  await client(['clone', '-q', url(host, projectId), two]);
  const cached = host.since(before);
  assert.deepEqual([cached.action, cached.mutation], [0, 0]);
  assert.equal(git(two, ['rev-parse', 'HEAD']).toString().trim(), tip, 'stable ids');

  // A later landing adds one commit on the last; old ids never change, small packs merge.
  const packsBefore = historyPacks(s, projectId).length;
  for (let i = 0; i < 4; i++) {
    const next = storeState(s, projectId, source.repo, source.head, {
      'src/app.go': old,
      'src/forge.go': `package forge // ${i}\n`,
    });
    land(
      s,
      projectId,
      s.tables.projectHostedAcceptances.size ? lastState(s, projectId) : second,
      next,
      `Step ${i}`,
    );
    await client(['-c', 'transfer.fsckObjects=true', 'fetch', '-q', 'origin'], one);
  }
  assert.equal(git(one, ['rev-parse', 'origin/main~4']).toString().trim(), tip);
  assert.ok(historyPacks(s, projectId).length <= packsBefore + 2, 'Forge packs merge geometrically');
  const three = join(work, 'three');
  await client(['-c', 'transfer.fsckObjects=true', 'clone', '-q', url(host, projectId), three]);
  assert.equal(
    git(three, ['rev-list', '--count', 'HEAD']).toString().trim(),
    String(Number(git(source.repo, ['rev-list', '--count', 'HEAD']).toString()) + 6),
  );
  await client(['fsck', '--full', '--strict'], three);
});
const url = (host, projectId) => `${host.base}/git/${projectId}.git`;
function lastState(s, projectId) {
  const rows = [...s.tables.projectHostedAcceptances.values()].filter(row => row.projectId === projectId);
  return JSON.parse(rows.at(-1).value).candidate.head;
}
