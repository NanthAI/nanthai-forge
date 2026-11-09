// SPDX-License-Identifier: Apache-2.0
import assert from 'node:assert/strict';
import test from 'node:test';
import { buildPackageGraph, packageSelection } from '../dist/package-graph.js';
import { graphShare } from '../dist/graph-first-check.js';
import { packagePlacement, pinnedPackagePlacement, placedRisk } from '../dist/package-placement.js';

/** Replays for the fail-safe rule (Issue 624ba0b9): an edge the package graph cannot resolve or place,
 * structure the build tool computes, and edges between ecosystems widen the selection, never narrow
 * it. Each case is a synthetic repository read in memory (manifests only). */
const graphOf = tree => buildPackageGraph(Object.keys(tree), path => tree[path]);
const select = (tree, changed) => packageSelection(graphOf(tree), changed);
const names = selection => selection.packages.map(pkg => `${pkg.ecosystem}:${pkg.dir}:${pkg.why}`);
const keys = selection => selection.packages.map(pkg => `${pkg.ecosystem}:${pkg.dir}`);

const csproj = (body = '') => `<Project Sdk="Microsoft.NET.Sdk">${body}</Project>`;
const testProject = reference =>
  csproj(
    `<ItemGroup><PackageReference Include="xunit" Version="2.0.0" /><ProjectReference Include="${reference}" /></ItemGroup>`,
  );
const dotnet = extra => ({
  'src/Lib/Lib.csproj': csproj(),
  'src/Lib/Thing.cs': '',
  'src/Other/Other.csproj': csproj(),
  'src/Other/Other.cs': '',
  'tests/Other.Tests/Other.Tests.csproj': testProject('../../src/Other/Other.csproj'),
  ...extra,
});

test('.NET: references resolve case-insensitively and by wildcard', () => {
  // MSBuild paths are case-insensitive: lib/lib.csproj is src/Lib/Lib.csproj.
  const folded = dotnet({ 'tests/Lib.Tests/Lib.Tests.csproj': testProject('..\\..\\SRC\\lib\\lib.csproj') });
  assert.deepEqual(keys(select(folded, ['src/Lib/Thing.cs'])), ['dotnet:src/Lib', 'dotnet:tests/Lib.Tests']);
  const wildcard = dotnet({ 'tests/All.Tests/All.Tests.csproj': testProject('../../src/**/*.csproj') });
  assert.deepEqual(keys(select(wildcard, ['src/Lib/Thing.cs'])), [
    'dotnet:src/Lib',
    'dotnet:tests/All.Tests',
  ]);
});

test('.NET: Directory.Build.props and imported .props add their project references', () => {
  const props = dotnet({
    'tests/Directory.Build.props':
      '<Project><ItemGroup><ProjectReference Include="$(MSBuildThisFileDirectory)../src/Lib/Lib.csproj" /></ItemGroup></Project>',
  });
  assert.deepEqual(keys(select(props, ['src/Lib/Thing.cs'])), ['dotnet:src/Lib', 'dotnet:tests/Other.Tests']);
  const imported = dotnet({
    'build/testing.props':
      '<Project><ItemGroup><ProjectReference Include="$(MSBuildThisFileDirectory)../src/Lib/Lib.csproj" /></ItemGroup></Project>',
    'tests/Other.Tests/Other.Tests.csproj': csproj(
      '<Import Project="..\\..\\build\\testing.props" /><Import Project="$(MSBuildExtensionsPath)\\x.targets" /><ItemGroup><PackageReference Include="xunit" /></ItemGroup>',
    ),
  });
  assert.deepEqual(keys(select(imported, ['src/Lib/Thing.cs'])), [
    'dotnet:src/Lib',
    'dotnet:tests/Other.Tests',
  ]);
  // A props file outside every project reaches every project below it: full.
  assert.equal(select(props, ['tests/Directory.Build.props']).scope, 'full');
});

test('.NET: a reference or import Forge cannot place marks the project unresolved; every change selects it', () => {
  const missing = dotnet({ 'tests/Gen.Tests/Gen.Tests.csproj': testProject('../../gen/Gen.csproj') });
  const lib = select(missing, ['src/Lib/Thing.cs']);
  assert.deepEqual(names(lib), ['dotnet:src/Lib:changed', 'dotnet:tests/Gen.Tests:dependent']);
  assert.match(
    lib.reason,
    /widened to 1 package\(s\) no edge names: dotnet:tests\/Gen\.Tests \(.*gen\/Gen\.csproj, which is no project Forge read\)/,
  );
  const computed = dotnet({
    'tests/Gen.Tests/Gen.Tests.csproj': csproj(
      '<Import Project="$(RepoRoot)eng/testing.props" /><ItemGroup><PackageReference Include="xunit" /></ItemGroup>',
    ),
  });
  assert.ok(keys(select(computed, ['src/Lib/Thing.cs'])).includes('dotnet:tests/Gen.Tests'));
});

