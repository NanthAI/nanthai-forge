// SPDX-License-Identifier: Apache-2.0
// One synthetic fixture repository per registry ecosystem (tests/fixtures/ecosystems/ID), read the
// way Forge reads a real one. Each case also shows that dropping the entry from the registry
// (src/ecosystems.ts) loses what the fixture needs.
// Swift, Kotlin and Dart use path → text trees instead (tests/fixtures/ecosystem-repos/ID.json):
// detection, pins, folders, test names, the package graph and its commands, the code map and the
// check environment, each failing when the ecosystem's entry is missing.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  chmodSync,
  cpSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import * as registry from '../dist/ecosystems.js';
import { buildPackageGraph, packageSelection } from '../dist/package-graph.js';
import { ecosystemInstall, installRequest } from '../dist/ecosystem-install.js';
import { CACHE_SEEDS, DEPS_SEED_PROGRAM } from '../dist/actions-toolchains.js';
import { hostedToolchains, hostedUnsupportedTools } from '../dist/actions-toolchains-hosted.js';
import { indexRepository } from '../dist/index.js';
import { validateArtifact } from '../dist/artifact-validation.js';
import { fixture } from './helpers.mjs';
import { sourceLanguage } from '../dist/languages.js';
import {
  ECOSYSTEMS,
  codeMapLanguages,
  dependencyDirs,
  ecosystemEntry,
  knownLockfiles,
  manifestNames,
  pinLockfiles,
  regenerableDirs,
} from '../dist/ecosystems.js';
import { packageManifestPath } from '../dist/package-graph.js';
import { testStem } from '../dist/hosted-landing-suspect.js';
import { ecosystemCheckEnvironment } from '../dist/check-ecosystem-env.js';
import { readPubspec } from '../dist/package-graph-pub.js';
import { scanBraces } from '../dist/structural-brace-scan.js';
import { packagePlacement, pinnedPackagePlacement } from '../dist/package-placement.js';

const FIXTURES = new URL('./fixtures/ecosystems/', import.meta.url);
function fixtureFiles(id) {
  const root = new URL(`${id}/`, FIXTURES).pathname;
  const files = readdirSync(root, { recursive: true, withFileTypes: true })
    .filter(entry => entry.isFile())
    .map(entry => relative(root, join(entry.parentPath, entry.name)))
    .sort();
  const read = path => {
    try {
      return readFileSync(join(root, path), 'utf8');
    } catch {
      return undefined;
    }
  };
  return { root, files, read };
}
/** The fixture with some files replaced (`undefined` removes one). */
function variant(id, changes) {
  const { files, read } = fixtureFiles(id);
  const paths = [...new Set([...files, ...Object.keys(changes)])].filter(
    path => !(path in changes) || changes[path] !== undefined,
  );
  return buildPackageGraph(paths, path => (path in changes ? changes[path] : read(path)));
}
const graphOf = id => {
  const { files, read } = fixtureFiles(id);
  return buildPackageGraph(files, read);
};
const shape = graph =>
  graph.packages.map(pkg => [pkg.dir || '.', pkg.name, pkg.dependsOn, pkg.testable, pkg.declared]);

/** What each fixture needs from its entry. */
const NEEDS = {
  elixir: {
    manager: 'mix',
    manifest: 'mix.exs',
    lockfile: 'mix.lock',
    language: 'elixir',
    file: 'apps/core/lib/core.ex',
    preset: 'hex',
    tool: 'elixir',
    dir: '_build',
  },
  ruby: {
    manager: 'bundler',
    manifest: 'Gemfile',
    lockfile: 'Gemfile.lock',
    language: 'ruby',
    file: 'gems/util/lib/util.rb',
    preset: 'bundler',
    tool: 'ruby',
    // `vendor` is shared by Ruby and PHP, so neither entry alone owns it.
  },
  php: {
    manager: 'composer',
    manifest: 'composer.json',
    lockfile: 'composer.lock',
    language: 'php',
    file: 'packages/money/src/Money.php',
    preset: 'composer',
    tool: 'php',
  },
};

