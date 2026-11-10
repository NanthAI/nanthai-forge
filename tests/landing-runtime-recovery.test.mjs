// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import {
  copyFileSync,
  cpSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  appendFileSync,
} from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { landingRuntime, landingRuntimeSchema, changedLandingRuntime } from '../dist/landing-environment.js';

test('Node binary identity pins the executable bytes as well as its location and version', () => {
  assert.equal(
    landingRuntime().nodeBinary,
    createHash('sha256').update(readFileSync(process.execPath)).digest('hex'),
  );
});

test('runtime snapshots predating the binary digest retain their available identity checks', () => {
  const legacy = { ...landingRuntime() };
  delete legacy.nodeBinary;
  assert.deepEqual(changedLandingRuntime(landingRuntimeSchema.parse(legacy)), []);
  assert.deepEqual(changedLandingRuntime({ ...legacy, cli: 'prior-build' }), ['cli']);
});

test('CLI identity pins packaged runtime helpers as well as compiled modules', t => {
  const root = mkdtempSync(join(tmpdir(), 'forge-helper-identity-'));
  t.after(() => rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }));
  const dist = join(root, 'dist');
  cpSync(fileURLToPath(new URL('../dist', import.meta.url)), dist, { recursive: true });
  copyFileSync(fileURLToPath(new URL('../package.json', import.meta.url)), join(root, 'package.json'));
  symlinkSync(fileURLToPath(new URL('../node_modules', import.meta.url)), join(root, 'node_modules'));
  const manifest = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
  for (const file of manifest.files.filter(
    file => file.startsWith('scripts/') && /\.(?:mjs|py)$/.test(file),
  )) {
    mkdirSync(dirname(join(root, file)), { recursive: true });
    copyFileSync(fileURLToPath(new URL('../' + file, import.meta.url)), join(root, file));
  }
  const script = `import { landingRuntime } from ${JSON.stringify(pathToFileURL(join(dist, 'landing-environment.js')).href)};console.log(JSON.stringify(landingRuntime()));`;
  const read = () =>
    JSON.parse(execFileSync(process.execPath, ['--input-type=module', '-e', script], { encoding: 'utf8' }));
  assert.deepEqual(changedLandingRuntime(landingRuntime(), read()), []);
  appendFileSync(join(root, 'scripts', 'test-coverage.mjs'), '\n// synthetic installed helper change\n');
  assert.deepEqual(changedLandingRuntime(landingRuntime(), read()), ['cli']);
});
