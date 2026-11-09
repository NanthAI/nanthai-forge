// SPDX-License-Identifier: Apache-2.0
import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { digest } from '../dist/portable-hash.js';
import { sourceTree } from '../dist/source-tree.js';
import { preflightPlan, preflightRuntime, runPreflight } from '../dist/agent-preflight.js';
import {
  buildPackageGraph,
  cachedPackageGraph,
  packageGraphFor,
  packageGraphKey,
  packageManifestPaths,
  packageSelection,
} from '../dist/package-graph.js';
import { parseToml } from '../dist/toml-lite.js';
import { projectTestRunner } from '../dist/project-test-runner.js';
import { contractManifestPaths, intentContractSelection } from '../dist/intent-contract-selection.js';
import { writeCheckPackages } from '../dist/package-graph-checkout.js';
import { commandCheckInputs } from '../scripts/check-command-env.mjs';
import { existsSync, readFileSync } from 'node:fs';

const laneId = '44444444-4444-4444-8444-444444444444';
const healthy = {
  ok: true,
  latencyMs: 1,
  fseventsdRssMb: null,
  fseventsdCpuPercent: null,
  reason: null,
  attempts: [],
};
test.beforeEach(t => t.mock.method(preflightRuntime, 'filesystemEventHealth', () => healthy));

/** Graph and selection for an in-memory tree (manifests read from it, nothing else). */
const graphOf = tree => buildPackageGraph(Object.keys(tree), path => tree[path]);
const select = (tree, changed) => packageSelection(graphOf(tree), changed);
const commands = selection => selection.commands.map(command => [command.cwd, ...command.argv].join(' '));
const names = selection => selection.packages.map(pkg => `${pkg.dir}:${pkg.why}`);

const go = {
  'lib/go.mod': 'module example.com/lib\n\ngo 1.23\n',
  'lib/sum/sum.go': 'package sum\n',
  'lib/sum/sum_test.go': 'package sum\n',
  'lib/sum/testdata/case.json': '{}',
  'svc/go.mod':
    'module example.com/svc\n\ngo 1.23\n\nrequire (\n\texample.com/lib v0.0.0 // local\n\tgithub.com/x/y v1.2.3\n)\n\nreplace example.com/lib => ../lib\n',
  'svc/main.go': 'package main\n',
  'tools/go.mod': 'module example.com/tools\n\ngo 1.23\n',
  'tools/gen.go': 'package tools\n',
  'README.md': '# Fixture\n',
};

test('Go: a changed module runs with the modules that require it; test-only changes run their package', () => {
  const lib = select(go, ['lib/sum/sum.go']);
  assert.equal(lib.scope, 'scoped');
  assert.deepEqual(names(lib), ['lib:changed', 'svc:dependent']);
  assert.deepEqual(commands(lib), ['lib go test ./...', 'svc go test ./...']);
  assert.deepEqual(commands(select(go, ['lib/sum/sum_test.go'])), ['lib go test ./sum']);
  // testdata is data any test of the module may read by a relative path: the module and its dependents.
  const tests = select(go, ['lib/sum/sum_test.go', 'lib/sum/testdata/case.json']);
  assert.deepEqual(commands(tests), ['lib go test ./...', 'svc go test ./...']);
  assert.deepEqual(commands(select(go, ['tools/gen.go', 'README.md'])), ['tools go test ./...']);
  // A root file (go.work) belongs to no package: full, with the reason.
  const root = select(go, ['go.work']);
  assert.equal(root.scope, 'full');
  assert.match(root.reason, /go\.work is outside every package/);
  // A single-module repository: a source change is the whole module (full), a test change is not.
  const single = { 'go.mod': 'module example.com/one\n', 'a/a.go': '', 'a/a_test.go': '' };
  assert.equal(select(single, ['a/a.go']).scope, 'full');
  assert.deepEqual(commands(select(single, ['a/a_test.go'])), [' go test ./a']);
});

