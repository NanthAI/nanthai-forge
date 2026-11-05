// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { build } from 'esbuild';
import { fixture } from './helpers.mjs';
import { checkConvexBundles } from '../scripts/check-convex-bundle.mjs';

for (const loader of [
  "import { createRequire as load } from 'node:module'; const parser = load(import.meta.url); export const run = () => parser('typescript');",
  "import * as modules from 'node:module'; export const run = () => modules.createRequire(import.meta.url)('typescript');",
  'export const run = name => import(name);',
  'export const run = name => require(name);',
])
  test('bundle guard rejects a hidden lazy runtime dependency: ' + loader.slice(0, 45), async t => {
    const root = fixture(t, {
      'convex/task.ts': "'use node'; export { run } from '../src/parser';",
      'src/parser.ts': loader,
    });
    await assert.rejects(checkConvexBundles(root), /CONVEX_BUNDLE_(RUNTIME_LOADER|DYNAMIC_IMPORT)/);
  });

test('bundle guard resolves static dependencies and builtins in isolation, and rejects a missing package', async t => {
  const root = fixture(t, {
    'convex/task.ts':
      "'use node'; import { basename } from 'node:path'; import { value } from '../src/parser'; export const run = () => basename(value);",
    'src/parser.ts': "export const value = 'synthetic';",
  });
  assert.equal((await checkConvexBundles(root)).entries, 1);
  const missing = fixture(t, { 'convex/task.ts': "export { parser } from 'not-a-real-parser-package';" });
  await assert.rejects(checkConvexBundles(missing), /Could not resolve/);
});

test('isolated source task bundles reconcile identical imports without local node_modules', async t => {
  const out = mkdtempSync(join(tmpdir(), 'forge-test-source-parser-'));
  t.after(() => rmSync(out, { recursive: true, force: true }));
  const file = join(out, 'task.mjs');
  await build({
    entryPoints: ['src/hosted-source-fanout.ts'],
    bundle: true,
    platform: 'node',
    format: 'esm',
    outfile: file,
    logLevel: 'silent',
  });
  const { runSourceTask } = await import(pathToFileURL(file));
  const { digest } = await import('../dist/hash.js');
  const base = 'export const a = 1;\nexport const b = 2;\n';
  const added = "import { value } from './value';\n";
  const bodies = [base, added + base, base + added].map(s => Buffer.from(s));
  const refs = bodies.map(bytes => ({ object: { sha256: digest(bytes), size: bytes.length }, recipe: null }));
  const native = index => ({ path: 'file.ts', mode: 'file', blob: refs[index].object.sha256 });
  const request = {
    key: 'synthetic',
    kind: 'merge',
    item: { path: 'file.ts', base: native(0), left: native(1), right: native(2) },
    order: 'left-first',
    channel: 'main',
  };
  let reads = 0,
    writes = 0,
    merged;
  const result = await runSourceTask({ kind: 'calculate', refs, requests: [request] }, null, {
    prepareRead: async pins => assert.equal(pins.length, 3),
    read: async pin => {
      reads++;
      return (async function* () {
        yield bodies[refs.findIndex(r => r.object.sha256 === pin.sha256)];
      })();
    },
    upload: async (_pin, chunks) => {
      writes++;
      const parts = [];
      for await (const part of chunks) parts.push(part);
      merged = Buffer.concat(parts).toString();
    },
  });
  assert.equal(result.done, true);
  assert.equal(merged, added + base);
  assert.equal(reads, 3);
  assert.equal(writes, 1);
});

test('registered roots include aliases, wrappers and nested deployed functions', async t => {
  const root = fixture(t, {
    'convex/nested/task.ts': "import { run as work } from '../../src/parser'; export { work };",
    'src/parser.ts': 'export const run = () => 1; run.isAction = true;',
  });
  assert.equal((await checkConvexBundles(root, { registeredOnly: true })).entries, 1);
});