test('JS: a package with test files but no test script of its own makes the selection full', () => {
  const tree = {
    'package.json': JSON.stringify({ workspaces: ['packages/*'], scripts: { test: 'vitest run' } }),
    'package-lock.json': '{}',
    'packages/a/package.json': JSON.stringify({ name: 'a' }),
    'packages/a/src/a.ts': '',
    'packages/a/src/a.test.ts': '',
    'packages/b/package.json': JSON.stringify({ name: 'b', scripts: { test: 'vitest run' } }),
    'packages/b/src/b.ts': '',
    'packages/c/package.json': JSON.stringify({ name: 'c' }),
    'packages/c/src/c.ts': '',
  };
  const both = select(tree, ['packages/a/src/a.ts', 'packages/b/src/b.ts']);
  assert.equal(both.scope, 'full');
  assert.match(
    both.reason,
    /js:packages\/a has test files \(packages\/a\/src\/a\.test\.ts\) but no test command of its own/,
  );
  // A package with neither tests nor a test script still drops out: nothing could test it.
  assert.deepEqual(select(tree, ['packages/c/src/c.ts', 'packages/b/src/b.ts']).commands.length, 1);
});

test('JS: a file: or workspace: dependency that names no package marks the package unresolved', () => {
  const tree = {
    'package.json': JSON.stringify({ workspaces: ['packages/*'] }),
    'package-lock.json': '{}',
    'packages/a/package.json': JSON.stringify({ name: 'a', scripts: { test: 'vitest' } }),
    'packages/a/a.ts': '',
    'packages/b/package.json': JSON.stringify({
      name: 'b',
      scripts: { test: 'vitest' },
      dependencies: { vendored: 'file:../../vendor/vendored' },
    }),
    'packages/b/b.ts': '',
    'vendor/vendored/index.js': '',
  };
  assert.deepEqual(names(select(tree, ['packages/a/a.ts'])), [
    'js:packages/a:changed',
    'js:packages/b:dependent',
  ]);
});

const gradle = extra => ({
  'settings.gradle.kts': 'include(":core", ":app", ":tool")\n',
  'build.gradle.kts': '',
  gradlew: '',
  'core/build.gradle.kts': 'plugins { `java-library` }\n',
  'core/src/main/java/Core.java': '',
  'app/build.gradle.kts': 'plugins { id("acme.service-conventions") }\n',
  'app/src/main/java/App.java': '',
  'tool/build.gradle.kts': 'plugins { application }\n',
  'tool/src/main/java/Tool.java': '',
  ...extra,
});

test('Gradle: a plugin from the build’s own plugin sources or an applied script marks the project unresolved', () => {
  // Without buildSrc or an included build, the plugin is a published one: no hidden edge.
  assert.deepEqual(keys(select(gradle(), ['core/src/main/java/Core.java'])), ['gradle:core']);
  // A convention plugin in buildSrc/ can add implementation(project(":core")) to app.
  const conventions = gradle({ 'buildSrc/src/main/kotlin/acme.service-conventions.gradle.kts': '' });
  const core = select(conventions, ['core/src/main/java/Core.java']);
  assert.deepEqual(names(core), ['gradle:app:dependent', 'gradle:core:changed']);
  assert.match(core.reason, /app\/build\.gradle\.kts applies plugin acme\.service-conventions/);
  const script = gradle({ 'tool/build.gradle.kts': 'apply(from = "../gradle/deps.gradle")\n' });
  assert.ok(keys(select(script, ['core/src/main/java/Core.java'])).includes('gradle:tool'));
  // The root build file's subprojects block applies to every project.
  const everywhere = gradle({
    'build.gradle.kts': 'subprojects { apply(from = "$rootDir/gradle/publish.gradle") }\n',
  });
  assert.deepEqual(keys(select(everywhere, ['core/src/main/java/Core.java'])), [
    'gradle:app',
    'gradle:core',
    'gradle:tool',
  ]);
});

