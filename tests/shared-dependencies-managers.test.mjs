// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import {
  chmodSync,
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  readlinkSync,
  symlinkSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { linkInstall } from '../dist/dependency-link.js';
import { removeInstall } from '../dist/dependency-seal.js';
import { detectPackageManager, managerWorkspaceFolders } from '../dist/package-manager.js';
import { dependencyKey, shareDependencies, installScriptsNotice } from '../dist/shared-dependencies.js';

const ORIGINAL_PATH = process.env.PATH;
function scratch(t) {
  const directory = mkdtempSync(join(tmpdir(), 'forge-deps-managers-'));
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
/** A PATH holding only fake managers (never the machine's), so a test cannot run a real one. */
function fakeManagers(t, directory, names, versions = {}) {
  const bin = join(directory, 'bin'),
    log = join(directory, 'calls.log');
  mkdirSync(bin, { recursive: true });
  for (const name of names.filter(entry => entry !== 'corepack')) {
    const version = versions[name] ?? '1.2.3';
    writeFileSync(
      join(bin, name),
      `#!/bin/sh
if [ "$1" = "--version" ]; then echo ${version}; exit 0; fi
echo "${name} $* | scripts=$YARN_ENABLE_SCRIPTS ignorepath=$YARN_IGNORE_PATH | files=$(ls -A | tr '\\n' ' ')" >> ${JSON.stringify(log)}
case "$1" in
  install|i) mkdir -p node_modules/dep; for d in packages/*; do [ -d "$d" ] && mkdir -p "$d/node_modules/dep"; done; true ;;
esac
`,
    );
    chmodSync(join(bin, name), 0o755);
  }
  // corepack forwards to the fake manager it is asked for.
  if (names.includes('corepack')) {
    writeFileSync(
      join(bin, 'corepack'),
      `#!/bin/sh
if [ "$1" = "--version" ]; then echo 0.34.0; exit 0; fi
echo "corepack $*" >> ${JSON.stringify(log)}
name=$1; shift; exec ${JSON.stringify(bin)}/"$name" "$@"
`,
    );
    chmodSync(join(bin, 'corepack'), 0o755);
  }
  process.env.PATH = `${bin}:/usr/bin:/bin`;
  t.after(() => (process.env.PATH = ORIGINAL_PATH));
  return () => (existsSync(log) ? readFileSync(log, 'utf8').trim().split('\n') : []);
}
function repo(directory, name, files) {
  const root = join(directory, name);
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(join(root, path, '..'), { recursive: true });
    writeFileSync(join(root, path), typeof content === 'string' ? content : JSON.stringify(content));
  }
  return root;
}
const workspaces = {
  'packages/a/package.json': { name: 'a', version: '1.0.0', bin: { a: 'cli.js' } },
  'packages/b/package.json': { name: 'b', version: '1.0.0', dependencies: { a: 'workspace:*' } },
};
const pnpmFiles = (extra = {}, manifest = {}) => ({
  'package.json': { name: 'root', private: true, packageManager: 'pnpm@10.4.1', ...manifest },
  'pnpm-workspace.yaml': 'packages:\n  - packages/*\n',
  'pnpm-lock.yaml': `lockfileVersion: '9.0'\n\nimporters:\n\n  .: {}\n\n  packages/a: {}\n\n  packages/b:\n    dependencies:\n      a:\n        specifier: workspace:*\n        version: link:../a\n\npackages:\n\n  esbuild@0.21.0:\n    resolution: {integrity: sha512-x}\n    requiresBuild: true\n\n  sharp@0.33.0:\n    resolution: {integrity: sha512-y}\n    requiresBuild: true\n`,
  ...workspaces,
  ...extra,
});
const berryFiles = (extra = {}, manifest = {}) => ({
  'package.json': { name: 'root', private: true, packageManager: 'yarn@4.5.0', ...manifest },
  '.yarnrc.yml': 'nodeLinker: node-modules\n',
  'yarn.lock': `__metadata:\n  version: 8\n\n"a@workspace:packages/a":\n  version: 0.0.0-use.local\n\n"b@workspace:packages/b":\n  version: 0.0.0-use.local\n\n"root@workspace:.":\n  version: 0.0.0-use.local\n`,
  ...workspaces,
  ...extra,
});
const bunFiles = (extra = {}, manifest = {}) => ({
  'package.json': { name: 'root', private: true, workspaces: ['packages/*'], ...manifest },
  'bun.lock': `{\n  "lockfileVersion": 1,\n  "workspaces": {\n    "": {\n      "name": "root",\n    },\n    "packages/a": {\n      "name": "a",\n    },\n    "packages/b": {\n      "name": "b",\n    },\n  },\n  "packages": {\n    "sharp": ["sharp@0.33.0", "", {}, "sha512-z"],\n  }\n}\n`,
  ...workspaces,
  ...extra,
});
/** This machine accepts repositories' install-script requests (the installScripts client setting). */
function acceptRequests(t, directory) {
  const file = join(directory, 'client.json'),
    saved = process.env.FORGE_CLIENT_SETTINGS;
  writeFileSync(file, JSON.stringify({ installScripts: true }));
  process.env.FORGE_CLIENT_SETTINGS = file;
  t.after(() => {
    if (saved === undefined) delete process.env.FORGE_CLIENT_SETTINGS;
    else process.env.FORGE_CLIENT_SETTINGS = saved;
  });
}
const share = (root, cache, options = {}) =>
  shareDependencies(root, { enabled: true, cache, heavy: false, ...options });

