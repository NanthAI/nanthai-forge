// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { coreBuildRoot, coreBuildState, ensureCoreBuild } from '../dist/heavy-build.js';
import { needsCoreBuild } from '../dist/heavy-slots.js';

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

test('incident 2659b45c: --no-build runs a new failing-first test against the existing main build', t => {
  const root = checkout(t, 'node -e "process.exit(93)"');
  built(root, 1);
  writeFileSync(join(root, 'dist', 'before.cjs'), 'exports.value = "main";\n');
  writeFileSync(
    join(root, 'sample.test.mjs'),
    `import test from 'node:test';import assert from 'node:assert/strict';import old from './dist/before.cjs';test('main behaviour is still present',()=>assert.equal(old.value,'main'));\n`,
  );
  const slots = mkdtempSync(join(tmpdir(), 'forge-heavy-baseline-'));
  t.after(() => rmSync(slots, { recursive: true, force: true }));
  const result = spawnSync(
    process.execPath,
    [
      join(process.cwd(), 'dist/cli-entry.js'),
      'heavy',
      '--no-build',
      process.execPath,
      '--test',
      'sample.test.mjs',
    ],
    {
      cwd: root,
      encoding: 'utf8',
      env: { ...process.env, FORGE_HEAVY_DIR: slots },
    },
  );
  assert.equal(result.status, 0, result.stderr);
  assert.doesNotMatch(result.stderr, /running npm run build:core/);
  assert.equal(coreBuildState(root), 'stale', 'the accepted build stays pinned');
});

test('frictions aa71d3ed and bfb98e08: wrapped test commands (sh <script>, sh -c with node --test) build missing or stale dist/ unless --no-build is set', t => {
  const root = checkout(
    t,
    "node -e \"const fs=require('fs');fs.mkdirSync('dist',{recursive:true});fs.writeFileSync('dist/cli-entry.js','');fs.writeFileSync('dist/mod.cjs','exports.v=1;\\n')\"",
  );
  const slots = mkdtempSync(join(tmpdir(), 'forge-heavy-wrapped-'));
  t.after(() => rmSync(slots, { recursive: true, force: true }));
  writeFileSync(
    join(root, 'sample.test.mjs'),
    "import test from 'node:test';import assert from 'node:assert/strict';import m from './dist/mod.cjs';test('built',()=>assert.equal(m.v,1));\n",
  );
  writeFileSync(join(root, 'run.sh'), `${JSON.stringify(process.execPath)} --test sample.test.mjs\n`);
  const cli = join(process.cwd(), 'dist', 'cli-entry.js');
  const env = { ...process.env, FORGE_HEAVY_DIR: slots };
  delete env.NODE_TEST_CONTEXT;
  const heavy = (...args) =>
    spawnSync(process.execPath, [cli, 'heavy', ...args], {
      cwd: root,
      encoding: 'utf8',
      env,
    });

  for (const [args, expected] of [
    [['node', '--test', 'sample.test.mjs'], true],
    [['sh', 'run.sh'], true],
    [['bash', '-e', 'run.sh'], true],
    [['/bin/zsh', '-euo', 'pipefail', 'run.sh'], true],
    [['sh', '--', 'run.sh'], true],
    [['sh', '-c', 'node --import ./setup.mjs --test sample.test.mjs'], true],
    [['bash', '-ec', `${process.execPath} --test sample.test.mjs`], true],
    [['sh', '-c', 'echo ok'], false],
    [['sh', '-c', 'echo "node --test sample.test.mjs"'], false],
    [['sh', '-c', 'node -e "process.exit(0)"'], false],
    [['sh', '-c', 'node -e "console.log(\\"--test\\")"'], false],
    [['sh', '-c', 'node --test-concurrency=2 script.mjs'], false],
    [['sh'], false],
    [['npm', 'run', 'typecheck'], false],
  ])
    assert.equal(needsCoreBuild(args), expected, args.join(' '));

  // aa71d3ed: fresh Lane (no dist/) running `nforge heavy sh <script>` builds dist/ first.
  const fromScript = heavy('sh', 'run.sh');
  assert.equal(fromScript.status, 0, fromScript.stderr);
  assert.match(fromScript.stderr, /dist\/ is missing; running npm run build:core/);
  assert.equal(coreBuildState(root), 'fresh');

  // bfb98e08: stale dist/ running `nforge heavy sh -c "... node --test ..."` rebuilds dist/ first.
  touch(join(root, 'dist', 'cli-entry.js'), 1000);
  touch(join(root, 'src', 'nested', 'a.ts'), 2000);
  assert.equal(coreBuildState(root), 'stale');
  const fromInline = heavy('sh', '-c', `${JSON.stringify(process.execPath)} --test sample.test.mjs`);
  assert.equal(fromInline.status, 0, fromInline.stderr);
  assert.match(fromInline.stderr, /dist\/ is stale; running npm run build:core/);
  assert.equal(coreBuildState(root), 'fresh');

  // Shell flags before the script (`sh -e run.sh`) also check/build dist/, while a non-test
  // `sh -c` or `--no-build` leaves a stale dist/ untouched.
  touch(join(root, 'dist', 'cli-entry.js'), 1000);
  touch(join(root, 'src', 'nested', 'a.ts'), 2000);
  const nonTest = heavy('sh', '-c', 'echo ok');
  assert.equal(nonTest.status, 0, nonTest.stderr);
  assert.doesNotMatch(nonTest.stderr, /running npm run build:core/);
  assert.equal(coreBuildState(root), 'stale');

  const noBuild = heavy('--no-build', 'sh', 'run.sh');
  assert.equal(noBuild.status, 0, noBuild.stderr);
  assert.doesNotMatch(noBuild.stderr, /running npm run build:core/);
  assert.equal(coreBuildState(root), 'stale');

  const flagged = heavy('sh', '-e', 'run.sh');
  assert.equal(flagged.status, 0, flagged.stderr);
  assert.match(flagged.stderr, /dist\/ is stale; running npm run build:core/);
  assert.equal(coreBuildState(root), 'fresh');
});
