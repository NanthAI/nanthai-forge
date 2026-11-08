// SPDX-License-Identifier: Apache-2.0
import assert from 'node:assert/strict';
import test from 'node:test';
import { buildPackageGraph, packageSelection } from '../dist/package-graph.js';

/** Builds and packages rooted in subfolders: Gradle under android/, standalone npm packages with
 * their own lockfiles (no workspaces), a Maven build under server/. Manifests only, read in memory. */
const graphOf = tree => buildPackageGraph(Object.keys(tree), path => tree[path]);
const select = (tree, changed) => packageSelection(graphOf(tree), changed);
const commands = selection => selection.commands.map(command => [command.cwd, ...command.argv].join(' '));
const names = selection => selection.packages.map(pkg => `${pkg.ecosystem}:${pkg.dir}:${pkg.why}`);

const polyglot = {
  'package.json': JSON.stringify({ name: 'tools', private: true, scripts: { lint: 'eslint .' } }),
  'package-lock.json': '{}',
  'README.md': '# Fixture\n',
  Makefile: 'all:\n',
  'android/settings.gradle.kts': 'rootProject.name = "mobile"\ninclude(":app", ":core")\n',
  'android/build.gradle.kts': '// shared\n',
  'android/gradlew': '',
  'android/gradle/libs.versions.toml': '',
  'android/app/build.gradle.kts': 'dependencies { implementation(project(":core")) }\n',
  'android/app/src/main/kotlin/App.kt': '',
  'android/core/build.gradle.kts': 'plugins { kotlin("jvm") }\n',
  'android/core/src/main/kotlin/Core.kt': '',
  'web/package.json': JSON.stringify({ name: 'web', scripts: { test: 'vitest run' } }),
  'web/package-lock.json': '{}',
  'web/src/a.ts': '',
  'server/package.json': JSON.stringify({ name: 'server', scripts: { test: 'node --test' } }),
  'server/pnpm-lock.yaml': '',
  'server/src/b.js': '',
  // No lockfile: a fixture, not a package.
  'tests/fixtures/pkg/package.json': '{}',
};

test('a subfolder Gradle build and standalone npm packages are one package per build/package', () => {
  const graph = graphOf(polyglot);
  assert.equal(graph.status, 'available', graph.reason);
  assert.deepEqual(graph.packages.map(pkg => `${pkg.ecosystem}:${pkg.dir || '.'}`).sort(), [
    'gradle:android',
    'gradle:android/app',
    'gradle:android/core',
    'js:.',
    'js:server',
    'js:web',
  ]);
  // A change in one standalone package selects only it, run in its folder with its own manager.
  const web = select(polyglot, ['web/src/a.ts']);
  assert.equal(web.scope, 'scoped', web.reason);
  assert.deepEqual(names(web), ['js:web:changed']);
  assert.deepEqual(commands(web), ['web npm run test']);
  assert.deepEqual(commands(select(polyglot, ['server/src/b.js'])), ['server pnpm run test']);
  // Gradle projects run in their build's folder, with that folder's wrapper.
  const core = select(polyglot, ['android/core/src/main/kotlin/Core.kt']);
  assert.deepEqual(names(core), ['gradle:android/app:dependent', 'gradle:android/core:changed']);
  assert.deepEqual(commands(core), ['android ./gradlew :app:test :core:test']);
  assert.deepEqual(commands(select(polyglot, ['android/app/src/main/kotlin/App.kt'])), [
    'android ./gradlew :app:test',
  ]);
  // The build's own files (version catalog, root build file) select every project of that build.
  assert.deepEqual(commands(select(polyglot, ['android/gradle/libs.versions.toml'])), [
    'android ./gradlew :app:test :core:test',
  ]);
  // Repository-root files still select a full run.
  assert.equal(select(polyglot, ['Makefile']).scope, 'full');
  assert.equal(select(polyglot, ['package.json']).scope, 'full');
  assert.equal(select(polyglot, ['web/src/a.ts', 'Makefile']).scope, 'full');
});