test('Gradle: a project with test sources but no build file of its own makes the selection full', () => {
  const tree = gradle({
    'settings.gradle.kts': 'include(":core", ":app", ":tool", ":bare")\n',
    'bare/src/test/java/BareTest.java': '',
  });
  delete tree['bare/build.gradle.kts'];
  const bare = select({ ...tree, 'bare/src/main/java/Bare.java': '' }, [
    'bare/src/main/java/Bare.java',
    'tool/src/main/java/Tool.java',
  ]);
  assert.equal(bare.scope, 'full');
  assert.match(bare.reason, /gradle:bare has test files/);
});

test('Cargo: a path dependency or patch inside the repository with no crate marks crates unresolved', () => {
  const tree = {
    'Cargo.toml': '[workspace]\nmembers = ["crates/*"]\n',
    'crates/a/Cargo.toml': '[package]\nname = "a"\n',
    'crates/a/src/lib.rs': '',
    'crates/b/Cargo.toml':
      '[package]\nname = "b"\n[dependencies]\nshim = { path = "../../third_party/shim" }\n',
    'crates/b/src/lib.rs': '',
    'third_party/shim/README.md': '',
  };
  assert.deepEqual(keys(select(tree, ['crates/a/src/lib.rs'])), ['cargo:crates/a', 'cargo:crates/b']);
  const patched = {
    ...tree,
    'Cargo.toml':
      '[workspace]\nmembers = ["crates/*"]\n[patch.crates-io]\nserde = { path = "vendor/serde" }\n',
    'crates/b/Cargo.toml': '[package]\nname = "b"\n',
  };
  const patch = select(patched, ['crates/a/src/lib.rs']);
  assert.deepEqual(keys(patch), ['cargo:crates/a', 'cargo:crates/b']);
  assert.match(patch.reason, /patches serde with vendor\/serde/);
});

test('Go: a local replace is an edge by folder; go.work modules may import each other', () => {
  const tree = {
    'svc/go.mod':
      'module example.com/svc\n\nrequire example.com/x v1.0.0\n\nreplace example.com/x => ../internal/x\n',
    'svc/main.go': '',
    // The folder's own module path differs from the replaced one.
    'internal/x/go.mod': 'module example.com/internal/x\n',
    'internal/x/x.go': '',
    'tools/go.mod': 'module example.com/tools\n',
    'tools/t.go': '',
  };
  assert.deepEqual(keys(select(tree, ['internal/x/x.go'])), ['go:internal/x', 'go:svc']);
  // A replace to a folder with no go.mod marks the module unresolved.
  const gone = select(
    { ...tree, 'svc/go.mod': 'module example.com/svc\n\nreplace example.com/x => ../gone\n' },
    ['tools/t.go'],
  );
  assert.deepEqual(keys(gone), ['go:svc', 'go:tools']);
  // In workspace mode every used module is a main module: imports between them need no require.
  const work = { ...tree, 'go.work': 'go 1.23\n\nuse (\n\t./svc\n\t./tools\n)\n' };
  assert.deepEqual(names(select(work, ['tools/t.go'])), ['go:svc:dependent', 'go:tools:changed']);
  assert.deepEqual(keys(select(work, ['svc/main.go'])), ['go:svc', 'go:tools']);
  // A used folder with no module is a workspace Forge cannot place: every module is unresolved.
  const broken = { ...work, 'go.work': 'go 1.23\nuse ./svc\nuse ./missing\n' };
  assert.deepEqual(keys(select(broken, ['internal/x/x.go'])), ['go:internal/x', 'go:svc', 'go:tools']);
});

test('Maven: profile modules belong to the reactor; selecting one runs full', () => {
  const tree = {
    'pom.xml':
      '<project><groupId>fx</groupId><artifactId>parent</artifactId><modules><module>core</module></modules><profiles><profile><id>it</id><modules><module>it</module></modules></profile></profiles></project>',
    'core/pom.xml':
      '<project><parent><groupId>fx</groupId><artifactId>parent</artifactId></parent><artifactId>core</artifactId></project>',
    'core/src/main/java/C.java': '',
    'it/pom.xml':
      '<project><parent><groupId>fx</groupId><artifactId>parent</artifactId></parent><artifactId>it</artifactId><dependencies><dependency><groupId>fx</groupId><artifactId>core</artifactId></dependency></dependencies></project>',
    'it/src/test/java/ItTest.java': '',
  };
  const graph = graphOf(tree);
  // Not a build of its own: a module of the root reactor.
  assert.equal(graph.packages.find(pkg => pkg.dir === 'it')?.declared, true);
  const core = select(tree, ['core/src/main/java/C.java']);
  assert.equal(core.scope, 'full');
  assert.match(core.reason, /it\/pom\.xml is a module only profile it adds/);
});

