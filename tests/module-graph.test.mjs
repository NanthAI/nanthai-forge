// SPDX-License-Identifier: Apache-2.0
import assert from 'node:assert/strict';
import test from 'node:test';
import {
  buildModuleGraph,
  moduleGraphFor,
  moduleGraphKey,
  MODULE_GRAPH_LIMITS,
} from '../dist/module-graph.js';
import { moduleReach } from '../dist/module-selection.js';
import { buildPackageGraph, enclosingPackages } from '../dist/package-graph.js';
import { packageTestSelection } from '../dist/package-test-selection.js';
import { DEFAULT_LIMITS } from '../dist/snapshot.js';

/** Synthetic heads only: every file below is written for this test. */
function head(files) {
  const paths = Object.keys(files);
  const read = path => files[path];
  const packages = buildPackageGraph(paths, read);
  const modules = buildModuleGraph({ paths, read });
  const select = changed => packageTestSelection(packages, changed, () => modules);
  const reach = changed =>
    [
      ...moduleReach(modules, changed, path =>
        enclosingPackages(packages, path).map(pkg => `${pkg.ecosystem}:${pkg.dir}`),
      ).reached,
    ]
      .filter(path => !path.startsWith('\0'))
      .sort();
  return { packages, modules, select, reach, without: changed => packageTestSelection(packages, changed) };
}

test('Python: an edit selects only the pytest files whose imports reach it', () => {
  const repo = head({
    'pyproject.toml': '[project]\nname = "shop"\n[project.optional-dependencies]\ntest = ["pytest"]\n',
    'shop/__init__.py': '',
    'shop/money.py': 'def cents(value):\n    return round(value * 100)\n',
    'shop/cart.py':
      'from .money import cents\n\ndef total(items):\n    return sum(cents(i) for i in items)\n',
    'shop/catalog.py': '"""import shop.cart is only text here."""\nNAMES = []\n',
    'shop/native.py': 'from ._speedups import fast  # compiled extension, no Python source\n',
    'tests/conftest.py': 'import pytest\n',
    'tests/test_money.py': 'from shop import money\n\ndef test_cents():\n    assert money.cents(1) == 100\n',
    'tests/test_cart.py':
      'from shop.cart import (\n    total,\n)\n\ndef test_total():\n    assert total([1]) == 100\n',
    'tests/test_catalog.py': 'import shop.catalog\n',
    'tests/test_plugins.py': 'import importlib\nmod = importlib.import_module("shop." + "money")\n',
    'tests/test_native.py': 'from shop.native import fast\n',
  });
  const changed = ['shop/money.py'];
  assert.deepEqual(repo.without(changed).scope, 'full', 'package level: the root package is affected');
  const selection = repo.select(changed);
  assert.equal(selection.scope, 'scoped');
  assert.equal(
    selection.command,
    'python -m pytest tests/test_cart.py tests/test_money.py tests/test_plugins.py',
    'dynamic loading (importlib) falls back to the package, never to empty',
  );
  assert.match(selection.reason, /module graph: python:\. runs 3 test unit/);
  // conftest.py is loaded for every test below it.
  assert.equal(
    repo.select(['tests/conftest.py']).command,
    'python -m pytest tests/test_cart.py tests/test_catalog.py tests/test_money.py tests/test_native.py tests/test_plugins.py',
  );
  // A docstring mentioning an import adds no edge; a compiled extension is no unresolved local import.
  assert.equal(repo.modules.nodes.get('shop/native.py').wide, undefined);
  assert.equal(
    repo.select(['shop/catalog.py']).command,
    'python -m pytest tests/test_catalog.py tests/test_plugins.py',
  );
  // A file without module facts (data, C, a deleted module) keeps the package whole.
  assert.equal(repo.select(['shop/rates.json']).scope, 'full');
});