test('each fixture ecosystem has its registry entry, and every consumer loses it without the entry', () => {
  for (const [id, need] of Object.entries(NEEDS)) {
    const { files } = fixtureFiles(id);
    assert.ok(files.includes(need.manifest) && files.includes(need.lockfile), id);
    const without = registry.ECOSYSTEMS.filter(entry => entry.id !== id);
    const tables = entries => ({
      pinned: registry.pinLockfiles(entries).includes(need.lockfile),
      manager: registry.managerLockfiles(entries).get(need.manager)?.includes(need.lockfile) ?? false,
      manifest: registry.manifestNames(entries).has(need.manifest),
      codeMap: registry
        .codeMapLanguages(entries)
        .some(([pattern, language]) => language === need.language && pattern.test(need.file)),
      code: registry.codeFilePattern(entries).test(need.file),
      preset: registry.cachePresets(entries).has(need.preset),
      tool: registry.actionsTools(entries).includes(need.tool),
      ...(need.dir ? { regenerable: registry.regenerableDirs(entries).has(need.dir) } : {}),
    });
    const all = Object.fromEntries(Object.keys(tables(registry.ECOSYSTEMS)).map(key => [key, true]));
    assert.deepEqual(tables(registry.ECOSYSTEMS), all, id);
    assert.deepEqual(tables(without), Object.fromEntries(Object.keys(all).map(key => [key, false])), id);
    assert.equal(sourceLanguage(need.file), need.language);
  }
});

test('Elixir: umbrella apps and in_umbrella deps select dependents for mix test per app', () => {
  const graph = graphOf('elixir');
  assert.equal(graph.status, 'available');
  assert.deepEqual(shape(graph), [
    ['apps/core', 'core', [], true, true],
    ['apps/web', 'web', ['mix:apps/core'], true, true],
    ['.', '.', [], false, false],
  ]);
  assert.equal(graph.packages.find(pkg => !pkg.dir).virtual, true);
  const selection = packageSelection(graph, ['apps/core/lib/core.ex']);
  assert.equal(selection.scope, 'scoped');
  assert.deepEqual(
    selection.commands.map(command => [command.cwd, command.argv.join(' ')]),
    [
      ['apps/core', 'mix test'],
      ['apps/web', 'mix test'],
    ],
  );
  assert.deepEqual(
    packageSelection(graph, ['apps/web/test/web_test.exs']).commands.map(command => command.cwd),
    ['apps/web'],
  );
  // Root config is every app's input: a full run.
  assert.equal(packageSelection(graph, ['config/config.exs']).scope, 'full');
  const missing = variant('elixir', {
    'apps/web/mix.exs':
      'defmodule W do\n  def project, do: [app: :web, deps: [{:billing, in_umbrella: true}, {:x, path: "../../x"}]]\nend\n',
  });
  assert.match(missing.packages.find(pkg => pkg.dir === 'apps/web').unresolved, /billing from its umbrella/);
});

test('Ruby: Gemfile path gems and gemspec dependencies select dependents; rspec and rake test commands', () => {
  const graph = graphOf('ruby');
  assert.deepEqual(shape(graph), [
    ['.', '.', ['bundler:gems/shop', 'bundler:gems/util'], false, false],
    ['gems/shop', 'shop', ['bundler:gems/util'], true, false],
    ['gems/util', 'util', [], true, false],
  ]);
  const selection = packageSelection(graph, ['gems/util/lib/util.rb']);
  assert.equal(selection.scope, 'scoped');
  assert.deepEqual(
    selection.commands.map(command => [command.cwd, command.argv.join(' ')]),
    [
      ['gems/shop', 'bundle exec rake test'],
      ['gems/util', 'bundle exec rspec'],
    ],
  );
  // Minitest files without a Rakefile have no command of their own: the selection is full.
  const noRake = variant('ruby', { 'gems/shop/Rakefile': undefined });
  assert.equal(noRake.packages.find(pkg => pkg.dir === 'gems/shop').hiddenTests, 'gems/shop/test');
  assert.equal(packageSelection(noRake, ['gems/util/lib/util.rb']).scope, 'full');
  const evaluated = variant('ruby', {
    Gemfile: 'source "https://rubygems.org"\neval_gemfile "Gemfile.local"\ngem "x", path: "gems/none"\n',
  });
  assert.match(evaluated.packages.find(pkg => !pkg.dir).unresolved, /evaluates another file/);
});