const maturin = {
  'pyproject.toml':
    '[project]\nname = "fast"\n[tool.maturin]\nmanifest-path = "crates/core/Cargo.toml"\n[tool.pytest.ini_options]\n',
  'python/fast/__init__.py': '',
  'tests/test_fast.py': '',
  'crates/core/Cargo.toml': '[package]\nname = "fast-core"\n',
  'crates/core/src/lib.rs': '',
  'crates/cli/Cargo.toml': '[package]\nname = "fast-cli"\n',
  'crates/cli/src/main.rs': '',
  'js/Cargo.toml': '[package]\nname = "fast-js"\n',
  'js/src/lib.rs': '',
};

test('mixed ecosystems: a crate change selects the other ecosystem’s packages unless forge.json declares the edges', () => {
  const crate = select(maturin, ['crates/cli/src/main.rs']);
  assert.equal(crate.scope, 'full', 'the root Python package may build any crate');
  // A Python package in a subfolder: still selected, and graph-first keeps the full check.
  const sub = Object.fromEntries(
    Object.entries(maturin).map(([path, text]) => [
      path.startsWith('crates/') || path.startsWith('js/') ? path : `py/${path}`,
      text,
    ]),
  );
  // A build backend that names no crate (setuptools-rust reads setup code): any crate may be its.
  const tree = {
    ...sub,
    'py/pyproject.toml':
      '[build-system]\nrequires = ["setuptools", "setuptools-rust"]\nbuild-backend = "setuptools.build_meta"\n[project]\nname = "fast"\n[tool.pytest.ini_options]\n',
  };
  const selection = select(tree, ['crates/cli/src/main.rs']);
  assert.deepEqual(keys(selection), ['cargo:crates/cli', 'python:py']);
  assert.equal(graphShare(graphOf(tree), ['crates/cli/src/main.rs']).selected, 2);
  // Declared: the Python package builds crates/core only, so a cli change stays with the crate.
  const declared = {
    ...tree,
    'forge.json': JSON.stringify({ packages: { edges: [{ from: 'python:py', to: 'cargo:crates/core' }] } }),
  };
  assert.deepEqual(keys(select(declared, ['crates/cli/src/main.rs'])), ['cargo:crates/cli']);
  assert.deepEqual(keys(select(declared, ['crates/core/src/lib.rs'])), ['cargo:crates/core', 'python:py']);
  const share = graphShare(graphOf(declared), ['crates/cli/src/main.rs']);
  assert.equal(share.scope, 'scoped');
  assert.equal(share.selected, 1);
  // A maturin build names its crate: that edge, no widening.
  const named = {
    ...sub,
    'py/pyproject.toml': maturin['pyproject.toml'].replace('crates/core', '../crates/core'),
  };
  assert.deepEqual(keys(select(named, ['crates/cli/src/main.rs'])), ['cargo:crates/cli']);
  assert.deepEqual(keys(select(named, ['crates/core/src/lib.rs'])), ['cargo:crates/core', 'python:py']);
});

test('mixed ecosystems: a package of another ecosystem that encloses the change is always selected', () => {
  // A napi-style JS package with its crate inside it, edges declared as none.
  const tree = {
    'forge.json': JSON.stringify({ packages: { edges: [] } }),
    'Cargo.toml': '[workspace]\nmembers = ["bindings/node/native", "crates/*"]\n',
    'bindings/node/package.json': JSON.stringify({ name: 'binding', scripts: { test: 'node --test' } }),
    'bindings/node/package-lock.json': '{}',
    'bindings/node/native/Cargo.toml': '[package]\nname = "binding-native"\n',
    'bindings/node/native/src/lib.rs': '',
    'crates/other/Cargo.toml': '[package]\nname = "other"\n',
    'crates/other/src/lib.rs': '',
  };
  assert.deepEqual(keys(select(tree, ['bindings/node/native/src/lib.rs'])), [
    'cargo:bindings/node/native',
    'js:bindings/node',
  ]);
  assert.deepEqual(keys(select(tree, ['crates/other/src/lib.rs'])), ['cargo:crates/other']);
});

