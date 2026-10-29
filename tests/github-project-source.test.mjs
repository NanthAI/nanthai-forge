import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import {
  mkdtempSync,
  writeFileSync,
  mkdirSync,
  chmodSync,
  symlinkSync,
  readFileSync,
  lstatSync,
  readlinkSync,
  rmSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import {
  beginGithubSource,
  discoverGithubSource,
  importGithubSourceFile,
  readGithubSourceBlob,
  githubBlobEndpointBytes,
} from '../dist/github-project-source.js';
import { NativeSource, nativeMarker } from '../dist/native-source.js';
import { digest } from '../dist/hash.js';

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'forge-github-source-'));
  t.after(() => rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }));
  const repo = join(root, 'repo');
  mkdirSync(repo);
  const git = args =>
    execFileSync('git', ['-C', repo, ...args], {
      env: { ...process.env, GIT_CONFIG_NOSYSTEM: '1' },
      maxBuffer: 8 * 1024 * 1024,
    });
  git(['init', '-q']);
  for (const [path, bytes] of [
    ['binary.dat', Buffer.from([0, 255, 10, 128])],
    ['run.sh', Buffer.from('#!/bin/sh\nexit 0\n')],
    ['empty', Buffer.alloc(0)],
    ['日本語/é.txt', Buffer.from('snow ☃\r\n')],
    ['nested/.gitignore', Buffer.from('kept.bin\n')],
    ['nested/kept.bin', Buffer.from([1, 2, 0])],
    ['boundary.bin', Buffer.alloc(1024 * 1024 + 1, 19)],
  ]) {
    mkdirSync(join(repo, path, '..'), { recursive: true });
    writeFileSync(join(repo, path), bytes);
  }
  chmodSync(join(repo, 'run.sh'), 0o755);
  symlinkSync('日本語/é.txt', join(repo, 'link'));
  git(['add', '-f', '.']);
  git(['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-qm', 'source']);
  const commit = git(['rev-parse', 'HEAD']).toString().trim();
  let blobReads = 0;
  const request = async (url, options) => {
    const path = new URL(url).pathname;
    if (path.includes('/commits/'))
      return Response.json({
        sha: commit,
        commit: { tree: { sha: git(['rev-parse', 'HEAD^{tree}']).toString().trim() } },
      });
    if (path.includes('/git/trees/')) {
      const sha = path.split('/').at(-1);
      const tree = git(['ls-tree', '-z', '-l', sha])
        .toString()
        .split('\0')
        .filter(Boolean)
        .map(line => {
          const [header, path] = line.split('\t');
          const [mode, type, sha, size] = header.trim().split(/\s+/);
          return { path, mode, type, sha, ...(size !== '-' ? { size: Number(size) } : {}) };
        });
      return Response.json({ sha, truncated: false, tree });
    }
    if (path.includes('/git/blobs/')) {
      blobReads++;
      assert.equal(options.headers.Accept, 'application/vnd.github.raw+json');
      return new Response(git(['cat-file', 'blob', path.split('/').at(-1)]));
    }
    assert.fail(url);
  };
  return { root, repo, git, request, commit, blobReads: () => blobReads };
}