test('Python: an unresolved import that a Python file could satisfy makes the importer wide', () => {
  const repo = head({
    'pyproject.toml': '[project]\nname = "app"\ndependencies = ["pytest"]\n',
    'app/__init__.py': '',
    'app/core.py': 'from .helpers import run  # helpers.py lives elsewhere (sys.path tricks)\n',
    'scripts/helpers.py': 'def run(): pass\n',
    'app/other.py': 'X = 1\n',
    'tests/test_core.py': 'from app.core import run\n',
  });
  assert.match(repo.modules.nodes.get('app/core.py').wide, /unresolved relative import \.helpers/);
  assert.deepEqual(repo.reach(['app/other.py']), ['app/core.py', 'app/other.py', 'tests/test_core.py']);
});

test('Python: pytest settings that change discovery or sys.path keep the package whole', () => {
  const repo = head({
    'pyproject.toml':
      '[project]\nname = "x"\ndependencies = ["pytest"]\n[tool.pytest.ini_options]\npythonpath = ["lib"]\n',
    'x/__init__.py': '',
    'x/a.py': '',
    'tests/test_a.py': 'import x.a\n',
  });
  assert.equal(repo.select(['x/a.py']).scope, 'full');
  assert.match(repo.select(['x/a.py']).reason, /pythonpath/);
  // Without pytest another runner may name tests otherwise: reach is known, selection stays whole.
  const unittest = head({
    'pyproject.toml': '[project]\nname = "x"\n',
    'x/__init__.py': '',
    'x/a.py': '',
    'examples/demo.py': 'import x\n',
    'tests/test_a.py': 'import x.a\n',
  });
  assert.deepEqual(unittest.reach(['x/a.py']), ['tests/test_a.py', 'x/a.py']);
  assert.equal(unittest.select(['examples/demo.py']).scope, 'full');
  assert.match(unittest.select(['examples/demo.py']).reason, /no pytest declared/);
});

test('Go: an edit selects only the package folders whose imports reach it', () => {
  const repo = head({
    'go.mod': 'module example.com/shop\n\ngo 1.22\n',
    'money/money.go': 'package money\n\nfunc Cents(v float64) int { return int(v * 100) }\n',
    'money/money_test.go': 'package money\n\nimport "testing"\n\nfunc TestCents(t *testing.T) {}\n',
    'cart/cart.go':
      'package cart\n\nimport (\n\t"fmt"\n\tm "example.com/shop/money"\n)\n\nfunc Total() int { fmt.Println(); return m.Cents(1) }\n',
    'cart/cart_test.go':
      'package cart_test\n\nimport (\n\t"testing"\n\t"example.com/shop/cart"\n)\n\nfunc TestTotal(t *testing.T) { cart.Total() }\n',
    'catalog/catalog.go':
      'package catalog\n\n// import "example.com/shop/money" is a comment\nvar Names []string\n',
    'catalog/catalog_test.go': 'package catalog\n\nimport "testing"\n\nfunc TestNames(t *testing.T) {}\n',
    'e2e/run_test.go':
      'package e2e\n\nimport (\n\t"os/exec"\n\t"testing"\n)\n\nfunc TestBinary(t *testing.T) { exec.Command("go", "run", "./cmd") }\n',
  });
  const changed = ['money/money.go'];
  assert.equal(repo.without(changed).scope, 'full');
  const selection = repo.select(changed);
  assert.equal(selection.command, 'go test ./cart ./e2e ./money', 'os/exec falls back to the module');
  assert.equal(repo.select(['catalog/catalog.go']).command, 'go test ./catalog ./e2e');
  // A test-only folder keeps its own leaf rule.
  assert.equal(repo.select(['cart/cart_test.go']).command, 'go test ./cart');
  assert.equal(repo.select(['money/rates.json']).scope, 'full');
});

