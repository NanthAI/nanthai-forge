// SPDX-License-Identifier: Apache-2.0
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtempSync, mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { pathToFileURL } from 'node:url';
import { promisify } from 'node:util';

const run = promisify(execFile);
const loader = new URL('./convex-module.mjs', import.meta.url).href;

function workspace(t) {
  const root = mkdtempSync(join(tmpdir(), 'forge-module-cache-'));
  t.after(() => rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }));
  const cache = join(root, 'cache');
  const src = join(root, 'sources');
  mkdirSync(src);
  writeFileSync(join(src, 'leaf.ts'), 'export const leaf: number = 1;\n');
  writeFileSync(
    join(src, 'top.ts'),
    "import { leaf } from './leaf';\nexport const top: number = leaf + 1;\n",
  );
  return { cache, src, top: pathToFileURL(join(src, 'top.ts')) };
}

async function load(cache, top) {
  const script = `import { moduleUrl } from ${JSON.stringify(loader)};
const url = moduleUrl(new URL(process.argv[1]));
console.log(JSON.stringify({ url, top: (await import(url)).top }));`;
  const { stdout } = await run(process.execPath, ['--input-type=module', '-e', script, top.href], {
    env: { ...process.env, FORGE_TEST_MODULE_DIRECTORY: cache, FORGE_TEST_PRECOMPILED: '0' },
  });
  return JSON.parse(stdout);
}

test('compiled modules are content addressed: reused when unchanged, rekeyed by any transitive edit', async t => {
  const { cache, src, top } = workspace(t);
  const first = await load(cache, top);
  assert.equal(first.top, 2);
  const files = readdirSync(cache);
  assert.equal(files.length, 2);
  assert.deepEqual(await load(cache, top), first);
  assert.deepEqual(readdirSync(cache), files, 'a warm load writes nothing');
  writeFileSync(join(src, 'leaf.ts'), 'export const leaf: number = 41;\n');
  const edited = await load(cache, top);
  assert.equal(edited.top, 42, 'a dependency edit is never served from the old output');
  assert.notEqual(edited.url, first.url);
  assert.equal(readdirSync(cache).length, 4);
});

test('parallel cold processes share one cache without partial or temporary files', async t => {
  const { cache, top } = workspace(t);
  const results = await Promise.all(Array.from({ length: 6 }, () => load(cache, top)));
  assert.ok(results.every(result => result.top === 2 && result.url === results[0].url));
  const names = readdirSync(cache);
  assert.equal(names.length, 2);
  assert.ok(
    names.every(name => /^[a-f0-9]{64}\.mjs$/.test(name)),
    names.join(),
  );
});