test('complete committed tree preserves bytes and modes, matching git archive without executing source', async t => {
  const f = fixture(t);
  let cursor = await beginGithubSource('fixture/repo', 'main', undefined, f.request);
  while (cursor.pending.length) cursor = await discoverGithubSource(cursor, undefined, f.request);
  assert.equal(cursor.files.length, 8);
  assert.equal(f.blobReads(), 0, 'discovery validates the complete tree before storing bytes');
  const owner = join(f.root, 'owner');
  mkdirSync(owner);
  nativeMarker(owner);
  const source = new NativeSource(owner);
  const files = [];
  while (cursor.completed < cursor.files.length) {
    const imported = await importGithubSourceFile(
      cursor,
      async bytes => {
        source.put(bytes);
      },
      undefined,
      f.request,
    );
    files.push({
      path: imported.file.path,
      blob: imported.file.blob,
      mode: { 100644: 'file', 100755: 'executable', 120000: 'symlink' }[imported.file.mode],
    });
    cursor = structuredClone(imported.cursor);
  }
  const head = source.writeState(files, [], 'Imported commit', '2026-01-01T00:00:00Z');
  const checkout = join(f.root, 'checkout');
  source.materialize(head, checkout, false);
  const archive = join(f.root, 'archive');
  mkdirSync(archive);
  execFileSync('tar', ['-xf', '-', '-C', archive], { input: f.git(['archive', '--format=tar', f.commit]) });
  for (const file of files) {
    const a = join(archive, file.path),
      b = join(checkout, file.path);
    if (file.mode === 'symlink') {
      assert.ok(lstatSync(b).isSymbolicLink());
      assert.deepEqual(readlinkSync(b, { encoding: 'buffer' }), readlinkSync(a, { encoding: 'buffer' }));
    } else {
      assert.deepEqual(readFileSync(b), readFileSync(a));
      assert.equal(Boolean(lstatSync(b).mode & 0o111), Boolean(lstatSync(a).mode & 0o111));
    }
  }
  assert.equal(cursor.bytes, cursor.totalBytes);
  assert.deepEqual(source.capture(checkout, false, head), source.state(head).files);
  assert.equal(source.capture(checkout).find(file => file.path === 'link').mode, 'symlink');
});

test('interrupted file sink leaves progress untouched and retry reuses exact bytes', async t => {
  const f = fixture(t);
  let cursor = await beginGithubSource('fixture/repo', 'main', undefined, f.request);
  while (cursor.pending.length) cursor = await discoverGithubSource(cursor, undefined, f.request);
  const stored = new Map();
  const put = async bytes => stored.set(digest(bytes), bytes);
  await assert.rejects(
    importGithubSourceFile(
      cursor,
      async bytes => {
        await put(bytes);
        throw Error('crash');
      },
      undefined,
      f.request,
    ),
    /crash/,
  );
  assert.equal(cursor.completed, 0);
  assert.equal(cursor.bytes, 0);
  const retry = await importGithubSourceFile(cursor, put, undefined, f.request);
  assert.equal(stored.size, 1);
  assert.equal(retry.cursor.completed, 1);
  assert.equal(retry.file.blob, [...stored.keys()][0]);
});

test('no repository access and incomplete/oversized trees never advance progress', async () => {
  await assert.rejects(
    beginGithubSource('fixture/repo', 'main', undefined, async () => new Response('', { status: 404 })),
    error => error.code === 'GITHUB_UNAVAILABLE',
  );
  const cursor = {
    schema: 1,
    repository: 'fixture/repo',
    commit: 'a'.repeat(40),
    pending: [{ path: '', sha: 'b'.repeat(40) }],
    files: [],
    completed: 0,
    bytes: 0,
    totalBytes: 0,
  };
  for (const tree of [
    { truncated: true, tree: [] },
    {
      truncated: false,
      tree: [
        {
          path: 'too-large',
          mode: '100644',
          type: 'blob',
          sha: 'c'.repeat(40),
          size: githubBlobEndpointBytes + 1,
        },
      ],
    },
  ])
    await assert.rejects(
      discoverGithubSource(cursor, undefined, async () => Response.json({ sha: 'b'.repeat(40), ...tree })),
      error => ['GITHUB_RESPONSE', 'GITHUB_BLOB_LIMIT'].includes(error.code),
    );
  assert.equal(cursor.files.length, 0);
  assert.equal(cursor.completed, 0);
});

test('raw blob hash and length failures never reach the object sink', async () => {
  const bytes = Buffer.from([0, 255, 12]);
  const sha = createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex');
  for (const actual of [Buffer.from([0, 255, 13]), Buffer.alloc(4), Buffer.alloc(2)]) {
    await assert.rejects(
      readGithubSourceBlob(
        'fixture/repo',
        { path: 'binary', sha, size: bytes.length, mode: '100644' },
        undefined,
        async () => new Response(actual),
      ),
      error => error.code === 'ARTIFACT_INTEGRITY',
    );
  }
});
