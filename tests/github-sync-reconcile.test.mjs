// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { fixture } from './helpers.mjs';
import { workGit } from '../dist/work-git.js';
import { githubReconciliation } from '../dist/github-sync-reconcile.js';

const entry = (bytes, mode = '100644') => ({ bytes, mode });
const binary = Buffer.from([0, 255, 0, 1]);
for (const [name, base, ours, theirs, reason] of [
  ['missing addition', undefined, undefined, entry('new'), 'external addition would change Forge content'],
  ['different additions', undefined, entry('ours'), entry('theirs'), 'conflicting additions'],
  ['missing deletion', entry('old'), entry('old'), undefined, 'external deletion would change Forge content'],
  [
    'delete versus modify',
    entry('old'),
    entry('ours'),
    undefined,
    'external deletion conflicts with Forge changes',
  ],
  [
    'modify versus delete',
    entry('old'),
    undefined,
    entry('theirs'),
    'Forge deletion conflicts with external changes',
  ],
  ['same deletion', entry('old'), undefined, undefined, undefined],
  [
    'missing mode change with later Forge bytes',
    entry('old'),
    entry('later'),
    entry('old', '100755'),
    'merge would change Forge mode',
  ],
  [
    'contained mode change with later Forge bytes',
    entry('old'),
    entry('later', '100755'),
    entry('old', '100755'),
    undefined,
  ],
  [
    'contained binary bytes with later Forge mode',
    entry('old'),
    entry(binary, '100755'),
    entry(binary),
    undefined,
  ],
  [
    'conflicting binary edits',
    entry(binary),
    entry(Buffer.from([0, 2])),
    entry(Buffer.from([0, 3])),
    'content conflicts or cannot be merged as text',
  ],
  [
    'conflicting symlink targets',
    entry('old', '120000'),
    entry('ours', '120000'),
    entry('theirs', '120000'),
    'conflicting non-regular file content',
  ],
  [
    'conflicting type changes',
    entry('old'),
    entry('ours', '120000'),
    entry('theirs', '100755'),
    'conflicting modes',
  ],
]) {
  test(`three-way reconciliation handles ${name}`, t => {
    const root = fixture(t),
      path = 'odd\tpath\n.txt';
    const tree = file => {
      const input = file
        ? `${file.mode} blob ${workGit(root, ['hash-object', '-w', '--stdin'], Buffer.from(file.bytes)).trim()}\t${path}\0`
        : '';
      return workGit(root, ['mktree', '-z'], input).trim();
    };
    const expected = workGit(root, ['commit-tree', tree(base), '-m', 'Recorded base']).trim(),
      remote = workGit(root, ['commit-tree', tree(theirs), '-p', expected, '-m', 'External change']).trim(),
      result = githubReconciliation(root, expected, remote, tree(ours));
    assert.equal(result.status, reason ? 'not-contained' : 'contained');
    assert.deepEqual(result.missingPathReasons, reason ? [{ path, reason }] : []);
    assert.deepEqual(result.missingPaths, reason ? [path] : []);
  });
}