test('PHP: composer path repositories and require names select dependents; phpunit runs from the installed root', () => {
  const graph = graphOf('php');
  assert.deepEqual(shape(graph), [
    ['.', 'acme/shop', ['composer:packages/billing'], false, false],
    ['packages/billing', 'acme/billing', ['composer:packages/money'], true, false],
    ['packages/money', 'acme/money', [], true, false],
  ]);
  const selection = packageSelection(graph, ['packages/money/src/Money.php']);
  assert.deepEqual(
    selection.commands.map(command => [command.cwd, command.argv.join(' ')]),
    [
      ['', 'vendor/bin/phpunit --configuration=packages/billing/phpunit.xml.dist'],
      ['', 'vendor/bin/phpunit --configuration=packages/money/phpunit.xml.dist'],
    ],
  );
  assert.deepEqual(
    packageSelection(graph, ['packages/billing/src/Invoice.php']).commands.map(command =>
      command.argv.at(-1),
    ),
    ['--configuration=packages/billing/phpunit.xml.dist'],
  );
  // A package with its own lockfile installs and tests in its own folder.
  const own = variant('php', { 'packages/money/composer.lock': '{}' });
  assert.deepEqual(
    packageSelection(own, ['packages/money/src/Money.php']).commands.find(
      command => command.cwd === 'packages/money',
    )?.argv,
    ['vendor/bin/phpunit'],
  );
  const missing = variant('php', {
    'composer.json': JSON.stringify({ name: 'acme/shop', repositories: [{ type: 'path', url: 'lib/*' }] }),
  });
  assert.match(missing.packages.find(pkg => !pkg.dir).unresolved, /path repository lib\/\*/);
  const untested = variant('php', { 'packages/money/phpunit.xml.dist': undefined });
  assert.equal(
    untested.packages.find(pkg => pkg.dir === 'packages/money').hiddenTests,
    'packages/money/tests/MoneyTest.php',
  );
  assert.equal(variant('php', { 'composer.json': '{' }).status, 'unknown');
});

test('the code map reads Ruby, PHP and Elixir declarations and resolves their imports without running them', t => {
  for (const [id, expect] of Object.entries({
    elixir: {
      names: ['Core', 'total', 'Item', 'Web', 'checkout'],
      private: ['price'],
      edges: [['apps/web/lib/web.ex', 'Shop.Core', 'apps/core/lib/core.ex']],
    },
    ruby: {
      names: ['Util', 'Money', 'to_s', 'Shop', 'Cart', 'total'],
      private: ['secret'],
      edges: [
        ['gems/shop/lib/shop.rb', 'util', 'gems/util/lib/util.rb'],
        ['gems/shop/lib/shop.rb', 'shop/version', 'gems/shop/lib/shop/version.rb'],
      ],
    },
    php: {
      names: ['Money', 'cents', 'Invoice', 'Payable', 'invoice_helper'],
      private: ['format'],
      edges: [['packages/billing/src/Invoice.php', 'Acme\\Money\\Money', 'packages/money/src/Money.php']],
    },
  })) {
    const { files, read } = fixtureFiles(id);
    const pack = indexRepository(fixture(t, Object.fromEntries(files.map(path => [path, read(path)])))).pack;
    validateArtifact(pack);
    assert.ok(
      pack.analysis.languages.some(item => item.language === NEEDS[id].language),
      id,
    );
    assert.deepEqual(
      pack.issues.filter(issue => /_SYNTAX$/.test(issue.code)),
      [],
      id,
    );
    for (const name of expect.names)
      assert.ok(
        pack.nodes.some(node => node.name === name && node.exported),
        `${id} ${name}`,
      );
    for (const name of expect.private)
      assert.ok(
        pack.nodes.some(node => node.name === name && !node.exported),
        `${id} private ${name}`,
      );
    for (const [from, specifier, target] of expect.edges)
      assert.ok(
        pack.imports.some(
          edge => edge.from === from && edge.specifier === specifier && edge.target === target,
        ),
        `${id} ${from} -> ${target}`,
      );
  }
});

