// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  readdirSync,
  rmSync,
  lstatSync,
  existsSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  checkSubmodules,
  materializeSubmodules,
  submoduleFailureCommand,
  submoduleFetchUrl,
} from '../dist/submodule-materialize.js';
import { verifySourceTree } from '../dist/hosted-actions-job-source.js';
import { warmPackCache } from '../dist/hosted-actions-job-pack.js';
import { hostedCheckDefinition } from '../dist/hosted-check.js';
import { digest } from '../dist/hash.js';

const git = (cwd, ...args) =>
  execFileSync('git', ['-c', 'protocol.file.allow=always', ...args], {
    cwd,
    encoding: 'utf8',
    env: {
      PATH: process.env.PATH,
      HOME: cwd,
      GIT_CONFIG_NOSYSTEM: '1',
      GIT_CONFIG_GLOBAL: '/dev/null',
      GIT_AUTHOR_NAME: 'fixture',
      GIT_AUTHOR_EMAIL: 'fixture@example.invalid',
      GIT_COMMITTER_NAME: 'fixture',
      GIT_COMMITTER_EMAIL: 'fixture@example.invalid',
    },
  }).trim();

/** Synthetic upstreams: `lib` (with a nested `deps/inner` submodule) and `inner`. */
function upstreams(t) {
  const root = mkdtempSync(join(tmpdir(), 'forge-submodule-fixture-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const repo = (name, files, links = []) => {
    const path = join(root, name);
    mkdirSync(path);
    git(path, 'init', '-q', '-b', 'main');
    for (const [file, text] of Object.entries(files)) {
      mkdirSync(join(path, file, '..'), { recursive: true });
      writeFileSync(join(path, file), text);
    }
    git(path, 'add', '-A');
    for (const link of links)
      git(path, 'update-index', '--add', '--cacheinfo', `160000,${link.commit},${link.path}`);
    git(path, 'commit', '-q', '-m', name);
    git(path, 'config', 'uploadpack.allowAnySHA1InWant', 'true');
    return { url: pathToFileURL(path).href, commit: git(path, 'rev-parse', 'HEAD') };
  };
  const inner = repo('inner', { 'inner.c': 'int inner;\n' });
  const lib = repo(
    'lib',
    {
      'lib/src/lib.c': 'int lib;\n',
      '.gitmodules': `[submodule "inner"]\n\tpath = deps/inner\n\turl = ${inner.url}\n`,
      '.gitattributes': 'lib/** export-ignore\n',
    },
    [{ path: 'deps/inner', commit: inner.commit }],
  );
  // A gitlink with no `.gitmodules` entry inside a fetched submodule.
  const ghosts = repo('ghosts', { 'g.c': 'int g;\n' }, [{ path: 'deps/ghost', commit: inner.commit }]);
  return { root, inner, lib, ghosts };
}

/** A check workspace as the runners install it: pointer file plus `.gitmodules`. */
function workspace(t, modules, links) {
  const directory = mkdtempSync(join(tmpdir(), 'forge-submodule-workspace-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const objects = new Map(),
    files = [];
  const put = (path, text, mode = 'file') => {
    const bytes = Buffer.from(text),
      blob = digest(bytes);
    objects.set(blob, bytes);
    files.push({ path, blob, mode });
    mkdirSync(join(directory, path, '..'), { recursive: true });
    writeFileSync(join(directory, path), bytes);
  };
  put('.gitmodules', modules);
  put('README.md', 'superproject\n');
  for (const link of links) put(link.path, link.commit, 'gitlink');
  return { directory, files, read: async blob => objects.get(blob) };
}

test('fetch URL policy: credential-free HTTPS only, GitHub SSH as HTTPS, relative needs an origin', () => {
  const ok = url => submoduleFetchUrl(url).url;
  assert.equal(
    ok('https://github.com/tree-sitter/tree-sitter'),
    'https://github.com/tree-sitter/tree-sitter',
  );
  assert.equal(
    ok('git@github.com:tree-sitter/tree-sitter.git'),
    'https://github.com/tree-sitter/tree-sitter.git',
  );
  assert.equal(ok('ssh://git@github.com/org/lib.git'), 'https://github.com/org/lib.git');
  for (const [url, reason] of [
    [null, 'url-unavailable'],
    ['http://example.invalid/lib.git', 'url-unsupported'],
    ['https://user:secret@example.invalid/lib.git', 'url-unsupported'],
    ['file:///tmp/lib.git', 'url-unsupported'],
    ['ext::sh -c touch% /tmp/pwned', 'url-unsupported'],
    ['git@gitlab.example.invalid:org/lib.git', 'url-unsupported'],
    ['/srv/lib.git', 'url-unsupported'],
    ['../lib.git', 'relative-url-without-origin'],
  ])
    assert.equal(submoduleFetchUrl(url).reason, reason, String(url));
  assert.equal(
    submoduleFetchUrl('../lib.git', 'https://github.com/org/app.git').url,
    'https://github.com/org/lib.git',
  );
  assert.equal(
    submoduleFetchUrl('./sub/x', 'git@github.com:org/app').url,
    'https://github.com/org/app/sub/x',
  );
});

test('check workspace: pinned tree replaces the pointer recursively, each commit fetched once per cache', async t => {
  process.env.FORGE_TEST_SUBMODULE_FILE_URLS = '1';
  t.after(() => delete process.env.FORGE_TEST_SUBMODULE_FILE_URLS);
  const { root, lib, inner } = upstreams(t);
  const modules = `[submodule "core"]\n\tpath = vendor/core\n\turl = ${lib.url}\n[submodule "again"]\n\tpath = again\n\turl = ${lib.url}\n`;
  const s = workspace(t, modules, [
    { path: 'vendor/core', commit: lib.commit },
    { path: 'again', commit: lib.commit },
  ]);
  const cache = join(root, 'cache'),
    lines = [];
  const started = performance.now();
  const done = await materializeSubmodules(s.directory, s.files, s.read, {
    cache,
    log: line => lines.push(line),
  });
  assert.deepEqual(
    done.map(item => [item.path, item.commit, item.fetched]),
    [
      ['vendor/core', lib.commit, true],
      ['again', lib.commit, false],
      ['vendor/core/deps/inner', inner.commit, true],
      ['again/deps/inner', inner.commit, false],
    ],
  );
  // export-ignore does not drop files: this is a checkout, not an archive.
  assert.equal(readFileSync(join(s.directory, 'vendor/core/lib/src/lib.c'), 'utf8'), 'int lib;\n');
  assert.equal(readFileSync(join(s.directory, 'again/deps/inner/inner.c'), 'utf8'), 'int inner;\n');
  assert(!existsSync(join(s.directory, 'vendor/core/.git')), 'no Git metadata in the workspace');
  assert.match(lines[0], /^submodules: 4 materialized \(2 fetched, 2 cached\)/);
  // The runner's tree verification accepts the materialized directory; pack warm-up skips it.
  await verifySourceTree({ files: s.files }, s.directory);
  const pack = join(root, 'pack');
  await warmPackCache({ files: s.files }, s.directory, pack);
  const pointer = s.files.find(file => file.path === 'vendor/core');
  assert(!existsSync(join(pack, pointer.blob)));
  assert(existsSync(join(pack, s.files.find(file => file.path === 'README.md').blob)));
  t.diagnostic(
    JSON.stringify({ submodules: 4, fetches: 2, wallMs: Math.round(performance.now() - started) }),
  );
});

test('unusable URLs refuse with path, commit and URL before any write; unreachable ones fail the check', async t => {
  const commit = 'a'.repeat(40);
  const s = workspace(
    t,
    '[submodule "x"]\n\tpath = vendor/x\n\turl = git@gitlab.example.invalid:org/x.git\n',
    [{ path: 'vendor/x', commit }],
  );
  const cache = mkdtempSync(join(tmpdir(), 'forge-submodule-cache-'));
  t.after(() => rmSync(cache, { recursive: true, force: true }));
  await assert.rejects(
    () => materializeSubmodules(s.directory, s.files, s.read, { cache }),
    error =>
      error.code === 'SUBMODULE_NOT_MATERIALIZED' &&
      error.message.includes('vendor/x') &&
      error.message.includes(commit.slice(0, 12)) &&
      error.message.includes('git@gitlab.example.invalid:org/x.git') &&
      error.recovery.refusals[0].reason === 'url-unsupported',
  );
  assert.equal(readFileSync(join(s.directory, 'vendor/x'), 'utf8'), commit, 'pointer kept, nothing fetched');

  const unreachable = workspace(t, '[submodule "y"]\n\tpath = y\n\turl = https://127.0.0.1:9/y.git\n', [
    { path: 'y', commit },
  ]);
  const result = await checkSubmodules(unreachable.directory, unreachable.files, unreachable.read, { cache });
  assert.equal(result.refusal.includes('fetch-failed'), true);
  assert.equal(result.refusal.includes('https://127.0.0.1:9/y.git'), true);
  const [node, ...args] = submoduleFailureCommand(process.execPath, result.refusal);
  const child = spawnSync(node, args, { encoding: 'utf8' });
  assert.equal(child.status, 1);
  assert.match(
    child.stderr,
    /^SUBMODULE_NOT_MATERIALIZED: Submodule y @ aaaaaaaaaaaa \(https:\/\/127\.0\.0\.1:9\/y\.git\)/,
  );
});

test('a fixture with no gitlinks runs no Git; opting out keeps the definition digest for others', async t => {
  const s = workspace(t, '', []);
  assert.deepEqual(await materializeSubmodules(s.directory, s.files, s.read, { cache: '/nonexistent' }), []);
  const command = { name: 'c', executable: 'node', args: [], environmentLabel: '' };
  const plain = hostedCheckDefinition(command, '00000000-0000-4000-8000-000000000000', 'at');
  const kept = hostedCheckDefinition({ ...command, submodules: true }, plain.id, 'at');
  const off = hostedCheckDefinition({ ...command, submodules: false }, plain.id, 'at');
  assert.equal(kept.definition, plain.definition);
  assert.equal(off.submodules, false);
  assert.notEqual(off.definition, plain.definition);
  assert(lstatSync(s.directory).isDirectory());
});

test('gitlinks with no .gitmodules URL become empty directories with one notice, as on GitHub; mapped ones still materialize', async t => {
  process.env.FORGE_TEST_SUBMODULE_FILE_URLS = '1';
  t.after(() => delete process.env.FORGE_TEST_SUBMODULE_FILE_URLS);
  const { root, lib, ghosts } = upstreams(t);
  const unmapped = [
    { path: '.repos/alchemy/submodules/distilled', commit: 'a'.repeat(40) },
    { path: 'floci', commit: 'b'.repeat(40) },
  ];
  // Two unmapped links and nothing else: no Git runs and nothing is fetched (the cache does not exist).
  const only = workspace(t, '', unmapped),
    onlyLines = [];
  assert.deepEqual(
    await materializeSubmodules(only.directory, only.files, only.read, {
      cache: '/nonexistent',
      log: line => onlyLines.push(line),
    }),
    [],
  );
  for (const link of unmapped) {
    assert(lstatSync(join(only.directory, link.path)).isDirectory(), link.path);
    assert.deepEqual(readdirSync(join(only.directory, link.path)), []);
  }
  assert.equal(
    onlyLines[0],
    "submodules: 2 without a URL in .gitmodules left as empty directories, as in GitHub's default checkout: .repos/alchemy/submodules/distilled, floci",
  );
  await verifySourceTree({ files: only.files }, only.directory);

  // Beside mapped links (and an unmapped one nested in a fetched tree), the check still passes.
  const modules = `[submodule "core"]\n\tpath = vendor/core\n\turl = ${lib.url}\n[submodule "g"]\n\tpath = vendor/g\n\turl = ${ghosts.url}\n[submodule "named-only"]\n\tpath = floci\n`;
  const s = workspace(t, modules, [
    { path: 'vendor/core', commit: lib.commit },
    { path: 'vendor/g', commit: ghosts.commit },
    ...unmapped,
  ]);
  const lines = [];
  const result = await checkSubmodules(s.directory, s.files, s.read, {
    cache: join(root, 'cache'),
    log: line => lines.push(line),
  });
  assert.equal(result.refusal, null);
  assert.deepEqual(
    result.materialized.map(item => item.path),
    ['vendor/core', 'vendor/g', 'vendor/core/deps/inner'],
  );
  assert.equal(readFileSync(join(s.directory, 'vendor/g/g.c'), 'utf8'), 'int g;\n');
  assert.deepEqual(readdirSync(join(s.directory, 'vendor/g/deps/ghost')), []);
  assert.match(
    lines[0],
    /^submodules: 3 without a URL in \.gitmodules left as empty directories.*: \.repos\/alchemy\/submodules\/distilled, floci, vendor\/g\/deps\/ghost$/,
  );
  assert.match(lines[1], /^submodules: 3 materialized/);
  await verifySourceTree({ files: s.files }, s.directory);
});
