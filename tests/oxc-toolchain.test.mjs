// SPDX-License-Identifier: Apache-2.0
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import test from 'node:test';
import { oxcFiles } from '../scripts/oxc.mjs';

const rules = {
  'no-var': 'export var value = 1;',
  'prefer-const': 'let value = 1; console.log(value);',
  'prefer-rest-params': 'export function value() { return arguments; }',
  'prefer-spread': 'const args = [1, 2]; export const value = Math.max.apply(Math, args);',
  'ban-ts-comment': '// @ts-ignore\nexport const value = 1;',
  'no-array-constructor': 'export const value = new Array(1, 2);',
  'no-duplicate-enum-values': 'export enum Value { A = 1, B = 1 }',
  'no-empty-object-type': 'export type Value = {};',
  'no-explicit-any': 'export const value: any = 1;',
  'no-extra-non-null-assertion': 'export const value = (null as string | null)!!;',
  'no-misused-new': 'export interface Value { new(): Value; }',
  'no-namespace': 'export namespace Value { export const item = 1; }',
  'no-non-null-asserted-optional-chain': 'export const value = (null as { x: number } | null)?.x!;',
  'no-require-imports': "export const value = require('node:fs');",
  'no-this-alias': 'export function value() { const self = this; return self; }',
  'no-unnecessary-type-constraint': 'export function value<T extends any>(item: T) { return item; }',
  'no-unsafe-declaration-merging': 'export interface Value { item: string; } export class Value {}',
  'no-unsafe-function-type': 'export type Value = Function;',
  'no-unused-expressions': 'export const value = 1; value;',
  'no-unused-vars': 'export function value() { try {} catch (error) {} }',
  'no-wrapper-object-types': 'export type Value = String;',
  'prefer-as-const': "export const value = 'value' as 'value';",
  'prefer-namespace-keyword': 'export module Value { export const item = 1; }',
  'triple-slash-reference': '/// <reference path="./value.ts" />\nexport const value = 1;',
};

function fixture(t) {
  const owner = mkdtempSync(join(tmpdir(), 'forge-oxc-'));
  t.after(() => rmSync(owner, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }));
  writeFileSync(join(owner, '.gitignore'), '.forge/\n');
  const root = join(owner, '.forge/work/lane');
  mkdirSync(root, { recursive: true });
  for (const path of ['.gitignore', '.oxlintrc.json', '.oxfmtrc.json'])
    writeFileSync(join(root, path), readFileSync(path));
  const write = (path, text) => {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), text);
  };
  for (const path of ['src/value.ts', 'web/src/value.tsx', 'convex/value.ts', 'netlify/functions/value.mts'])
    write(path, 'export const value = 1;\n');
  return { root, write };
}
const run = (root, tool, args) => {
  const result = spawnSync(process.execPath, [resolve(`node_modules/${tool}/bin/${tool}`), ...args], {
    cwd: root,
    encoding: 'utf8',
  });
  assert.equal(result.error, undefined);
  return result;
};

test('Oxc selects source explicitly inside ignored native Lanes and preserves exclusions', t => {
  const { root, write } = fixture(t);
  for (const path of [
    'scripts/value.mjs',
    'tests/value.test.mjs',
    'tests/fixtures/value.ts',
    'convex/_generated/value.ts',
    'dist/value.js',
    'node_modules/value/index.js',
    'evals/value.mjs',
    'private-artifacts/value.ts',
    'docs/value.ts',
    'README.md',
  ])
    write(path, 'preserve exact bytes');
  const sources = ['convex/value.ts', 'netlify/functions/value.mts', 'src/value.ts', 'web/src/value.tsx'];
  assert.deepEqual(oxcFiles(root, true), sources);
  assert.deepEqual(oxcFiles(root, false), [...sources, 'scripts/value.mjs', 'tests/value.test.mjs'].sort());
  const result = run(root, 'oxlint', ['--threads', '2', '--debug', 'files', ...oxcFiles(root, true)]);
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.deepEqual(result.stdout.trim().split('\n').sort(), sources);
});

test('Oxlint rejects every mapped ESLint rule, including compiler unused-check gaps', t => {
  const { root, write } = fixture(t);
  for (const [rule, text] of Object.entries(rules)) write(`src/${rule}.ts`, text);
  write('src/type-only-use.ts', 'const value = 1; export type Value = typeof value;');
  const result = run(root, 'oxlint', ['--threads', '2', '--format', 'json', ...oxcFiles(root, true)]);
  assert.equal(result.status, 1, result.stdout + result.stderr);
  const diagnostics = JSON.parse(result.stdout).diagnostics;
  for (const rule of Object.keys(rules))
    assert.ok(
      diagnostics.some(d => d.filename === `src/${rule}.ts` && d.code.endsWith(`(${rule})`)),
      rule,
    );
  assert.ok(
    diagnostics.some(d => d.filename === 'src/type-only-use.ts' && d.code.endsWith('(no-unused-vars)')),
  );
});

test('Oxlint accepts used destructured parameters, underscore parameters and described suppressions', t => {
  const { root, write } = fixture(t);
  write(
    'src/allowed.ts',
    [
      'export function value({ item }: { item: number }, _unused: number) { void item; }',
      '// @ts-expect-error: synthetic mismatch for this fixture',
      'export const wrong: string = 1;',
      '// eslint-disable-next-line @typescript-eslint/no-explicit-any',
      'export const allowed: any = 1;',
    ].join('\n'),
  );
  const result = run(root, 'oxlint', ['--threads', '2', ...oxcFiles(root, true)]);
  assert.equal(result.status, 0, result.stdout + result.stderr);
});

test('Oxfmt detects, writes and rechecks source while preserving prose and generated bytes', t => {
  const { root, write } = fixture(t);
  write('src/value.ts', 'export const value={x:"value"}\n');
  write('README.md', '  preserve   prose');
  write('convex/_generated/value.ts', '  preserve   generated');
  const files = oxcFiles(root, false);
  assert.equal(run(root, 'oxfmt', ['--threads', '2', '--check', ...files]).status, 1);
  assert.equal(run(root, 'oxfmt', ['--threads', '2', '--write', ...files]).status, 0);
  assert.equal(readFileSync(join(root, 'src/value.ts'), 'utf8'), "export const value = { x: 'value' };\n");
  assert.equal(run(root, 'oxfmt', ['--threads', '2', '--check', ...files]).status, 0);
  assert.equal(readFileSync(join(root, 'README.md'), 'utf8'), '  preserve   prose');
  assert.equal(readFileSync(join(root, 'convex/_generated/value.ts'), 'utf8'), '  preserve   generated');
});
