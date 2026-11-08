// SPDX-License-Identifier: Apache-2.0
// Global risk by placement (Issue 5cfcca4b): a manifest or lockfile inside a package is risk for that
// package and its dependents only; root manifests, workspace files and unknown layouts stay global.
import test from 'node:test';
import assert from 'node:assert/strict';
import { buildPackageGraph } from '../dist/package-graph.js';
import {
  packagePlacement,
  pinnedPackagePlacement,
  placedRiskBetween,
  validPlacedRisk,
  PACKAGE_PLACEMENT_MAX_BYTES,
} from '../dist/package-placement.js';
import { checkedPackagePlacement } from '../dist/package-placement-pin.js';
import { globalRiskBetween } from '../dist/first-check-risk.js';

/** The pin a runner writes for a tree, read back as the proof reads it. */
const pinned = tree => {
  const selection = checkedPackagePlacement(Object.keys(tree), path => tree[path]);
  return pinnedPackagePlacement(JSON.parse(JSON.stringify(selection)));
};
const decide = (tree, lane, main) => placedRiskBetween(lane, main, [], pinned(tree));

const npm = {
  'package.json': JSON.stringify({ name: 'fx', private: true, workspaces: ['packages/*'] }),
  'package-lock.json': '{}',
  'packages/a/package.json': JSON.stringify({ name: 'a', scripts: { test: 'node --test' } }),
  'packages/a/src/x.ts': '',
  'packages/b/package.json': JSON.stringify({ name: 'b', dependencies: { a: '*' }, scripts: { test: 'x' } }),
  'packages/b/src/y.ts': '',
  'packages/c/package.json': JSON.stringify({ name: 'c', scripts: { test: 'x' } }),
  'packages/c/package-lock.json': '{}',
  'packages/c/src/z.ts': '',
};
const cargo = {
  'Cargo.toml': '[workspace]\nmembers = ["crates/*"]\n',
  'Cargo.lock': '',
  'crates/core/Cargo.toml': '[package]\nname = "fx-core"\n',
  'crates/core/src/lib.rs': '',
  'crates/api/Cargo.toml': '[package]\nname = "fx-api"\n\n[dependencies]\nfx-core = { path = "../core" }\n',
  'crates/api/src/lib.rs': '',
  'crates/tool/Cargo.toml': '[package]\nname = "fx-tool"\n',
  'crates/tool/src/main.rs': '',
};
const go = {
  'go.work': 'go 1.23\nuse (\n  ./lib\n  ./svc\n  ./tools\n)\n',
  'lib/go.mod': 'module example.com/lib\n\ngo 1.23\n',
  'lib/sum.go': 'package lib\n',
  'svc/go.mod':
    'module example.com/svc\n\nrequire example.com/lib v0.0.0\n\nreplace example.com/lib => ../lib\n',
  'svc/main.go': 'package main\n',
  'tools/go.mod': 'module example.com/tools\n',
  'tools/go.sum': '',
  'tools/gen.go': 'package tools\n',
};
const gradle = {
  'settings.gradle.kts': 'rootProject.name = "fx"\ninclude(":core", ":app", ":libs:util")\n',
  'build.gradle.kts': '// root\n',
  gradlew: '',
  'core/build.gradle.kts':
    'plugins { `java-library` }\ndependencies { implementation(projects.libs.util) }\n',
  'core/src/main/java/Core.java': '',
  'app/build.gradle.kts': 'plugins { application }\ndependencies { implementation(project(":core")) }\n',
  'app/src/main/java/App.java': '',
  'libs/util/build.gradle': "apply plugin: 'java'\n",
  'libs/util/src/main/java/Util.java': '',
};

for (const [ecosystem, tree, independent, dependent, global] of [
  [
    'npm workspace',
    npm,
    [['packages/c/package.json', 'packages/c/package-lock.json'], ['packages/a/src/x.ts']],
    [['packages/a/package.json'], ['packages/b/src/y.ts']],
    [['package.json'], ['packages/a/src/x.ts']],
  ],
  [
    'Cargo workspace',
    cargo,
    [['crates/tool/Cargo.toml'], ['crates/core/src/lib.rs']],
    [['crates/core/Cargo.toml'], ['crates/api/src/lib.rs']],
    [['Cargo.lock'], ['crates/core/src/lib.rs']],
  ],
  [
    'Go multi-module',
    go,
    [['tools/go.mod', 'tools/go.sum'], ['lib/sum.go']],
    [['lib/go.mod'], ['svc/main.go']],
    [['go.work'], ['lib/sum.go']],
  ],
  [
    'Gradle multi-project',
    gradle,
    [['app/build.gradle.kts'], ['libs/util/src/main/java/Util.java']],
    [['libs/util/build.gradle'], ['app/src/main/java/App.java']],
    [['settings.gradle.kts'], ['app/src/main/java/App.java']],
  ],
])
  test(`replay (${ecosystem}): an in-package manifest is risk only for its package and dependents`, () => {
    // Before (rule v2): every one of these pairs was global-risk and rechecked.
    for (const pair of [independent, dependent, global]) assert.equal(globalRiskBetween(...pair), true);
    const placed = decide(tree, ...independent);
    assert.ok(placed?.length, `${independent}: the independent package's Lane keeps its first check`);
    assert.ok(
      validPlacedRisk({
        candidatePaths: independent[0],
        mainPaths: independent[1],
        checkEntries: [],
        placedRisk: placed,
      }),
    );
    // The same manifest on main's side is placed too.
    assert.ok(decide(tree, independent[1], independent[0])?.length);
    assert.equal(decide(tree, ...dependent), null, `${dependent}: a dependent package rechecks`);
    assert.equal(decide(tree, ...global), null, `${global}: the root manifest stays global`);
  });

