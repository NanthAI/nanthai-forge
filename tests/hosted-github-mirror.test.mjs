// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { prepareMirror, stepMirror } from '../dist/hosted-github-mirror.js';
import { gitHash, gitTree, githubCommit } from '../dist/hosted-github-git.js';
import { mirrorFixture } from './hosted-github-mirror-fixture.mjs';
async function drain(f, initial) {
  let plan = initial ?? (await prepareMirror(f.seed, f.io));
  while (plan.phase !== 'done') {
    const calls = f.calls.length,
      reads = f.reads.length;
    const start = performance.now();
    plan = await stepMirror(structuredClone(plan), f.io);
    f.ticks.push({
      calls: f.calls.length - calls,
      reads: f.reads.length - reads,
      ms: performance.now() - start,
      rss: process.memoryUsage().rss,
      cursorBytes: Buffer.byteLength(JSON.stringify(plan)),
    });
  }
  return plan;
}
test('small diff creates only changed blobs, base tree, outcome commit and fast-forward ref', async () => {
  const f = mirrorFixture({
    before: { same: 'same', delete: 'gone', edit: 'old' },
    after: { same: 'same', edit: 'new', added: { text: 'link', mode: 'symlink' } },
  });
  const plan = await drain(f);
  assert.equal(plan.entry.tree, f.expected());
  assert.equal(plan.entry.commit, f.remote());
  assert.equal(plan.entry.message, f.seed.message);
  assert.deepEqual(plan.entry.author, f.seed.identity);
  assert.equal(f.calls.filter(c => c.path.endsWith('/blobs')).length, 2);
  assert.equal(f.calls.length, 6, 'N changed blobs + 4 Git Data calls');
  assert.equal(f.reads.length, 2, 'steady-state never reads unchanged blobs');
});
test('5,000 changed files use 50 bounded steps and metadata windows rather than per-file RPCs', async t => {
  const before = {},
    after = {};
  for (let i = 0; i < 5000; i++) {
    before[`dir/file-${i}`] = `old ${i}`;
    after[`dir/file-${i}`] = `new ${i}`;
  }
  const f = mirrorFixture({ before, after });
  const rssBefore = process.memoryUsage().rss;
  const start = performance.now(),
    plan = await drain(f);
  assert.equal(plan.entry.tree, f.expected());
  assert.equal(f.ticks.length, 50);
  assert(f.ticks.every(t => t.reads <= 100));
  assert.equal(f.calls.length, 5004);
  assert.equal(f.windows.filter(w => w.blobs).length, 50);
  assert(f.ticks.every(t => t.cursorBytes < 3 * 1024 * 1024));
  assert(
    Math.max(...f.ticks.map(t => t.rss)) - rssBefore < 128 * 1024 * 1024,
    'synthetic run adds under 128 MiB RSS',
  );
  t.diagnostic(
    JSON.stringify({
      files: 5000,
      githubCalls: f.calls.length,
      descriptorCalls: 51,
      steps: f.ticks.length,
      elapsedMs: performance.now() - start,
      peakRss: Math.max(...f.ticks.map(t => t.rss)),
      maxCursorBytes: Math.max(...f.ticks.map(t => t.cursorBytes)),
    }),
  );
});
test('blob bytes bound a step independently of file count', async () => {
  const f = mirrorFixture({
    before: {},
    after: { a: 'a'.repeat(5 * 1024 * 1024), b: 'b'.repeat(5 * 1024 * 1024) },
  });
  await drain(f);
  assert.equal(f.ticks.length, 2);
  assert(f.ticks.every(t => t.reads === 1));
});
test('lost commit, ref and final mapping replies reconcile to the same single commit', async () => {
  for (const route of ['trees', 'commits', 'refs/heads/main', null]) {
    const f = mirrorFixture(),
      initial = await prepareMirror(f.seed, f.io);
    if (route) {
      f.lose(route);
      await assert.rejects(stepMirror(structuredClone(initial), f.io), /lost reply/);
    } else await stepMirror(structuredClone(initial), f.io);
    const plan = await drain(f, initial);
    assert.equal(f.commits.size, 2, 'one new content-addressed commit');
    assert.equal(plan.entry.commit, f.remote());
    assert.equal(f.calls.filter(c => c.method === 'PATCH').length, 1);
  }
});
test('bootstrap verifies the complete matching State tree, including modes', async () => {
  const f = mirrorFixture({
    verified: false,
    before: { 'a.x': 'x', 'a/file': { mode: 'executable', text: 'y' } },
    after: { 'a.x': 'new', 'a/file': { mode: 'executable', text: 'y' } },
  });
  const plan = await drain(f);
  assert.equal(plan.entry.tree, f.expected());
  assert.equal(f.calls.filter(c => c.path.endsWith('/blobs')).length, 1);
});
test('bootstrap mismatch refuses before any GitHub write', async () => {
  const f = mirrorFixture({ verified: false });
  f.commits.get(f.remote()).tree = 'f'.repeat(40);
  await assert.rejects(drain(f), e => e.code === 'GITHUB_SYNC_BOOTSTRAP_TREE');
  assert(f.calls.every(c => c.method === 'GET'));
});
test('unexpected remote head refuses without updating the ref', async () => {
  const f = mirrorFixture();
  f.move('e'.repeat(40));
  await assert.rejects(drain(f), e => e.code === 'GITHUB_SYNC_CHANGED');
  assert.equal(f.remote(), 'e'.repeat(40));
  assert(!f.calls.some(c => c.method === 'PATCH'));
});
test('unchanged source maps to the existing commit without creating an empty commit', async () => {
  const f = mirrorFixture({ before: { same: 'same' }, after: { same: 'same' } });
  await drain(f);
  assert.equal(f.commits.size, 1);
  assert(f.calls.every(c => c.method === 'GET'));
});
test('Git object identity matches real bare Git for tree ordering, modes and commit bytes', t => {
  const root = mkdtempSync(join(tmpdir(), 'forge-mirror-git-'));
  t.after(() => rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }));
  const git = (args, input) =>
    execFileSync('git', ['--no-replace-objects', '-C', root, ...args], { input, encoding: 'utf8' }).trim();
  git(['init', '--bare', '--template=', '--initial-branch=main']);
  const bytes = Buffer.from('synthetic\0binary\xff');
  const blob = git(['hash-object', '-w', '--stdin'], bytes);
  assert.equal(blob, gitHash('blob', bytes));
  const files = [
    { path: 'a.c', mode: 'file', sha: blob },
    { path: 'a/z', mode: 'symlink', sha: blob },
    { path: 'a-/x', mode: 'executable', sha: blob },
  ];
  const sub = git(['mktree'], `120000 blob ${blob}\tz\n`),
    other = git(['mktree'], `100755 blob ${blob}\tx\n`);
  const tree = git(['mktree'], `040000 tree ${sub}\ta\n100644 blob ${blob}\ta.c\n040000 tree ${other}\ta-\n`);
  assert.equal(gitTree(files), tree);
  const f = mirrorFixture(),
    entry = { ...f.root, tree, parent: 'a'.repeat(40) };
  const person = `${entry.author.name} <${entry.author.email}> ${entry.seconds} +0000`;
  const raw = `tree ${tree}\nparent ${entry.parent}\nauthor ${person}\ncommitter ${person}\n\n${entry.message}\n`;
  assert.equal(githubCommit(entry), git(['hash-object', '-t', 'commit', '--stdin'], raw));
});

test('bootstrap lost final reply adopts its already-published exact State without a duplicate commit', async () => {
  const f = mirrorFixture({ verified: false });
  f.lose('refs/heads/main');
  await assert.rejects(drain(f), /lost reply/);
  const plan = await drain(f);
  assert.equal(f.commits.size, 2);
  assert.equal(plan.entry.commit, f.remote());
});

test('slow GitHub replies yield a continuation after a bounded time window', async () => {
  const f = mirrorFixture({ before: {}, after: { a: 'a', b: 'b' } });
  const initial = await prepareMirror(f.seed, f.io);
  let clock = 0;
  const api = f.io.api;
  f.io.api = async (...args) => {
    const result = await api(...args);
    clock += 60_001;
    return result;
  };
  const next = await stepMirror(initial, f.io, () => clock);
  assert.equal(next.phase, 'blobs');
  assert.equal(next.index, 1);
  assert.equal(f.calls.filter(c => c.path.endsWith('/blobs')).length, 1);
  await drain(f, next);
});
