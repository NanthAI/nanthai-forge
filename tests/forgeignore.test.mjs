import { capture as captureAnalysis } from '../dist/snapshot.js';
// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  existsSync,
  realpathSync,
  linkSync,
  rmSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { workGit } from '../dist/work-git.js';
import { NativeSource, nativePaths } from '../dist/native-source.js';
import { initNative } from '../dist/native-work.js';
import { WorkService } from '../dist/work.js';
import { PeersSource } from '../dist/agent-peers-source.js';
import { readPendingStatus } from '../dist/pending-status-read.js';
import { formatPendingStatus } from '../dist/pending-status-format.js';
import { readIgnoredStatus } from '../dist/ignored-status.js';
import { registerAgentWorkflow } from '../dist/mcp-agent-workflow.js';
import { exportNativeGit, importNativeGit } from '../dist/native-git.js';

function fixture(t) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'forge-ignore-')));
  t.after(() => rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }));
  return root;
}
function put(root, path, content = 'SYNTHETIC_EXCLUDED_CONTENT') {
  mkdirSync(join(root, path, '..'), { recursive: true });
  writeFileSync(join(root, path), content);
}

const patterns = [
  ['*.tmp\n!keep.tmp\n', ['a.tmp', 'keep.tmp', 'sub/a.tmp', 'a.txt'], ['a.txt', 'keep.tmp']],
  ['/root.txt\n', ['root.txt', 'sub/root.txt'], ['sub/root.txt']],
  ['cache/\n', ['cache/a', 'nested/cache/b', 'cache.txt'], ['cache.txt']],
  ['*.tmp\n!nested/keep.tmp\n', ['nested/a.tmp', 'nested/keep.tmp'], ['nested/keep.tmp']],
  ['a/**/x.?s\n', ['a/x.ts', 'a/b/x.js', 'a/b/x.txt'], ['a/b/x.txt']],
  ['# comment\n\\#literal\nspace\\ \n', ['#literal', 'space ', 'normal'], ['normal']],
  ['private/\n!private/keep\n', ['private/keep', 'private/drop'], []],
  ['private/*\n!private/keep\n', ['private/keep', 'private/drop'], ['private/keep']],
];
for (const [index, [rules, names, expected]] of patterns.entries())
  test(`Git and Forge ignore pattern table ${index + 1}`, t => {
    const root = fixture(t);
    for (const name of ['.gitignore', '.forgeignore']) {
      const dir = join(root, name.slice(1));
      for (const file of names) put(dir, file);
      put(dir, name, rules);
      assert.deepEqual(
        nativePaths(dir).filter(path => path !== name),
        expected,
      );
    }
  });

test('nested rules, negation and built-in precedence are shared by capture', t => {
  const root = fixture(t);
  for (const path of [
    'a.tmp',
    'keep.tmp',
    'nested/drop.txt',
    'nested/keep.tmp',
    'nested/deep/drop.txt',
    'nested/deep/keep.txt',
    '.env',
    'nested/private.key',
  ])
    put(root, path);
  put(root, '.gitignore', '*.tmp\n');
  put(root, '.forgeignore', '!keep.tmp\n!.env\n!nested/private.key\n');
  put(root, 'nested/.forgeignore', '*.txt\n!keep.tmp\n');
  put(root, 'nested/deep/.forgeignore', '!keep.txt\n');
  const paths = nativePaths(root);
  assert(paths.includes('keep.tmp'));
  assert(paths.includes('nested/keep.tmp'));
  assert(paths.includes('nested/deep/keep.txt'));
  for (const path of ['a.tmp', 'nested/drop.txt', 'nested/deep/drop.txt', '.env', 'nested/private.key'])
    assert(!paths.includes(path), path);
  const status = readIgnoredStatus(root, true);
  assert.deepEqual(status.counts, { '.gitignore': 1, '.forgeignore': 2, builtin: 2 });
  assert.deepEqual(
    status.paths.find(item => item.path === 'nested/drop.txt'),
    {
      path: 'nested/drop.txt',
      source: '.forgeignore',
      rule: '*.txt',
      file: 'nested/.forgeignore',
      line: 1,
    },
  );
});

test('save, first-write path set, Lane materialization and export omit Forge-ignored bytes', async t => {
  const root = fixture(t);
  put(root, 'retained.txt', 'original');
  initNative(root);
  const work = new WorkService(root),
    source = new NativeSource(root);
  const act = command => work.execute(command, work.store.load().revision).result;
  const intent = act({ action: 'intent', outcome: 'Synthetic ignore integration' });
  const lane = act({ action: 'lane', intentId: intent.id, name: 'Ignore paths' });
  const path = work.store.path(lane.id);
  const peer = () => new PeersSource(work.store, lane.head).live(lane, ['retained.txt']);
  assert.equal(peer().length, 1); // Warm the old scoped saved-path cache.
  put(path, '.gitignore', 'retained.txt\n');
  put(path, '.forgeignore', 'retained.txt\nprivate/\n');
  put(path, 'private/hidden.txt');
  put(path, 'public.txt', 'public');
  assert.deepEqual(peer(), []);
  assert(!new PeersSource(work.store, lane.head).live(lane).some(file => file.path.startsWith('private/')));
  const report = source.captureReport(path, false, lane.head);
  const saved = act({
    action: 'checkpoint',
    laneId: lane.id,
    expectedHead: lane.head,
    expectedTree: source.tree(report.files),
    message: 'Respect Forge rules',
  });
  const names = source.state(saved.head).files.map(file => file.path);
  assert.deepEqual(names, ['.forgeignore', '.gitignore', 'public.txt']);
  source.materialize(saved.head, join(root, 'opened'), false);
  assert(!existsSync(join(root, 'opened/retained.txt')));
  assert(!existsSync(join(root, 'opened/private')));
  const exported = await exportNativeGit(root, saved.head, join(root, 'export'));
  const repo = join(exported.path, 'repository.git');
  assert.deepEqual(
    workGit(repo, ['ls-tree', '-r', '--name-only', exported.commit]).trim().split('\n'),
    names,
  );
  assert.equal(workGit(repo, ['show', `${exported.commit}:public.txt`]), 'public');
  assert.equal(readFileSync(join(path, 'retained.txt'), 'utf8'), 'original');
});