test('the manager comes from packageManager, then the lockfile; nothing is guessed', t => {
  const directory = scratch(t);
  const detect = (name, files) => detectPackageManager(repo(directory, name, files));
  assert.deepEqual(detect('pnpm', pnpmFiles()).manager, {
    name: 'pnpm',
    declared: '10.4.1',
    lockfile: 'pnpm-lock.yaml',
    berry: false,
  });
  assert.equal(detect('berry', berryFiles()).manager.berry, true);
  assert.equal(
    detect('classic', { 'package.json': { name: 'x' }, 'yarn.lock': '# yarn v1\n' }).manager.berry,
    false,
  );
  assert.equal(detect('bun', bunFiles()).manager.name, 'bun');
  assert.equal(
    detect('npm', { 'package.json': { name: 'x' }, 'package-lock.json': '{}' }).manager.name,
    'npm',
  );
  assert.equal(detect('none', { 'package.json': { name: 'x' } }), null);
  assert.match(
    detect('two', { 'package.json': { name: 'x' }, 'yarn.lock': '', 'pnpm-lock.yaml': '' }).reason,
    /More than one lockfile/,
  );
  assert.match(
    detect('wrong', { 'package.json': { name: 'x', packageManager: 'pnpm@10.0.0' }, 'yarn.lock': '' }).reason,
    /declares pnpm but .* no pnpm-lock.yaml/,
  );
  assert.match(
    detect('odd', { 'package.json': { name: 'x', packageManager: 'deno@2.0.0' }, 'yarn.lock': '' }).reason,
    /cannot install/,
  );
});

test('a pnpm 11+ lockfile with a leading environment document still lists every workspace', t => {
  const directory = scratch(t);
  const lock = `---\nlockfileVersion: '9.0'\n\nimporters:\n\n  .:\n    configDependencies: {}\n\npackages:\n\n  pnpm@12.0.0:\n    resolution: {integrity: sha512-x}\n\n---\nlockfileVersion: '9.0'\n\nimporters:\n\n  .: {}\n\n  packages/a: {}\n\n  playground/deep/c:\n    dependencies: {}\n`;
  const root = repo(directory, 'multi', {
    ...pnpmFiles(),
    'pnpm-lock.yaml': lock,
    'playground/deep/c/package.json': { name: 'c' },
  });
  assert.deepEqual(managerWorkspaceFolders(root, detectPackageManager(root).manager), [
    'packages/a',
    'playground/deep/c',
  ]);
});