test('Rust: module edges for use/crate/super paths; test-target edits run only their targets', () => {
  const repo = head({
    'Cargo.toml':
      '[package]\nname = "shop-core"\nversion = "0.1.0"\nautotests = false\n\n[[test]]\nname = "integration"\npath = "tests/main.rs"\n\n[[test]]\nname = "smoke"\npath = "tests/smoke.rs"\n',
    'src/lib.rs': 'pub mod money;\npub mod cart;\nmod catalog;\n',
    'src/money.rs': 'pub fn cents(v: f64) -> i64 { (v * 100.0) as i64 }\n',
    'src/cart.rs':
      'use crate::money::cents;\n\npub fn total() -> i64 { cents(1.0) }\n\n#[cfg(test)]\nmod tests {\n    use super::*;\n}\n',
    'src/catalog.rs': '// crate::money::cents is only a comment here\npub struct Catalog;\n',
    'tests/main.rs': '#[macro_use]\nmod macros;\nmod util;\nmod cart_tests;\n',
    'tests/macros.rs': 'macro_rules! check { () => {} }\n',
    'tests/util.rs': 'pub fn fixture() {}\n',
    'tests/cart_tests.rs': 'use crate::util::fixture;\nuse shop_core::cart::total;\n',
    'tests/smoke.rs': 'use shop_core::money;\n',
  });
  assert.deepEqual(repo.modules.nodes.get('src/cart.rs').deps.sort(), ['src/money.rs']);
  // Not src/catalog.rs (a comment names the path) nor tests/util.rs.
  assert.deepEqual(repo.reach(['src/money.rs']), [
    'src/cart.rs',
    'src/money.rs',
    'tests/cart_tests.rs',
    'tests/smoke.rs',
  ]);
  assert.deepEqual(repo.modules.nodes.get('tests/util.rs').units, ['integration']);
  assert.deepEqual(repo.modules.nodes.get('tests/cart_tests.rs').deps.sort(), [
    'src/cart.rs',
    'tests/util.rs',
  ]);
  const changed = ['tests/util.rs'];
  assert.equal(repo.without(changed).scope, 'full');
  assert.equal(repo.select(changed).command, 'cargo test --test=integration');
  // Library code is built into every test target: the crate stays whole.
  assert.equal(repo.select(['src/catalog.rs']).scope, 'full');
  assert.match(repo.select(['src/catalog.rs']).reason, /Cargo builds it into every test target/);
});

test('Java (Maven): an edit selects only the test classes that reach it, by package and name', () => {
  const repo = head({
    'pom.xml': '<project><groupId>g</groupId><artifactId>shop</artifactId></project>\n',
    'src/main/java/shop/Money.java':
      'package shop;\n\npublic final class Money { public static int cents(double v) { return 1; } }\n',
    'src/main/java/shop/Cart.java':
      'package shop;\n\npublic class Cart { int total() { return Money.cents(1); } }\n',
    'src/main/java/shop/Catalog.java':
      'package shop;\n\n/** Money is only named in a comment. */\npublic class Catalog {}\n',
    'src/main/java/shop/api/Client.java':
      'package shop.api;\n\npublic class Client { Object m = shop.Money.class; }\n',
    'src/test/java/shop/CartTest.java':
      'package shop;\n\nimport org.junit.jupiter.api.Test;\n\nclass CartTest { @Test void total() { new Cart(); } }\n',
    'src/test/java/shop/CatalogTest.java':
      'package shop;\n\nimport org.junit.jupiter.api.Test;\n\nclass CatalogTest { @Test void it() { new Catalog(); } }\n',
    'src/test/java/shop/api/ClientTest.java':
      'package shop.api;\n\nimport org.junit.jupiter.api.Test;\n\nclass ClientTest { @Test void it() { new Client(); } }\n',
    'src/test/java/shop/PluginTest.java':
      'package shop;\n\nimport org.junit.jupiter.api.Test;\n\nclass PluginTest { @Test void it() throws Exception { Class.forName("shop.X"); } }\n',
  });
  const changed = ['src/main/java/shop/Money.java'];
  assert.equal(repo.without(changed).scope, 'full');
  assert.equal(
    repo.select(changed).command,
    'mvn test -Dtest=shop.CartTest,shop.PluginTest,shop.api.ClientTest -Dsurefire.failIfNoSpecifiedTests=false',
  );
});

