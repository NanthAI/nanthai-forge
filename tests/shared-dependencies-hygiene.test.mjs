// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  chmodSync,
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readInstallScriptAllowlist } from '../dist/install-script-allowlist.js';
import {
  dependencyKey,
  npmInstaller,
  shareDependencies,
  skippedScriptsNotice,
} from '../dist/shared-dependencies.js';

function scratch(t) {
  const directory = mkdtempSync(join(tmpdir(), 'forge-deps-hygiene-'));
  const saved = { XDG_STATE_HOME: process.env.XDG_STATE_HOME, FORGE_HEAVY_DIR: process.env.FORGE_HEAVY_DIR };
  process.env.XDG_STATE_HOME = join(directory, 'state');
  process.env.FORGE_HEAVY_DIR = join(directory, 'heavy');
  t.after(() => {
    for (const [key, value] of Object.entries(saved))
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    rmSync(directory, { recursive: true, force: true });
  });
  return directory;
}
const lockOf = (packages = {}) => JSON.stringify({ lockfileVersion: 3, packages: { '': {}, ...packages } });
function lane(directory, name, { lock = lockOf(), manifest = { name: 'x' }, workspaces = {} } = {}) {
  const root = join(directory, name);
  mkdirSync(root);
  writeFileSync(join(root, 'package.json'), JSON.stringify(manifest));
  writeFileSync(join(root, 'package-lock.json'), lock);
  for (const [folder, content] of Object.entries(workspaces)) {
    mkdirSync(join(root, folder), { recursive: true });
    writeFileSync(join(root, folder, 'package.json'), content);
  }
  return root;
}
const fakeInstall = calls => async (stage, options) => {
  calls.push({
    stage,
    runScripts: options?.runScripts,
    rebuild: options?.rebuild,
    files: stageFiles(stage),
  });
  mkdirSync(join(stage, 'node_modules', 'dep'), { recursive: true });
};
const stageFiles = stage =>
  ['package.json', 'package-lock.json', 'packages/a/package.json', 'packages/b/package.json'].filter(file =>
    existsSync(join(stage, file)),
  );

test('npm ci skips install scripts by default and runs them only on request', async t => {
  const directory = scratch(t),
    bin = join(directory, 'bin'),
    log = join(directory, 'args.log');
  mkdirSync(bin);
  writeFileSync(join(bin, 'npm'), `#!/bin/sh\necho "$@" >> ${JSON.stringify(log)}\n`);
  chmodSync(join(bin, 'npm'), 0o755);
  const savedPath = process.env.PATH;
  process.env.PATH = `${bin}:${savedPath}`;
  t.after(() => (process.env.PATH = savedPath));
  const stage = join(directory, 'stage');
  mkdirSync(stage);
  await npmInstaller(stage);
  await npmInstaller(stage, { runScripts: false });
  await npmInstaller(stage, { runScripts: true });
  const lines = readFileSync(log, 'utf8').trim().split('\n');
  assert.equal(lines.length, 3);
  assert(lines[0].startsWith('ci --ignore-scripts '), lines[0]);
  assert(lines[1].startsWith('ci --ignore-scripts '), lines[1]);
  assert(!lines[2].includes('--ignore-scripts') && lines[2].startsWith('ci '), lines[2]);
});