test('replay (Go): shared testdata read from another package runs that package too', () => {
  const tree = {
    'go.mod': 'module example.com/one\n',
    'pkg/a/a.go': 'package a\n',
    'pkg/a/testdata/x.json': '{}',
    'pkg/b/b.go': 'package b\n',
    'pkg/b/b_test.go': 'package b\n// reads ../a/testdata/x.json\n',
  };
  // Before: only pkg/a ran (`go test ./pkg/a`); pkg/b's reader was skipped.
  const selection = select(tree, ['pkg/a/testdata/x.json']);
  assert.equal(selection.scope, 'full', JSON.stringify(selection));
  assert.deepEqual(commands(select(tree, ['pkg/b/b_test.go'])), [' go test ./pkg/b']);
});

test('replay (*.txt): dependency, build and fixture text files select their consumers, prose does not', () => {
  const tree = {
    'pyproject.toml': '[project]\nname = "root"\n',
    'requirements.txt': 'requests==2.32.0\n',
    'pkgs/leaf/pyproject.toml': '[project]\nname = "leaf"\n',
    'pkgs/leaf/x.py': '',
    'pkgs/other/pyproject.toml': '[project]\nname = "other"\n',
    'pkgs/other/y.py': '',
    'tests/fixtures/expected.txt': 'golden\n',
    'LICENSE.txt': 'text\n',
    'docs/notes.txt': 'prose\n',
  };
  const graph = graphOf(tree);
  // Before: requirements.txt was skipped as documentation and the check scoped to the leaf.
  assert.notEqual(packageSelection(graph, ['requirements.txt', 'pkgs/leaf/x.py']).scope, 'scoped');
  for (const path of ['requirements.txt', 'CMakeLists.txt', 'tests/fixtures/expected.txt'])
    assert.notEqual(packageSelection(graph, [path]).scope, 'none', path);
  assert.equal(packageSelection(graph, ['LICENSE.txt', 'docs/notes.txt']).scope, 'none');
});

const cargo = {
  'Cargo.toml':
    '[workspace]\nmembers = ["crates/*"]\nexclude = ["crates/skip"]\nresolver = "2"\n\n[workspace.dependencies]\ncore = { path = "crates/core" }\nserde = "1"\n',
  'Cargo.lock': '',
  'crates/core/Cargo.toml': '[package]\nname = "fx-core"\nversion = "0.1.0"\n',
  'crates/core/src/lib.rs': '',
  'crates/api/Cargo.toml':
    '[package]\nname = "fx-api"\nversion = "0.1.0"\n\n[dependencies]\ncore = { workspace = true, package = "fx-core" }\nserde.workspace = true\n',
  'crates/api/src/lib.rs': '',
  'crates/cli/Cargo.toml':
    "[package]\nname = 'fx-cli'\n\n[target.'cfg(unix)'.dev-dependencies]\nfx-api = { path = \"../api\" }\n",
  'crates/cli/src/main.rs': '',
  'crates/skip/Cargo.toml': '[package]\nname = "skip"\n',
  'crates/skip/src/lib.rs': '',
};

test('Rust: Cargo workspace members and path or workspace dependencies give cargo test -p per crate', () => {
  const core = select(cargo, ['crates/core/src/lib.rs']);
  assert.deepEqual(names(core), ['crates/api:dependent', 'crates/cli:dependent', 'crates/core:changed']);
  assert.deepEqual(commands(core), [' cargo test -p fx-api -p fx-cli -p fx-core']);
  assert.deepEqual(commands(select(cargo, ['crates/cli/src/main.rs'])), [' cargo test -p fx-cli']);
  // Excluded from the workspace: a standalone crate tested in its own folder.
  assert.deepEqual(commands(select(cargo, ['crates/skip/src/lib.rs'])), ['crates/skip cargo test']);
  assert.equal(select(cargo, ['Cargo.lock']).scope, 'full');
  // A manifest Forge cannot parse makes the layout unknown, never empty.
  const broken = graphOf({ ...cargo, 'crates/api/Cargo.toml': '[package\nname = 1' });
  assert.equal(broken.status, 'unknown');
  assert.match(broken.reason, /^cargo: crates\/api\/Cargo\.toml: TOML/);
});