test('an unbalanced Ruby, PHP or Elixir file is a syntax issue, not a guess', t => {
  const base = fixture(t, {
    'bad.rb': 'class A\n  def b\nend\n',
    'bad.php': '<?php class A { function b() { }\n',
    'bad.ex': 'defmodule A do\n  def b do\nend\n',
  });
  const pack = indexRepository(base).pack;
  assert.deepEqual(pack.issues.map(issue => [issue.file, issue.code]).sort(), [
    ['bad.ex', 'ELIXIR_SYNTAX'],
    ['bad.php', 'PHP_SYNTAX'],
    ['bad.rb', 'RUBY_SYNTAX'],
  ]);
});

test('install: Composer scripts and plugins, gem extensions and mix.exs run only when the repository asks and the user accepts', () => {
  const { read } = fixtureFiles('php');
  // The fixture asks for one plugin (config.allow-plugins) and has a post-install script.
  assert.deepEqual(installRequest('composer', read), {
    source: 'composer.json',
    packages: ['acme/installer'],
  });
  assert.deepEqual(ecosystemInstall('composer', read, { machine: false }).argv, [
    'composer',
    'install',
    '--no-interaction',
    '--no-scripts',
    '--no-plugins',
  ]);
  // Accepted on this machine: Composer enforces its own plugin allowlist; scripts stay off.
  const accepted = ecosystemInstall('composer', read, { machine: true });
  assert.equal(accepted.scripts, 'allowlist');
  assert.deepEqual(accepted.argv.slice(3), ['--no-scripts']);
  assert.deepEqual(ecosystemInstall('composer', read, { machine: true, startFlag: false }).argv.slice(3), [
    '--no-scripts',
    '--no-plugins',
  ]);
  assert.deepEqual(ecosystemInstall('composer', read, { machine: false, startFlag: true }).argv.slice(3), []);
  // No allowlist: nothing runs even when the machine accepts requests.
  const bare = path => (path === 'composer.json' ? '{"name":"a/b"}' : undefined);
  assert.equal(ecosystemInstall('composer', bare, { machine: true }).scripts, 'none');
  for (const [manager, file] of [
    ['bundler', 'Gemfile'],
    ['mix', 'mix.exs'],
  ]) {
    const repo = path => (path === file ? 'code' : undefined);
    assert.match(ecosystemInstall(manager, repo, { machine: true }).refusal, /runs .* installScripts:true/);
    const asked = path => (path === 'forge.json' ? '{"install":{"scripts":true}}' : repo(path));
    assert.match(ecosystemInstall(manager, asked, { machine: false }).refusal, /installScripts/);
    assert.equal(ecosystemInstall(manager, asked, { machine: true }).scripts, 'all');
    assert.equal(
      ecosystemInstall(manager, repo, { machine: false, startFlag: true }).argv.join(' '),
      manager === 'mix' ? 'mix deps.get' : 'bundle install',
    );
  }
  // Seeds: Composer's downloads with scripts and plugins off; Gemfile and mix.exs are code, never seeded.
  for (const flag of ['--no-scripts', '--no-plugins']) assert.ok(CACHE_SEEDS.composer.command.includes(flag));
  assert.equal(CACHE_SEEDS.bundler, undefined);
  assert.equal(CACHE_SEEDS.hex, undefined);
});

test('the Candidate-free Composer seed copies only composer.json and the lockfile and passes the script flags', t => {
  const base = mkdtempSync(join(tmpdir(), 'forge-composer-seed-'));
  t.after(() => rmSync(base, { recursive: true, force: true }));
  const root = join(base, 'repo');
  cpSync(fixtureFiles('php').root, root, { recursive: true });
  writeFileSync(join(root, 'auth.json'), '{}');
  const bin = join(base, 'bin');
  mkdirSync(bin);
  const record = join(base, 'record.txt');
  // A stand-in composer records its arguments and the folder it ran in.
  writeFileSync(
    join(bin, 'composer'),
    `#!/bin/sh\nprintf '%s\\n' "$*" >> "${record}"\nls -A >> "${record}"\n`,
  );
  chmodSync(join(bin, 'composer'), 0o755);
  const run = spawnSync(process.execPath, ['-e', DEPS_SEED_PROGRAM, root, 'composer'], {
    env: { PATH: `${bin}:/usr/bin:/bin` },
    encoding: 'utf8',
  });
  assert.equal(run.status, 0, run.stderr);
  assert.match(run.stdout, /Forge seed: composer composer\.lock downloaded/);
  const [argv, ...listing] = readFileSync(record, 'utf8').trim().split('\n');
  assert.match(argv, /^install --no-interaction --no-scripts --no-plugins --no-autoloader/);
  assert.deepEqual(listing.sort(), ['composer.json', 'composer.lock']);
});

