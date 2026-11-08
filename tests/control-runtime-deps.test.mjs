// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';
import {
  controlRuntimeEntries,
  controlRuntimeKey,
  controlRuntimePackages,
  controlRuntimePaths,
} from '../scripts/control-runtime-deps.mjs';

const specifiers = /(?:from\s*|import\s*\(\s*|import\s+)['"]([^'"]+)['"]/g;
const packageName = specifier =>
  specifier.startsWith('@') ? specifier.split('/').slice(0, 2).join('/') : specifier.split('/')[0];

/** Every file the supervisor and its executor load, and every bare package they import. */
function closure(root, entries) {
  const files = new Set(),
    packages = new Map(),
    computed = [];
  const visit = file => {
    if (files.has(file) || !existsSync(file)) return;
    files.add(file);
    const text = readFileSync(file, 'utf8');
    for (const [, specifier] of text.matchAll(specifiers)) {
      if (specifier.startsWith('.')) visit(resolve(dirname(file), specifier));
      else if (!specifier.startsWith('node:') && !packages.has(packageName(specifier)))
        packages.set(packageName(specifier), relative(root, file));
    }
    // A computed specifier would hide a package from this list.
    for (const match of text.matchAll(/\bimport\(\s*(?!['"])([^)]{0,60})/g))
      computed.push(`${relative(root, file)}: import(${match[1]}`);
  };
  for (const entry of entries) visit(resolve(root, entry));
  return { files, packages, computed };
}

test('the control runtime list covers every package the supervisor and executor import', () => {
  const found = closure('.', controlRuntimeEntries);
  assert.ok(found.files.size > 50, 'the closure follows dist modules (build:core ran)');
  assert.deepEqual(found.computed, [], 'imports in the control runtime use literal specifiers');
  const missing = [...found.packages].filter(([name]) => !controlRuntimePackages.includes(name));
  assert.deepEqual(missing, [], 'add these packages to scripts/control-runtime-deps.mjs');
  // A listed package with its own dependencies would need them restored too.
  const lock = JSON.parse(readFileSync('package-lock.json', 'utf8')).packages;
  for (const name of controlRuntimePackages) {
    const entry = lock[`node_modules/${name}`];
    assert.ok(entry, `${name} is installed at the top level`);
    assert.deepEqual(Object.keys(entry.dependencies ?? {}), [], `${name} has no runtime dependencies`);
  }
});

test('the guard fails when the supervisor imports an unlisted package', t => {
  const root = mkdtempSync(join(tmpdir(), 'forge-test-runtime-deps-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  writeFileSync(join(root, 'entry.mjs'), "import './a.mjs';\nconst m = await import(name);\n");
  writeFileSync(
    join(root, 'a.mjs'),
    "import { z } from 'zod';\nimport 'left-pad/x.js';\nimport 'node:fs';\n",
  );
  const found = closure(root, ['entry.mjs']);
  assert.deepEqual([...found.packages.keys()], ['zod', 'left-pad']);
  assert.deepEqual(found.computed, ['entry.mjs: import(name']);
});

test('the runtime key follows the control lockfile and the list; paths take the checkout prefix', t => {
  const root = mkdtempSync(join(tmpdir(), 'forge-test-runtime-key-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  writeFileSync(join(root, 'package-lock.json'), '{"lock":1}');
  const key = controlRuntimeKey(root);
  assert.match(key, /^forge-control-runtime-v1-[\w]+-[\w]+-node-[\d.]+-[0-9a-f]{64}$/);
  assert.equal(controlRuntimeKey(root), key);
  writeFileSync(join(root, 'package-lock.json'), '{"lock":2}');
  assert.notEqual(controlRuntimeKey(root), key);
  // Never the full install's key: a runtime entry can never be restored as the full one.
  assert.doesNotMatch(key, /forge-control-deps-/);
  assert.deepEqual(controlRuntimePaths('control'), [
    'control/node_modules/zod',
    'control/node_modules/@noble/hashes',
    'control/node_modules/typescript',
  ]);
});
