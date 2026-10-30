import test from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync } from 'node:fs';
import { fixture, write } from './helpers.mjs';
import { findRuntimeViolations, nodeGlobalUse } from '../scripts/check-convex-runtime.mjs';

// A Convex module without "use node" is bundled for V8 on deploy, where node: builtins do not resolve.
test('no Convex V8 module reaches a node: builtin through src', async () => {
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