test('the first-check placement pin carries unresolved packages and the cross-ecosystem declaration', () => {
  const tree = {
    'Cargo.toml': '[workspace]\nmembers = ["crates/*"]\n',
    'crates/a/Cargo.toml': '[package]\nname = "a"\n',
    'crates/a/src/lib.rs': '',
    'crates/b/Cargo.toml':
      '[package]\nname = "b"\n[dependencies]\nshim = { path = "../../third_party/shim" }\n',
    'crates/b/src/lib.rs': '',
    'crates/c/Cargo.toml': '[package]\nname = "c"\n',
  };
  const pin = packagePlacement(graphOf(tree));
  assert.equal(pin.rule, 'package-placement-v2');
  const pinned = pinnedPackagePlacement(JSON.parse(JSON.stringify({ packagePlacement: pin })));
  // A manifest change in crate a reaches the unresolved crate b as well.
  assert.deepEqual(placedRisk(pinned, 'crates/a/Cargo.toml', []), ['cargo:crates/a', 'cargo:crates/b']);
  // A v1 pin (no unresolved list) is not trusted.
  const { unresolved: _drop, ...old } = pin;
  assert.equal(
    pinnedPackagePlacement({ packagePlacement: { ...old, rule: 'package-placement-v1' } }),
    undefined,
  );
});

/** The text-level over-approximation the graph may never fall below: when another package's manifest
 * names a package's folder, a change in that package selects it (or the selection is full). */
test('invariant: a manifest that names another package’s folder is selected by a change there', () => {
  const fixtures = [
    dotnet({ 'tests/Lib.Tests/Lib.Tests.csproj': testProject('..\\..\\SRC\\lib\\lib.csproj') }),
    gradle({ 'buildSrc/src/main/kotlin/acme.service-conventions.gradle.kts': '' }),
    {
      'svc/go.mod': 'module example.com/svc\nreplace example.com/x => ../internal/x\n',
      'internal/x/go.mod': 'module example.com/internal/x\n',
      'internal/x/x.go': '',
    },
    { ...maturin, 'pyproject.toml': maturin['pyproject.toml'] },
  ];
  for (const tree of fixtures) {
    const graph = graphOf(tree);
    assert.equal(graph.status, 'available');
    for (const pkg of graph.packages.filter(pkg => pkg.dir)) {
      const file = Object.keys(tree).find(path => path.startsWith(`${pkg.dir}/`) && path !== pkg.manifest);
      if (!file) continue;
      const selection = packageSelection(graph, [file]);
      if (selection.scope === 'full') continue;
      const tail = pkg.dir.split('/').at(-1).toLowerCase();
      for (const other of graph.packages.filter(other => other !== pkg && other.dir))
        if (
          tree[other.manifest].toLowerCase().includes(`/${tail}`) ||
          tree[other.manifest].toLowerCase().includes(`\\${tail}`)
        )
          assert.ok(
            keys(selection).includes(`${other.ecosystem}:${other.dir}`),
            `${other.manifest} names ${pkg.dir}`,
          );
    }
  }
});

/** Ownership: a package reads a nested package's files only through what its manifest declares, and
 * a root package the change reaches as a dependent is one more package where its command tests just
 * that package. Every real edge still selects. */
const argv = selection => selection.commands.map(command => [command.cwd, command.argv.join(' ')]);
const crate = (name, deps = '') =>
  `[package]\nname = "${name}"\nversion = "0.1.0"\n\n[dependencies]\n${deps}`;

/** A uv workspace root that builds nothing, a maturin member that compiles the crate in its folder,
 * and a fuzz crate with its own workspace that the Cargo workspace excludes. */
const mixed = {
  'pyproject.toml': [
    '[project]\nname = "ws"\nversion = "0.1.0"',
    '[dependency-groups]\ndev = ["maturin", "pytest"]',
    '[tool.uv]\npackage = false',
    '[tool.uv.workspace]\nmembers = ["crates/core-python"]',
  ].join('\n\n'),
  'Cargo.toml': '[workspace]\nmembers = ["crates/core", "crates/core-python"]\nexclude = ["crates/fuzz"]\n',
  'crates/core/Cargo.toml': crate('core'),
  'crates/core/src/lib.rs': '',
  'crates/core-python/Cargo.toml': crate('core-python', 'core = { path = "../core" }'),
  'crates/core-python/pyproject.toml':
    '[build-system]\nrequires = ["maturin"]\nbuild-backend = "maturin"\n\n[project]\nname = "core"\n',
  'crates/core-python/tests/test_core.py': '',
  'crates/fuzz/Cargo.toml': `${crate('fuzz', 'core = { path = "../core" }')}\n[workspace]\n`,
  'crates/fuzz/fuzz_targets/one.rs': '',
};