test('local status, CLI JSON/list and MCP expose rules without ignored file contents or remote IO', async t => {
  const root = fixture(t);
  put(root, '.gitignore', '*.tmp\n');
  put(root, '.forgeignore', 'private/\n');
  put(root, 'a.tmp');
  put(root, 'private/a.txt');
  put(root, '.env');
  initNative(root);
  const work = new WorkService(root),
    revision = work.store.revision();
  put(root, 'public.txt', 'public');
  linkSync(join(root, 'public.txt'), join(root, 'public-linked.txt'));
  let calls = 0;
  t.mock.method(globalThis, 'fetch', () => {
    calls++;
    throw Error('Unexpected network call');
  });
  const compact = readPendingStatus(work.store);
  assert.deepEqual(compact.ignored.counts, { '.gitignore': 1, '.forgeignore': 1, builtin: 2 });
  assert(!('paths' in compact.ignored));
  const detailed = readPendingStatus(work.store, undefined, undefined, { ignored: true });
  assert.match(formatPendingStatus(detailed), /Ignored: 1 .gitignore · 1 .forgeignore · 2 built-in/);
  assert.match(formatPendingStatus(detailed), /"private" · ".forgeignore":1 · "private\/"/);
  assert(!JSON.stringify(detailed).includes('SYNTHETIC_EXCLUDED_CONTENT'));
  const cli = fileURLToPath(new URL('../dist/cli.js', import.meta.url));
  for (const flags of [[], ['--ignored'], ['--json'], ['--ignored', '--json']]) {
    const child = spawnSync(process.execPath, [cli, 'status', root, ...flags], { encoding: 'utf8' });
    assert.equal(child.status, 0, child.stderr);
    assert(!child.stdout.includes('SYNTHETIC_EXCLUDED_CONTENT'));
    if (flags.includes('--json')) {
      const status = JSON.parse(child.stdout);
      assert.deepEqual(status.ignored.counts, detailed.ignored.counts);
      assert.equal(Array.isArray(status.ignored.paths), flags.includes('--ignored'));
    } else assert.match(child.stdout, /Ignored:/);
  }
  const tools = new Map();
  const close = registerAgentWorkflow(
    {
      registerTool(name, spec, handler) {
        tools.set(name, { spec, handler });
      },
    },
    root,
  );
  try {
    const mcp = tools.get('forge_work_overview');
    const response = await mcp.handler({ command: { action: 'pending-status', ignored: true } });
    const result = JSON.parse(response.content[0].text);
    assert.deepEqual(result.ignored, detailed.ignored);
    assert.equal(calls, 0);
    assert.equal(work.store.revision(), revision);
  } finally {
    await close();
  }
});

test('original Git import retains exact history while subsequent captures honor Forge rules', async t => {
  const root = fixture(t),
    repo = join(root, 'git');
  mkdirSync(repo);
  workGit(repo, ['init', '--template=', '--initial-branch=main']);
  put(repo, '.forgeignore', 'historical.txt\n');
  put(repo, 'historical.txt', 'original historical source');
  workGit(repo, ['add', '--all']);
  workGit(repo, [
    '-c',
    'user.name=Fixture',
    '-c',
    'user.email=fixture@example.invalid',
    'commit',
    '-m',
    'Original',
  ]);
  const commit = workGit(repo, ['rev-parse', 'HEAD']).trim();
  const imported = await importNativeGit(repo, commit, join(root, 'native'));
  const source = new NativeSource(imported.root);
  assert(source.state(imported.head).files.some(file => file.path === 'historical.txt'));
  assert(!source.capture(imported.root, false, imported.head).some(file => file.path === 'historical.txt'));
  assert.equal(readFileSync(join(imported.root, 'historical.txt'), 'utf8'), 'original historical source');
});

test('Git analysis shares Forge rules, re-includes Git-ignored source and preserves local info exclusions', t => {
  const root = fixture(t);
  workGit(root, ['init', '--template=', '--initial-branch=main']);
  put(root, '.gitignore', '*.tmp.ts\n');
  put(root, '.forgeignore', '!keep.tmp.ts\nprivate.ts\n!.env.ts\n');
  put(root, '.git/info/exclude', 'local.ts\n');
  for (const name of ['keep.tmp.ts', 'drop.tmp.ts', 'private.ts', '.env.ts', 'local.ts', 'public.ts'])
    put(root, name, 'export const synthetic = 1;');
  const snapshot = captureAnalysis(root);
  assert.deepEqual(
    snapshot.source.files.map(file => file.path),
    ['keep.tmp.ts', 'public.ts'],
  );
  assert.deepEqual([...snapshot.content.keys()], ['keep.tmp.ts', 'public.ts']);
});
