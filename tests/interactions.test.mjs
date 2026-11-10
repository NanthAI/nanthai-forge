// SPDX-License-Identifier: Apache-2.0
import { readWorkBytes } from './work-store-fixture.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, renameSync, existsSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';

import { WorkService } from '../dist/work.js';
import { fixture, git, write, code } from './helpers.mjs';

function setup(t, files = { 'a.ts': 'export const a = 1;\n', 'b.ts': 'export const b = 1;\n' }) {
  const root = fixture(t, files);
  git(root, ['add', '.']);
  git(root, ['commit', '-qm', 'Original source']);
  const original = git(root, ['rev-parse', 'HEAD']).trim(),
    work = new WorkService(root);
  const local = command => work.execute(command, work.store.load().revision).result;
  function candidate(name, edit) {
    const intent = local({ action: 'intent', outcome: name }),
      lane = local({ action: 'lane', intentId: intent.id, name });
    const path = work.store.path(lane.id);
    edit(path);
    git(path, ['add', '.']);
    const head = git(path, ['rev-parse', 'HEAD']).trim(),
      tree = git(path, ['write-tree']).trim();
    const checked = local({
      action: 'checkpoint',
      laneId: lane.id,
      expectedHead: head,
      expectedTree: tree,
      message: name,
    });
    const view = local({
      action: 'compose',
      intentId: intent.id,
      inputs: [{ laneId: lane.id, head: checked.head }],
    });
    return { intent, lane, path, view };
  }
  const command = (left, right, patch = {}) => ({
    action: 'compare-views',
    viewId: left.id,
    expectedHead: left.head,
    otherViewId: right.id,
    otherHead: right.head,
    ...patch,
  });
  const compare = async (left, right, patch) => (await work.dispatch(command(left, right, patch), 0)).result;
  return { root, original, work, local, candidate, command, compare };
}

test('original View pairs observe additions/deletions/binary and both rename paths with paged exact overlap, preserving old pins and dirty work', async t => {
  const files = Object.fromEntries(
    Array.from({ length: 25 }, (_, i) => [
      `shared-${String(i).padStart(2, '0')}.ts`,
      `export const value = ${i};\n`,
    ]),
  );
  Object.assign(files, {
    'removed.txt': 'remove me',
    'old-name.ts': 'rename me',
    'binary.bin': Buffer.from([0, 1, 2]),
  });
  const { root, original, work, local, candidate, compare } = setup(t, files);
  const edit = (path, side) => {
    for (let i = 0; i < 25; i++)
      write(path, `shared-${String(i).padStart(2, '0')}.ts`, `export const ${side} = ${i};\n`);
    unlinkSync(join(path, 'removed.txt'));
    write(path, 'binary.bin', Buffer.from([0, side === 'left' ? 3 : 4]));
  };
  const left = candidate('Left outcome', path => {
    edit(path, 'left');
    renameSync(join(path, 'old-name.ts'), join(path, 'new-name.ts'));
  });
  const right = candidate('Right outcome', path => {
    edit(path, 'right');
    write(path, 'old-name.ts', 'changed original');
    write(path, 'new-name.ts', 'independent addition');
  });
  write(left.path, 'unfinished.ts', 'private unfinished source');
  const before = readWorkBytes(join(work.store.directory, 'work.json'));
  // Repository diff configuration must not silently omit committed path facts or execute source transforms.
  const marker = join(root, 'executed');
  git(root, ['config', 'diff.external', `touch ${marker}`]);
  git(root, ['config', 'diff.relative', 'true']);
  git(root, ['replace', left.view.head, original]);
  const first = await compare(left.view, right.view);
  assert.equal(first.status, 'observed');
  assert.equal(first.commonPathCount, 29);
  assert.equal(first.left.changedPathCount, 29);
  assert.equal(first.right.changedPathCount, 29);
  assert.equal(first.sharedPaths.length, 20);
  assert.equal(first.nextOffset, 20);
  const second = await compare(left.view, right.view, { offset: first.nextOffset });
  assert.equal(second.sharedPaths.length, 9);
  assert.equal(second.nextOffset, null);
  const names = [...first.sharedPaths, ...second.sharedPaths].map(p => p.display);
  for (const path of ['old-name.ts', 'new-name.ts', 'removed.txt', 'binary.bin'])
    assert(names.includes(path));
  for (const path of [...first.sharedPaths, ...second.sharedPaths])
    assert.equal(Buffer.from(path.rawBase64, 'base64').toString('utf8'), path.display);
  assert.equal(existsSync(marker), false);
  assert.deepEqual(readWorkBytes(join(work.store.directory, 'work.json')), before);
  git(root, ['replace', '-d', left.view.head]);
  write(right.path, 'newer.ts', 'newer candidate');
  git(right.path, ['add', 'newer.ts']);
  const checkpoint = local({
    action: 'checkpoint',
    laneId: right.lane.id,
    expectedHead: right.view.head,
    expectedTree: git(right.path, ['write-tree']).trim(),
    message: 'New candidate',
  });
  local({
    action: 'compose',
    intentId: right.intent.id,
    inputs: [{ laneId: right.lane.id, head: checkpoint.head }],
  });
  const old = await compare(left.view, right.view);
  assert.equal(old.right.head, right.view.head);
  assert.equal(old.commonPathCount, 29);
  assert.equal(git(root, ['rev-parse', 'HEAD']).trim(), original);
  assert.equal(readFileSync(join(left.path, 'unfinished.ts'), 'utf8'), 'private unfinished source');
});