test('the fixed App/OIDC workflow refuses Elixir, Ruby and PHP toolchains by name instead of skipping them', () => {
  const declaration = {
    toolchains: [
      { tool: 'go', version: '1.23' },
      { tool: 'ruby', version: '3.3' },
      { tool: 'php', versionFile: '.php-version' },
    ],
  };
  assert.deepEqual(hostedUnsupportedTools(declaration), ['ruby', 'php']);
  assert.deepEqual(Object.keys(hostedToolchains(declaration)), ['go']);
  assert.deepEqual(hostedUnsupportedTools({ toolchains: [{ tool: 'rust', version: '1.82.0' }] }), []);
  // Zig and CMake have their own hosted blocks (hostedLateToolBlocks), so they are never refused here.
  assert.deepEqual(
    hostedUnsupportedTools({
      toolchains: [
        { tool: 'zig', version: '0.14.0' },
        { tool: 'cmake', version: '3.31.6' },
      ],
    }),
    [],
  );
});

// Swift, Kotlin/Android and Dart/Flutter (Issue 870791c3).
const repo = id =>
  JSON.parse(readFileSync(new URL(`./fixtures/ecosystem-repos/${id}.json`, import.meta.url), 'utf8'));
const treeGraph = tree => buildPackageGraph(Object.keys(tree), path => tree[path]);
const commands = selection => (selection.commands ?? []).map(c => [c.cwd || '.', ...c.argv].join(' '));
const symbols = (pack, file) =>
  pack.nodes
    .filter(n => n.locator.file === file && n.kind !== 'File')
    .map(n => `${n.kind}:${n.name}${n.exported ? '' : ' (private)'}`);
const edges = (pack, file) => pack.imports.filter(i => i.from === file).map(i => i.target ?? i.resolution);
function codeMap(t, tree) {
  const { pack } = indexRepository(fixture(t, tree));
  validateArtifact(pack);
  return pack;
}
/** The placement pin round-trips the ecosystem (the first-check proof reads it in Convex). */
function pinRoundTrip(graph) {
  const pinned = pinnedPackagePlacement({ packagePlacement: packagePlacement(graph) });
  assert.ok(pinned, 'pinned placement');
  assert.deepEqual(
    pinned.packages.map(p => `${p.ecosystem}:${p.dir}`),
    graph.packages.map(p => `${p.ecosystem}:${p.dir}`),
  );
}