test('the key follows the lockfile, the manager version and the install settings, not the folder', t => {
  const directory = scratch(t);
  const one = repo(directory, 'one', pnpmFiles()),
    two = repo(directory, 'two', pnpmFiles());
  assert.equal(dependencyKey(one), dependencyKey(two));
  const other = repo(directory, 'v11', pnpmFiles({}, { packageManager: 'pnpm@11.0.0' }));
  assert.notEqual(dependencyKey(one), dependencyKey(other), 'manager version');
  assert.notEqual(dependencyKey(one, '10.4.2'), dependencyKey(one, '10.4.1'));
  const patched = repo(directory, 'rc', pnpmFiles({ '.npmrc': 'registry=https://example.invalid/\n' }));
  assert.notEqual(dependencyKey(one), dependencyKey(patched), 'install settings');
  const lock = repo(
    directory,
    'lock',
    pnpmFiles({ 'pnpm-lock.yaml': pnpmFiles()['pnpm-lock.yaml'] + '\n# edited\n' }),
  );
  assert.notEqual(dependencyKey(one), dependencyKey(lock), 'lockfile');
});

test('pnpm installs once for the lockfile; the second Lane links without installing', async t => {
  const directory = scratch(t),
    calls = fakeManagers(t, directory, ['pnpm'], { pnpm: '10.4.1' }),
    cache = join(directory, 'cache');
  const first = await share(repo(directory, 'lane1', pnpmFiles()), cache);
  assert.equal(first.status, 'installed');
  const second = await share(repo(directory, 'lane2', pnpmFiles()), cache);
  assert.equal(second.status, 'linked');
  assert.equal(second.key, first.key);
  const installs = calls().filter(line => line.startsWith('pnpm install'));
  assert.equal(installs.length, 1, 'one install, no install on a cache hit');
  assert.match(installs[0], /^pnpm install --frozen-lockfile --ignore-scripts \|/);
  // The stage held the lockfile, workspace file and every workspace manifest.
  for (const file of ['package.json', 'pnpm-lock.yaml', 'pnpm-workspace.yaml', 'packages'])
    assert.ok(installs[0].includes(file), file);
  assert.ok(existsSync(join(directory, 'lane2', 'packages', 'b', 'node_modules', 'dep')));
  assert.equal(
    readdirSync(cache).filter(name => name.startsWith('pnpm-') && !name.endsWith('.lock')).length,
    1,
  );
});

test('a declared version runs through corepack; without corepack the manager on PATH runs', async t => {
  const directory = scratch(t),
    cache = join(directory, 'cache'),
    calls = fakeManagers(t, directory, ['corepack', 'pnpm'], { pnpm: '9.9.9' });
  const viaCorepack = await share(repo(directory, 'lane', pnpmFiles()), cache);
  assert.equal(viaCorepack.status, 'installed');
  assert.ok(calls().some(line => line === 'corepack pnpm install --frozen-lockfile --ignore-scripts'));
  assert.equal(
    viaCorepack.key,
    dependencyKey(join(directory, 'lane'), '10.4.1'),
    'keyed on the declared version',
  );
  // No corepack: the PATH manager runs and its own version keys the install.
  rmSync(join(directory, 'bin', 'corepack'));
  const onPath = await share(repo(directory, 'lane-path', pnpmFiles()), cache);
  assert.equal(onPath.status, 'installed');
  assert.equal(onPath.key, dependencyKey(join(directory, 'lane-path'), '9.9.9'));
  assert.notEqual(onPath.key, viaCorepack.key);
});

test('yarn classic and berry use their frozen commands; berry never runs the committed release or scripts', async t => {
  const directory = scratch(t),
    cache = join(directory, 'cache'),
    calls = fakeManagers(t, directory, ['yarn'], { yarn: '4.5.0' });
  const berry = await share(repo(directory, 'berry', berryFiles()), cache);
  assert.equal(berry.status, 'installed');
  const line = calls().find(entry => entry.startsWith('yarn install'));
  assert.match(line, /^yarn install --immutable \| scripts=false ignorepath=1 \|/);
  assert.match(
    installScriptsNotice(berry),
    /Skipped install scripts of dependencies\. Run them with: yarn rebuild/,
  );
  // Classic: no packageManager, a v1 lockfile, a v1 yarn on PATH.
  const classicCalls = fakeManagers(t, join(directory, 'v1'), ['yarn'], { yarn: '1.22.22' });
  const classic = await share(
    repo(directory, 'classic', {
      'package.json': { name: 'x', workspaces: ['packages/*'] },
      'yarn.lock': '# yarn lockfile v1\n',
      ...workspaces,
    }),
    cache,
  );
  assert.equal(classic.status, 'installed');
  assert.ok(
    classicCalls().some(entry =>
      entry.startsWith('yarn install --frozen-lockfile --non-interactive --ignore-scripts'),
    ),
  );
});