test('skipped install scripts are named once, only when a package declared one', async t => {
  const directory = scratch(t),
    cache = join(directory, 'deps'),
    calls = [];
  const options = { install: fakeInstall(calls), enabled: true, cache, heavy: false };
  const plain = lane(directory, 'plain', {
    lock: lockOf({ 'node_modules/a': { version: '1.0.0' } }),
  });
  const quiet = await shareDependencies(plain, options);
  assert.equal(quiet.status, 'installed');
  assert.equal(quiet.skippedScripts, undefined);
  assert.equal(skippedScriptsNotice(quiet), null);

  const scripted = lane(directory, 'scripted', {
    lock: lockOf({ 'node_modules/native': { version: '1.0.0', hasInstallScript: true } }),
    manifest: { name: 'x', scripts: { postinstall: 'node setup.js' } },
  });
  const skipped = await shareDependencies(scripted, options);
  assert.equal(calls.at(-1).runScripts, false, 'default install runs no scripts');
  assert.deepEqual(skipped.skippedScripts, { packages: 2, command: 'npm rebuild' });
  const notice = skippedScriptsNotice(skipped);
  assert(notice.includes('2 packages') && notice.includes('npm rebuild') && !notice.includes('\n'));

  // The opt-in installs with scripts, in its own cache entry, and has nothing to report.
  const opted = lane(directory, 'opted', {
    lock: lockOf({ 'node_modules/native': { version: '1.0.0', hasInstallScript: true } }),
    manifest: { name: 'x', scripts: { postinstall: 'node setup.js' } },
  });
  const ran = await shareDependencies(opted, { ...options, runScripts: true });
  assert.equal(calls.at(-1).runScripts, true);
  assert.equal(ran.status, 'installed', 'a script-less cached install is not reused for the opt-in');
  assert.equal(skippedScriptsNotice(ran), null);
  assert.notEqual(ran.path, skipped.path);
});

test('workspace package.json files reach the install stage and the key', async t => {
  const directory = scratch(t),
    cache = join(directory, 'deps'),
    calls = [];
  const options = { install: fakeInstall(calls), enabled: true, cache, heavy: false };
  const packages = {
    'packages/a': { name: 'a', version: '1.0.0' },
    'node_modules/a': { resolved: 'packages/a', link: true },
    'packages/b': { name: 'b', version: '1.0.0' },
  };
  const make = (name, a) =>
    lane(directory, name, {
      lock: lockOf(packages),
      manifest: { name: 'x', workspaces: ['packages/*'] },
      workspaces: { 'packages/a': a, 'packages/b': '{"name":"b"}' },
    });
  const first = make('one', '{"name":"a"}');
  const result = await shareDependencies(first, options);
  assert.equal(result.status, 'installed');
  assert.deepEqual(calls[0].files, [
    'package.json',
    'package-lock.json',
    'packages/a/package.json',
    'packages/b/package.json',
  ]);
  assert(lstatSync(join(first, 'node_modules')).isDirectory(), 'a workspace repo gets per-entry links');
  assert(lstatSync(join(first, 'node_modules', 'dep')).isSymbolicLink());
  const changed = make('two', '{"name":"a","dependencies":{"left-pad":"1.0.0"}}');
  assert.notEqual(
    dependencyKey(first),
    dependencyKey(changed),
    'a workspace manifest change changes the key',
  );
  assert.equal(dependencyKey(make('three', '{"name":"a"}')), dependencyKey(first));
});

test('a workspace the stage cannot copy reports none with the reason, never an opaque failure', async t => {
  const directory = scratch(t),
    cache = join(directory, 'deps'),
    calls = [];
  const options = { install: fakeInstall(calls), enabled: true, cache, heavy: false };
  const missing = lane(directory, 'missing', {
    lock: lockOf({ 'packages/a': { name: 'a', version: '1.0.0' } }),
    manifest: { name: 'x', workspaces: ['packages/*'] },
  });
  const none = await shareDependencies(missing, options);
  assert.equal(none.status, 'none');
  assert(none.reason.includes('packages/a'), none.reason);
  const outside = lane(directory, 'outside', {
    lock: lockOf({ '../sibling': { name: 's', version: '1.0.0' } }),
  });
  const escaped = await shareDependencies(outside, options);
  assert.equal(escaped.status, 'none');
  assert(escaped.reason.includes('outside'), escaped.reason);
  assert.equal(calls.length, 0, 'nothing was installed');
  assert(!existsSync(join(missing, 'node_modules')));
  assert.deepEqual(
    existsSync(cache) ? readdirSync(cache).filter(name => name.includes('.tmp-')) : [],
    [],
    'no partial stage stays in the cache',
  );
});

