// SPDX-License-Identifier: Apache-2.0
import assert from 'node:assert/strict';
import test from 'node:test';
import ts from 'typescript';
import { directoryDependency } from '../scripts/test-directory-path.mjs';

function dependencies(text) {
  const ast = ts.createSourceFile(
    'fixture.mjs',
    `import {resolve,join} from 'node:path';\n${text}`,
    ts.ScriptTarget.Latest,
    true,
  );
  assert.equal(ast.parseDiagnostics.length, 0);
  const result = [];
  function visit(node) {
    if (ts.isStringLiteralLike(node) && node.text === 'dist') result.push(directoryDependency(node, ast));
    ts.forEachChild(node, visit);
  }
  visit(ast);
  return result;
}

test('directory membership tables and process-path comparisons are not module reads', () => {
  for (const text of [
    "['dist'].includes(name)",
    "const excluded = new Set(['dist']); excluded.has(name)",
    "const dir = resolve('dist'); const script = join(dir, 'worker.js'); 'worker'.includes(script)",
    "function matches(dir) { const script = ` ${resolve(dir, name)} `; return 'worker'.indexOf(script) > 0; } export function cleanup(dir = resolve('dist')) { matches(dir); }",
    "const dir = resolve('dist'); const alias = dir; value === alias",
    "const dir = resolve('dist'); const alias = dir; value !== alias",
  ])
    assert.deepEqual(dependencies(text), [false], text);
});

test('directory reads follow aliases and local helper arguments', () => {
  for (const text of [
    "readdirSync('dist')",
    "readdirSync(resolve('dist'))",
    "const dir = resolve('dist'); readdirSync(dir)",
    "const dir = resolve('dist'); let alias; alias = dir; readdirSync(alias)",
    "function read(dir) { return readdirSync(dir); } read(resolve('dist'))",
    "function resolve(dir) { return readdirSync(dir); } resolve('dist')",
    "const dir = resolve('dist'); const name = `${dir}/${leaf}`; readFileSync(name)",
    "const dirs = new Set(['dist']); consume(dirs)",
  ])
    assert.deepEqual(dependencies(text), [true], text);
});

test('unknown consumers, escaping values and unsupported uses stay broad', () => {
  for (const text of [
    "unknown('dist')",
    "export const directory = resolve('dist');",
    "import {Set} from 'external'; const dirs = new Set(['dist']); dirs.has(name);",
    "const object = 'safe'; object = unknown; object.includes('dist');",
    "const dir = resolve('dist'); unknown.includes(dir)",
    "const dir = resolve('dist'); unknown(dir)",
    "export function path() { return resolve('dist'); }",
    "const dir = resolve('dist'); const value = { dir };",
    "const dir = resolve('dist'); for (const x of dir) consume(x)",
    "const { dir } = { dir: 'dist' };",
    "const dir = resolve('dist'); dir && consume(dir)",
  ])
    assert.deepEqual(dependencies(text), [true], text);
});
