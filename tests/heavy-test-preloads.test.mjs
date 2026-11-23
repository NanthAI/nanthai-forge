// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Ferdinando Valsecchi
// Friction c804f164: a focused `node --test` run left out the project's test preload and failed only
// on that machine. Friction dfb2a8d6: `nforge heavy sh -c "npm run build:core && node --test …"` ran
// the whole build and only then failed inside the test. Heavy refuses both before any work, naming
// the missing flag and the corrected command (synthetic projects).
import assert from 'node:assert/strict';
import test from 'node:test';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { preloadRefusal } from '../dist/heavy-test-preloads.js';

const cli = resolve('dist/cli-entry.js');
const project = (t, manifest) => {
  const root = mkdtempSync(join(tmpdir(), 'forge-heavy-preload-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  if (manifest !== undefined) writeFileSync(join(root, 'package.json'), manifest);
  return root;
};
const script = (test, extra = {}) => JSON.stringify({ scripts: { test, ...extra } });

test('a direct node --test is refused with the missing preloads and the corrected command', t => {
  const root = project(
    t,
    script('npm run build && node --import ./setup.mjs -r ./env.cjs --test tests/*.test.mjs'),
  );
  const refusal = preloadRefusal(['node', '--test', 'tests/a.test.mjs'], root);
  assert.match(refusal, /refused before taking a slot/);
  assert.match(refusal, /--import \.\/setup\.mjs --require \.\/env\.cjs/);
  assert.match(
    refusal,
    /Corrected command: nforge heavy node --import \.\/setup\.mjs --require \.\/env\.cjs --test tests\/a\.test\.mjs/,
  );
  // A preload exported in NODE_OPTIONS reaches the runner and counts as present.
  const saved = process.env.NODE_OPTIONS;
  process.env.NODE_OPTIONS = '--import ./setup.mjs -r ./env.cjs';
  t.after(() => (saved === undefined ? delete process.env.NODE_OPTIONS : (process.env.NODE_OPTIONS = saved)));
  assert.equal(preloadRefusal(['node', '--test', 'tests/a.test.mjs'], root), null);
  if (saved === undefined) delete process.env.NODE_OPTIONS;
  else process.env.NODE_OPTIONS = saved;
  // Either spelling of the same preload counts as present.
  assert.equal(
    preloadRefusal(
      ['node', '--import=./setup.mjs', '--require', './env.cjs', '--test', 'tests/a.test.mjs'],
      root,
    ),
    null,
  );
});

test('a node --test segment inside sh -c or bash -c is refused, other segments are left alone', t => {
  const root = project(t, script('node --import ./tests/check-runtime.mjs --test tests/*.test.mjs'));
  for (const shell of ['sh', 'bash', '/bin/sh']) {
    const refusal = preloadRefusal(
      [shell, '-c', 'npm run build:core && node --test tests/x.test.mjs || echo failed'],
      root,
    );
    assert.match(refusal, /--import \.\/tests\/check-runtime\.mjs/);
    assert.ok(
      refusal.endsWith(
        `${shell} -c 'npm run build:core && node --import ./tests/check-runtime.mjs --test tests/x.test.mjs || echo failed'`,
      ),
      refusal,
    );
  }
  assert.equal(
    preloadRefusal(
      ['sh', '-c', 'npm run build:core && node --import ./tests/check-runtime.mjs --test tests/x.test.mjs'],
      root,
    ),
    null,
  );
  // Not a test, not a single -c string, or not node: nothing to check.
  for (const args of [
    ['sh', '-c', 'npm run build:core && node scripts/run.mjs'],
    ['sh', 'run.sh', 'node --test x'],
    ['npm', 'test'],
    ['sh', '-c'],
  ])
    assert.equal(preloadRefusal(args, root), null, args.join(' '));
});

test('asks for nothing without a node --test script or a readable manifest', t => {
  for (const manifest of [
    undefined,
    'not json',
    JSON.stringify({ scripts: {} }),
    script('vitest run'),
    script('node --import ./setup.mjs scripts/run.mjs'),
    script('node --test tests/*.test.mjs'),
  ])
    assert.equal(
      preloadRefusal(['node', '--test', 'tests/a.test.mjs'], project(t, manifest)),
      null,
      String(manifest),
    );
});

test('heavy refuses a wrapped test without the preload before the build runs; a correct one still runs', t => {
  const root = project(
    t,
    script('node --import ./setup.mjs --test tests/*.test.mjs', {
      'build:core': "node -e \"require('fs').writeFileSync('build-ran','')\"",
    }),
  );
  writeFileSync(join(root, 'setup.mjs'), '');
  writeFileSync(join(root, 'a.test.mjs'), "import 'node:test';\n");
  const heavy = command =>
    spawnSync(process.execPath, [cli, 'heavy', '--no-build', 'sh', '-c', command], {
      cwd: root,
      encoding: 'utf8',
      env: {
        ...process.env,
        FORGE_HEAVY_DIR: join(root, 'slots'),
        FORGE_CLIENT_SETTINGS: join(root, 'client.json'),
        FORGE_HEAVY_PARENT: '',
      },
    });
  const refused = heavy('npm run build:core && node --test a.test.mjs');
  assert.notEqual(refused.status, 0);
  assert.match(refused.stderr, /--import \.\/setup\.mjs/);
  assert.match(refused.stderr, /Corrected command: nforge heavy sh -c/);
  assert.equal(existsSync(join(root, 'build-ran')), false, 'the build never started');
  assert.equal(existsSync(join(root, 'slots')), false, 'no slot was taken');

  const ran = heavy('npm run build:core && node --import ./setup.mjs --test a.test.mjs');
  assert.equal(ran.status, 0, ran.stderr);
  assert.equal(existsSync(join(root, 'build-ran')), true);
});