test('unknown layouts, a missing pin and manifests on both sides stay global', () => {
  const pair = [['packages/c/package.json'], ['packages/a/src/x.ts']];
  assert.equal(placedRiskBetween(...pair, [], undefined), null, 'no pin');
  // A manifest Forge cannot parse makes the layout unknown: no pin at all.
  assert.deepEqual(
    checkedPackagePlacement(Object.keys(cargo), p =>
      p === 'crates/api/Cargo.toml' ? '[package\n' : cargo[p],
    ),
    {},
  );
  // A single root package has nothing below the root to place.
  assert.deepEqual(
    checkedPackagePlacement(['package.json', 'src/a.ts'], () => '{"name":"one"}'),
    {},
  );
  assert.equal(decide(npm, ['packages/c/package.json'], ['packages/a/package.json']), null, 'both sides');
  // A non-manifest risk path (build configuration, CI, check entries) is never placed.
  assert.equal(decide(npm, ['packages/c/tsconfig.json'], ['packages/a/src/x.ts']), null);
  assert.equal(
    placedRiskBetween(
      ['packages/c/package.json'],
      ['packages/a/src/x.ts'],
      ['packages/c/package.json'],
      pinned(npm),
    ),
    null,
  );
  // A non-Markdown path outside every package is unknown; Markdown is not.
  const loose = { ...npm, 'package.json': JSON.stringify({ private: true, workspaces: ['packages/*'] }) };
  assert.ok(decide(loose, ['packages/c/package.json'], ['docs/guide.md'])?.length);
  // No risk path at all: nothing placed, nothing global.
  assert.deepEqual(decide(npm, ['packages/c/src/z.ts'], ['packages/a/src/x.ts']), []);
});

test('the pin is bounded and malformed pins read as absent', () => {
  const pin = packagePlacement(buildPackageGraph(Object.keys(npm), path => npm[path]));
  assert.ok(Buffer.byteLength(JSON.stringify(pin)) < 1024);
  assert.equal(pinnedPackagePlacement({ packagePlacement: { ...pin, rule: 'other' } }), undefined);
  assert.equal(
    pinnedPackagePlacement({ packagePlacement: { ...pin, packages: [['js', 'a', 1, 1, [9]]] } }),
    undefined,
  );
  const many = {};
  for (let i = 0; i < 4000; i++)
    many[`p/${i}/Cargo.toml`] = `[package]\nname = "crate-with-a-long-name-${i}"\n`;
  many['Cargo.toml'] = '[workspace]\nmembers = ["p/*"]\n';
  const big = packagePlacement(buildPackageGraph(Object.keys(many), path => many[path]));
  assert.ok(big === undefined || Buffer.byteLength(JSON.stringify(big)) <= PACKAGE_PLACEMENT_MAX_BYTES);
});

test('the proof check rejects placed lists that do not match their own paths', () => {
  const base = {
    candidatePaths: ['packages/c/package.json'],
    mainPaths: ['packages/a/src/x.ts'],
    checkEntries: [],
  };
  const ok = { ...base, placedRisk: [{ path: 'packages/c/package.json', reach: ['js:packages/c'] }] };
  assert.equal(validPlacedRisk(ok), true);
  assert.equal(
    validPlacedRisk({ ...ok, placedRisk: [{ path: 'packages/c/package.json', reach: ['js:'] }] }),
    false,
  );
  assert.equal(validPlacedRisk({ ...ok, mainPaths: ['packages/a/src/x.ts', 'tsconfig.json'] }), false);
  assert.equal(
    validPlacedRisk({ ...ok, placedRisk: [{ path: 'package.json', reach: ['js:packages/c'] }] }),
    false,
  );
});
