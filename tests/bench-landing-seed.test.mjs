// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { initNative } from '../dist/native-work.js';
import { NativeSource } from '../dist/native-source.js';
import { treeForGit } from '../dist/native-git.js';
import { workGit } from '../dist/work-git.js';
import { prepareGithubClone, seedNativeGit } from '../scripts/bench-landing-seed.mjs';

test('benchmark seed has one commit and the exact main tree without retained history or filters', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'bench-seed-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const root = join(dir, 'owner');
  mkdirSync(root);
  const initial = initNative(root);
  const source = new NativeSource(root);
  const files = [
    ['.gitattributes', 'file', '*.txt text eol=lf\n'],
    ['notice.txt', 'file', 'vendor notice\r\nunchanged bytes\r\n'],
    ['run.sh', 'executable', '#!/bin/sh\nexit 0\n'],
    ['link', 'symlink', 'notice.txt'],
    ['binary', 'file', Buffer.from([0, 255, 13, 10])],
  ].map(([path, mode, bytes]) => ({ path, mode, blob: source.put(Buffer.from(bytes)) }));
  const head = source.writeState(files, [initial.head], 'main', new Date().toISOString());
  const seed = join(dir, 'seed');
  await seedNativeGit(root, head, seed);
  assert.equal(workGit(seed, ['rev-list', '--all', '--count']).trim(), '1');
  assert.equal(workGit(seed, ['rev-parse', 'HEAD^{tree}']).trim(), treeForGit(seed, files, source));
  for (const file of files)
    assert.deepEqual(
      workGit(seed, ['cat-file', 'blob', `HEAD:${file.path}`], undefined, false, true),
      source.object(file.blob),
    );
  const clone = join(dir, 'clone');
  await prepareGithubClone(
    async (command, args) => {
      assert.equal(command, 'git');
      return { stdout: workGit(dir, args) };
    },
    seed,
    clone,
    'name: Synthetic workflow\n',
  );
  const landedFiles = workGit(clone, ['ls-tree', '-r', '--name-only', 'HEAD']).trim().split('\n');
  assert.deepEqual(
    landedFiles.sort(),
    [...files.map(f => f.path), '.github/workflows/bench-check.yml'].sort(),
  );
  for (const file of files)
    assert.deepEqual(
      workGit(clone, ['cat-file', 'blob', `HEAD:${file.path}`], undefined, false, true),
      source.object(file.blob),
    );
  assert.equal(await seedNativeGit(root, head, seed), seed);
  workGit(seed, [
    'update-ref',
    'refs/heads/extra',
    workGit(seed, [
      'commit-tree',
      workGit(seed, ['rev-parse', 'HEAD^{tree}']).trim(),
      '-p',
      'HEAD',
      '-m',
      'old history',
    ]).trim(),
  ]);
  await assert.rejects(seedNativeGit(root, head, seed), /fresh --work/);
});
