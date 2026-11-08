// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { removeInstall } from '../dist/dependency-seal.js';
import { dependencyKey, shareDependencies } from '../dist/shared-dependencies.js';

function scratch(t) {
  const directory = mkdtempSync(join(tmpdir(), 'forge-deps-sealed-'));
  const saved = { XDG_STATE_HOME: process.env.XDG_STATE_HOME, FORGE_HEAVY_DIR: process.env.FORGE_HEAVY_DIR };
  process.env.XDG_STATE_HOME = join(directory, 'state');
  process.env.FORGE_HEAVY_DIR = join(directory, 'heavy');
  t.after(() => {
    for (const [key, value] of Object.entries(saved))
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    removeInstall(directory);
  });
  return directory;
}
function lane(directory, name, project) {
  const root = join(directory, name);
  mkdirSync(root);
  writeFileSync(join(root, 'package.json'), JSON.stringify({ name: 'x' }));
  writeFileSync(
    join(root, 'package-lock.json'),
    JSON.stringify({ lockfileVersion: 3, packages: { '': {} } }),
  );
  if (project) {
    mkdirSync(join(root, '.forge'));
    writeFileSync(
      join(root, '.forge/hosted-lane.json'),
      JSON.stringify({ url: 'https://example.invalid', selection: { projectId: project } }),
    );
  }
  return root;
}
const install = async stage => {
  mkdirSync(join(stage, 'node_modules', 'dep', 'lib'), { recursive: true });
  writeFileSync(join(stage, 'node_modules', 'dep', 'index.js'), 'module.exports = 1;');
  writeFileSync(join(stage, 'node_modules', 'dep', 'lib', 'a.js'), 'a');
};
const options = directory => ({ install, enabled: true, cache: join(directory, 'deps'), heavy: false });
const unlessRoot = process.platform === 'win32' || process.getuid?.() === 0;

test(
  'a finished shared install is read-only, so a Lane cannot change what every Lane runs',
  { skip: unlessRoot },
  async t => {
    const directory = scratch(t);
    const root = lane(directory, 'one');
    const result = await shareDependencies(root, options(directory));
    assert.equal(result.status, 'installed');
    const linked = join(root, 'node_modules');
    assert.equal(lstatSync(linked).isSymbolicLink(), true);
    // Writing an installed file, adding a file or removing one inside a package all fail.
    assert.throws(() => writeFileSync(join(linked, 'dep/index.js'), 'evil'), /EACCES|EPERM/);
    assert.throws(() => writeFileSync(join(linked, 'dep/lib/new.js'), 'evil'), /EACCES|EPERM/);
    assert.throws(() => rmSync(join(linked, 'dep/lib/a.js')), /EACCES|EPERM/);
    assert.equal(readFileSync(join(linked, 'dep/index.js'), 'utf8'), 'module.exports = 1;');
    // Tool caches can still be created beside the packages.
    mkdirSync(join(linked, '.cache'));
    writeFileSync(join(linked, '.cache', 'x'), 'cache');
    // A second Lane with the same lockfile reuses the sealed entry.
    const again = await shareDependencies(lane(directory, 'two'), options(directory));
    assert.equal(again.status, 'linked');
    // The sealed entry is still removable by Forge, and a stale one is replaced on the next share.
    const entries = readdirSync(join(directory, 'deps')).filter(name => /^npm-[0-9a-f]{24}$/.test(name));
    assert.equal(entries.length, 1);
    removeInstall(join(directory, 'deps', entries[0]));
    assert.equal(existsSync(join(directory, 'deps', entries[0])), false);
  },
);

test('a hosted Lane keys its install per project, so a fork never shares it', t => {
  const directory = scratch(t);
  const plain = dependencyKey(lane(directory, 'plain'));
  const one = dependencyKey(lane(directory, 'one', 'project-one'));
  const two = dependencyKey(lane(directory, 'two', 'project-two'));
  const again = dependencyKey(lane(directory, 'again', 'project-one'));
  assert.match(one, /^[0-9a-f]{24}$/);
  assert.notEqual(one, two);
  assert.notEqual(one, plain);
  assert.equal(one, again);
});