test('start accepts the client-only installScripts flag and rejects a non-boolean', async t => {
  const { agentFixture } = await import('./hosted-agent-fixture.mjs');
  const { validateHostedCliCommand } = await import('../dist/hosted-cli-validation.js');
  const f = agentFixture(t);
  assert.doesNotThrow(() =>
    validateHostedCliCommand(f.root, 'start', { outcome: 'x', installScripts: true }),
  );
  assert.throws(
    () => validateHostedCliCommand(f.root, 'start', { outcome: 'x', installScripts: 'yes' }),
    /installScripts/,
  );
});

test('a repository build-script allowlist is read from every ecosystem file, nothing declared reads null', t => {
  const directory = scratch(t);
  const make = (name, files) => {
    const root = join(directory, name);
    mkdirSync(root);
    for (const [file, content] of Object.entries(files)) writeFileSync(join(root, file), content);
    return root;
  };
  assert.equal(readInstallScriptAllowlist(make('none', { 'package.json': '{"name":"x"}' })), null);
  assert.equal(readInstallScriptAllowlist(make('missing', {})), null);
  assert.deepEqual(
    readInstallScriptAllowlist(
      make('pnpm-yaml', {
        'pnpm-workspace.yaml':
          'packages:\n  - a\nonlyBuiltDependencies:\n  - electron\n  - "node-pty"\n# c\nallowBuilds:\n  esbuild: true\n  nope: false\nother: 1\n',
      }),
    ),
    { source: 'pnpm-workspace.yaml', packages: ['electron', 'esbuild', 'node-pty'] },
  );
  assert.deepEqual(
    readInstallScriptAllowlist(
      make('manifest', {
        'package.json': JSON.stringify({
          pnpm: { onlyBuiltDependencies: ['a'], allowBuilds: { b: true, c: false } },
          trustedDependencies: ['d'],
          dependenciesMeta: { e: { built: true }, f: { built: false } },
        }),
      }),
    ),
    { source: 'package.json', packages: ['a', 'b', 'd', 'e'] },
  );
  assert.deepEqual(readInstallScriptAllowlist(make('yarn', { '.yarnrc.yml': 'enableScripts: true\n' })), {
    source: '.yarnrc.yml',
    all: true,
  });
  assert.equal(
    readInstallScriptAllowlist(make('yarn-off', { '.yarnrc.yml': 'enableScripts: false\n' })),
    null,
  );
  assert.deepEqual(
    readInstallScriptAllowlist(make('empty', { 'package.json': '{"trustedDependencies":[]}' })),
    { source: 'package.json', packages: [] },
    'an explicit empty list is a declaration that allows nothing',
  );
});

test('allowlisted packages are rebuilt after a script-less install and no longer reported as skipped', async t => {
  const directory = scratch(t),
    cache = join(directory, 'deps'),
    calls = [];
  const options = { install: fakeInstall(calls), enabled: true, cache, heavy: false };
  const lock = lockOf({
    'node_modules/node-pty': { version: '1.0.0', hasInstallScript: true },
    'node_modules/electron': { version: '1.0.0', hasInstallScript: true },
    'node_modules/other': { version: '1.0.0', hasInstallScript: true },
    'node_modules/a/node_modules/@s/native': { version: '1.0.0', hasInstallScript: true },
  });
  const allowed = lane(directory, 'allowed', {
    lock,
    manifest: { name: 'x', trustedDependencies: ['node-pty', '@s/native', 'not-in-lock'] },
  });
  const result = await shareDependencies(allowed, options);
  assert.equal(calls.at(-1).runScripts, false, 'blanket scripts stay off');
  assert.deepEqual(calls.at(-1).rebuild, ['@s/native', 'node-pty']);
  assert.deepEqual(result.skippedScripts, { packages: 2, command: 'npm rebuild' });
  const plain = lane(directory, 'plain', { lock, manifest: { name: 'x' } });
  assert.notEqual(dependencyKey(allowed), dependencyKey(plain), 'the allowlist is part of the install key');
  const everything = lane(directory, 'everything', { lock, manifest: { name: 'x' } });
  writeFileSync(join(everything, '.yarnrc.yml'), 'enableScripts: true\n');
  const all = await shareDependencies(everything, options);
  assert.equal(calls.at(-1).runScripts, true, 'a repository that enables scripts runs them');
  assert.equal(all.skippedScripts, undefined);
});