test('bun installs the frozen lockfile without scripts', async t => {
  const directory = scratch(t),
    calls = fakeManagers(t, directory, ['bun'], { bun: '1.2.15' });
  const result = await share(repo(directory, 'lane', bunFiles()), join(directory, 'cache'));
  assert.equal(result.status, 'installed');
  assert.ok(calls().some(entry => entry.startsWith('bun install --frozen-lockfile --ignore-scripts')));
  assert.match(installScriptsNotice(result), /Run them with: bun pm trust --all/);
});

test('a declared build allowlist is a request: shown and skipped by default, rebuilt once this machine accepts it', async t => {
  const directory = scratch(t),
    calls = fakeManagers(t, directory, ['pnpm', 'bun', 'yarn'], {
      pnpm: '10.4.1',
      bun: '1.2.15',
      yarn: '4.5.0',
    }),
    cache = join(directory, 'cache');
  const asked = await share(
    repo(directory, 'pnpm-asked', pnpmFiles({}, { pnpm: { onlyBuiltDependencies: ['esbuild'] } })),
    cache,
  );
  assert.ok(!calls().some(l => l.startsWith('pnpm rebuild')), 'the repository alone runs nothing');
  assert.deepEqual(asked.skippedScripts, { packages: 2, command: 'pnpm rebuild' });
  assert.deepEqual(asked.requestedScripts, { source: 'package.json', packages: ['esbuild'] });
  assert.match(
    installScriptsNotice(asked),
    /package\.json asks to run esbuild; that is a request, not a permission\./,
  );
  acceptRequests(t, directory);
  const pnpm = await share(
    repo(directory, 'pnpm', pnpmFiles({}, { pnpm: { onlyBuiltDependencies: ['esbuild', 'not-in-lock'] } })),
    cache,
  );
  assert.ok(calls().some(l => l.startsWith('pnpm rebuild esbuild |')));
  assert.ok(!calls().some(l => l.includes('not-in-lock')), 'only lockfile packages are rebuilt');
  // The allowed package is no longer reported; the other build-script package still is.
  assert.deepEqual(pnpm.skippedScripts, { packages: 1, command: 'pnpm rebuild' });
  assert.deepEqual(pnpm.scripts, { ran: ['esbuild'], because: 'machine', source: 'package.json' });
  assert.notEqual(pnpm.path, asked.path, 'the rebuilt install is cached apart from the script-less one');
  const none = await share(repo(directory, 'pnpm-none', pnpmFiles()), cache);
  assert.equal(none.status, 'installed');
  assert.deepEqual(none.skippedScripts, { packages: 2, command: 'pnpm rebuild' });
  assert.match(
    installScriptsNotice(none),
    /^Skipped install scripts of 2 packages\. Run them with: pnpm rebuild \(in the Lane\), or start with \{"installScripts":true\}, or accept repository requests on this machine with nforge settings installScripts true\.$/,
  );
  await share(repo(directory, 'bun', bunFiles({}, { trustedDependencies: ['sharp'] })), cache);
  assert.ok(calls().some(l => l.startsWith('bun pm trust sharp |')));
  await share(repo(directory, 'berry', berryFiles({}, { dependenciesMeta: { a: { built: true } } })), cache);
  assert.ok(calls().some(l => l.startsWith('yarn rebuild a |')));
  // Opting in runs every script: no skip flag, no rebuild, no hint.
  const all = await share(repo(directory, 'pnpm-all', pnpmFiles()), cache, { runScripts: true });
  assert.equal(all.skippedScripts, undefined);
  assert.ok(calls().some(l => l.startsWith('pnpm install --frozen-lockfile |')));
});