test('Swift: SwiftPM and Xcode are detected, pinned, cleaned and tested from the registry entry', t => {
  const tree = repo('swift');
  const entry = ecosystemEntry('swift');
  assert.ok(manifestNames().has('Package.swift'));
  assert.ok(pinLockfiles().includes('Package.resolved'));
  assert.ok(knownLockfiles().includes('Podfile.lock'));
  for (const dir of ['.build', '.swiftpm', 'DerivedData', 'Pods']) assert.ok(regenerableDirs().has(dir), dir);
  assert.ok(packageManifestPath('Packages/Core/Package.swift'));
  assert.equal(sourceLanguage('Packages/Core/Sources/Core/Point.swift'), 'swift');
  assert.equal(testStem('Packages/Core/Tests/CoreTests/PointTests.swift'), 'point');
  assert.ok(entry.actions.cache.swiftpm.lockfiles.includes('**/Package.resolved'));

  // Without the Xcode app, a Core change runs `swift test` in Core and in Feature, which uses it.
  const packages = Object.fromEntries(Object.entries(tree).filter(([path]) => !path.startsWith('App/')));
  const graph = treeGraph(packages);
  assert.equal(graph.status, 'available');
  assert.deepEqual(
    graph.packages.map(p => [p.ecosystem, p.dir, p.dependsOn]),
    [
      ['swiftpm', 'Packages/Core', []],
      ['swiftpm', 'Packages/Feature', ['swiftpm:Packages/Core']],
    ],
  );
  pinRoundTrip(graph);
  const core = packageSelection(graph, ['Packages/Core/Sources/Core/Point.swift']);
  assert.equal(core.scope, 'scoped');
  assert.deepEqual(commands(core), ['Packages/Core swift test', 'Packages/Feature swift test']);
  assert.deepEqual(commands(packageSelection(graph, ['Packages/Feature/Sources/Feature/Route.swift'])), [
    'Packages/Feature swift test',
  ]);
  // A local package Forge cannot place, or a computed path, reaches the package from every change.
  const missing = treeGraph({
    ...packages,
    'Packages/Feature/Package.swift': packages['Packages/Feature/Package.swift'].replace(
      '../Core',
      '../Gone',
    ),
  });
  assert.match(missing.packages[1].unresolved, /Packages\/Gone, which has no Package.swift/);
  // Test sources with no test target are run some other way: the selection is full.
  const hidden = treeGraph({
    ...packages,
    'Packages/Core/Package.swift': packages['Packages/Core/Package.swift'].replace(
      /\.testTarget\([^)]*\),/,
      '',
    ),
  });
  assert.equal(packageSelection(hidden, ['Packages/Core/Sources/Core/Point.swift']).scope, 'full');

  // The Xcode app depends on every local package and names the declaration it needs.
  const app = treeGraph(tree);
  assert.deepEqual(app.packages.at(-1).dependsOn, ['swiftpm:Packages/Core', 'swiftpm:Packages/Feature']);
  const full = packageSelection(app, ['App/App/ContentView.swift']);
  assert.equal(full.scope, 'full');
  assert.match(full.reason, /"xcodebuild","test","-project","App.xcodeproj","-scheme","App"/);
  pinRoundTrip(app);

  // Code map: declarations and `import Module` edges to the SwiftPM target folder.
  const pack = codeMap(t, tree);
  assert.ok(pack.analysis.languages.some(l => l.language === 'swift'));
  assert.deepEqual(symbols(pack, 'Packages/Core/Sources/Core/Point.swift'), [
    'StructDeclaration:Point',
    'PropertyDeclaration:x',
    'MethodDeclaration:moved',
    'VariableDeclaration:secret (private)',
  ]);
  assert.deepEqual(edges(pack, 'Packages/Feature/Sources/Feature/Route.swift'), [
    'Packages/Core/Sources/Core/Point.swift',
  ]);
  assert.deepEqual(edges(pack, 'App/App/ContentView.swift'), [
    'external',
    'Packages/Feature/Sources/Feature/Route.swift',
  ]);
});

