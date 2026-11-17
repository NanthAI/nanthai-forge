// SPDX-License-Identifier: Apache-2.0
// Item 52235fbf: a change is read in the order of what needs eyes, and every file's reason is a fact Forge observed
// (a conflict, a protected-path rule, a mode, a status, a path), never a risk score. The web review screen and the
// agent's diff summary share this order, so the same facts give the same group and words on both.
import test from 'node:test';
import assert from 'node:assert/strict';
import { moduleUrl } from './convex-module.mjs';

const { reviewOrder, reviewEntry, reviewCounts } = await import(moduleUrl('../src/review-order.ts'));

test('conflicts, then protected paths, then code read first; tests next; docs, fixtures and binaries last', () => {
  const order = reviewOrder([
    { path: 'docs/parser.md', status: 'modified', doc: true },
    { path: 'tests/fixtures/split-utf8.bin', status: 'added' },
    { path: 'tests/stream-parser.test.ts', status: 'modified' },
    { path: 'src/parser/index.ts', status: 'modified' },
    { path: 'src/parser/utf8-carry.ts', status: 'added' },
    { path: 'package.json', status: 'modified', protected: true },
    {
      path: 'src/parser/stream-parser.ts',
      status: 'modified',
      crossing: [{ with: 'mara/salt-wren', lines: '22-31' }],
    },
    { path: 'assets/logo.png', status: 'modified' },
  ]);
  assert.deepEqual(
    order.map(entry => [entry.path, entry.group, entry.reason]),
    [
      ['src/parser/stream-parser.ts', 'eyes', 'same lines as mara/salt-wren, 22-31'],
      ['package.json', 'eyes', 'a protected path'],
      ['src/parser/utf8-carry.ts', 'eyes', 'new file'],
      ['src/parser/index.ts', 'eyes', 'code changed'],
      ['tests/stream-parser.test.ts', 'tests', 'test changed'],
      ['docs/parser.md', 'low', 'docs only'],
      ['tests/fixtures/split-utf8.bin', 'low', 'a test fixture'],
      ['assets/logo.png', 'low', 'binary'],
    ],
  );
  assert.deepEqual(reviewCounts(order), { eyes: 4, tests: 1, low: 3 });
});

test('a conflict with main and a mode change are named as what was seen', () => {
  assert.equal(
    reviewEntry({ path: 'a.ts', status: 'modified', crossing: [{ with: 'main', lines: '4' }] }).reason,
    'conflicts with main at 4',
  );
  assert.equal(
    reviewEntry({ path: 'run.sh', status: 'modified', before: 'file', after: 'executable' }).reason,
    'now executable',
  );
  assert.equal(
    reviewEntry({ path: 'vendor/lib', status: 'modified', before: 'gitlink', after: 'gitlink' }).reason,
    'a submodule pointer',
  );
  // A protected test is still a protected path: the rule, not the file kind, decides it needs eyes.
  assert.equal(reviewEntry({ path: 'tests/a.test.ts', status: 'modified', protected: true }).group, 'eyes');
});

test('no reason is a score or a guess', () => {
  const words = reviewOrder(
    ['a.ts', 'b.md', 'c.test.ts', 'd.png', 'fixtures/e.json'].flatMap(path =>
      ['added', 'deleted', 'modified'].map(status => ({ path, status, doc: path.endsWith('.md') })),
    ),
  ).map(entry => entry.reason);
  for (const word of words) assert.doesNotMatch(word, /risk|score|likely|probably|\d+%/i, word);
});
