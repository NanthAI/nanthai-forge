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
import { mkdtempSync, realpathSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { getFunctionName } from 'convex/server';
import { moduleUrl } from './convex-module.mjs';
import { state } from './hosted-fixture.mjs';
import { defaultR2Objects, interceptDefaultR2 } from './default-r2.mjs';
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
        if (modules[name]) return modules[name][fn]._handler(s.ctx, args);
        return original(ref, args);
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
      99,
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
      1,
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
    const response = await gitServe.serve._handler(
      s.ctx,
      new Request(`https://forge.example${req.url}`, {
        method: req.method,
        headers,
        ...(req.method === 'POST' ? { body: Buffer.concat(body) } : {}),
      }),
    );
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
