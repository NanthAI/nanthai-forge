// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { constants, copyFileSync, cpSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { checkEnvironment } from '../dist/check-environment.js';
import {
  changedLandingEnvironment,
  changedLandingRuntime,
  landingRuntime,
} from '../dist/landing-environment.js';

const copy = value => structuredClone(value);
test('shell defaults are supplied by the worker unless explicitly declared by a check', () => {
  const before = checkEnvironment(),
    after = copy(before);
  for (const name of ['PATH', 'TERM', 'LANG', 'TZ', 'LC_ALL']) after.env[name] = 'synthetic-shell';
  assert.deepEqual(changedLandingEnvironment(before, after), []);
  assert.deepEqual(changedLandingEnvironment(before, after, { env: ['PATH', 'TZ'] }), ['PATH', 'TZ']);
  assert.deepEqual(changedLandingEnvironment(before, after, { credentials: ['LANG'] }), ['LANG']);
});
test('runtime, platform and check setting differences remain names-only incompatibilities', () => {
  const before = checkEnvironment(),
    after = copy(before);
  after.node = 'synthetic-node';
  after.arch = 'synthetic-arch';
  after.env.FORGE_CHECK_SCOPED = 'synthetic-scoped';
  after.env.FORGE_CHECK_FULL = 'synthetic-full';
  assert.deepEqual(changedLandingEnvironment(before, after), [
    'arch',
    'node',
    'FORGE_CHECK_FULL',
    'FORGE_CHECK_SCOPED',
  ]);
});
test('runtime identity follows executable bytes for CLI and canonical location for Node', t => {
  const root = mkdtempSync(join(tmpdir(), 'forge-landing-runtime-'));
  t.after(() => rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }));
  const dist = join(root, 'dist');
  cpSync(fileURLToPath(new URL('../dist', import.meta.url)), dist, { recursive: true });
  symlinkSync(fileURLToPath(new URL('../node_modules', import.meta.url)), join(root, 'node_modules'));
  copyFileSync(fileURLToPath(new URL('../package.json', import.meta.url)), join(root, 'package.json'));
  symlinkSync(fileURLToPath(new URL('../scripts', import.meta.url)), join(root, 'scripts'));
  const script = `import { landingRuntime } from ${JSON.stringify(pathToFileURL(join(dist, 'landing-environment.js')).href)};console.log(JSON.stringify(landingRuntime()));`;
  const read = executable =>
    JSON.parse(execFileSync(executable, ['--input-type=module', '-e', script], { encoding: 'utf8' }));
  const original = landingRuntime();
  assert.deepEqual(changedLandingRuntime(original, read(process.execPath)), []);
  const alias = join(root, 'node-alias');
  symlinkSync(process.execPath, alias);
  assert.deepEqual(changedLandingRuntime(original, read(alias)), []);
  writeFileSync(join(dist, 'synthetic-build.js'), '// changed installed controller\n');
  assert.deepEqual(changedLandingRuntime(original, read(process.execPath)), ['cli']);
  const node = join(root, 'node');
  copyFileSync(process.execPath, node, constants.COPYFILE_FICLONE);
  assert.deepEqual(changedLandingRuntime(original, read(node)), ['nodeExecutable', 'cli']);
});
