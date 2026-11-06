// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { classifyConflict, classifyConflictFile } from '../scripts/conflict-classify.mjs';

// Synthetic replay of the conflict shapes seen in dogfood landings. No private source.
const lines = (...rows) => rows.join('\n') + '\n';
const cls = (path, base, left, right) => classifyConflictFile(path, base, left, right);

const tests = lines("import test from 'node:test';", "test('one', () => {});", "test('two', () => {});");

test('both sides append a different test at the end of a test file: different-declaration', () => {
  const left = tests + "test('left', () => {});\n";
  const right = tests + "test('right', () => {});\n";
  assert.deepEqual(cls('a.test.mjs', tests, left, right), { cls: 'different-declaration', flags: [] });
});

test('adjacent import lines for different modules only: import-block-only', () => {
  const base = lines("import a from 'a';", 'export const x = 1;');
  const left = lines("import a from 'a';", "import b from 'b';", 'export const x = 1;');
  const right = lines("import a from 'a';", "import c from 'c';", 'export const x = 1;');
  assert.deepEqual(cls('x.ts', base, left, right), { cls: 'import-block-only', flags: [] });
});

test('imports plus a different declaration each side: different-declaration, flagged plus-imports', () => {
  const base = lines(
    "import a from 'a';",
    'export function f() { return 1; }',
    'export function g() { return 2; }',
  );
  const left = lines(
    "import a from 'a';",
    "import b from 'b';",
    'export function f() { return b; }',
    'export function g() { return 2; }',
  );
  const right = lines(
    "import a from 'a';",
    'export function f() { return 1; }',
    'export function g() { return 3; }',
  );
  assert.deepEqual(cls('x.ts', base, left, right), { cls: 'different-declaration', flags: ['plus-imports'] });
});

test('the same import edited differently is flagged, not hidden', () => {
  const base = lines("import { a } from 'm';", 'export const x = 1;');
  const left = lines("import { a, b } from 'm';", 'export const x = 1;');
  const right = lines("import { a, c } from 'm';", 'export const x = 1;');
  assert.deepEqual(cls('x.ts', base, left, right), {
    cls: 'import-block-only',
    flags: ['same-import-edited'],
  });
});

test('the same declaration edited on both sides is same-declaration, even if disjoint lines', () => {
  const base = lines('export function f() {', '  const a = 1;', '  const b = 2;', '  return a + b;', '}');
  const left = base.replace('const a = 1', 'const a = 10');
  const right = base.replace('const b = 2', 'const b = 20');
  assert.equal(cls('x.ts', base, left, right).cls, 'same-declaration');
});

test('the same top-level name added twice (a const declared by both Lanes) is same-declaration', () => {
  const base = lines('export function f() { return 1; }');
  const left = base + "const root = 'a';\n";
  const right = base + "const root = 'b';\n";
  assert.equal(cls('x.mjs', base, left, right).cls, 'same-declaration');
});

test('different members of one class are same-declaration with the nested-disjoint hint', () => {
  const base = lines('class C {', '  one() { return 1; }', '  two() { return 2; }', '}');
  const left = base.replace('return 1', 'return 10');
  const right = base.replace('return 2', 'return 20');
  assert.deepEqual(cls('x.ts', base, left, right), { cls: 'same-declaration', flags: ['nested-disjoint'] });
});

test('two edits of one member are not nested-disjoint', () => {
  const base = lines('class C {', '  one() { return 1; }', '}');
  const left = base.replace('return 1', 'return 10');
  const right = base.replace('return 1', 'return 11');
  assert.deepEqual(cls('x.ts', base, left, right), { cls: 'same-declaration', flags: [] });
});

test('unnamed statements are flagged weak so identical-position edits are never trusted', () => {
  const base = lines('run(1);', 'export const x = 1;');
  const left = lines('run(2);', 'export const x = 1;');
  const right = lines('run(1);', 'export const x = 2;');
  assert.deepEqual(cls('x.ts', base, left, right), {
    cls: 'different-declaration',
    flags: ['weak-identity'],
  });
});

test('shapes a declaration merge cannot decide stay other', () => {
  assert.deepEqual(cls('a.ts', null, 'export const a = 1;', 'export const a = 2;'), {
    cls: 'other',
    why: 'add-add',
    flags: [],
  });
  assert.equal(cls('a.ts', 'export const a = 1;', null, 'export const a = 2;').why, 'delete-vs-edit');
  assert.equal(cls('a.md', '# a', '# b', '# c').why, 'non-js');
  assert.equal(
    cls('a.ts', 'export const a = 1;', 'export const a = ;', 'export const a = 2;').why,
    'unparseable-side',
  );
  assert.equal(
    cls(
      'a.ts',
      lines('// one', 'export const a = 1;'),
      lines('// two', 'export const a = 1;'),
      lines('// three', 'export const a = 1;'),
    ).cls,
    'same-declaration',
    'a comment above a declaration belongs to that declaration',
  );
});

test('a conflict is as hard as its hardest file', () => {
  const same = { cls: 'same-declaration' };
  const other = { cls: 'other' };
  const different = { cls: 'different-declaration' };
  const imports = { cls: 'import-block-only' };
  assert.equal(classifyConflict([imports, different, same]), 'same-declaration');
  assert.equal(classifyConflict([imports, different, other]), 'other');
  assert.equal(classifyConflict([imports, different]), 'different-declaration');
  assert.equal(classifyConflict([imports, imports]), 'import-block-only');
});
