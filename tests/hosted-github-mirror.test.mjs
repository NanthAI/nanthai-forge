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
import { formatLfsPointer, isLfsPath, lfsRules, parseLfsPointer } from '../dist/github-lfs.js';
import { digest } from '../dist/hash.js';
import { GithubMirrorApiError } from '../dist/hosted-github-api.js';
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
test("a Candidate branch (flip 3) is created once on main's verified commit and never moves main", async () => {
  const f = mirrorFixture({ before: { a: 'a', b: 'old' }, after: { a: 'a', b: 'new' } });
  const branch = 'forge/candidates/6f1c2d3e-4a5b-4c6d-8e7f-0a1b2c3d4e5f';
  f.seed.branch = branch;
  const plan = await drain(f);
  assert.equal(f.branches.get(branch), plan.entry.commit);
  assert.equal(f.commits.get(plan.entry.commit).parent, f.root.commit);
  assert.equal(plan.entry.tree, f.expected());
  assert.equal(f.remote(), f.root.commit, 'main is untouched');
  // A replay after a lost reply finds its own commit there and writes nothing.
  const writes = f.calls.filter(c => c.method === 'POST').length;
  const again = await drain(f, await prepareMirror(f.seed, f.io));
  assert.equal(again.entry.commit, plan.entry.commit);
  assert.equal(f.calls.filter(c => c.path.endsWith('/refs') && c.method === 'POST').length, 1);
  assert.ok(f.calls.filter(c => c.method === 'POST').length > writes, 'blobs and commit replay idempotently');
  // A branch holding another commit is never moved.
  f.branches.set(branch, f.root.commit);
  await assert.rejects(drain(f, await prepareMirror(f.seed, f.io)), { code: 'GITHUB_SYNC_CHANGED' });
  // Only on top of a verified main commit.
  await assert.rejects(prepareMirror({ ...f.seed, verified: false }, f.io), { code: 'GITHUB_SYNC_CHANGED' });
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
test('a mirror turned on after landings catches GitHub main up from the import State in one commit', async () => {
  const f = mirrorFixture({
    verified: false,
    imported: true,
    before: { a: '1', b: 'x' },
    between: { a: '2', b: 'x' },
    after: { a: '2', b: 'y', c: 'z' },
  });
  const plan = await drain(f);
  assert.equal(plan.entry.tree, f.expected(), 'GitHub holds exactly the current Forge main');
  assert.equal(plan.entry.parent, f.root.commit, 'a fast-forward of the import commit');
  assert.equal(f.remote(), plan.entry.commit);
  assert.match(
    plan.entry.message,
    /^An accepted outcome\n\nForge mirror catch-up: .*including landings made before the mirror was on\.\n\nForge-State: /,
  );
  assert(
    f.calls.every(c => c.method === 'GET' || !c.path.endsWith('/refs/heads/main') || c.body.force === false),
  );
});
test('Issue 5bc16ea7: an empty GitHub repository gets a one-file first commit through the Contents API, then Forge main on top of it, no force push', async () => {
  const f = mirrorFixture({
    verified: false,
    empty: true,
    after: { 'README.md': '# hi', 'src/run.sh': { mode: 'executable', text: 'echo' } },
  });
  const plan = await drain(f);
  assert.equal(
    plan.entry.tree,
    f.expected(),
    'GitHub holds exactly Forge main; the first-commit file is gone',
  );
  const first = f.commits.get(plan.entry.parent);
  assert.equal(first.parent, null, 'the parent is the Contents API commit, the repository root');
  assert.match(
    plan.entry.message,
    /^An accepted outcome\n\nForge mirror first publish: the GitHub repository was empty;/,
  );
  assert.equal(f.calls.filter(c => c.method === 'PUT').length, 1, 'one Contents API write');
  assert(f.calls.every(c => !c.path.endsWith('/refs/heads/main') || c.body.force === false));
  assert.equal(f.remote(), plan.entry.commit);
});
test('Issue 5bc16ea7: a lost first-commit reply is recognized by its tree on the retry, never written twice', async () => {
  const f = mirrorFixture({ verified: false, empty: true, after: { a: '1' } });
  f.lose('/repos/synthetic/mirror/contents/.forge/mirror-first-commit');
  await assert.rejects(prepareMirror(f.seed, f.io), /lost reply/);
  const plan = await drain(f);
  assert.equal(plan.entry.tree, f.expected());
  assert.equal(f.calls.filter(c => c.method === 'PUT').length, 1);
});
test('Issue 5bc16ea7: a repository with branches but no main is not empty: nothing is written', async () => {
  const f = mirrorFixture({ verified: false, after: { a: '1' } });
  const api = f.io.api;
  f.io.api = async (path, method, body) => {
    if (path.endsWith('/git/ref/heads/main')) throw new GithubMirrorApiError(404, 'GET ref', 0);
    return api(path, method, body);
  };
  await assert.rejects(prepareMirror(f.seed, f.io), e => e.status === 404);
  assert(f.calls.every(c => c.method === 'GET'));
});
test('GitHub main that moved on its own stops with a next step and pushes nothing', async () => {
  const f = mirrorFixture({
    verified: false,
    imported: true,
    before: { a: '1' },
    between: { a: '2' },
    after: { a: '3' },
  });
  f.commits.get(f.remote()).tree = 'f'.repeat(40);
  await assert.rejects(
    drain(f),
    e => e.code === 'GITHUB_SYNC_BOOTSTRAP_TREE' && /reset GitHub main yourself/.test(e.message),
  );
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
  // Issue 6a0dd2e8: a pushed path GitHub shows with U+FFFD (bytes that are not UTF-8) is refused
  // by name, never brought in under the substituted name.
  const lossy = build({
    ...unchanged,
    'README.md': ['100644', 'hello'],
    'src/caf\uFFFD.py': ['100644', 'l'],
  });
  await assert.rejects(
    diffGithubTrees(api, 'synthetic/mirror', after, lossy),
    error => error.code === 'GITHUB_SOURCE_UNSUPPORTED' && error.message.includes('src/caf\\uFFFD.py'),
  );
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

test('Git LFS paths mirror as pointers from the Forge digest; GitHub LFS gets only objects it lacks', async () => {
  const model = 'm'.repeat(4096),
    added = 'n'.repeat(2048),
    legacy = formatLfsPointer({ oid: 'c'.repeat(64), size: 99 }).toString();
  const lfsFile = text => formatLfsPointer({ oid: digest(Buffer.from(text)), size: Buffer.byteLength(text) });
  const attributes = '*.bin filter=lfs diff=lfs merge=lfs -text\n';
  const f = mirrorFixture({
    before: { '.gitattributes': attributes, 'model.bin': model, 'old.bin': legacy, 'a.txt': 'a' },
    after: {
      '.gitattributes': attributes,
      'model.bin': model,
      'old.bin': legacy,
      'new.bin': added,
      'a.txt': 'b',
    },
    verified: false,
    githubBytes: (path, bytes) => (path === 'model.bin' ? lfsFile(model) : bytes),
  });
  const batches = [],
    uploads = [];
  f.io.lfs = {
    batch: async objects => {
      batches.push(objects);
      return objects.map(object => ({
        ...object,
        upload: { href: 'https://lfs.example.test/u', header: {} },
      }));
    },
    upload: async (object, bytes) => {
      uploads.push({ oid: object.oid, bytes: bytes.toString() });
    },
  };
  const plan = await drain(f);
  const expected = gitTree(
    f.states.get(f.head).files.map(file => {
      const bytes = f.objects.get(file.blob);
      return {
        ...file,
        sha: gitHash(
          'blob',
          file.path === 'model.bin' || file.path === 'new.bin' ? lfsFile(bytes.toString()) : bytes,
        ),
      };
    }),
  );
  assert.equal(
    plan.entry.tree,
    expected,
    'GitHub holds pointers; bootstrap matched without re-uploading model.bin',
  );
  assert.deepEqual(batches, [[{ oid: digest(Buffer.from(added)), size: 2048 }]]);
  assert.deepEqual(uploads, [{ oid: digest(Buffer.from(added)), bytes: added }]);
  assert(
    !f.reads.includes(digest(Buffer.from(model))),
    'an LFS object over 1 KiB is never read to hash its pointer',
  );
  assert.equal(
    f.windows.filter(w => w.blobs).length,
    2,
    '.gitattributes rides the first object window: one bootstrap and one change window',
  );
  // Without LFS transport a new LFS object stops the mirror before any ref moves.
  const g = mirrorFixture({
    before: { '.gitattributes': attributes },
    after: { '.gitattributes': attributes, 'new.bin': added },
  });
  await assert.rejects(drain(g), /GitHub LFS/);
  assert.equal(g.remote(), g.root.commit);
});
test('LFS pointers parse strictly and .gitattributes rules follow Git precedence', () => {
  const oid = 'a'.repeat(64);
  assert.deepEqual(parseLfsPointer(formatLfsPointer({ oid, size: 12 })), { oid, size: 12 });
  const ext = `version https://git-lfs.github.com/spec/v1\next-0-foo sha256:${'b'.repeat(64)}\noid sha256:${oid}\nsize 0\n`;
  assert.deepEqual(parseLfsPointer(Buffer.from(ext)), { oid, size: 0 });
  for (const bad of [
    `version https://git-lfs.github.com/spec/v1\nsize 12\noid sha256:${oid}\n`,
    `version https://git-lfs.github.com/spec/v1\noid sha256:${oid}\nsize 12`,
    `version https://example.com/v9\noid sha256:${oid}\nsize 12\n`,
    `version https://git-lfs.github.com/spec/v1\noid sha1:${'a'.repeat(40)}\nsize 12\n`,
    `version https://git-lfs.github.com/spec/v1\noid sha256:${oid}\nsize 012\n`,
  ])
    assert.equal(parseLfsPointer(Buffer.from(bad)), null, bad);
  const rules = lfsRules([
    { path: 'game/.gitattributes', text: '*.png -filter\nlevels/**/*.dat filter=lfs\n' },
    {
      path: '.gitattributes',
      text: '# comment\n[attr]binary -diff\n*.png filter=lfs\n/top.psd filter=lfs\nassets/ filter=lfs\n"with space.bin" filter=lfs\nmodels/** filter=lfs\n',
    },
  ]);
  const lfs = path => isLfsPath(rules, path);
  assert.equal(lfs('a/b/c.png'), true);
  assert.equal(lfs('game/hero.png'), false, 'a deeper .gitattributes overrides');
  assert.equal(lfs('game/levels/one.dat'), true);
  assert.equal(lfs('game/levels/a/b/two.dat'), true);
  assert.equal(lfs('levels/one.dat'), false);
  assert.equal(lfs('top.psd'), true);
  assert.equal(lfs('sub/top.psd'), false, 'a leading slash anchors');
  assert.equal(lfs('assets/x.bin'), false, 'directory patterns never match files');
  assert.equal(lfs('with space.bin'), true);
  assert.equal(lfs('models/a/b.onnx'), true);
});

test('two-way: an inbound push with Git LFS pointers lands the real objects, once per oid, through the import resolver', async () => {
  const { bringInChanges } = await import('../dist/github-inbound-bytes.js');
  const { readObjectRecipe } = await import('../dist/object-chunks.js');
  const small = Buffer.alloc(4096, 5),
    big = Buffer.alloc(2 * 1024 * 1024 + 5, 9),
    untracked = Buffer.from('a pointer nobody tracks\n');
  const files = new Map([
    ['README.md', Buffer.from('# plain\n')],
    ['model.bin', formatLfsPointer({ oid: digest(small), size: small.length })],
    ['copy.bin', formatLfsPointer({ oid: digest(small), size: small.length })],
    ['assets/big.dat', formatLfsPointer({ oid: digest(big), size: big.length })],
    ['docs/pointer.txt', formatLfsPointer({ oid: digest(untracked), size: untracked.length })],
  ]);
  const objects = new Map([small, big].map(bytes => [digest(bytes), bytes]));
  const attributeText = '*.bin filter=lfs -text\nassets/** filter=lfs\n';
  const run = (paths, extra = {}) => {
    const seen = {
      batch: 0,
      download: 0,
      attributes: 0,
      stored: 0,
      blobs: 0,
      uploaded: new Map(),
      recipes: [],
    };
    const known = extra.known ?? new Set();
    const io = {
      repository: 'o/r',
      token: 'synthetic',
      blob: async sha => {
        seen.blobs++;
        return [...files.values()].find(bytes => gitHash('blob', bytes) === sha);
      },
      unchangedAttributes: extra.attributes ?? ['.gitattributes'],
      attributes: async () => {
        seen.attributes++;
        return attributeText;
      },
      store: async batch => {
        for (const bytes of batch) seen.uploaded.set(digest(bytes), Buffer.from(bytes));
        return batch.map(bytes => ({ sha256: digest(bytes), size: bytes.length }));
      },
      stored: async oids => {
        seen.stored++;
        return oids.filter(oid => known.has(oid));
      },
      bindRecipes: async recipes => seen.recipes.push(...recipes),
      request: async (url, options = {}) => {
        const { hostname, pathname } = new URL(url);
        if (hostname === 'github.com') {
          seen.batch++;
          const body = JSON.parse(options.body);
          return Response.json({
            objects: body.objects.map(({ oid, size }) =>
              objects.has(oid) && !extra.missing
                ? {
                    oid,
                    size,
                    actions: { download: { href: `https://lfs.example.test/${oid}`, header: {} } },
                  }
                : { oid, size, error: { code: 404, message: 'Object does not exist' } },
            ),
          });
        }
        seen.download++;
        return new Response(objects.get(pathname.slice(1)));
      },
    };
    const changes = paths.map(path => ({
      path,
      after: { mode: 'file', sha: gitHash('blob', files.get(path)) },
    }));
    return { seen, applied: bringInChanges(changes, io) };
  };
  const all = ['README.md', 'model.bin', 'copy.bin', 'assets/big.dat', 'docs/pointer.txt'];
  const { seen, applied: pending } = run(all);
  const applied = new Map((await pending).map(change => [change.path, change.after.blob]));
  assert.equal(applied.get('README.md'), digest(files.get('README.md')));
  assert.equal(applied.get('model.bin'), digest(small), 'a pointer-only inbound fails here');
  assert.equal(applied.get('copy.bin'), digest(small));
  assert.equal(applied.get('assets/big.dat'), digest(big));
  assert.equal(
    applied.get('docs/pointer.txt'),
    digest(files.get('docs/pointer.txt')),
    'untracked pointer stays',
  );
  assert.deepEqual([seen.batch, seen.download, seen.attributes], [1, 2, 1], 'one batch, one fetch per oid');
  assert.deepEqual(seen.uploaded.get(digest(small)), small);
  assert.equal(seen.recipes.length, 1, 'the large object is bound as a chunk recipe under its oid');
  assert.equal(seen.recipes[0].digest, digest(big));
  const chunks = [];
  const read = async pin => seen.uploaded.get(pin.sha256);
  for await (const chunk of readObjectRecipe(
    JSON.parse(await read({ sha256: seen.recipes[0].recipeDigest })),
    read,
  ))
    chunks.push(chunk);
  assert.deepEqual(Buffer.concat(chunks), big);

  // A push without pointers asks GitHub for nothing beyond its blobs.
  const plain = run(['README.md']);
  await plain.applied;
  assert.deepEqual(
    [plain.seen.batch, plain.seen.download, plain.seen.attributes, plain.seen.stored],
    [0, 0, 0, 0],
  );

  // Objects the project already stores are bound, not fetched again.
  const again = run(['model.bin'], { known: new Set([digest(small)]) });
  assert.equal((await again.applied)[0].after.blob, digest(small));
  assert.deepEqual([again.seen.batch, again.seen.download], [0, 0]);

  // A changed .gitattributes is read from the push itself; an untracked path keeps the pointer.
  files.set('.gitattributes', Buffer.from('*.dat filter=lfs\n'));
  const switched = run(['.gitattributes', 'model.bin'], { attributes: [] });
  assert.equal(
    (await switched.applied).find(change => change.path === 'model.bin').after.blob,
    digest(files.get('model.bin')),
  );
  assert.equal(switched.seen.attributes, 0);
  assert.equal(switched.seen.batch, 0);

  const missing = run(['model.bin'], { missing: true });
  await assert.rejects(missing.applied, error => error.code === 'GITHUB_LFS_OBJECT_MISSING');
  files.set('huge.bin', formatLfsPointer({ oid: 'a'.repeat(64), size: 2 * 1024 ** 3 }));
  const huge = run(['huge.bin']);
  await assert.rejects(huge.applied, error => error.code === 'GITHUB_LFS_LIMIT');
  assert.equal(huge.seen.batch, 0, 'refused from the pointers before any LFS request');
});