test('npm rebuild runs only for allowlisted packages after a script-less ci', async t => {
  const directory = scratch(t),
    bin = join(directory, 'bin'),
    log = join(directory, 'args.log');
  mkdirSync(bin);
  writeFileSync(join(bin, 'npm'), `#!/bin/sh\necho "$@" >> ${JSON.stringify(log)}\n`);
  chmodSync(join(bin, 'npm'), 0o755);
  const savedPath = process.env.PATH;
  process.env.PATH = `${bin}:${savedPath}`;
  t.after(() => (process.env.PATH = savedPath));
  await npmInstaller(directory, { rebuild: ['node-pty'] });
  await npmInstaller(directory, { runScripts: true, rebuild: ['node-pty'] });
  const lines = readFileSync(log, 'utf8').trim().split('\n');
  assert.equal(lines.length, 3);
  assert(lines[0].startsWith('ci --ignore-scripts '));
  assert(lines[1].startsWith('rebuild ') && lines[1].endsWith(' node-pty'), lines[1]);
  assert(
    lines[2].startsWith('ci ') && !lines[2].includes('--ignore-scripts'),
    'opt-in installs once, no rebuild',
  );
});

/** What npm leaves in the shared install: sibling workspace links are relative and sit in the root. */
const siblingInstall = calls => async (stage, options) => {
  await fakeInstall(calls)(stage, options);
  symlinkSync('../packages/a', join(stage, 'node_modules', 'a'), 'dir');
  symlinkSync('../packages/b', join(stage, 'node_modules', 'b'), 'dir');
};
const siblingPackages = {
  'packages/a': { name: 'a', version: '1.0.0' },
  'node_modules/a': { resolved: 'packages/a', link: true },
  'packages/b': { name: 'b', version: '1.0.0' },
  'node_modules/b': { resolved: 'packages/b', link: true },
};
function siblingLane(directory, name, answer) {
  const root = lane(directory, name, {
    lock: lockOf(siblingPackages),
    manifest: { name: 'x', workspaces: ['packages/*'] },
    workspaces: {
      'packages/a': '{"name":"a","main":"index.js"}',
      'packages/b': '{"name":"b","main":"index.js"}',
    },
  });
  writeFileSync(join(root, 'packages', 'b', 'index.js'), `module.exports = ${JSON.stringify(answer)};\n`);
  writeFileSync(join(root, 'packages', 'a', 'index.js'), "module.exports = require('b');\n");
  return root;
}

test("npm workspaces: package a loads the Lane's own edit of sibling b, with one install and no reinstall", async t => {
  const directory = scratch(t),
    cache = join(directory, 'deps'),
    calls = [],
    options = { install: siblingInstall(calls), enabled: true, cache, heavy: false };
  const roots = [siblingLane(directory, 'one', 'lane one'), siblingLane(directory, 'two', 'lane two')];
  const results = [];
  for (const root of roots) results.push(await shareDependencies(root, options));
  assert.deepEqual(
    results.map(r => r.status),
    ['installed', 'linked'],
  );
  assert.equal(calls.length, 1, 'no install on a cache hit');
  for (const [index, root] of roots.entries()) {
    assert.equal(realpathSync(join(root, 'node_modules', 'b')), realpathSync(join(root, 'packages', 'b')));
    assert.equal(
      execFileSync(process.execPath, ['-p', "require('a')"], { cwd: join(root, 'packages', 'a') })
        .toString()
        .trim(),
      index ? 'lane two' : 'lane one',
    );
    assert(lstatSync(join(root, 'node_modules', 'dep')).isSymbolicLink(), 'other packages stay shared links');
  }
  // Editing b in the Lane is seen by a straight away; the shared copy is untouched.
  writeFileSync(join(roots[0], 'packages', 'b', 'index.js'), "module.exports = 'edited';\n");
  assert.equal(
    execFileSync(process.execPath, ['-p', "require('a')"], { cwd: join(roots[0], 'packages', 'a') })
      .toString()
      .trim(),
    'edited',
  );
  const entry = join(
    cache,
    readdirSync(cache).find(name => name.startsWith('npm-') && !name.endsWith('.lock')),
  );
  assert.equal(
    existsSync(join(entry, 'packages', 'b', 'index.js')),
    false,
    'the cached copy stays manifest-only',
  );
});

