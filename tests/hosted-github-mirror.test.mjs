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

test('gitlink bootstrap, unchanged pointer, SHA bump and deletion use commit entries without blob writes', async () => {
  const pointer = sha => ({ text: sha.repeat(40), mode: 'gitlink' });
  for (const verified of [true, false]) {
    const f = mirrorFixture({
      verified,
      before: { kept: pointer('a'), bumped: pointer('b'), gone: pointer('c') },
      after: { kept: pointer('a'), bumped: pointer('d'), added: pointer('e') },
    });
    const plan = await drain(f);
    assert.equal(plan.entry.tree, f.expected());
    assert.equal(f.calls.filter(c => c.path.endsWith('/blobs')).length, 0);
    const tree = f.calls.find(c => c.path.endsWith('/trees')).body.tree;
    assert.deepEqual(
      tree.map(e => [e.path, e.mode, e.type, e.sha]),
      [
        ['gone', '160000', 'commit', null],
        ['bumped', '160000', 'commit', 'd'.repeat(40)],
        ['added', '160000', 'commit', 'e'.repeat(40)],
      ],
    );
  }
});

test('5,000 pointer bumps use 50 descriptor windows and four GitHub metadata calls', async t => {
  const before = {},
    after = {};
  for (let i = 0; i < 5000; i++) {
    before[`vendor/${i}`] = { mode: 'gitlink', text: i.toString(16).padStart(40, '0') };
    after[`vendor/${i}`] = { mode: 'gitlink', text: (i + 5000).toString(16).padStart(40, '0') };
  }
  const f = mirrorFixture({ before, after }),
    start = performance.now(),
    rss = process.memoryUsage().rss;
  const plan = await drain(f);
  assert.equal(plan.entry.tree, f.expected());
  assert.equal(f.ticks.length, 50);
  assert.equal(f.windows.filter(w => w.blobs).length, 50);
  assert.equal(f.calls.length, 4);
  assert(f.ticks.every(tick => tick.reads <= 100));
  assert(Math.max(...f.ticks.map(tick => tick.rss)) - rss < 128 * 1024 * 1024);
  t.diagnostic(
    JSON.stringify({
      pointers: 5000,
      descriptorCalls: 51,
      githubCalls: f.calls.length,
      steps: f.ticks.length,
      elapsedMs: performance.now() - start,
      peakRss: Math.max(...f.ticks.map(tick => tick.rss)),
    }),
  );
});