test('Kotlin and Android: Gradle Kotlin DSL projects, .kt/.kts code map and Android toolchain homes', t => {
  const tree = repo('kotlin');
  const jvm = ecosystemEntry('jvm');
  for (const path of ['a.kt', 'build.gradle.kts'])
    assert.deepEqual(
      codeMapLanguages()
        .filter(([pattern]) => pattern.test(path))
        .map(([, language]) => language),
      ['kotlin'],
      path,
    );
  assert.equal(sourceLanguage('app/src/main/kotlin/com/acme/app/MainActivity.kt'), 'kotlin');
  assert.equal(testStem('core/src/test/kotlin/com/acme/core/PointTest.kt'), 'point');
  for (const dir of ['.gradle', '.kotlin', '.cxx']) assert.ok(regenerableDirs().has(dir), dir);
  assert.ok(knownLockfiles().includes('gradle.lockfile'));
  assert.ok(packageManifestPath('app/build.gradle.kts'));

  const graph = treeGraph(tree);
  assert.deepEqual(
    graph.packages.map(p => [p.dir, p.dependsOn]),
    [
      ['core', []],
      ['app', ['gradle:core']],
    ],
  );
  assert.deepEqual(commands(packageSelection(graph, ['core/src/main/kotlin/com/acme/core/Point.kt'])), [
    '. gradle :app:test :core:test',
  ]);
  assert.deepEqual(commands(packageSelection(graph, ['app/src/main/kotlin/com/acme/app/MainActivity.kt'])), [
    '. gradle :app:test',
  ]);

  const pack = codeMap(t, tree);
  assert.ok(pack.analysis.languages.some(l => l.language === 'kotlin'));
  assert.deepEqual(symbols(pack, 'core/src/main/kotlin/com/acme/core/Point.kt'), [
    'ClassDeclaration:Point',
    'MethodDeclaration:moved',
    'PropertyDeclaration:label (private)',
    'FunctionDeclaration:origin',
  ]);
  // `import a.b.C` reaches the files of package a.b that declare C.
  assert.deepEqual(edges(pack, 'app/src/main/kotlin/com/acme/app/MainActivity.kt'), [
    'core/src/main/kotlin/com/acme/core/Point.kt',
    'core/src/main/kotlin/com/acme/core/Point.kt',
  ]);

  // Kotlin/Native and the Android SDK pass into checks only where installed at their default place.
  const home = mkdtempSync(join(tmpdir(), 'forge-eco-home-'));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  assert.equal(ecosystemCheckEnvironment(undefined, home, 'p', '/run').env.ANDROID_HOME, undefined);
  for (const dir of ['.konan', 'Android/Sdk']) mkdirSync(join(home, dir), { recursive: true });
  const env = ecosystemCheckEnvironment(undefined, home, 'p', '/run').env;
  assert.equal(env.KONAN_DATA_DIR, join(home, '.konan'));
  assert.equal(env.ANDROID_HOME, join(home, 'Android/Sdk'));
  assert.deepEqual(
    jvm.checkEnv.toolchains.map(([name]) => name),
    ['KONAN_DATA_DIR', 'ANDROID_HOME', 'ANDROID_HOME'],
  );
});

test('Dart and Flutter: pub path dependencies, dart test or flutter test, pub cache home, code map', t => {
  const tree = repo('dart');
  assert.ok(manifestNames().has('pubspec.yaml'));
  assert.ok(pinLockfiles().includes('pubspec.lock'));
  assert.ok(regenerableDirs().has('.dart_tool'));
  assert.ok(dependencyDirs().has('.dart_tool'));
  assert.equal(sourceLanguage('app/lib/main.dart'), 'dart');
  assert.equal(testStem('packages/core/test/point_test.dart'), 'point');
  assert.deepEqual(ecosystemEntry('dart').actions.tool, ['dart', 'flutter']);

  const graph = treeGraph(tree);
  assert.deepEqual(
    graph.packages.map(p => [p.dir, p.name, p.dependsOn, p.testable]),
    [
      ['app', 'app', ['pub:packages/core'], true],
      ['packages/core', 'core', [], true],
    ],
  );
  pinRoundTrip(graph);
  // A core change runs `dart test` there and `flutter test` in the Flutter app that takes it by path.
  assert.deepEqual(commands(packageSelection(graph, ['packages/core/lib/point.dart'])), [
    'app flutter test',
    'packages/core dart test',
  ]);
  assert.deepEqual(commands(packageSelection(graph, ['app/lib/home.dart'])), ['app flutter test']);
  const gone = treeGraph({
    ...tree,
    'app/pubspec.yaml': tree['app/pubspec.yaml'].replace('../packages/core', '../gone'),
  });
  assert.match(gone.packages[0].unresolved, /takes core from gone, which has no pubspec.yaml/);
  // Workspace members, flow-style paths and hosted dependencies named like a repository package.
  const spec = readPubspec(
    'name: root\nworkspace:\n  - packages/a\n  - "packages/b"\ndependencies:\n  a: {path: packages/a}\n  b: ^1.0.0 # hosted\n',
  );
  assert.deepEqual(
    [spec.name, spec.workspace, [...spec.dependencies]],
    [
      'root',
      ['packages/a', 'packages/b'],
      [
        ['a', 'packages/a'],
        ['b', null],
      ],
    ],
  );
  const workspace = treeGraph({
    'pubspec.yaml': 'name: root\nworkspace:\n  - packages/a\n  - packages/b\n',
    'packages/a/pubspec.yaml': 'name: a\nresolution: workspace\n',
    'packages/a/test/a_test.dart': 'void main() {}\n',
    'packages/b/pubspec.yaml': 'name: b\nresolution: workspace\ndependencies:\n  a: any\n',
    'packages/b/test/b_test.dart': 'void main() {}\n',
  });
  assert.deepEqual(
    workspace.packages.map(p => [p.dir, p.declared, p.dependsOn]),
    [
      ['packages/a', true, []],
      ['packages/b', true, ['pub:packages/a']],
      ['', false, []],
    ],
  );
  assert.deepEqual(commands(packageSelection(workspace, ['packages/a/lib/a.dart'])), [
    'packages/a dart test',
    'packages/b dart test',
  ]);

  // The pub cache holds globally activated executables too: only package content links in.
  const env = ecosystemCheckEnvironment(undefined, tmpdir(), 'p', '/run');
  assert.equal(env.env.PUB_CACHE, '/run/pub-cache');
  assert.deepEqual(
    env.links.filter(link => link.link.startsWith('/run/pub-cache/')).map(link => link.link),
    ['/run/pub-cache/hosted', '/run/pub-cache/git'],
  );

  const pack = codeMap(t, tree);
  assert.ok(pack.analysis.languages.some(l => l.language === 'dart'));
  assert.deepEqual(symbols(pack, 'packages/core/lib/point.dart'), [
    'ClassDeclaration:Point',
    'PropertyDeclaration:x',
    'MethodDeclaration:Point',
    'MethodDeclaration:moved',
    'VariableDeclaration:_hidden (private)',
  ]);
  // Relative and package: imports reach captured files; SDK packages are external.
  assert.deepEqual(edges(pack, 'app/lib/main.dart'), [
    'external',
    'packages/core/lib/point.dart',
    'app/lib/home.dart',
  ]);
});