test('a root package with tests may read the packages inside it: a change there selects full', () => {
  const tested = {
    ...polyglot,
    'package.json': JSON.stringify({ name: 'tools', scripts: { test: 'node --test web/tests' } }),
  };
  const web = select(tested, ['web/src/a.ts']);
  assert.equal(web.scope, 'full');
  assert.match(web.reason, /root package tools \(js\) is affected/);
  // Without a lockfile the root package.json is not a package; the subfolder packages still are.
  const unlocked = Object.fromEntries(
    Object.entries(tested).filter(([path]) => path !== 'package-lock.json'),
  );
  assert.deepEqual(commands(select(unlocked, ['web/src/a.ts'])), ['web npm run test']);
});

test('Gradle: single-project, included and buildSrc builds in subfolders', () => {
  const tree = {
    'jvm/settings.gradle': "rootProject.name = 'svc'\n",
    'jvm/build.gradle': "apply plugin: 'java'\n",
    'jvm/src/main/java/Svc.java': '',
    'android/settings.gradle.kts': 'includeBuild("../build-logic")\ninclude(":app")\n',
    'android/app/build.gradle.kts': '',
    'android/app/src/main/kotlin/App.kt': '',
    'android/buildSrc/settings.gradle.kts': '',
    'android/buildSrc/build.gradle.kts': '',
    'android/buildSrc/src/main/kotlin/Conventions.kt': '',
    'build-logic/settings.gradle.kts': 'rootProject.name = "build-logic"\n',
    'build-logic/build.gradle.kts': '',
    'build-logic/src/main/kotlin/Plugin.kt': '',
  };
  assert.deepEqual(commands(select(tree, ['jvm/src/main/java/Svc.java'])), ['jvm gradle test']);
  // Projects of a build that includes another build run when that build changes.
  assert.deepEqual(commands(select(tree, ['build-logic/src/main/kotlin/Plugin.kt'])).sort(), [
    'android gradle :app:test',
    'build-logic gradle test',
  ]);
  // buildSrc is part of its build, never a build of its own.
  assert.deepEqual(commands(select(tree, ['android/buildSrc/src/main/kotlin/Conventions.kt'])), [
    'android gradle :app:test',
  ]);
  const clash = graphOf({ ...tree, 'android/app/settings.gradle.kts': '' });
  assert.equal(clash.status, 'unknown');
  assert.match(clash.reason, /android\/app is a project of two Gradle builds/);
});

test('Maven: a pom.xml no other pom lists is a build root; modules run in its folder', () => {
  const tree = {
    'server/pom.xml':
      '<project><groupId>fx</groupId><artifactId>server</artifactId><packaging>pom</packaging><modules><module>api</module><module>../shared</module></modules></project>',
    'server/api/pom.xml':
      '<project><parent><groupId>fx</groupId><artifactId>server</artifactId></parent><artifactId>api</artifactId><dependencies><dependency><groupId>fx</groupId><artifactId>shared</artifactId></dependency></dependencies></project>',
    'server/api/src/main/java/A.java': '',
    'shared/pom.xml': '<project><groupId>fx</groupId><artifactId>shared</artifactId></project>',
    'shared/src/main/java/S.java': '',
    'web/package.json': '{}',
  };
  assert.deepEqual(commands(select(tree, ['server/api/src/main/java/A.java'])), [
    'server mvn -pl api -am test',
  ]);
  assert.deepEqual(commands(select(tree, ['shared/src/main/java/S.java'])), [
    'server mvn -pl ../shared,api -am test',
  ]);
  assert.deepEqual(commands(select(tree, ['server/pom.xml'])), ['server mvn test']);
});

test('the unknown reason names the manifests Forge read; "no package manifests" only when there are none', () => {
  const unplaced = graphOf({
    'package.json': JSON.stringify({ name: 'x', scripts: { test: 'node --test' } }),
    'android/app/build.gradle.kts': '',
    'src/a.js': '',
  });
  assert.equal(unplaced.status, 'unknown');
  assert.doesNotMatch(unplaced.reason, /no package manifests/);
  assert.match(unplaced.reason, /android\/app\/build\.gradle\.kts has no settings\.gradle\(\.kts\)/);
  assert.match(unplaced.reason, /package\.json: no workspaces, and no package\.json has its own lockfile/);
  const selection = packageSelection(unplaced, ['src/a.js']);
  assert.equal(selection.scope, 'full');
  assert.doesNotMatch(selection.reason, /no package manifests/);
  const none = graphOf({ 'src/main.c': '', Makefile: '' });
  assert.match(none.reason, /^no package manifests Forge can read/);
});