test('a virtual Python root and an excluded nested Cargo workspace leave the fuzz crate alone', () => {
  const fuzz = select(mixed, ['crates/fuzz/fuzz_targets/one.rs']);
  assert.equal(fuzz.scope, 'scoped', fuzz.reason);
  assert.deepEqual(keys(fuzz), ['cargo:crates/fuzz']);
  assert.deepEqual(argv(fuzz), [['crates/fuzz', 'cargo test -p fuzz']]);
  assert.equal(graphShare(graphOf(mixed), ['crates/fuzz/fuzz_targets/one.rs']).scope, 'scoped');
  // Real edges still select: the maturin package builds core-python, which uses core.
  assert.deepEqual(keys(select(mixed, ['crates/core/src/lib.rs'])), [
    'cargo:crates/core',
    'cargo:crates/core-python',
    'cargo:crates/fuzz',
    'python:crates/core-python',
  ]);
  // A root file is still the root's: full.
  assert.equal(select(mixed, ['pyproject.toml']).scope, 'full');
});

test('a Python root with a build system that compiles a nested crate keeps owning it', () => {
  const maturin = {
    'pyproject.toml':
      '[build-system]\nrequires = ["maturin"]\nbuild-backend = "maturin"\n\n[project]\nname = "x"\ndependencies = ["pytest"]\n\n[tool.maturin]\nmanifest-path = "crates/x/Cargo.toml"\n',
    'crates/x/Cargo.toml': crate('x'),
    'crates/x/src/lib.rs': '',
    'crates/y/Cargo.toml': crate('y'),
    'crates/y/src/lib.rs': '',
  };
  const graph = graphOf(maturin);
  assert.deepEqual(graph.packages.find(pkg => pkg.ecosystem === 'python').dependsOn, ['cargo:crates/x']);
  const change = select(maturin, ['crates/x/src/lib.rs']);
  assert.equal(change.scope, 'full');
  assert.match(change.reason, /root package x \(python\)/);
});

test('a virtual Python root stays selected for a crate it takes as a path source', () => {
  const virtual = extra => ({
    'pyproject.toml': `[project]\nname = "ws"\nversion = "0"\ndependencies = ["pytest", "x"]\n\n[tool.uv]\npackage = false\n\n[tool.uv.sources]\nx = { path = "crates/x" }\n`,
    'crates/x/Cargo.toml': crate('x'),
    'crates/x/src/lib.rs': '',
    'crates/y/Cargo.toml': crate('y'),
    'crates/y/src/lib.rs': '',
    ...extra,
  });
  // The source folder holds only a crate: an edge across ecosystems.
  const onlyCrate = select(virtual({}), ['crates/x/src/lib.rs']);
  assert.equal(onlyCrate.scope, 'full');
  assert.match(onlyCrate.reason, /root package ws \(python\)/);
  // It holds a Python package that builds the crate: the Python edge.
  const withPython = virtual({
    'crates/x/pyproject.toml':
      '[build-system]\nrequires = ["maturin"]\nbuild-backend = "maturin"\n\n[project]\nname = "x"\n',
  });
  assert.equal(select(withPython, ['crates/x/src/lib.rs']).scope, 'full');
  // A crate it names nowhere is not its: scoped.
  const other = select(virtual({}), ['crates/y/src/lib.rs']);
  assert.equal(other.scope, 'scoped', other.reason);
  assert.deepEqual(keys(other), ['cargo:crates/y']);
  // A source folder with no package at all: unresolved, every change selects the root.
  const missing = virtual({
    'pyproject.toml': virtual({})['pyproject.toml'].replace('crates/x', 'crates/z'),
  });
  assert.equal(select(missing, ['crates/y/src/lib.rs']).scope, 'full');
});

