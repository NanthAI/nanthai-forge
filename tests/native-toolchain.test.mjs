// SPDX-License-Identifier: Apache-2.0
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';

const compilers = ['@typescript/native', 'typescript'].map(name =>
  resolve('node_modules', name, 'bin', 'tsc'),
);
function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'forge-native-toolchain-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  writeFileSync(join(root, 'package.json'), '{"type":"module"}');
  return root;
}
function compile(root, compiler, args) {
  const result = spawnSync(process.execPath, [compiler, ...args, '--pretty', 'false'], {
    cwd: root,
    env: { ...process.env, GOMAXPROCS: '2' },
    encoding: 'utf8',
  });
  assert.equal(result.error, undefined);
  return result;
}
const options = {
  target: 'ES2022',
  module: 'NodeNext',
  moduleResolution: 'NodeNext',
  strict: true,
  types: [],
  skipLibCheck: true,
  declaration: true,
  noUncheckedSideEffectImports: false,
};

test('Convex deployment config typechecks after core build with native and tsc 5', () => {
  // Standard verification builds core before tests. Use the real deployment config
  // without npm's compatibility flags, just as the Convex CLI invokes its compiler.
  readFileSync('dist/index.d.ts');
  for (const compiler of compilers) {
    const result = compile(resolve('.'), compiler, ['-p', 'convex/tsconfig.json', '--noEmit']);
    assert.equal(result.status, 0, result.stdout + result.stderr);
  }
});

test('native compiler and tsc fallback detect assignment, argument and property errors', t => {
  const root = fixture(t);
  writeFileSync(
    join(root, 'tsconfig.json'),
    JSON.stringify({ compilerOptions: options, files: ['probe.ts'] }),
  );
  writeFileSync(
    join(root, 'probe.ts'),
    [
      "import './unresolved-side-effect.js';",
      'export const value: string = 1;',
      'function takesNumber(value: number) { return value; }',
      "export const result = takesNumber('wrong');",
      'export const property = value.missing;',
    ].join('\n'),
  );
  for (const compiler of compilers) {
    const result = compile(root, compiler, ['--noEmit']);
    assert.notEqual(result.status, 0, result.stdout + result.stderr);
    assert.deepEqual([...result.stdout.matchAll(/error TS(\d+):/g)].map(m => m[1]).sort(), [
      '2322',
      '2339',
      '2345',
    ]);
  }
});

test('native emit preserves package declarations, shebang and ES2022 class fields', t => {
  const root = fixture(t);
  writeFileSync(
    join(root, 'tsconfig.json'),
    JSON.stringify({ compilerOptions: { ...options, outDir: 'dist' }, files: ['probe.ts'] }),
  );
  writeFileSync(
    join(root, 'probe.ts'),
    [
      '#!/usr/bin/env node',
      'export class Box { empty!: number; constructor(public value: number) {} }',
      'const box = new Box(7);',
      "if (!Object.hasOwn(box, 'empty') || box.value !== 7) throw new Error('class fields');",
    ].join('\n'),
  );
  const declarations = [];
  for (const compiler of compilers) {
    const result = compile(root, compiler, []);
    assert.equal(result.status, 0, result.stdout + result.stderr);
    const js = readFileSync(join(root, 'dist/probe.js'), 'utf8');
    assert.ok(js.startsWith('#!/usr/bin/env node\n'));
    declarations.push(readFileSync(join(root, 'dist/probe.d.ts'), 'utf8').replace(/\s+/g, ''));
    const runtime = spawnSync(process.execPath, ['dist/probe.js'], { cwd: root, encoding: 'utf8' });
    assert.equal(runtime.status, 0, runtime.stderr);
  }
  assert.equal(declarations[0], declarations[1]);
});

test('native compiler and fallback build project references and reject a broken consumer', t => {
  const root = fixture(t);
  for (const name of ['library', 'app']) mkdirSync(join(root, name));
  const composite = { ...options, composite: true, rootDir: '.', outDir: 'dist' };
  writeFileSync(
    join(root, 'tsconfig.json'),
    JSON.stringify({ files: [], references: [{ path: 'library' }, { path: 'app' }] }),
  );
  writeFileSync(
    join(root, 'library/tsconfig.json'),
    JSON.stringify({ compilerOptions: composite, files: ['index.ts'] }),
  );
  writeFileSync(
    join(root, 'app/tsconfig.json'),
    JSON.stringify({ compilerOptions: composite, files: ['index.ts'], references: [{ path: '../library' }] }),
  );
  writeFileSync(join(root, 'library/index.ts'), 'export const value: number = 42;');
  for (const compiler of compilers) {
    assert.equal(compile(root, compiler, ['-b', '--clean']).status, 0);
    writeFileSync(
      join(root, 'app/index.ts'),
      'import { value } from "../library/index.js"; export const result: number = value;',
    );
    const built = compile(root, compiler, ['-b']);
    assert.equal(built.status, 0, built.stdout + built.stderr);
    assert.equal(compile(root, compiler, ['-b']).status, 0);
    writeFileSync(
      join(root, 'app/index.ts'),
      'import { value } from "../library/index.js"; export const result: string = value;',
    );
    const broken = compile(root, compiler, ['-b']);
    assert.notEqual(broken.status, 0);
    assert.match(broken.stdout, /TS2322/);
  }
});

test('compiler unused checks cover all projects and permit underscore parameters', t => {
  for (const path of [
    'tsconfig.json',
    'web/tsconfig.json',
    'convex/tsconfig.json',
    'netlify/tsconfig.json',
  ]) {
    const config = JSON.parse(readFileSync(path, 'utf8'));
    assert.equal(config.compilerOptions.noUnusedLocals, true, path);
    assert.equal(config.compilerOptions.noUnusedParameters, true, path);
  }
  const root = fixture(t);
  writeFileSync(
    join(root, 'tsconfig.json'),
    JSON.stringify({
      compilerOptions: { ...options, noUnusedLocals: true, noUnusedParameters: true },
      files: ['probe.ts'],
    }),
  );
  for (const compiler of compilers) {
    writeFileSync(
      join(root, 'probe.ts'),
      ['const unusedLocal = 1;', 'export function value(unusedParameter: number) { return 1; }'].join('\n'),
    );
    const bad = compile(root, compiler, ['--noEmit']);
    assert.notEqual(bad.status, 0, bad.stdout + bad.stderr);
    assert.equal([...bad.stdout.matchAll(/error TS6133:/g)].length, 2, bad.stdout);
    writeFileSync(
      join(root, 'probe.ts'),
      'export function value({ item }: { item: number }, _unused: number) { void item; }',
    );
    const good = compile(root, compiler, ['--noEmit']);
    assert.equal(good.status, 0, good.stdout + good.stderr);
  }
});
