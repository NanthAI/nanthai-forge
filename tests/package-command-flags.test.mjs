// SPDX-License-Identifier: Apache-2.0
// Issue b94681af (M2-07): a scoped package run keeps the test flags the project's own CI passes.
import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildPackageGraph, packageSelection } from '../dist/package-graph.js';
import { ciFlags } from '../dist/package-ci-flags.js';
import { declaredPackageTemplates } from '../dist/package-command-flags.js';
import { checkText, checkoutPackageFlags } from '../dist/package-command-flags-checkout.js';
import { writeCheckPackages } from '../dist/package-graph-checkout.js';

const graphOf = tree => buildPackageGraph(Object.keys(tree), path => tree[path]);
const lines = selection =>
  (assert.ok(selection.commands, selection.reason), selection).commands.map(command =>
    [command.cwd, ...command.argv].join(' '),
  );

const cargo = {
  'Cargo.toml': '[workspace]\nmembers = ["crates/*"]\n',
  'crates/core/Cargo.toml': '[package]\nname = "fx-core"\n',
  'crates/core/src/lib.rs': '',
  'crates/api/Cargo.toml': '[package]\nname = "fx-api"\n[dependencies]\nfx-core = { path = "../core" }\n',
  'crates/api/src/lib.rs': '',
  'crates/solo/Cargo.toml': '[package]\nname = "fx-solo"\n',
  'crates/solo/src/lib.rs': '',
};
const go = {
  'a/go.mod': 'module example.com/fx/a\n',
  'a/x.go': 'package a\n',
  'b/go.mod': 'module example.com/fx/b\n',
  'b/x.go': 'package b\n',
};
const python = {
  'pyproject.toml': '[tool.pytest.ini_options]\n',
  'uv.lock': '',
  'pkgs/a/pyproject.toml': '[project]\nname = "fx-a"\n',
  'pkgs/a/tests/test_a.py': '',
  'pkgs/b/pyproject.toml': '[project]\nname = "fx-b"\n',
  'pkgs/b/tests/test_b.py': '',
};
const dotnet = {
  'A/A.csproj':
    '<Project Sdk="Microsoft.NET.Sdk"><PropertyGroup><IsTestProject>true</IsTestProject></PropertyGroup></Project>',
  'A/T.cs': '',
  'B/B.csproj':
    '<Project Sdk="Microsoft.NET.Sdk"><PropertyGroup><IsTestProject>true</IsTestProject></PropertyGroup></Project>',
  'B/T.cs': '',
};
const gradle = {
  'settings.gradle': "include 'app', 'lib'\n",
  gradlew: '',
  'app/build.gradle': "dependencies { implementation project(':lib') }\n",
  'app/src/test/java/AppTest.java': '',
  'lib/build.gradle': '',
  'lib/src/test/java/LibTest.java': '',
};

test('ciFlags reads the one way a CI runs each ecosystem and keeps its flags', () => {
  const expectations = [
    [
      'cargo',
      'cargo test --workspace --all-features -- --test-threads=1',
      { before: ['--all-features'], after: ['--test-threads=1'] },
    ],
    [
      'cargo',
      'cargo +nightly test -p a --features "x y" --no-fail-fast',
      { before: ['--features', 'x y', '--no-fail-fast'], after: [] },
    ],
    [
      'go',
      'go test -race -tags integration -count=1 ./...',
      { before: ['-race', '-tags', 'integration', '-count=1'], after: [] },
    ],
    [
      'python',
      'pytest -m "not slow" --strict-markers -x tests/',
      { before: ['-m', 'not slow', '--strict-markers', '-x'], after: [] },
    ],
    ['python', 'uv run python -m pytest -n auto --cov-fail-under=80', { before: ['-n', 'auto'], after: [] }],
    [
      'dotnet',
      'dotnet test -c Release --no-build --filter "Category!=Slow" App.sln',
      { before: ['-c', 'Release', '--no-build', '--filter', 'Category!=Slow'], after: [] },
    ],
    [
      'gradle',
      './gradlew --no-daemon check -x lint',
      { before: ['--no-daemon', '-x', 'lint'], after: [], task: 'check' },
    ],
    [
      'maven',
      'mvn -B -ntp verify -pl a -am -DskipITs=false',
      { before: ['-B', '-ntp', '-DskipITs=false'], after: [], task: 'verify' },
    ],
  ];
  for (const [ecosystem, line, expected] of expectations)
    assert.deepEqual(ciFlags(`set -e\n# comment\n${line}\n`, ecosystem), expected, line);
  // A tool the CI never runs yields nothing; env assignments and continuations are read.
  assert.equal(ciFlags('make all\n', 'go'), null);
  assert.deepEqual(ciFlags('RUST_LOG=debug cargo test \\\n  --all-features\n', 'cargo'), {
    before: ['--all-features'],
    after: [],
  });
});

