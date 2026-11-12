// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync } from 'node:fs';
import { fixture, write } from './helpers.mjs';
import { findRuntimeViolations, nodeGlobalUse } from '../scripts/check-convex-runtime.mjs';

// A Convex module without "use node" is bundled for V8 on deploy, where node: builtins do not resolve.
test('no Convex V8 module reaches a builtin, Node global or dynamic import', async () => {
  const modules = readdirSync(new URL('../convex', import.meta.url)).filter(name => name.endsWith('.ts'));
  assert.ok(modules.length > 100);
  assert.deepEqual(await findRuntimeViolations(new URL('..', import.meta.url).pathname), []);
});

test('guard reports the chain from a V8 module to a builtin and spares node actions and types', async t => {
  const root = fixture(t, {
    'src/portable.ts': 'export const pure = 1;',
    'src/disk.ts': "import { readFileSync } from 'node:fs'; export const disk = () => readFileSync;",
    'src/disk-types.ts': "import type { Stats } from 'node:fs'; export type Disk = Stats;",
    'src/indirect.ts': "import { disk } from './disk.js'; export const indirect = disk;",
    'convex/clean.ts':
      "import { pure } from '../src/portable'; import type { Disk } from '../src/disk-types'; export const a = pure as unknown as Disk;",
    'convex/bad.ts': "import { indirect } from '../src/indirect'; export const b = indirect;",
    'convex/action.ts': "'use node';\nimport { disk } from '../src/disk'; export const c = disk;",
  });
  assert.deepEqual(await findRuntimeViolations(root), [
    { module: 'convex/bad.ts', chain: ['convex/bad.ts', 'src/indirect.ts', 'src/disk.ts', 'node:fs'] },
  ]);
});

// 2026-10-30: Buffer.byteLength in a V8 result path 403d every hosted check; globals need no import.
test('guard reports Node globals reached from a V8 module and ignores comments and types', async t => {
  assert.equal(nodeGlobalUse('// Buffer.from(x)\n/** Buffer.concat(y) */ const b: Buffer = x;'), null);
  assert.equal(nodeGlobalUse('const n = Buffer.byteLength(s);'), 'Buffer');
  const root = fixture(t, {
    'src/size.ts': 'export const size = (s: string) => Buffer.byteLength(s);',
    'convex/sized.ts': "import { size } from '../src/size'; export const d = size;",
    'convex/action.ts': "'use node';\nimport { size } from '../src/size'; export const e = size;",
  });
  assert.deepEqual(await findRuntimeViolations(root), [
    { module: 'convex/sized.ts', chain: ['convex/sized.ts', 'src/size.ts', 'global Buffer'] },
  ]);
});

// A literal lazy import bundled and passed Node fixtures, then failed the live V8 pack.
test('guard rejects literal, computed and unreachable dynamic imports in every V8 source path', async t => {
  for (const expression of ["import('./portable')", 'import(name)', 'import(`./${name}`)']) {
    const root = fixture(t, {
      'src/portable.ts': 'export const value = 1;',
      'src/lazy.ts': `export const load = (name: string) => false ? ${expression} : null;`,
      'convex/nested/pack.ts': "export { load } from '../../src/lazy';",
      'convex/direct.ts': `export const run = () => ${expression.replace('./portable', '../src/portable')};`,
    });
    const violations = await findRuntimeViolations(root);
    assert.equal(violations.length, 2);
    assert(violations.every(item => item.chain.at(-1).startsWith('dynamic import ')));
    assert.deepEqual(violations.find(item => item.module === 'convex/nested/pack.ts').chain.slice(0, -1), [
      'convex/nested/pack.ts',
      'src/lazy.ts',
    ]);
  }
});

test('Node-only lazy loaders stay allowed until a V8 root reaches them; import types and text stay allowed', async t => {
  const root = fixture(t, {
    'src/portable.ts': 'export type Value = string; export const value = 1;',
    'src/lazy.ts': "export const load = () => import('./portable');",
    'convex/task.ts': "/* Node action */ 'use node'; export { load } from '../src/lazy';",
    'convex/clean.ts': `export type Value = import('../src/portable').Value;
      // import('./missing')
      export const text = "import('./missing')";`,
  });
  assert.deepEqual(await findRuntimeViolations(root), []);
  write(root, 'convex/shared.ts', "export { load } from '../src/lazy';");
  assert.deepEqual(await findRuntimeViolations(root), [
    {
      module: 'convex/shared.ts',
      chain: ['convex/shared.ts', 'src/lazy.ts', "dynamic import './portable'"],
    },
  ]);
  write(root, 'convex/shared.ts', "export { load } from './task';");
  assert.deepEqual(await findRuntimeViolations(root), [
    {
      module: 'convex/shared.ts',
      chain: ['convex/shared.ts', 'convex/task.ts', 'src/lazy.ts', "dynamic import './portable'"],
    },
  ]);
});
