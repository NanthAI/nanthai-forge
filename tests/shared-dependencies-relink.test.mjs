// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { removeInstall } from '../dist/dependency-seal.js';
import { dependencyKey, shareDependencies } from '../dist/shared-dependencies.js';

// Replay of friction abf02795 (issue 5b104d9a): a sync brought a package, the Lane kept the old
// install link and `shareDependencies` answered "present", so the next build failed.
function scratch(t) {
  const directory = mkdtempSync(join(tmpdir(), 'forge-deps-relink-'));
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
const lockOf = (names = []) =>
  JSON.stringify({
    lockfileVersion: 3,
    packages: {
      '': {},
      ...Object.fromEntries(names.map(name => [`node_modules/${name}`, { version: '1.0.0' }])),
    },
  });
function lane(directory, name, { lock = lockOf(), workspaces = [] } = {}) {
  const root = join(directory, name);
  mkdirSync(root);
  writeFileSync(join(root, 'package.json'), JSON.stringify({ name: 'x' }));
  writeFileSync(join(root, 'package-lock.json'), lock);
  for (const folder of workspaces) {
    mkdirSync(join(root, folder), { recursive: true });
    writeFileSync(join(root, folder, 'package.json'), JSON.stringify({ name: folder }));
  }
  return root;
}
/** Installs exactly the packages the lockfile in the stage names. */
const installer = calls => async stage => {
  calls.push(stage);
  const names = Object.keys(JSON.parse(readFileSync(join(stage, 'package-lock.json'), 'utf8')).packages)
    .filter(key => key.startsWith('node_modules/'))
    .map(key => key.slice('node_modules/'.length));
  for (const name of names) {
    mkdirSync(join(stage, 'node_modules', name), { recursive: true });
    writeFileSync(join(stage, 'node_modules', name, 'index.js'), name);
  }
  mkdirSync(join(stage, 'node_modules', '.bin'), { recursive: true });
};
const options = (directory, calls, extra = {}) => ({
  enabled: true,
  cache: join(directory, 'cache'),
  heavy: false,
  install: installer(calls),
  ...extra,
});
const sees = (root, name) => existsSync(join(root, 'node_modules', name, 'index.js'));

test('a sync that brings a package relinks the Lane to the new lockfile before the next build', async t => {
  const directory = scratch(t),
    calls = [],
    root = lane(directory, 'a', { lock: lockOf(['old-dep']) });
  assert.equal((await shareDependencies(root, options(directory, calls))).status, 'installed');
  assert.equal(sees(root, 'old-dep'), true);
  // Nothing changed: one key compare, no install, no relink.
  assert.deepEqual(await shareDependencies(root, options(directory, calls)), { status: 'present' });
  assert.equal(calls.length, 1);
  // The sync brings @lezer/go.
  writeFileSync(join(root, 'package-lock.json'), lockOf(['old-dep', 'lezer-go']));
  const result = await shareDependencies(root, options(directory, calls, { refresh: true }));
  assert.equal(result.status, 'installed');
  assert.equal(result.key, dependencyKey(root));
  assert.equal(typeof result.relinked.from, 'string');
  assert.equal(sees(root, 'lezer-go'), true);
  assert.equal(sees(root, 'old-dep'), true);
  assert.equal(realpathSync(join(root, 'node_modules')).includes(result.key), true);
  assert.equal(calls.length, 2, 'the new key installs once');
  assert.deepEqual(await shareDependencies(root, options(directory, calls, { refresh: true })), {
    status: 'present',
  });
  // Another Lane that syncs to the same lockfile only relinks.
  const other = lane(directory, 'b', { lock: lockOf(['old-dep']) });
  await shareDependencies(other, options(directory, calls));
  writeFileSync(join(other, 'package-lock.json'), lockOf(['old-dep', 'lezer-go']));
  const again = await shareDependencies(other, options(directory, calls, { refresh: true }));
  assert.equal(again.status, 'linked');
  assert.equal(calls.length, 2, 'a cache hit installs nothing');
});

test('a Lane linked before this change follows its target name, with no marker needed', async t => {
  const directory = scratch(t),
    calls = [],
    root = lane(directory, 'a', { lock: lockOf(['x']) });
  await shareDependencies(root, options(directory, calls));
  assert.equal(lstatSync(join(root, 'node_modules')).isSymbolicLink(), true);
  writeFileSync(join(root, 'package-lock.json'), lockOf(['x', 'y']));
  assert.equal((await shareDependencies(root, options(directory, calls))).status, 'installed');
  assert.equal(sees(root, 'y'), true);
});

test('an install the agent made, or no install at all, is never touched', async t => {
  const directory = scratch(t),
    calls = [],
    root = lane(directory, 'own');
  mkdirSync(join(root, 'node_modules', 'mine'), { recursive: true });
  writeFileSync(join(root, 'node_modules', 'mine', 'index.js'), 'mine');
  writeFileSync(join(root, 'package-lock.json'), lockOf(['y']));
  assert.deepEqual(await shareDependencies(root, options(directory, calls)), { status: 'present' });
  assert.equal(sees(root, 'mine'), true);
  const bare = lane(directory, 'bare');
  assert.deepEqual(await shareDependencies(bare, options(directory, calls, { refresh: true })), {
    status: 'none',
  });
  assert.equal(existsSync(join(bare, 'node_modules')), false, 'refresh never makes a first link');
  assert.equal(calls.length, 0);
});

test('a failed install puts the previous link back', async t => {
  const directory = scratch(t),
    calls = [],
    root = lane(directory, 'a', { lock: lockOf(['x']) });
  await shareDependencies(root, options(directory, calls));
  const before = readlinkSync(join(root, 'node_modules'));
  writeFileSync(join(root, 'package-lock.json'), lockOf(['x', 'y']));
  const failed = await shareDependencies(
    root,
    options(directory, calls, {
      install: async () => {
        throw new Error('registry down');
      },
    }),
  );
  assert.equal(failed.status, 'failed');
  assert.equal(readlinkSync(join(root, 'node_modules')), before);
  assert.equal(sees(root, 'x'), true);
});

test('workspace Lanes relink their real node_modules directories and sibling links', async t => {
  const directory = scratch(t),
    calls = [],
    folder = 'packages/a',
    root = lane(directory, 'ws', { workspaces: [folder], lock: lockOf(['x']) });
  const withWorkspace = names =>
    JSON.stringify({
      lockfileVersion: 3,
      packages: {
        '': {},
        [folder]: {},
        ...Object.fromEntries(names.map(name => [`node_modules/${name}`, { version: '1.0.0' }])),
      },
    });
  writeFileSync(join(root, 'package-lock.json'), withWorkspace(['x']));
  const install = async stage => {
    await installer(calls)(stage);
    mkdirSync(join(stage, folder, 'node_modules'), { recursive: true });
  };
  assert.equal((await shareDependencies(root, options(directory, calls, { install }))).status, 'installed');
  assert.equal(lstatSync(join(root, 'node_modules')).isDirectory(), true);
  writeFileSync(join(root, 'package-lock.json'), withWorkspace(['x', 'y']));
  const result = await shareDependencies(root, options(directory, calls, { install, refresh: true }));
  assert.equal(result.status, 'installed');
  assert.equal(sees(root, 'y'), true);
  assert.equal(sees(root, 'x'), true);
  // A real directory with the agent's own package in it is kept, and reported.
  writeFileSync(join(root, 'package-lock.json'), withWorkspace(['x', 'y', 'z']));
  mkdirSync(join(root, 'node_modules', 'mine'));
  const kept = await shareDependencies(root, options(directory, calls, { install, refresh: true }));
  assert.equal(kept.status, 'stale');
  assert.equal(existsSync(join(root, 'node_modules', 'mine')), true);
  assert.equal(sees(root, 'y'), true, 'a refused relink changes nothing');
});

// The manager-neutral path: pnpm, Yarn and bun Lanes always hold a directory of links with a marker.
const managers = {
  pnpm: {
    files: extra => ({
      'package.json': JSON.stringify({ name: 'x', packageManager: 'pnpm@10.4.1' }),
      'pnpm-lock.yaml': `lockfileVersion: '9.0'\n\nimporters:\n\n  .: {}\n\npackages:\n${extra}`,
    }),
    lock: 'pnpm-lock.yaml',
  },
  yarn: {
    files: extra => ({
      'package.json': JSON.stringify({ name: 'x' }),
      'yarn.lock': `# yarn lockfile v1\n\n${extra}`,
    }),
    lock: 'yarn.lock',
  },
  bun: {
    files: extra => ({
      'package.json': JSON.stringify({ name: 'x' }),
      'bun.lock': `{\n  "lockfileVersion": 1,\n  "workspaces": {\n    "": {\n      "name": "x",\n    },\n  },\n  "packages": {\n${extra}  }\n}\n`,
    }),
    lock: 'bun.lock',
  },
};
for (const [name, manager] of Object.entries(managers))
  test(`${name}: a lockfile change relinks the Lane's directory of links`, async t => {
    const directory = scratch(t),
      root = join(directory, name),
      calls = [];
    mkdirSync(root);
    const write = extra => {
      for (const [file, content] of Object.entries(manager.files(extra)))
        writeFileSync(join(root, file), content);
    };
    const install = async stage => {
      calls.push(stage);
      const lock = readFileSync(join(stage, manager.lock), 'utf8');
      for (const dep of ['alpha', 'beta'])
        if (lock.includes(dep)) {
          mkdirSync(join(stage, 'node_modules', dep), { recursive: true });
          writeFileSync(join(stage, 'node_modules', dep, 'index.js'), dep);
        }
      mkdirSync(join(stage, 'node_modules'), { recursive: true });
    };
    const resolve = async () => ({ command: name, prefix: [], version: '1.2.3' });
    const run = (extra = {}) =>
      shareDependencies(root, { ...options(directory, calls, { install }), resolve, ...extra });
    write(name === 'bun' ? '    "alpha": ["alpha@1.0.0", "", {}, "sha512-a"],\n' : '  alpha@1.0.0:\n');
    assert.equal((await run()).status, 'installed');
    assert.equal(sees(root, 'alpha'), true);
    assert.deepEqual(await run({ refresh: true }), { status: 'present' });
    write(
      name === 'bun'
        ? '    "alpha": ["alpha@1.0.0", "", {}, "sha512-a"],\n    "beta": ["beta@1.0.0", "", {}, "sha512-b"],\n'
        : '  alpha@1.0.0:\n  beta@1.0.0:\n',
    );
    const result = await run({ refresh: true });
    assert.equal(result.status, 'installed');
    assert.equal(typeof result.relinked.from, 'string');
    assert.equal(sees(root, 'beta'), true);
    assert.equal(calls.length, 2);
    assert.deepEqual(await run({ refresh: true }), { status: 'present' });
  });