const python = {
  'pyproject.toml': '[tool.ruff]\nline-length = 100\n\n[tool.pytest.ini_options]\ntestpaths = ["packages"]\n',
  'uv.lock': '',
  'packages/core/pyproject.toml': '[project]\nname = "fx.core"\ndependencies = ["requests>=2"]\n',
  'packages/core/src/fx_core/__init__.py': '',
  'packages/core/tests/test_core.py': '',
  'packages/api/pyproject.toml':
    '[project]\nname = "fx-api"\ndependencies = [\n  "FX_Core[speed] >=0.1; python_version > \'3.9\'",\n]\n',
  'packages/api/src/fx_api/app.py': '',
  'packages/legacy/setup.cfg':
    '[metadata]\nname = fx-legacy\n\n[options]\ninstall_requires =\n    fx-api\n    attrs\n',
  'packages/legacy/fx_legacy.py': '',
};

test('Python: pyproject/setup.cfg packages and requirement names select dependents; pytest via the lockfile tool', () => {
  const core = select(python, ['packages/core/src/fx_core/__init__.py']);
  assert.deepEqual(names(core), [
    'packages/api:dependent',
    'packages/core:changed',
    'packages/legacy:dependent',
  ]);
  assert.deepEqual(commands(core), [' uv run pytest packages/api packages/core packages/legacy']);
  assert.deepEqual(commands(select(python, ['packages/legacy/fx_legacy.py'])), [
    ' uv run pytest packages/legacy',
  ]);
  // setup.py is code: a package declared only there makes the layout unknown.
  const setupOnly = graphOf({ ...python, 'packages/old/setup.py': 'setup(name="old")' });
  assert.equal(setupOnly.status, 'unknown');
  assert.match(setupOnly.reason, /setup\.py, which is code/);
  // Without pytest declared anywhere there is no unambiguous command: full, with the reason.
  const { 'pyproject.toml': _root, ...bare } = python;
  const none = select(bare, ['packages/core/src/fx_core/__init__.py']);
  assert.equal(none.scope, 'full');
  assert.match(none.reason, /no pytest declared/);
});