test('ciFlags is unsure, never narrower: several ways, shell expansions, unclear values, unscopable tasks', () => {
  const unsure = [
    ['cargo', 'cargo test --lib\ncargo test --doc'],
    ['cargo', 'cargo test $EXTRA_FLAGS'],
    ['go', 'go test -args -foo'],
    ['go', 'go test -weird value ./...'],
    ['python', 'pytest --mystery thing'],
    ['gradle', './gradlew check sonar'],
    ['maven', 'mvn verify sonar:sonar'],
  ];
  for (const [ecosystem, text] of unsure) assert.ok('unsure' in ciFlags(text, ecosystem), text);
  // The same invocation twice is one way.
  assert.deepEqual(ciFlags('cargo test --locked\ncargo test --locked\n', 'cargo'), {
    before: ['--locked'],
    after: [],
  });
});

test('the CI check text keeps its flags in the per-package commands (M2-07)', () => {
  const flags = text => ({ templates: {}, ciText: text });
  const select = (tree, changed, text) => packageSelection(graphOf(tree), changed, undefined, flags(text));
  const cargoSel = select(
    cargo,
    ['crates/core/src/lib.rs'],
    'cargo test --workspace --all-features --no-fail-fast -- --test-threads=1',
  );
  assert.deepEqual(lines(cargoSel), [
    ' cargo test --all-features --no-fail-fast -p fx-api -p fx-core -- --test-threads=1',
  ]);
  assert.ok(cargoSel.commands.every(command => command.flagsFrom === 'ci'));
  assert.match(cargoSel.reason, /test flags from the check's own text/);
  // Without the CI text the bare command is used, as before.
  assert.deepEqual(lines(packageSelection(graphOf(cargo), ['crates/core/src/lib.rs'])), [
    ' cargo test -p fx-api -p fx-core',
  ]);
  assert.deepEqual(lines(select(go, ['a/x.go'], 'go test -race -tags integration ./...')), [
    'a go test -race -tags integration ./...',
  ]);
  assert.deepEqual(
    lines(select(python, ['pkgs/a/tests/test_a.py'], 'pytest -m "not slow" --strict-markers tests')),
    [' uv run pytest -m not slow --strict-markers pkgs/a'],
  );
  assert.deepEqual(lines(select(dotnet, ['A/T.cs'], 'dotnet test -c Release --no-build')), [
    ' dotnet test -c Release --no-build A/A.csproj',
  ]);
  // Gradle `check` replaces `test`; Maven `verify` replaces `test`.
  assert.deepEqual(lines(select(gradle, ['lib/src/test/java/LibTest.java'], './gradlew --no-daemon check')), [
    ' ./gradlew --no-daemon :app:check :lib:check',
  ]);
});

test('a CI the flags cannot be placed from makes the selection full with the reason', () => {
  const selection = packageSelection(graphOf(cargo), ['crates/core/src/lib.rs'], undefined, {
    templates: {},
    ciText: 'cargo test --lib\ncargo test --doc\n',
  });
  assert.equal(selection.scope, 'full');
  assert.match(
    selection.reason,
    /cargo: the CI runs cargo tests in 2 different ways; declare packages\.commands/,
  );
});

test('a forge.json template is used verbatim, with {packages} expanded', () => {
  const declared = declaredPackageTemplates(
    JSON.stringify({ packages: { commands: { cargo: ['cargo', 'test', '--all-features', '{packages}'] } } }),
  );
  assert.deepEqual(declared, { templates: { cargo: ['cargo', 'test', '--all-features', '{packages}'] } });
  const selection = packageSelection(graphOf(cargo), ['crates/core/src/lib.rs'], undefined, {
    templates: declared.templates,
    // The template wins over the CI's own text.
    ciText: 'cargo test --release',
  });
  assert.deepEqual(lines(selection), [' cargo test --all-features -p fx-api -p fx-core']);
  assert.ok(selection.commands.every(command => command.flagsFrom === 'forge.json'));
  assert.match(selection.reason, /forge\.json packages\.commands/);
  // Invalid declarations are errors, not silent fallbacks.
  for (const bad of [
    { packages: { commands: { cargo: ['cargo', 'test'] } } },
    { packages: { commands: { cargo: ['cargo', '{packages}', '{packages}'] } } },
    { packages: { commands: { rust: ['cargo', 'test', '{packages}'] } } },
    { packages: { commands: [] } },
  ])
    assert.ok('error' in declaredPackageTemplates(JSON.stringify(bad)), JSON.stringify(bad));
  assert.ok('error' in declaredPackageTemplates('not json'));
  const refused = packageSelection(graphOf(cargo), ['crates/core/src/lib.rs'], undefined, {
    refusal: 'forge.json broken',
  });
  assert.equal(refused.scope, 'full');
});

test('the checkout reads forge.json and the check script; FORGE_CHECK_PACKAGES records the flags', t => {
  const root = mkdtempSync(join(tmpdir(), 'forge-package-flags-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  for (const [path, body] of Object.entries({
    ...cargo,
    'ci/check.sh': '#!/bin/sh\nset -e\ncargo fmt --check\ncargo test --workspace --all-features\n',
  })) {
    mkdirSync(join(root, path, '..'), { recursive: true });
    writeFileSync(join(root, path), body);
  }
  const check = { executable: 'bash', args: ['ci/check.sh'] };
  assert.match(checkText(root, check), /cargo test --workspace --all-features/);
  // A file outside the checkout is never read.
  assert.equal(
    checkText(root, { executable: 'bash', args: ['/etc/hosts', '../x'] }).includes('localhost'),
    false,
  );
  const flags = checkoutPackageFlags(root, check);
  assert.deepEqual(flags.templates, {});
  const packages = writeCheckPackages(
    root,
    { mode: 'scoped', paths: ['crates/core/src/lib.rs'] },
    undefined,
    check,
  );
  t.after(() => packages?.remove());
  const file = JSON.parse(readFileSync(packages.path, 'utf8'));
  assert.deepEqual(file.commands, [
    {
      ecosystem: 'cargo',
      cwd: '',
      argv: ['cargo', 'test', '--all-features', '-p', 'fx-api'],
      flagsFrom: 'ci',
    },
  ]);
  // (The checkout read narrows the changed crate: fx-core has no test unit of its own, its dependent runs.)
  // A malformed forge.json template makes the run full: no packages file commands.
  writeFileSync(join(root, 'forge.json'), JSON.stringify({ packages: { commands: { cargo: ['cargo'] } } }));
  const refused = writeCheckPackages(
    root,
    { mode: 'scoped', paths: ['crates/core/src/lib.rs'] },
    undefined,
    check,
  );
  t.after(() => refused?.remove());
  assert.equal(JSON.parse(readFileSync(refused.path, 'utf8')).scope, 'full');
});
