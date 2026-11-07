// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { coreBuildRoot, coreBuildState, ensureCoreBuild } from '../dist/heavy-build.js';

// A synthetic checkout: package.json with a build:core script that writes dist/cli-entry.js.
function checkout(
  t,
  buildScript = "node -e \"require('fs').mkdirSync('dist',{recursive:true});require('fs').writeFileSync('dist/cli-entry.js','')\"",
) {
  const root = mkdtempSync(join(tmpdir(), 'forge-heavy-build-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(root, 'src', 'nested'), { recursive: true });
  writeFileSync(join(root, 'src', 'nested', 'a.ts'), 'export {};\n');
  writeFileSync(join(root, 'tsconfig.json'), '{}\n');
  writeFileSync(join(root, 'package.json'), JSON.stringify({ scripts: { 'build:core': buildScript } }));
  return root;
}
const built = (root, seconds) => {
  mkdirSync(join(root, 'dist'), { recursive: true });
  const entry = join(root, 'dist', 'cli-entry.js');
  writeFileSync(entry, '');
  utimesSync(entry, seconds, seconds);
};
const touch = (file, seconds) => utimesSync(file, seconds, seconds);

test('missing dist/ is reported and built before the tests', async t => {
  const root = checkout(t);
  assert.equal(coreBuildState(root), 'missing');
  const lines = [];
  const calls = [];
  const code = await ensureCoreBuild(
    root,
    async folder => (calls.push(folder), 0),
    text => lines.push(text),
  );
  assert.equal(code, 0);
  assert.deepEqual(calls, [root]);
  assert.match(lines.join(''), /dist\/ is missing; running npm run build:core/);
});

test('dist/ older than src/ or tsconfig.json is stale; a fresh dist/ builds nothing', async t => {
  const root = checkout(t);
  touch(join(root, 'src', 'nested', 'a.ts'), 1000);
  touch(join(root, 'tsconfig.json'), 1000);
  built(root, 2000);
  assert.equal(coreBuildState(root), 'fresh');
  const calls = [];
  const lines = [];
  assert.equal(
    await ensureCoreBuild(
      root,
      async folder => (calls.push(folder), 0),
      text => lines.push(text),
    ),
    0,
  );
  assert.deepEqual(calls, []);
  assert.deepEqual(lines, []);
  touch(join(root, 'src', 'nested', 'a.ts'), 3000);
  assert.equal(coreBuildState(root), 'stale');
  touch(join(root, 'src', 'nested', 'a.ts'), 1000);
  touch(join(root, 'tsconfig.json'), 3000);
  assert.equal(coreBuildState(root), 'stale');
});

test('a failed build stops the batch and prints the exact command', async t => {
  const root = checkout(t);
  const lines = [];
  const code = await ensureCoreBuild(
    root,
    async () => 2,
    text => lines.push(text),
  );
  assert.equal(code, 2);
  assert.match(lines.join(''), /npm run build:core failed with exit 2; the tests were not run/);
});

test('a folder that is not a Forge checkout is left alone', t => {
  const folder = mkdtempSync(join(tmpdir(), 'forge-heavy-build-none-'));
  t.after(() => rmSync(folder, { recursive: true, force: true }));
  assert.equal(coreBuildRoot(folder), null);
});

test('nforge heavy node --test builds a fresh Lane without dist/ and then runs the tests', t => {
  const root = checkout(t);
  const slots = mkdtempSync(join(tmpdir(), 'forge-heavy-slots-'));
  t.after(() => rmSync(slots, { recursive: true, force: true }));
  writeFileSync(join(root, 'sample.test.mjs'), "import test from 'node:test';test('ran',()=>{});\n");
  const run = () =>
    spawnSync(
      process.execPath,
      [join(process.cwd(), 'dist', 'cli-entry.js'), 'heavy', process.execPath, '--test', 'sample.test.mjs'],
      { cwd: root, encoding: 'utf8', env: { ...process.env, FORGE_HEAVY_DIR: slots } },
    );
  const cold = run();
  assert.equal(cold.status, 0, cold.stderr);
  assert.match(cold.stderr, /dist\/ is missing; running npm run build:core/);
  assert.equal(coreBuildState(root), 'fresh');
  const warm = run();
  assert.equal(warm.status, 0, warm.stderr);
  assert.doesNotMatch(warm.stderr, /build:core/);
});
