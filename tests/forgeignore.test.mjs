// SPDX-License-Identifier: Apache-2.0
import { capture as captureAnalysis } from '../dist/snapshot.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  existsSync,
  realpathSync,
  rmSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { generateKeyPairSync } from 'node:crypto';

import { workGit } from '../dist/work-git.js';
import { NativeSource, nativePaths } from '../dist/native-source.js';
import { initNative } from '../dist/native-work.js';
import { WorkService } from '../dist/work.js';
import { PeersSource } from '../dist/agent-peers-source.js';
import { readIgnoredStatus } from '../dist/ignored-status.js';

import { exportNativeGit, importNativeGit } from '../dist/native-git.js';

// Generated per run, so no key is ever committed.
const privateKey = () =>
  generateKeyPairSync('ec', { namedCurve: 'P-256' }).privateKey.export({ type: 'pkcs8', format: 'pem' });
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
  // Wildcard negations never re-include a held credential name; an exact one is the deliberate include.
  put(root, 'nested/private.key', privateKey());
  put(root, 'nested/fixture.key', privateKey());
  put(root, '.forgeignore', '!keep.tmp\n!.env*\n!nested/*.key\n!nested/fixture.key\n');
  put(root, 'nested/.forgeignore', '*.txt\n!keep.tmp\n');
  put(root, 'nested/deep/.forgeignore', '!keep.txt\n');
  const paths = nativePaths(root);
  assert(paths.includes('keep.tmp'));
  assert(paths.includes('nested/keep.tmp'));
  assert(paths.includes('nested/deep/keep.txt'));
  assert(paths.includes('nested/fixture.key'));
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
    // The ignore files are text with a file-level entry; their text is not retained as content.
    ['keep.tmp.ts', 'public.ts', '.forgeignore', '.gitignore'],
  );
  assert.deepEqual([...snapshot.content.keys()], ['keep.tmp.ts', 'public.ts']);
});