test('different bases are measured separately; identical or disjoint committed paths imply no runtime independence', async t => {
  const { root, work, candidate, compare } = setup(t);
  const left = candidate('Original-base outcome', path => write(path, 'a.ts', 'export const a = 2;\n'));
  write(root, 'a.ts', 'export const a = 3;\n');
  git(root, ['add', 'a.ts']);
  git(root, ['commit', '-qm', 'New base']);
  const right = candidate('New-base outcome', path => write(path, 'b.ts', 'export const b = 2;\n'));
  const before = readWorkBytes(join(work.store.directory, 'work.json'));
  const result = await compare(left.view, right.view);
  assert.equal(result.differentBases, true);
  assert.notEqual(result.left.base, result.right.base);
  assert.equal(result.left.changedPathCount, 1);
  assert.equal(result.right.changedPathCount, 1);
  assert.equal(result.commonPathCount, 0);
  assert.equal(result.status, 'observed');
  assert.match(result.coverage, /independence are unknown/);
  assert.deepEqual(result.sharedPaths, []);
  const self = await compare(left.view, left.view);
  assert.equal(self.commonPathCount, 1);
  assert.equal(self.sharedPaths[0].display, 'a.ts');
  assert.deepEqual(readWorkBytes(join(work.store.directory, 'work.json')), before);
});

test('non-UTF-8 and control-character paths match exact bytes, while missing promisor trees are incomplete without fetch or lost decisions', async t => {
  const { root, work, local, candidate, compare } = setup(t);
  const left = candidate('Raw path candidate', path => write(path, 'a.ts', 'left')),
    right = candidate('Other raw candidate', path => write(path, 'a.ts', 'right'));
  const ordinary = left.view;
  const blob = git(root, ['rev-parse', `${left.view.head}:a.ts`]).trim();
  const names = [
    Buffer.from('line\nbreak\t<script>.ts'),
    Buffer.from([0x62, 0x61, 0x64, 0xfe]),
    Buffer.from([0x62, 0x61, 0x64, 0xff]),
  ];
  const tree = execFileSync('git', ['-C', root, 'mktree', '-z'], {
    input: Buffer.concat(
      names.map(name => Buffer.concat([Buffer.from(`100644 blob ${blob}\t`), name, Buffer.from([0])])),
    ),
    encoding: 'utf8',
  }).trim();
  const raw = git(root, ['commit-tree', tree, '-p', left.view.base, '-m', 'Original byte paths']).trim();
  git(left.path, ['update-ref', 'HEAD', raw]);
  git(right.path, ['update-ref', 'HEAD', raw]);
  left.view = local({
    action: 'compose',
    intentId: left.intent.id,
    inputs: [{ laneId: left.lane.id, head: raw }],
  });
  right.view = local({
    action: 'compose',
    intentId: right.intent.id,
    inputs: [{ laneId: right.lane.id, head: raw }],
  });
  const result = await compare(left.view, right.view);
  assert.equal(result.commonPathCount, 5);
  for (const name of names)
    assert(result.sharedPaths.some(path => Buffer.from(path.rawBase64, 'base64').equals(name)));
  const replacements = result.sharedPaths.filter(path => path.displayEncoding.includes('replacement'));
  assert.equal(replacements.length, 2);
  assert.equal(replacements[0].display, replacements[1].display);
  assert.notEqual(replacements[0].rawBase64, replacements[1].rawBase64);
  const treePath = join(root, '.git/objects', tree.slice(0, 2), tree.slice(2)),
    held = `${treePath}.held`;
  renameSync(treePath, held);
  const marker = join(root, 'remote-called'),
    helper = join(root, 'git-remote-forge-interaction-test');
  writeFileSync(helper, `#!/bin/sh\n: > '${marker}'\nexit 1\n`, { mode: 0o700 });
  git(root, ['config', 'extensions.partialClone', 'origin']);
  git(root, ['config', 'remote.origin.promisor', 'true']);
  git(root, ['config', 'remote.origin.url', 'forge-interaction-test::untrusted']);
  const previous = process.env.PATH;
  process.env.PATH = `${root}:${previous}`;
  try {
    assert.throws(() => git(root, ['cat-file', '-e', tree]));
    assert.equal(existsSync(marker), true);
    unlinkSync(marker);
    const before = readWorkBytes(join(work.store.directory, 'work.json'));
    const missing = await compare(left.view, right.view);
    assert.equal(missing.status, 'incomplete');
    assert.equal(missing.commonPathCount, null);
    assert.equal(missing.left.changedPathCount, null);
    assert.equal(missing.left.diagnostic.code, 'WORK_GIT_FAILED');
    assert.equal(existsSync(marker), false);
    assert.deepEqual(readWorkBytes(join(work.store.directory, 'work.json')), before);
    const partial = await compare(ordinary, right.view);
    assert.equal(partial.left.changedPathCount, 1);
    assert.equal(partial.right.changedPathCount, null);
    assert.equal(partial.commonPathCount, null);
    const note = local({
      action: 'note',
      intentId: left.intent.id,
      text: 'Keep work usable while source is unavailable.',
      kind: 'decision',
    });
    assert.equal(note.notes.length, 1);
  } finally {
    process.env.PATH = previous;
    renameSync(held, treePath);
  }
});