test('the declaration scanner masks strings and comments and never reads function bodies', () => {
  const swift = scanBraces(
    'let a = #"raw \\(x) "quoted" "#\n/* outer /* nested */ class Fake {} */\nfunc f() { class Inner {} }\nclass func g() {}\n',
    'swift',
  );
  assert.deepEqual(
    swift.symbols.map(s => s.name),
    ['a', 'f', 'g'],
  );
  const kotlin = scanBraces(
    'package a.b\nimport x.y.Z as W\nval s = "${"}"} class Fake"\nfun <T> List<T>.second(): T = this[1]\nfun interface Act { fun run() }\n',
    'kotlin',
  );
  assert.equal(kotlin.packageName, 'a.b');
  assert.deepEqual(
    kotlin.imports.map(i => i.specifier),
    ['x.y.Z'],
  );
  assert.deepEqual(
    kotlin.symbols.map(s => s.name),
    ['s', 'second', 'Act', 'run'],
  );
  const dart = scanBraces(
    "import 'a.dart' show b;\npart of 'lib.dart';\nvar r = r'\\${not}';\nfinal int n = 1;\nint get twice => n * 2;\nextension on String { bool get blank => isEmpty; }\n",
    'dart',
  );
  assert.deepEqual(
    dart.imports.map(i => i.specifier),
    ['a.dart'],
  );
  assert.deepEqual(
    dart.symbols.map(s => s.name),
    ['r', 'n', 'twice', 'blank'],
  );
  assert.equal(scanBraces('class A {', 'swift').ok, false);
});

test('install: Package.swift, the Podfile and Gradle scripts are code and run only when everything is allowed; pub get runs none', () => {
  const read = () => undefined;
  for (const manager of ['swiftpm', 'cocoapods', 'gradle']) {
    assert.match(ecosystemInstall(manager, read, { machine: true }).refusal, /installScripts:true/, manager);
    assert.equal(
      ecosystemInstall(manager, read, { startFlag: true, machine: false }).scripts,
      'all',
      manager,
    );
  }
  assert.deepEqual(ecosystemInstall('swiftpm', read, { startFlag: true, machine: false }).argv, [
    'swift',
    'package',
    'resolve',
  ]);
  assert.deepEqual(ecosystemInstall('pub', read, { machine: false }), {
    manager: 'pub',
    requested: null,
    scripts: 'none',
    argv: ['dart', 'pub', 'get'],
  });
});

test('the Swift and Dart fixture repositories are registry entries', () => {
  for (const id of ['swift', 'dart'])
    assert.ok(
      ECOSYSTEMS.some(entry => entry.id === id),
      id,
    );
});