const gradle = {
  'settings.gradle.kts':
    'rootProject.name = "fx"\ninclude(\n  ":core",\n  ":app",\n)\ninclude(":libs:util")\n',
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

test('Gradle: settings includes, project() and type-safe accessors select dependents for ./gradlew :x:test', () => {
  const util = select(gradle, ['libs/util/src/main/java/Util.java']);
  assert.deepEqual(names(util), ['app:dependent', 'core:dependent', 'libs/util:changed']);
  assert.deepEqual(commands(util), [' ./gradlew :app:test :core:test :libs:util:test']);
  assert.deepEqual(commands(select(gradle, ['app/src/main/java/App.java'])), [' ./gradlew :app:test']);
  const moved = graphOf({
    ...gradle,
    'settings.gradle.kts': 'include(":a")\nproject(":a").projectDir = file("x")\n',
  });
  assert.equal(moved.status, 'unknown');
});

const maven = {
  'pom.xml':
    '<project><groupId>fx</groupId><artifactId>parent</artifactId><packaging>pom</packaging><modules><module>core</module><module>web</module></modules></project>',
  'core/pom.xml':
    '<project><parent><groupId>fx</groupId><artifactId>parent</artifactId></parent><artifactId>fx-core</artifactId></project>',
  'core/src/main/java/A.java': '',
  'web/pom.xml':
    '<project><parent><groupId>fx</groupId><artifactId>parent</artifactId></parent><artifactId>fx-web</artifactId><dependencies><dependency><groupId>${project.groupId}</groupId><artifactId>fx-core</artifactId></dependency><dependency><groupId>org.x</groupId><artifactId>other</artifactId></dependency></dependencies></project>',
  'web/src/main/java/B.java': '',
};

test('Maven: root modules and dependency coordinates give mvn -pl … -am test', () => {
  assert.deepEqual(commands(select(maven, ['core/src/main/java/A.java'])), [' mvn -pl core,web -am test']);
  assert.deepEqual(commands(select(maven, ['web/src/main/java/B.java'])), [' mvn -pl web -am test']);
  assert.equal(select(maven, ['pom.xml']).scope, 'full');
});

const dotnet = {
  'Fx.sln': '',
  'src/Lib/Lib.csproj': '<Project Sdk="Microsoft.NET.Sdk"></Project>',
  'src/Lib/Thing.cs': '',
  'src/App/App.csproj':
    '<Project><ItemGroup><ProjectReference Include="..\\Lib\\Lib.csproj" /></ItemGroup></Project>',
  'src/App/Program.cs': '',
  'tests/Lib.Tests/Lib.Tests.csproj':
    '<Project><ItemGroup><PackageReference Include="Microsoft.NET.Test.Sdk" Version="17.0.0" /><ProjectReference Include="../../src/Lib/Lib.csproj" /></ItemGroup></Project>',
  'tests/Lib.Tests/LibTests.cs': '',
  'tests/App.Specs/App.Specs.fsproj':
    '<Project><PropertyGroup><IsTestProject>true</IsTestProject></PropertyGroup><ItemGroup><ProjectReference Include="..\\..\\src\\App\\App.csproj" /></ItemGroup></Project>',
};

test('.NET: ProjectReference edges select dependents; only test projects run dotnet test', () => {
  const lib = select(dotnet, ['src/Lib/Thing.cs']);
  assert.deepEqual(names(lib), [
    'src/App:dependent',
    'src/Lib:changed',
    'tests/App.Specs:dependent',
    'tests/Lib.Tests:dependent',
  ]);
  assert.deepEqual(commands(lib), [
    ' dotnet test tests/App.Specs/App.Specs.fsproj',
    ' dotnet test tests/Lib.Tests/Lib.Tests.csproj',
  ]);
  // A project with no test project downstream has nothing to run.
  const app = select({ ...dotnet, 'tests/App.Specs/App.Specs.fsproj': '<Project/>' }, ['src/App/Program.cs']);
  assert.equal(app.scope, 'none');
});

const pnpm = {
  'package.json': JSON.stringify({ name: 'fx', private: true, scripts: { test: 'turbo run test' } }),
  'pnpm-lock.yaml': '',
  'pnpm-workspace.yaml': "packages:\n  - 'packages/*'\n  - apps/*\n  - '!packages/ignored'\n",
  'packages/core/package.json': JSON.stringify({ name: '@fx/core', scripts: { test: 'vitest run' } }),
  'packages/core/src/index.ts': '',
  'packages/ui/package.json': JSON.stringify({ name: '@fx/ui', dependencies: { '@fx/core': 'workspace:*' } }),
  'packages/ui/src/index.ts': '',
  'apps/web/package.json': JSON.stringify({
    name: 'web',
    devDependencies: { '@fx/ui': 'workspace:^' },
    scripts: { test: 'vitest run' },
  }),
  'apps/web/src/main.ts': '',
  'packages/ignored/package.json': JSON.stringify({ name: 'ignored', dependencies: { '@fx/core': '1' } }),
};

test('JS/TS workspaces: pnpm workspace packages and their dependents run through the package manager', () => {
  const core = select(pnpm, ['packages/core/src/index.ts']);
  assert.deepEqual(names(core), ['apps/web:dependent', 'packages/core:changed', 'packages/ui:dependent']);
  // packages/ui has no test script: selected, nothing to run.
  assert.deepEqual(commands(core), [' pnpm --filter ./apps/web --filter ./packages/core run test']);
  const npm = { ...pnpm, 'package.json': JSON.stringify({ workspaces: ['packages/*', 'apps/*'] }) };
  delete npm['pnpm-workspace.yaml'];
  delete npm['pnpm-lock.yaml'];
  assert.deepEqual(commands(select(npm, ['apps/web/src/main.ts'])), [' npm run test --workspace=apps/web']);
});

test('an undeclared package nested in another selects the enclosing package; unknown layouts say why', () => {
  const nested = {
    'svc/go.mod': 'module x/svc\n',
    'svc/a.go': '',
    'svc/fixtures/mod/go.mod': 'module x/fixture\n',
    'svc/fixtures/mod/f.go': '',
  };
  assert.deepEqual(names(select(nested, ['svc/fixtures/mod/f.go'])), [
    'svc:changed',
    'svc/fixtures/mod:changed',
  ]);
  const empty = select({ 'main.c': '', Makefile: '' }, ['main.c']);
  assert.equal(empty.scope, 'full');
  assert.match(empty.reason, /package graph unknown: no package manifests/);
});

test('the graph reads manifests only, within a bounded count, cached per head', () => {
  const reads = [];
  const tree = { ...go, ...cargo };
  const paths = Object.keys(tree);
  const files = paths.map(path => ({ path, blob: digest(tree[path]) }));
  const key = packageGraphKey(files);
  packageGraphFor(key, paths, path => (reads.push(path), tree[path]));
  assert.deepEqual([...new Set(reads)].sort(), packageManifestPaths(paths));
  assert.ok(reads.every(path => /(?:go\.mod|Cargo\.toml)$/.test(path)));
  reads.length = 0;
  packageGraphFor(key, paths, path => (reads.push(path), tree[path]));
  assert.equal(reads.length, 0, 'a second selection on the same head reads nothing');
  assert.ok(cachedPackageGraph(key));
  // A manifest edit is a new head key.
  assert.notEqual(packageGraphKey(files.map(f => (f.path === 'svc/go.mod' ? { ...f, blob: 'x' } : f))), key);
  // A source edit is not.
  assert.equal(packageGraphKey(files.map(f => (f.path === 'svc/main.go' ? { ...f, blob: 'x' } : f))), key);
  const many = Object.fromEntries(Array.from({ length: 2001 }, (_, i) => [`m${i}/go.mod`, `module m${i}\n`]));
  const over = graphOf(many);
  assert.equal(over.status, 'unknown');
  assert.match(over.reason, /2001 manifests exceed/);
});

test('TOML subset: tables, arrays of tables, dotted and quoted keys, multi-line strings and arrays', () => {
  const toml = parseToml(
    '# c\n[a.b]\nx = "q\\"t" # c\n\'k.y\' = [\n  1, 2, # c\n]\n[[bin]]\nname = """\nmulti"""\n[[bin]]\nname = \'lit\'\n[c]\nd.e = { f = true, g = [] }\n',
  );
  assert.deepEqual(toml, {
    a: { b: { x: 'q"t', 'k.y': [1, 2] } },
    bin: [{ name: 'multi' }, { name: 'lit' }],
    c: { d: { e: { f: true, g: [] } } },
  });
  assert.throws(() => parseToml('a = 1\na = 2\n'), /duplicate key/);
});

function lane(t, bytes) {
  const dir = mkdtempSync(join(tmpdir(), 'forge-package-graph-'));
  const root = join(dir, 'lane');
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  for (const [path, body] of Object.entries(bytes)) {
    mkdirSync(join(root, path, '..'), { recursive: true });
    writeFileSync(join(root, path), body);
  }
  const files = () =>
    Object.entries(bytes).map(([path, body]) => ({ path, blob: digest(body), mode: 'file' }));
  return {
    root,
    plan: paths => preflightPlan(root, { paths, complete: true }, { laneId, files: files() }),
    run: plan => runPreflight(root, laneId, digest(JSON.stringify(files())), plan, sourceTree(files())),
  };
}

test('preflight on a Go repository with no package.json plans and runs package commands', t => {
  const repo = lane(t, go);
  const plan = repo.plan(['lib/sum/sum.go']);
  assert.equal(plan.status, 'planned');
  assert.equal(plan.scope, 'scoped');
  assert.equal(plan.runner.label, 'package commands (go)');
  // The module graph narrows the changed module to the package folders whose tests reach the change
  // (lib's only test folder is ./sum); svc, which requires lib, still runs whole.
  assert.deepEqual(plan.tests, ['package:svc:go test ./...', 'package:lib:go test ./sum']);
  assert.equal(plan.command, '(cd svc && go test ./...) && (cd lib && go test ./sum)');
  assert.deepEqual(
    plan.packages.map(pkg => pkg.name),
    ['example.com/lib', 'example.com/svc'],
  );
  assert.equal(repo.plan(['go.work']).scope, 'full');
  assert.equal(repo.plan(['README.md']).scope, 'docs');
  // Run: each unit is one process in its package folder; a failure stops the rest.
  const ok = [process.execPath, '-e', 'process.exit(require("fs").existsSync("go.mod") ? 0 : 3)'];
  const pass = repo.run({
    ...plan,
    packageCommands: { [plan.tests[0]]: { cwd: 'svc', argv: ok }, [plan.tests[1]]: { cwd: 'lib', argv: ok } },
  });
  assert.equal(pass.passed, true);
  assert.equal(pass.tests, 2);
  const fail = repo.run({
    ...plan,
    packageCommands: {
      [plan.tests[0]]: { cwd: 'svc', argv: [process.execPath, '-e', 'process.exit(4)'] },
      [plan.tests[1]]: { cwd: 'lib', argv: ok },
    },
  });
  assert.equal(fail.passed, false);
  assert.equal(fail.exitCode, 4);
  assert.equal(fail.stoppedForFailure, 1);
});

test('forge.json declares a runner for any language; package.json keeps working; both is an error', t => {
  const declared = {
    preflight: { tests: { glob: '**/test_*.py', command: ['python', '-m', 'pytest', '{files}'] } },
  };
  const resolved = projectTestRunner(undefined, () => [], { forgeJson: JSON.stringify(declared) });
  assert.equal(resolved.status, 'available');
  assert.equal(resolved.runner.declaredIn, 'forge.json');
  assert.deepEqual(resolved.runner.globs, ['**/test_*.py']);
  const fromPackage = projectTestRunner(JSON.stringify({ forge: declared }), () => []);
  assert.equal(fromPackage.runner.declaredIn, 'package.json');
  assert.throws(
    () =>
      projectTestRunner(JSON.stringify({ forge: declared }), () => [], {
        forgeJson: JSON.stringify(declared),
      }),
    /declared in both forge\.json and package\.json/,
  );
  assert.throws(() => projectTestRunner(undefined, () => [], { forgeJson: '{' }), /forge\.json is not JSON/);
  // No package.json: a stray Node-pattern test file does not turn a Go repository into a Node one.
  const goRepo = { ...go, 'tools/test/helper.js': '' };
  const goPaths = Object.keys(goRepo);
  const graph = () => buildPackageGraph(goPaths, path => goRepo[path]);
  assert.equal(projectTestRunner(undefined, () => goPaths, { packages: graph }).runner.layout, 'packages');
  // Without the graph either, Node's file rule still needs a package.json (slice F, e89be958).
  assert.equal(projectTestRunner(undefined, () => goPaths).status, 'unavailable');
  // Without a declaration and without the graph, nothing is guessed.
  assert.equal(projectTestRunner(undefined, () => ['a.go']).status, 'unavailable');

  // Declared pytest in a Python repository: changed tests plus test files in the affected packages.
  const repo = lane(t, {
    ...python,
    'forge.json': JSON.stringify(declared),
    'packages/api/tests/test_api.py': '',
  });
  const plan = repo.plan(['packages/core/src/fx_core/__init__.py']);
  assert.equal(plan.runner.label, 'declared (declared in forge.json)');
  // Equally close tests run in a stable hash order, not name order (Issue 964e2d2b).
  assert.deepEqual([...plan.tests].sort(), [
    'packages/api/tests/test_api.py',
    'packages/core/tests/test_core.py',
  ]);
  assert.equal(plan.command, `python -m pytest ${plan.tests.join(' ')}`);
});

test('the tests read selects packages for a Rust repository with no package.json', () => {
  const allPaths = Object.keys(cargo);
  const files = new Map();
  const key = packageGraphKey(allPaths.map(path => ({ path, blob: digest(cargo[path]) })));
  for (const path of contractManifestPaths(files, allPaths, key)) files.set(path, cargo[path]);
  assert.ok([...files.keys()].every(path => path.endsWith('Cargo.toml')));
  const selection = intentContractSelection(files, ['crates/api/src/lib.rs'], allPaths, key);
  assert.equal(selection.scope, 'scoped');
  assert.equal(selection.runner.label, 'package commands (cargo)');
  assert.equal(selection.command, 'cargo test -p fx-api -p fx-cli');
  assert.deepEqual(selection.tests, []);
  // Forge's own layout reads no manifests for the graph.
  const forge = new Map([
    ['package.json', JSON.stringify({ scripts: { test: 'node --test tests/*.test.mjs' } })],
  ]);
  assert.deepEqual(contractManifestPaths(forge, ['package.json', 'tests/a.test.mjs', 'x/go.mod']), []);
});

test('a scoped configured command gets FORGE_CHECK_PACKAGES from the checkout manifests; a full run does not', t => {
  const repo = lane(t, {
    ...cargo,
    // A unit test in the changed library: the module graph narrows fx-api to it (and fx-cli runs whole).
    'crates/api/src/lib.rs': '#[cfg(test)]\nmod tests {\n    #[test]\n    fn ok() {}\n}\n',
    'node_modules/x/Cargo.toml': '[package\n',
    '.git/Cargo.toml': '[',
  });
  const scoped = writeCheckPackages(repo.root, { mode: 'scoped', paths: ['crates/api/src/lib.rs'] });
  t.after(() => scoped?.remove());
  assert.ok(scoped && !scoped.path.startsWith(repo.root), 'the file lives outside the checkout');
  const file = JSON.parse(readFileSync(scoped.path, 'utf8'));
  assert.equal(file.version, 1);
  assert.equal(file.scope, 'scoped');
  assert.deepEqual(file.commands, [
    { ecosystem: 'cargo', cwd: '', argv: ['cargo', 'test', '-p', 'fx-cli'] },
    { ecosystem: 'cargo', cwd: '', argv: ['cargo', 'test', '-p', 'fx-api', '--lib'] },
  ]);
  assert.deepEqual(
    file.packages.map(pkg => pkg.name),
    ['fx-api', 'fx-cli'],
  );
  const root = writeCheckPackages(repo.root, { mode: 'scoped', paths: ['Cargo.lock'] });
  t.after(() => root?.remove());
  assert.equal(JSON.parse(readFileSync(root.path, 'utf8')).scope, 'full');
  assert.equal(writeCheckPackages(repo.root, { mode: 'full', paths: ['crates/api/src/lib.rs'] }), null);
  assert.equal(writeCheckPackages(repo.root, { mode: 'scoped' }), null);
  scoped.remove();
  assert.equal(existsSync(scoped.path), false);

  // The executor passes it to the command only on a scoped run.
  const previous = process.env.FORGE_CHECK_PACKAGES;
  t.after(() =>
    previous === undefined
      ? delete process.env.FORGE_CHECK_PACKAGES
      : (process.env.FORGE_CHECK_PACKAGES = previous),
  );
  process.env.FORGE_CHECK_PACKAGES = '/tmp/packages.json';
  const changes = mode => ({
    groups: [],
    selection: { changes: { version: 1, mode, base: 'a', head: 'b', paths: [] } },
  });
  const asked = commandCheckInputs(changes('scoped'), 'static');
  asked.finish(false);
  assert.equal(asked.env.FORGE_CHECK_PACKAGES, '/tmp/packages.json');
  const full = commandCheckInputs(changes('full'), 'static');
  full.finish(false);
  assert.equal(full.env.FORGE_CHECK_PACKAGES, undefined);
});