test('layouts that cannot be shared safely report none with the reason and run nothing', async t => {
  const directory = scratch(t),
    calls = fakeManagers(t, directory, ['pnpm', 'yarn', 'bun']),
    cache = join(directory, 'cache');
  const reasons = async files => (await share(repo(directory, `r${Math.random()}`, files), cache)).reason;
  assert.match(await reasons(pnpmFiles({ '.pnpmfile.cjs': 'module.exports = {}' })), /\.pnpmfile\.cjs/);
  assert.match(
    await reasons(berryFiles({ '.yarnrc.yml': 'plugins:\n  - path: .yarn/plugins/x.cjs\n' })),
    /plugins/,
  );
  assert.match(await reasons(berryFiles({ '.yarnrc.yml': 'enableTelemetry: false\n' })), /Plug'n'Play/);
  assert.match(
    await reasons({ 'package.json': { name: 'x' }, 'yarn.lock': '', 'pnpm-lock.yaml': '' }),
    /More than one lockfile/,
  );
  assert.match(
    await reasons(
      pnpmFiles({
        'pnpm-lock.yaml': pnpmFiles()['pnpm-lock.yaml'].replace('packages/a: {}', 'packages/zzz: {}'),
      }),
    ),
    /Workspace packages\/zzz has no package.json/,
  );
  assert.deepEqual(calls(), [], 'nothing ran');
  // A declared manager that is not installed is never installed for the user.
  rmSync(join(directory, 'bin', 'bun'));
  assert.match(await reasons(bunFiles()), /bun is not installed.*does not install package managers/);
});