test('Kotlin (Gradle): top-level functions, facades and imports; other test source sets stay whole', () => {
  const repo = head({
    'settings.gradle.kts': 'include(":lib")\n',
    'lib/build.gradle.kts': 'plugins { kotlin("jvm") }\n',
    'lib/src/main/kotlin/q/Util.kt': 'package q\n\nfun helper(): Int = 1\n\nprivate fun hidden() = 2\n',
    'lib/src/main/kotlin/q/Other.kt': 'package q\n\nclass Other(val hidden: Int)\n',
    'lib/src/main/kotlin/r/Uses.kt': 'package r\n\nimport q.helper\n\nobject Uses { val v = helper() }\n',
    'lib/src/test/kotlin/q/UtilTest.kt':
      'package q\n\nimport kotlin.test.Test\n\nclass UtilTest { @Test fun it() { helper() } }\n',
    'lib/src/test/kotlin/q/OtherTest.kt':
      'package q\n\nimport kotlin.test.Test\n\nclass OtherTest { @Test fun it() { Other(hidden = 1) } }\n',
    'lib/src/test/kotlin/r/UsesTest.kt':
      'package r\n\nimport kotlin.test.Test\n\nclass UsesTest { @Test fun it() { Uses.v } }\n',
    'lib/src/test/java/q/JavaTest.java':
      'package q;\n\nimport org.junit.Test;\n\npublic class JavaTest { @Test public void it() { UtilKt.helper(); } }\n',
  });
  const changed = ['lib/src/main/kotlin/q/Util.kt'];
  assert.equal(repo.without(changed).command, 'gradle :lib:test');
  assert.equal(
    repo.select(changed).command,
    'gradle :lib:test --tests q.JavaTest --tests q.UtilTest --tests r.UsesTest',
  );
  const kmp = head({
    'settings.gradle.kts': 'include(":lib")\n',
    'lib/build.gradle.kts': 'plugins { kotlin("multiplatform") }\n',
    'lib/src/commonMain/kotlin/q/Util.kt': 'package q\n\nfun helper(): Int = 1\n',
    'lib/src/jvmTest/kotlin/q/UtilTest.kt':
      'package q\n\nimport kotlin.test.Test\n\nclass UtilTest { @Test fun it() { helper() } }\n',
  });
  assert.equal(kmp.select(['lib/src/commonMain/kotlin/q/Util.kt']).command, 'gradle :lib:test');
});

test('module graph stays within the code graph bounds and re-reads only changed blobs', () => {
  assert.deepEqual(MODULE_GRAPH_LIMITS, {
    maxFiles: DEFAULT_LIMITS.maxFiles,
    maxFileBytes: DEFAULT_LIMITS.maxFileBytes,
    maxTotalBytes: DEFAULT_LIMITS.maxTotalBytes,
  });
  const files = { 'go.mod': 'module m\n' };
  for (let i = 0; i <= MODULE_GRAPH_LIMITS.maxFiles; i++) files[`p/f${i}.go`] = 'package p\n';
  const over = buildModuleGraph({ paths: Object.keys(files), read: path => files[path] });
  assert.equal(over.status, 'unknown');
  assert.match(over.reason, /exceed the module graph limit/);

  const small = { 'a.py': 'import b\n', 'b.py': '', 'test_a.py': 'import a\n' };
  let reads = 0;
  const source = blobs => ({
    paths: Object.keys(small),
    read: path => (reads++, small[path]),
    blobs: new Map(Object.keys(small).map(path => [path, blobs[path] ?? `${path}@1`])),
  });
  const first = source({});
  moduleGraphFor(undefined, first);
  assert.equal(reads, 3);
  reads = 0;
  const saved = source({ 'b.py': 'b.py@2' });
  const key = moduleGraphKey([...saved.blobs].map(([path, blob]) => ({ path, blob })));
  const graph = moduleGraphFor(key, saved);
  assert.equal(reads, 1, 'only the changed blob is read again');
  assert.equal(moduleGraphFor(key, saved), graph, 'one graph per head');
  assert.equal(reads, 1);
});