test('two-way: the GitHub tree diff walks only changed directories and builds the exact Lane State', async () => {
  const { diffGithubTrees, applyInbound, inboundConflicts } = await import('../dist/github-inbound.js');
  const { inboundMessage } = await import('../dist/github-inbound-job.js');
  const { parseNativeState } = await import('../dist/native-state-format.js');
  const trees = new Map();
  const sha = value => gitHash('blob', Buffer.from(value));
  /** Store a flat {path: [mode, text]} map as nested GitHub trees; returns the root SHA. */
  const build = files => {
    const node = new Map();
    for (const [path, entry] of Object.entries(files)) {
      const [head, ...rest] = path.split('/');
      if (rest.length) {
        if (!node.has(head)) node.set(head, {});
        node.get(head)[rest.join('/')] = entry;
      } else node.set(head, entry);
    }
    const tree = [...node].map(([name, value]) =>
      Array.isArray(value)
        ? {
            path: name,
            mode: value[0],
            type: value[0] === '160000' ? 'commit' : 'blob',
            sha: value[0] === '160000' ? value[1] : sha(value[1]),
          }
        : { path: name, mode: '040000', type: 'tree', sha: build(value) },
    );
    const id = gitHash('tree', Buffer.from(JSON.stringify(tree)));
    trees.set(id, tree);
    return id;
  };
  const calls = [];
  const api = async path => {
    calls.push(path);
    const id = path.split('/').at(-1);
    return { tree: trees.get(id), truncated: false };
  };
  const unchanged = {};
  for (let i = 0; i < 50; i++) unchanged[`vendor/lib-${i}/index.js`] = ['100644', `lib ${i}`];
  const pinned = 'a'.repeat(40);
  const before = build({
    ...unchanged,
    'README.md': ['100644', 'hello'],
    'src/a.ts': ['100644', 'a1'],
    'src/old/x.ts': ['100644', 'x'],
    'bin/run': ['100644', 'run'],
    docs: ['100644', 'docs file becomes a directory'],
    '.forge/meta': ['100644', 'never imported'],
  });
  const after = build({
    ...unchanged,
    'README.md': ['100644', 'hello'],
    'src/a.ts': ['100644', 'a2'],
    'src/new/y.ts': ['100644', 'y'],
    'bin/run': ['100755', 'run'],
    'docs/index.md': ['100644', 'docs'],
    'deps/sub': ['160000', pinned],
    '.forge/meta': ['100644', 'changed but never imported'],
  });
  const diff = await diffGithubTrees(api, 'synthetic/mirror', before, after);
  assert.deepEqual(
    diff.changes.map(c => [c.path, c.after?.mode ?? null]),
    [
      ['bin/run', 'executable'],
      ['deps/sub', 'gitlink'],
      ['docs', null],
      ['docs/index.md', 'file'],
      ['src/a.ts', 'file'],
      ['src/new/y.ts', 'file'],
      ['src/old/x.ts', null],
    ],
  );
  assert.equal(diff.skipped, 1, 'Forge metadata never round-trips');
  assert(calls.length <= 12, `changed directories only: ${calls.length} tree reads for 50 unchanged`);
  assert(
    !calls.some(path => path.includes(build({ 'index.js': ['100644', 'lib 0'] }))),
    'unchanged subtrees are not read',
  );
  assert.deepEqual(await diffGithubTrees(api, 'synthetic/mirror', after, after), {
    changes: [],
    skipped: 0,
    directories: 0,
  });
  const file = (path, blob, mode = 'file') => ({ path, blob, mode });
  const base = {
    schema: 1,
    kind: 'forge-source-state',
    parents: [],
    files: [
      file('README.md', '1'.repeat(64)),
      file('src/a.ts', '2'.repeat(64)),
      file('src/old/x.ts', '3'.repeat(64)),
      file('docs', '4'.repeat(64)),
      file('private-artifacts/keep', '5'.repeat(64)),
    ],
    message: 'base',
    at: '2026-01-01T00:00:00.000Z',
  };
  const applied = diff.changes.map(change => ({
    path: change.path,
    after: change.after && { mode: change.after.mode, blob: '9'.repeat(64) },
  }));
  const parent = '8'.repeat(64);
  const lane = applyInbound(base, parent, applied, 'Merge pull request #1', '2026-01-02T00:00:00.000Z');
  const state = parseNativeState(lane.bytes);
  assert.deepEqual(state.parents, [parent], 'the merge base is the accepted State GitHub matched');
  assert.deepEqual(
    state.files.map(f => f.path),
    [
      'README.md',
      'bin/run',
      'deps/sub',
      'docs/index.md',
      'private-artifacts/keep',
      'src/a.ts',
      'src/new/y.ts',
    ],
  );
  assert.equal(lane.pin.size, lane.bytes.length);
  // Forge changed src/a.ts after the State GitHub matched: that path cannot be brought in by path.
  const moved = {
    ...base,
    files: base.files.map(f => (f.path === 'src/a.ts' ? { ...f, blob: '7'.repeat(64) } : f)),
  };
  assert.deepEqual(inboundConflicts(base, moved, diff.changes), ['src/a.ts']);
  assert.deepEqual(inboundConflicts(base, base, diff.changes), []);
  assert.match(
    inboundMessage({ commit: pinned, message: 'Merge pull request #1\n\nbody', repository: 'o/r' }),
    /^Merge pull request #1\n\nBrought in from GitHub o\/r main at a{40}\.\nGitHub-Commit: a{40}$/,
  );
});