function realManager(command) {
  try {
    execFileSync(command, ['--version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}
for (const [name, files, prepare] of [
  ['pnpm', () => pnpmFiles({}, { packageManager: undefined }), ['install', '--lockfile-only']],
  ['bun', bunFiles, ['install', '--lockfile-only']],
]) {
  test(
    `real ${name}: workspace links point at each Lane's own sources and one install serves both`,
    { skip: !realManager(name) },
    async t => {
      const directory = scratch(t),
        cache = join(directory, 'cache'),
        source = repo(directory, 'source', files());
      if (name === 'pnpm') rmSync(join(source, 'pnpm-lock.yaml'));
      else rmSync(join(source, 'bun.lock'));
      execFileSync(name, prepare, { cwd: source, stdio: 'ignore' });
      rmSync(join(source, 'node_modules'), { recursive: true, force: true });
      for (const folder of ['a', 'b'])
        rmSync(join(source, 'packages', folder, 'node_modules'), { recursive: true, force: true });
      const lanes = ['one', 'two'].map(lane => {
        const root = join(directory, lane);
        cpSync(source, root, { recursive: true });
        // Each Lane edits workspace package a's CLI; its bin must run that edit, not a cached copy.
        writeFileSync(
          join(root, 'packages', 'a', 'cli.js'),
          `#!/usr/bin/env node\nconsole.log('lane ${lane}');\n`,
        );
        chmodSync(join(root, 'packages', 'a', 'cli.js'), 0o755);
        return root;
      });
      const results = [];
      for (const root of lanes) results.push(await share(root, cache));
      assert.deepEqual(
        results.map(r => r.status),
        ['installed', 'linked'],
      );
      for (const root of lanes) {
        // b depends on workspace package a: it must resolve to this Lane's a, not the cached copy.
        const link = [join(root, 'packages', 'b', 'node_modules', 'a'), join(root, 'node_modules', 'a')].find(
          path => {
            try {
              return lstatSync(path).isSymbolicLink();
            } catch {
              return false;
            }
          },
        );
        assert.ok(link, `${name}: workspace dependency linked`);
        assert.equal(realpathSync(link), realpathSync(join(root, 'packages', 'a')));
        const bin = [
          join(root, 'packages', 'b', 'node_modules', '.bin', 'a'),
          join(root, 'node_modules', '.bin', 'a'),
        ].find(path => existsSync(path));
        assert.ok(bin, `${name}: workspace bin linked`);
        assert.equal(
          execFileSync(bin, { encoding: 'utf8' }).trim(),
          `lane ${root.endsWith('one') ? 'one' : 'two'}`,
        );
      }
      assert.ok(existsSync(join(cache, `${name}-${results[0].key}`, '.forge-complete')));
    },
  );
}

// Issue de6620eb: `.bin` entries of workspace packages must run the Lane's own source, not the
// manifest-only copy in the shared install. The cached layouts below mirror what each manager writes.
function binScratch(t) {
  const directory = mkdtempSync(join(tmpdir(), 'forge-deps-bins-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  return directory;
}
const binPut = (path, content = '', mode) => {
  mkdirSync(join(path, '..'), { recursive: true });
  writeFileSync(join(path, ''), content);
  if (mode) chmodSync(path, mode);
};
const binLink = (target, path) => {
  mkdirSync(join(path, '..'), { recursive: true });
  symlinkSync(target, path);
};
const binScript = marker => `#!/usr/bin/env node\nconsole.log(${JSON.stringify(marker)});\n`;
/** A Lane whose workspace package `packages/tool` has been edited; the cache holds only its manifest. */
function binPair(directory) {
  const entry = join(directory, 'cache', 'entry'),
    root = join(directory, 'lane');
  for (const base of [entry, root]) {
    binPut(join(base, 'packages', 'tool', 'package.json'), '{"name":"tool","bin":"cli.js"}');
    binPut(join(base, 'packages', 'app', 'package.json'), '{"name":"app"}');
  }
  binPut(join(root, 'packages', 'tool', 'cli.js'), binScript('lane edit'), 0o755);
  binPut(join(entry, 'node_modules', 'jest', 'bin.js'), binScript('shared jest'), 0o755);
  return { entry, root };
}
const binRun = path => execFileSync(path, { encoding: 'utf8' }).trim();

test('npm: a workspace bin symlink beside the workspace link runs the Lane source; third-party stays shared', t => {
  const { entry, root } = binPair(binScratch(t));
  binLink('../packages/tool', join(entry, 'node_modules', 'tool'));
  binLink('../tool/cli.js', join(entry, 'node_modules', '.bin', 'tool'));
  binLink('../jest/bin.js', join(entry, 'node_modules', '.bin', 'jest'));
  linkInstall(entry, root, ['packages/tool']);
  assert.equal(binRun(join(root, 'node_modules', '.bin', 'tool')), 'lane edit');
  assert.equal(binRun(join(root, 'node_modules', '.bin', 'jest')), 'shared jest');
  assert.match(readlinkSync(join(root, 'node_modules', '.bin', 'tool')), /^\.\.\/.*packages\/tool\/cli\.js$/);
  assert.ok(lstatSync(join(root, 'node_modules', '.bin')).isDirectory(), '.bin is a Lane directory of links');
});

for (const name of ['yarn', 'bun']) {
  test(`${name}: a bin symlink that goes through the repository to a workspace file runs the Lane source`, t => {
    const { entry, root } = binPair(binScratch(t));
    binLink('../../packages/tool/cli.js', join(entry, 'node_modules', '.bin', 'tool'));
    binLink('../jest/bin.js', join(entry, 'node_modules', '.bin', 'jest'));
    // A workspace's own node_modules/.bin links to a sibling workspace the same way.
    binLink('../../../tool/cli.js', join(entry, 'packages', 'app', 'node_modules', '.bin', 'tool'));
    linkInstall(entry, root, ['packages/tool', 'packages/app']);
    assert.equal(binRun(join(root, 'node_modules', '.bin', 'tool')), 'lane edit');
    assert.equal(binRun(join(root, 'packages', 'app', 'node_modules', '.bin', 'tool')), 'lane edit');
    assert.equal(binRun(join(root, 'node_modules', '.bin', 'jest')), 'shared jest');
  });
}

test('pnpm: a shell shim that finds the workspace package next to .bin runs the Lane source', t => {
  const { entry, root } = binPair(binScratch(t));
  // `..` is followed physically by the shell (Node would collapse it lexically and hide the bug).
  binPut(join(root, 'packages', 'tool', 'cli.sh'), 'echo "lane edit"\n');
  const shim = `#!/bin/sh\nbasedir=$(dirname "$0")\nexec sh "$basedir/../tool/cli.sh" "$@"\n`;
  binLink('../../tool', join(entry, 'packages', 'app', 'node_modules', 'tool'));
  binPut(join(entry, 'packages', 'app', 'node_modules', '.bin', 'tool'), shim, 0o755);
  linkInstall(entry, root, ['packages/tool', 'packages/app']);
  // Run it as a command (not `sh FILE`): the system resolves a link to a script before it starts.
  assert.equal(binRun(join(root, 'packages', 'app', 'node_modules', '.bin', 'tool')), 'lane edit');
});

test('relinking costs one link per .bin entry and leaves no entry pointing into a workspace cache copy', t => {
  const { entry, root } = binPair(binScratch(t));
  for (const name of ['a', 'b', 'c']) binLink('../tool/cli.js', join(entry, 'node_modules', '.bin', name));
  binLink('../packages/tool', join(entry, 'node_modules', 'tool'));
  linkInstall(entry, root, ['packages/tool']);
  for (const name of ['a', 'b', 'c'])
    assert.equal(binRun(join(root, 'node_modules', '.bin', name)), 'lane edit');
});

// Real managers install from manifests alone, so they write no bin for a workspace package whose
// file is missing (observed: npm and bun create none; pnpm creates an empty .bin). The Lane's own
// package.json declares it, so the relink adds it beside the workspace link.
for (const name of ['npm', 'yarn', 'bun']) {
  test(`${name}: a workspace bin the cached install never made is linked to the Lane source`, t => {
    const { entry, root } = binPair(binScratch(t));
    binLink('../packages/tool', join(entry, 'node_modules', 'tool'));
    binLink('../jest/bin.js', join(entry, 'node_modules', '.bin', 'jest'));
    linkInstall(entry, root, ['packages/tool', 'packages/app']);
    assert.equal(binRun(join(root, 'node_modules', '.bin', 'tool')), 'lane edit');
    assert.equal(binRun(join(root, 'node_modules', '.bin', 'jest')), 'shared jest');
  });
}

test('pnpm: a workspace dependency gets its bin in the dependent package, from the Lane manifest', t => {
  const { entry, root } = binPair(binScratch(t));
  binLink('../../tool', join(entry, 'packages', 'app', 'node_modules', 'tool'));
  mkdirSync(join(entry, 'packages', 'app', 'node_modules', '.bin'), { recursive: true });
  linkInstall(entry, root, ['packages/tool', 'packages/app']);
  assert.equal(binRun(join(root, 'packages', 'app', 'node_modules', '.bin', 'tool')), 'lane edit');
});

test('bins come from the declared names only: scoped and object forms, no unsafe names or files', t => {
  const { entry, root } = binPair(binScratch(t));
  writeFileSync(
    join(root, 'packages', 'tool', 'package.json'),
    JSON.stringify({
      name: '@scope/tool',
      bin: {
        ok: 'cli.js',
        '../evil': 'cli.js',
        '.hidden': 'cli.js',
        'a/b': 'cli.js',
        outside: '../app/package.json',
      },
    }),
  );
  mkdirSync(join(entry, 'node_modules', '@scope'), { recursive: true });
  binLink('../../packages/tool', join(entry, 'node_modules', '@scope', 'tool'));
  linkInstall(entry, root, ['packages/tool', 'packages/app']);
  assert.equal(binRun(join(root, 'node_modules', '.bin', 'ok')), 'lane edit');
  assert.deepEqual(readdirSync(join(root, 'node_modules', '.bin')).sort(), ['ok']);
  writeFileSync(join(root, 'packages', 'tool', 'package.json'), '{"name":"@scope/tool","bin":"cli.js"}');
});

test('a package nothing links, and an existing third-party bin of the same name, are left alone', t => {
  const { entry, root } = binPair(binScratch(t));
  binPut(join(entry, 'node_modules', 'tool', 'real.js'), binScript('third party'), 0o755);
  binLink('../tool/real.js', join(entry, 'node_modules', '.bin', 'tool'));
  linkInstall(entry, root, ['packages/tool']);
  assert.equal(binRun(join(root, 'node_modules', '.bin', 'tool')), 'third party');
  const other = binScratch(t),
    second = binPair(other);
  mkdirSync(join(second.entry, 'node_modules'), { recursive: true });
  linkInstall(second.entry, second.root, ['packages/tool']);
  assert.equal(
    (() => {
      try {
        return readdirSync(join(second.root, 'node_modules', '.bin'));
      } catch {
        return [];
      }
    })().length,
    0,
  );
});
