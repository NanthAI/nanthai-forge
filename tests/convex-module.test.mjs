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

async function load(cache, top, windowsRename = false, mismatched = false) {
  const script = `import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
let collisions = 0;
if (${windowsRename}) {
  const exists = fs.existsSync;
  // Both writers compile even if the other already published: force the race's cold-cache observation.
  fs.existsSync = path => String(path).endsWith('.mjs') ? false : exists(path);
  fs.renameSync = (temp, output) => {
    if (${mismatched}) {
      fs.writeFileSync(output, 'different output');
      throw Object.assign(new Error('locked destination'), { code: 'EPERM' });
    }
    try { fs.linkSync(temp, output); fs.unlinkSync(temp); }
    catch (error) {
      if (error.code !== 'EEXIST') throw error;
      collisions++;
      throw Object.assign(new Error('locked destination'), { code: 'EPERM' });
    }
  };
  syncBuiltinESMExports();
}
const { moduleUrl } = await import(${JSON.stringify(loader)});
const url = moduleUrl(new URL(process.argv[1]));
console.log(JSON.stringify({ url, top: (await import(url)).top, ...(${windowsRename} ? { collisions } : {}) }));`;
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

test('two cache writers survive Windows rename collisions only when the complete output matches', async t => {
  const { cache, top } = workspace(t);
  const results = await Promise.all([load(cache, top, true), load(cache, top, true)]);
  assert(results.every(result => result.top === 2 && result.url === results[0].url));
  assert.equal(
    results.reduce((n, result) => n + result.collisions, 0),
    2,
    'both cache files had a losing publisher',
  );
  const names = readdirSync(cache);
  assert.equal(names.length, 2);
  assert(
    names.every(name => /^[a-f0-9]{64}\.mjs$/.test(name)),
    'no partial or temporary files remain',
  );
});

test('a Windows cache rename error with different destination bytes stays an error and cleans its temp file', async t => {
  const { cache, top } = workspace(t);
  await assert.rejects(load(cache, top, true, true), error => /EPERM/.test(error.stderr));
  assert.equal(readdirSync(cache).length, 1);
  assert(
    readdirSync(cache).every(name => name.endsWith('.mjs')),
    'the failed writer removes its own temp',
  );
});

test('the actual extension selects TypeScript generic arrows versus TSX elements', async t => {
  const { cache, src, top } = workspace(t);
  writeFileSync(
    join(src, 'top.ts'),
    'const identity = <T>(value: T): T => value;\nexport const top = identity(42);\n',
  );
  assert.equal((await load(cache, top)).top, 42, 'formatted .ts generic arrows are not JSX');
  const jsx = pathToFileURL(join(src, 'top.tsx'));
  writeFileSync(join(src, 'top.tsx'), 'export const top = <span>42</span>;\n');
  const element = (await load(cache, jsx)).top;
  assert.equal(element.type, 'span');
  assert.equal(element.props.children, '42');
});

test('replay: a module reached through a type-only cycle is rekeyed when its value import changes', async t => {
  // Seen 2026-11-08: keys follow source imports, type-only ones too, while compiled output keeps only
  // value imports. Entering such a cycle from its far side keyed a module by its value import's
  // href, not its bytes, so after an edit the cached module still loaded the older compiled import.
  const { cache, src, top } = workspace(t);
  const gate = value =>
    writeFileSync(
      join(src, 'gate.ts'),
      `import type { Reader } from './reader';\nexport const value = (): number => ${value};\nexport type Gate = Reader;\n`,
    );
  writeFileSync(
    join(src, 'reader.ts'),
    "import { value } from './gate';\nexport type Reader = number;\nexport const viaGate = () => value();\n",
  );
  writeFileSync(
    join(src, 'top.ts'),
    "import { value } from './gate';\nimport { viaGate } from './reader';\nexport const top = [value(), viaGate()];\n",
  );
  gate(1);
  assert.deepEqual((await load(cache, top)).top, [1, 1]);
  gate(2);
  assert.deepEqual((await load(cache, top)).top, [2, 2], 'before: [2, 1] from the cached reader');
});

test('server marker diagnostics stay on stderr while child result stdout remains JSON', async () => {
  const script = `await import(${JSON.stringify(loader)});
console.log('FORGE_PROJECT_EXECUTION {"synthetic":true}');
console.log('FORGE_ACCEPTED_LANDINGS 4');
console.log('FORGE_FUTURE_DIAGNOSTIC 2');
console.log(JSON.stringify({ result: 'synthetic' }));`;
  const { stdout, stderr } = await run(process.execPath, ['--input-type=module', '-e', script]);
  assert.deepEqual(JSON.parse(stdout), { result: 'synthetic' });
  assert.deepEqual(stderr.trim().split('\n'), [
    'FORGE_PROJECT_EXECUTION {"synthetic":true}',
    'FORGE_ACCEPTED_LANDINGS 4',
    'FORGE_FUTURE_DIAGNOSTIC 2',
  ]);
});