/** A root Cargo package that depends on every workspace member (ripgrep's layout). */
const binary = {
  'Cargo.toml': `${crate('app', 'globs = { path = "crates/globs" }\nwalk = { path = "crates/walk" }\ncli = { path = "crates/cli" }\nprint = { path = "crates/print" }\n')}\n[workspace]\nmembers = ["crates/*"]\nexclude = ["fuzz"]\n`,
  'src/main.rs': '',
  'crates/globs/Cargo.toml': crate('globs'),
  'crates/globs/src/lib.rs': '',
  'crates/walk/Cargo.toml': crate('walk', 'globs = { path = "../globs" }'),
  'crates/walk/src/lib.rs': '',
  'crates/cli/Cargo.toml': crate('cli'),
  'crates/cli/src/lib.rs': '',
  'crates/print/Cargo.toml': crate('print'),
  'crates/print/src/lib.rs': '',
  'crates/search/Cargo.toml': crate('search'),
  'crates/search/src/lib.rs': '',
  'fuzz/Cargo.toml': `${crate('fuzz', 'globs = { path = "../crates/globs" }')}\n[workspace]\n`,
  'fuzz/src/main.rs': '',
};

test('a non-virtual Cargo root reached as a dependent is one more package', () => {
  const member = select(binary, ['crates/globs/src/lib.rs']);
  assert.equal(member.scope, 'scoped', member.reason);
  assert.deepEqual(keys(member), ['cargo:', 'cargo:crates/globs', 'cargo:crates/walk', 'cargo:fuzz']);
  assert.deepEqual(argv(member), [
    ['', 'cargo test -p app -p globs -p walk'],
    ['fuzz', 'cargo test -p fuzz'],
  ]);
  // The root's own files are the root's: full.
  assert.equal(select(binary, ['src/main.rs']).scope, 'full');
  // An excluded crate with its own workspace is not read by the root package.
  assert.deepEqual(keys(select(binary, ['fuzz/src/main.rs'])), ['cargo:fuzz']);
  // A nested crate in no workspace may be read by the root package's build: full.
  const stray = { ...binary, 'tools/gen/Cargo.toml': crate('gen'), 'tools/gen/src/main.rs': '' };
  assert.equal(select(stray, ['tools/gen/src/main.rs']).scope, 'full');
});

const kotlinBuild = projects => ({
  'settings.gradle.kts': `rootProject.name = "r"\n${Object.keys(projects)
    .map(name => `include(":${name}")`)
    .join('\n')}\n`,
  'build.gradle.kts': 'plugins {\n  kotlin("multiplatform") apply false\n}\n',
  ...Object.fromEntries(
    Object.entries(projects).flatMap(([name, [build, ...files]]) => [
      [`${name}/build.gradle.kts`, build],
      ...files.map(file => [`${name}/${file}`, '']),
    ]),
  ),
});

test('Gradle: a Kotlin Multiplatform project runs allTests; an unnamed test source set runs full', () => {
  const tree = kotlinBuild({
    kmp: [
      'plugins {\n  kotlin("multiplatform")\n}\n',
      'src/commonMain/kotlin/A.kt',
      'src/jvmTest/kotlin/ATest.kt',
    ],
    common: ['plugins {\n  id("my.conventions")\n}\n', 'src/commonMain/kotlin/B.kt'],
    jvm: ['plugins {\n  kotlin("jvm")\n}\n', 'src/main/kotlin/C.kt', 'src/test/kotlin/CTest.kt'],
    suite: [
      'plugins {\n  java\n}\ntesting {\n  suites {\n    register<JvmTestSuite>("integrationTest")\n  }\n}\n',
      'src/main/java/D.java',
      'src/integrationTest/java/DIT.java',
    ],
    conventions: [
      'plugins {\n  id("my.conventions")\n}\n',
      'src/main/java/E.java',
      'src/e2eTest/java/ET.java',
    ],
  });
  assert.deepEqual(argv(select(tree, ['kmp/src/commonMain/kotlin/A.kt'])), [['', 'gradle :kmp:allTests']]);
  assert.deepEqual(argv(select(tree, ['common/src/commonMain/kotlin/B.kt'])), [
    ['', 'gradle :common:allTests'],
  ]);
  assert.deepEqual(argv(select(tree, ['jvm/src/main/kotlin/C.kt'])), [['', 'gradle :jvm:test']]);
  const suite = select(tree, ['suite/src/main/java/D.java']);
  assert.equal(suite.scope, 'full');
  assert.match(suite.reason, /integrationTest/);
  // A plugin from elsewhere may register the suite: full as well.
  assert.equal(select(tree, ['conventions/src/main/java/E.java']).scope, 'full');
});
