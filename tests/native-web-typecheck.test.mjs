// SPDX-License-Identifier: Apache-2.0
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { cpSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';
import { prepareConvexApi } from '../scripts/prepare-convex-api.mjs';

// A real source copy preserves JSX, Convex generics and cross-scope imports.
// The seeded errors never touch the checkout or shared dependencies.
// Each compiler keeps its own incremental state in the copy, so the seeded pass re-checks only the
// probe file and what it affects instead of the whole web project again. Diagnostics are the same.
test('web native and fallback diagnostics agree on clean source and seeded strict/JSX errors', t => {
  const root = mkdtempSync(join(tmpdir(), 'forge-native-web-'));
  t.after(() => rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }));
  for (const path of [
    'src',
    'scripts',
    'web/src',
    'web/tsconfig.json',
    'convex',
    'package.json',
    'tsconfig.json',
  ])
    cpSync(path, join(root, path), { recursive: true });
  symlinkSync(realpathSync('node_modules'), join(root, 'node_modules'), 'dir');
  prepareConvexApi(root);
  const compile = native => {
    const result = spawnSync(
      process.execPath,
      [
        resolve('node_modules', native ? '@typescript/native' : 'typescript', 'bin/tsc'),
        ...(native ? ['--noUncheckedSideEffectImports', 'false', '--types', '*'] : []),
        '-p',
        'web/tsconfig.json',
        '--pretty',
        'false',
        '--incremental',
        '--tsBuildInfoFile',
        join(root, native ? 'native.tsbuildinfo' : 'fallback.tsbuildinfo'),
      ],
      { cwd: root, encoding: 'utf8' },
    );
    assert.equal(result.error, undefined);
    assert.equal(result.signal, null);
    return { status: result.status, output: result.stdout + result.stderr };
  };
  for (const native of [false, true]) {
    const result = compile(native);
    assert.equal(result.status, 0, result.output);
  }
  writeFileSync(
    join(root, 'web/src/typecheck-probe.tsx'),
    [
      "import './unresolved-side-effect.js';",
      'export const assigned: string = 1;',
      'function numberOnly(value: number) { return value; }',
      "export const argument = numberOnly('wrong');",
      'export const property = assigned.missing;',
      'export const nullable: string = null;',
      'export const indexed: string = ([] as string[])[0];',
      'const unusedLocal = 1;',
      'export function unused(unusedParameter: number) { return 1; }',
      'export function implicit(value) { return value; }',
      'function Label(props: { count: number }) { return <span>{props.count}</span>; }',
      'export const jsx = <Label count="wrong" />;',
    ].join('\n'),
  );
  const diagnostics = [];
  for (const native of [false, true]) {
    const result = compile(native);
    assert.notEqual(result.status, 0, result.output);
    const errors = [...result.output.matchAll(/^(.+\(\d+,\d+\)): error TS(\d+):/gm)]
      .map(match => `${match[1]} TS${match[2]}`)
      .sort();
    assert.equal(errors.length, 9, result.output);
    assert.deepEqual([...new Set(errors.map(error => error.split(' TS')[1]))].sort(), [
      '2322',
      '2339',
      '2345',
      '6133',
      '7006',
    ]);
    diagnostics.push(errors);
  }
  assert.deepEqual(diagnostics[0], diagnostics[1]);
});