test('npm without workspaces still gets the single root link', async t => {
  const directory = scratch(t),
    root = lane(directory, 'plain'),
    result = await shareDependencies(root, {
      install: fakeInstall([]),
      enabled: true,
      cache: join(directory, 'deps'),
      heavy: false,
    });
  assert.equal(result.status, 'installed');
  assert(lstatSync(join(root, 'node_modules')).isSymbolicLink());
});

function realNpm() {
  try {
    execFileSync('npm', ['--version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}
test("real npm ci: sibling workspace links reach each Lane's own source", { skip: !realNpm() }, async t => {
  const directory = scratch(t),
    cache = join(directory, 'deps'),
    source = siblingLane(directory, 'source', 'source');
  execFileSync('npm', ['install', '--package-lock-only', '--offline', '--ignore-scripts'], {
    cwd: source,
    stdio: 'ignore',
  });
  const roots = ['one', 'two'].map(name => {
    const root = join(directory, name);
    mkdirSync(root);
    for (const file of ['package.json', 'package-lock.json', 'packages'])
      cpSync(join(source, file), join(root, file), { recursive: true });
    writeFileSync(join(root, 'packages', 'b', 'index.js'), `module.exports = ${JSON.stringify(name)};\n`);
    return root;
  });
  const results = [];
  for (const root of roots)
    results.push(await shareDependencies(root, { enabled: true, cache, heavy: false }));
  assert.deepEqual(
    results.map(r => r.status),
    ['installed', 'linked'],
  );
  for (const root of roots)
    assert.equal(
      execFileSync(process.execPath, ['-p', "require('a')"], { cwd: join(root, 'packages', 'a') })
        .toString()
        .trim(),
      root.endsWith('one') ? 'one' : 'two',
    );
});

test('forge.json install.scripts runs install scripts with no start flag; an explicit flag still wins', async t => {
  const directory = scratch(t),
    cache = join(directory, 'deps'),
    calls = [];
  const options = { install: fakeInstall(calls), enabled: true, cache, heavy: false };
  const lock = lockOf({ 'node_modules/native': { version: '1.0.0', hasInstallScript: true } });
  const opted = lane(directory, 'opted', { lock });
  writeFileSync(join(opted, 'forge.json'), JSON.stringify({ install: { scripts: true } }));
  assert.deepEqual(readInstallScriptAllowlist(opted), { source: 'forge.json', all: true });
  const ran = await shareDependencies(opted, options);
  assert.equal(calls.at(-1).runScripts, true, 'the project setting runs scripts without a flag');
  assert.equal(ran.skippedScripts, undefined);
  // Without the setting (absent, false, malformed), scripts stay skipped.
  for (const [name, text] of [
    ['absent', undefined],
    ['off', JSON.stringify({ install: { scripts: false } })],
    ['malformed', '{"install":'],
  ]) {
    const root = lane(directory, name, { lock, manifest: { name } });
    const before = calls.length;
    if (text !== undefined) writeFileSync(join(root, 'forge.json'), text);
    const result = await shareDependencies(root, options);
    assert.equal(calls.length, before + 1, name);
    assert.equal(calls.at(-1).runScripts, false, name);
    assert.match(skippedScriptsNotice(result), /forge\.json/, name);
  }
  // The start flag wins over the project file, both ways.
  const flagged = lane(directory, 'flagged', { lock, manifest: { name: 'flagged' } });
  writeFileSync(join(flagged, 'forge.json'), JSON.stringify({ install: { scripts: true } }));
  await shareDependencies(flagged, { ...options, runScripts: false });
  assert.equal(calls.at(-1).runScripts, false, 'installScripts:false wins over forge.json');
});
