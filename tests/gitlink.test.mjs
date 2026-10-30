// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { createElement as h } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { moduleUrl } from './convex-module.mjs';
import { gitlinkCommit, gitmoduleUrls, readSubmodulePointers, submoduleLabel } from '../dist/gitlink.js';
import { sourceTreeEntries } from '../dist/source-tree-index.js';
import { digest } from '../dist/hash.js';
const { SubmodulePointers, SubmodulePointerView } = await import(moduleUrl('../web/src/Submodules.tsx'));
const { CodeFileTree } = await import(moduleUrl('../web/src/CodeFileTree.tsx'));

test('pointer bytes and inert gitmodules parsing preserve relative and SSH URLs', () => {
  assert.equal(gitlinkCommit(Buffer.from('a'.repeat(40) + '\n')), 'a'.repeat(40));
  for (const bytes of ['short', 'a'.repeat(40) + '\nextra', 'a'.repeat(40) + '\0'])
    assert.throws(
      () => gitlinkCommit(Buffer.from(bytes)),
      e => e.code === 'INVALID_GITLINK',
    );
  const urls = gitmoduleUrls(
    '[submodule "quoted name"]\npath = "vendor/a b" # comment\nurl = "../lib.git"\n[submodule "ssh"]\npath=vendor/ssh\nurl=git@example.invalid:org/lib.git\n[include]\npath=/never/read\n',
  );
  assert.deepEqual(
    [...urls],
    [
      ['vendor/a b', '../lib.git'],
      ['vendor/ssh', 'git@example.invalid:org/lib.git'],
    ],
  );
});

test('Now and Code render submodule URLs and short pins as leaf entries', () => {
  const pointer = { path: 'vendor/lib', commit: 'a'.repeat(40), url: '../lib.git' };
  for (const view of [h(SubmodulePointers, { pointers: [pointer] }), h(SubmodulePointerView, { pointer })]) {
    const html = renderToStaticMarkup(view);
    assert(html.includes('submodule → ../lib.git @ aaaaaaaa'));
    assert(!html.includes('<details'));
  }
  const tree = renderToStaticMarkup(
    h(CodeFileTree, { paths: ['vendor/lib'], selected: 'vendor/lib', touched: new Set(), select() {} }),
  );
  assert.equal((tree.match(/<details/g) ?? []).length, 1, 'only vendor is a folder');
  assert(tree.includes('title="vendor/lib"'));
  assert.equal(submoduleLabel({ ...pointer, url: null }), 'submodule → (URL unavailable) @ aaaaaaaa');
  const index = sourceTreeEntries('head', [{ path: pointer.path, mode: 'gitlink' }]);
  assert.equal(JSON.parse(index.at(-1).value).submodules, 1);
});

test('5,000 pointers resolve in bounded windows without per-entry calls or content reads', async t => {
  const objects = new Map(),
    files = [],
    readWindows = [],
    start = performance.now(),
    rss = process.memoryUsage().rss;
  let modules = '';
  for (let i = 0; i < 5000; i++) {
    const bytes = Buffer.from(i.toString(16).padStart(40, '0')),
      blob = digest(bytes),
      path = `vendor/${i}`;
    objects.set(blob, bytes);
    files.push({ path, blob, mode: 'gitlink' });
    modules += `[submodule "${i}"]\npath=${path}\nurl=../lib-${i}.git\n`;
  }
  const blob = digest(modules);
  objects.set(blob, Buffer.from(modules));
  files.push({ path: '.gitmodules', blob, mode: 'file' });
  const pointers = await readSubmodulePointers(files, async ids => {
    readWindows.push(ids.length);
    return ids.map(id => objects.get(id));
  });
  assert.equal(pointers.length, 5000);
  assert.equal(readWindows.length, 51);
  assert(readWindows.every(size => size <= 100));
  assert.equal(pointers[4999].url, '../lib-4999.git');
  assert(process.memoryUsage().rss - rss < 128 * 1024 * 1024);
  t.diagnostic(
    JSON.stringify({
      pointers: 5000,
      readCalls: readWindows.length,
      maxWindow: Math.max(...readWindows),
      elapsedMs: performance.now() - start,
      rss: process.memoryUsage().rss,
    }),
  );
});

test('bare Git export writes 160000 commit entries without requiring submodule commit objects', async t => {
  const { mkdtempSync, mkdirSync, rmSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const { execFileSync } = await import('node:child_process');
  const { NativeSource } = await import('../dist/native-source.js');
  const { treeForGit, gitTreeHasher, asyncGitTreeWriter } = await import('../dist/native-git-tree.js');
  const root = mkdtempSync(join(tmpdir(), 'forge-gitlink-tree-'));
  t.after(() => rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }));
  const git = (args, input) => execFileSync('git', ['-C', root, ...args], { input, encoding: 'utf8' }).trim();
  git(['init', '--bare', '--template=']);
  mkdirSync(join(root, 'source'));
  const source = new NativeSource(join(root, 'source'));
  const pin = 'a'.repeat(40),
    blob = source.put(Buffer.from(pin));
  const files = [
    { path: 'lib', blob, mode: 'gitlink' },
    { path: 'plain.txt', blob, mode: 'file' },
  ];
  const tree = treeForGit(root, files, source);
  const listing = git(['ls-tree', tree]);
  assert(listing.includes(`160000 commit ${pin}\tlib`));
  assert(listing.includes('100644 blob'));
  assert.equal(gitTreeHasher(source, 'sha1')(files), tree);
  const writer = asyncGitTreeWriter(
    source,
    async bytes => git(['hash-object', '-w', '--stdin'], bytes),
    async bytes => git(['mktree', '-z', '--batch'], bytes),
  );
  assert.equal(await writer(files), tree);
});

test('opposing pointer updates conflict atomically and resolution drafts retain the Lane pointer', async t => {
  const { mkdtempSync, rmSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const { NativeSource } = await import('../dist/native-source.js');
  const { conflictPlan } = await import('../dist/agent-sync.js');
  const root = mkdtempSync(join(tmpdir(), 'forge-gitlink-merge-'));
  t.after(() => rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }));
  const source = new NativeSource(root),
    at = '2026-01-01T00:00:00.000Z';
  const state = (sha, parents = []) =>
    source.writeState(
      [{ path: 'lib', mode: 'gitlink', blob: source.put(Buffer.from(sha.repeat(40))) }],
      parents,
      'pointer',
      at,
    );
  const base = state('a'),
    left = state('b', [base]),
    right = state('c', [base]);
  assert.deepEqual(source.compose(left, right, 'merge', at).conflicts, ['lib']);
  const draft = conflictPlan(source, left, right, 'main');
  assert.deepEqual(draft.conflicts, [{ path: 'lib', kind: 'binary' }]);
  assert.equal(draft.files[0].blob, source.state(left).files[0].blob);
  assert.equal(draft.files[0].bytes, undefined, 'never place text conflict markers inside a commit SHA');
});
