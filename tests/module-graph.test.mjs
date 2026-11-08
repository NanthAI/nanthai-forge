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

test('Python without pytest: unittest modules narrow to python -m unittest MODULE', () => {
  const case_ = (name, body) =>
    `import unittest\nfrom app import ${name}\n\nclass ${name.toUpperCase()}Test(unittest.TestCase):\n${body}`;
  const files = {
    'pyproject.toml': '[project]\nname = "app"\n',
    'app/__init__.py': '',
    'app/a.py': 'def one():\n    return 1\n',
    'app/b.py': 'from . import a\n\ndef two():\n    return a.one() + 1\n',
    'app/c.py': 'X = 3\n',
    'tests/__init__.py': '',
    'tests/test_a.py': case_('a', '    def test_one(self):\n        self.assertEqual(a.one(), 1)\n'),
    'tests/test_b.py': case_('b', '    def test_two(self):\n        self.assertEqual(b.two(), 2)\n'),
    'tests/test_c.py': case_('c', '    def test_x(self):\n        self.assertEqual(c.X, 3)\n'),
    'tests/data_check.py': 'from app import c\n',
  };
  const repo = head(files);
  assert.equal(repo.without(['app/a.py']).scope, 'full', 'package level: no pytest, no unambiguous command');
  const selection = repo.select(['app/a.py']);
  assert.equal(selection.scope, 'scoped');
  assert.equal(selection.command, 'python -m unittest tests.test_a tests.test_b');
  assert.match(selection.reason, /module graph: python:\. runs 2 test unit/);
  assert.deepEqual(repo.modules.nodes.get('tests/test_a.py').units, ['unittest:tests/test_a.py']);
  // A helper module no test reaches runs nothing.
  assert.equal(repo.select(['tests/data_check.py']).scope, 'none');
  // The lockfile's tool wraps the interpreter.
  assert.equal(
    head({ ...files, 'uv.lock': '' }).select(['app/c.py']).command,
    'uv run python -m unittest tests.test_c',
  );
  // A test-looking file Forge cannot prove is a unittest module keeps the project whole, however narrow
  // the rest is; so does a test folder that is not a package (unittest would import it differently).
  const odd = head({ ...files, 'tests/test_odd.py': 'from app import c\n\ndef test_x():\n    assert c.X\n' });
  assert.match(odd.modules.nodes.get('tests/test_odd.py').whole, /not a unittest\.TestCase module/);
  assert.equal(odd.select(['app/c.py']).scope, 'full');
  assert.equal(odd.select(['app/a.py']).scope, 'scoped', 'the odd file does not reach a.py');
  const loose = { ...files };
  delete loose['tests/__init__.py'];
  const flat = head(loose).select(['app/a.py']);
  assert.equal(flat.scope, 'full');
  assert.match(flat.reason, /not importable as a unittest module .*__init__\.py/);
  // Only a pytest declaration (or its conftest.py) makes files pytest tests.
  const both = head({ ...files, 'conftest.py': '' });
  assert.equal(both.select(['app/a.py']).command, 'python -m pytest tests/test_a.py tests/test_b.py');
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
      'use crate::money::cents;\n\npub fn total() -> i64 { cents(1.0) }\n\n#[cfg(test)]\nmod tests {\n    use super::*;\n\n    #[test]\n    fn adds() { assert_eq!(total(), 100); }\n}\n',
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
  // Library code: the unit tests of the library modules that reach it (a test-name filter on the module
  // path) plus the integration targets that reach it; the harnesses run as separate invocations
  // because the filter would also filter the targets.
  assert.equal(repo.without(['src/money.rs']).scope, 'full');
  assert.equal(
    repo.select(['src/money.rs']).command,
    'cargo test --test=integration --test=smoke && cargo test --lib -- cart::',
  );
  assert.match(repo.select(['src/money.rs']).reason, /module graph: cargo:\. runs 3 test unit/);
  // Nothing reaches an unused library module: no test runs, and the landing check still builds it.
  assert.equal(repo.select(['src/catalog.rs']).scope, 'none');
});

test('Rust: library code that is used without being named, and tests Forge cannot see, widen the run', () => {
  const crate = extra => ({
    'Cargo.toml':
      '[package]\nname = "shop"\nversion = "0.1.0"\nautotests = false\n\n[[test]]\nname = "smoke"\npath = "tests/smoke.rs"\n',
    'src/lib.rs': 'pub mod shape;\nmod shape_ext;\nmod gen;\nmod uses_gen;\nmod ffi;\npub mod plain;\n',
    'src/shape.rs': 'pub struct Shape;\n',
    // An inherent impl in another file than its type: callers of Shape use it without naming this file.
    'src/shape_ext.rs': 'use crate::shape::Shape;\n\nimpl Shape {\n    pub fn area(&self) -> i64 { 1 }\n}\n',
    'src/plain.rs': 'pub fn unused() {}\n',
    // A macro that defines tests: whoever calls it has tests in its own module.
    'src/gen.rs':
      'macro_rules! gen_tests {\n    ($n:ident) => {\n        #[test]\n        fn $n() {}\n    };\n}\n',
    'src/uses_gen.rs': 'gen_tests!(works);\n',
    'src/ffi.rs': '#[no_mangle]\npub extern "C" fn exported() {}\n',
    'tests/smoke.rs': 'use shop::shape::Shape;\n\n#[test]\nfn area() { assert_eq!(Shape.area(), 1); }\n',
    ...extra,
  });
  const repo = head(crate({}));
  assert.equal(repo.select(['src/shape_ext.rs']).command, 'cargo test --test=smoke');
  assert.equal(repo.select(['src/gen.rs']).command, 'cargo test --lib -- gen:: uses_gen::');
  // Symbols and linker tricks are visible to the whole crate (and beyond) without a name.
  assert.match(repo.modules.nodes.get('src/ffi.rs').whole, /no_mangle.*acts without being named/);
  assert.equal(repo.select(['src/ffi.rs']).scope, 'full');
  // A proc-macro library acts in every file that uses its macros, named by attribute, not by path.
  const macros = head(
    crate({
      'Cargo.toml': '[package]\nname = "shop"\nversion = "0.1.0"\n\n[lib]\nproc-macro = true\n',
    }),
  );
  assert.match(macros.modules.nodes.get('src/plain.rs').whole, /proc-macro library/);
  assert.equal(macros.select(['src/plain.rs']).scope, 'full');
  // Binary, bench and example code is built into every test target.
  const bins = head(crate({ 'src/main.rs': 'fn main() {}\n', 'examples/demo.rs': 'fn main() {}\n' }));
  assert.match(
    bins.modules.nodes.get('examples/demo.rs').whole,
    /builds it into every integration test target/,
  );
  assert.equal(bins.select(['examples/demo.rs']).scope, 'full');
  // Doc comments are not read for edges, so a crate with doctests reruns all of them when any library
  // module is reached; `--doc` cannot share an invocation with other targets.
  const docs = head(
    crate({
      'src/plain.rs': '/// ```\n/// shop::plain::unused();\n/// ```\npub fn unused() {}\n',
    }),
  );
  assert.equal(docs.select(['src/shape.rs']).command, 'cargo test --test=smoke && cargo test --doc');
  assert.equal(docs.select(['src/plain.rs']).command, 'cargo test --doc');
  // A harness switched off in [lib] is not run.
  const off = head(
    crate({
      'Cargo.toml':
        '[package]\nname = "shop"\nautotests = false\n\n[lib]\ntest = false\ndoctest = false\n\n[[test]]\nname = "smoke"\npath = "tests/smoke.rs"\n',
    }),
  );
  assert.equal(off.select(['src/gen.rs']).scope, 'none');
});

test('Rust: crates of a workspace are run with -p and the library filter', () => {
  const repo = head({
    'Cargo.toml': '[workspace]\nmembers = ["crates/*"]\n',
    'crates/a/Cargo.toml': '[package]\nname = "a"\nversion = "0.1.0"\n',
    'crates/a/src/lib.rs': 'pub mod x;\npub mod y;\n',
    'crates/a/src/x.rs': 'pub fn x() {}\n',
    'crates/a/src/y.rs': 'use crate::x::x;\n\n#[test]\nfn y() { x(); }\n',
  });
  assert.equal(repo.select(['crates/a/src/x.rs']).command, 'cargo test -p a --lib -- y::');
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
    'lib/build.gradle.kts':
      'plugins { kotlin("multiplatform") }\n\nkotlin {\n  jvm()\n  js { nodejs() }\n}\n',
    'lib/src/commonMain/kotlin/q/Util.kt': 'package q\n\nfun helper(): Int = 1\n',
    'lib/src/commonTest/kotlin/q/CommonUtilTest.kt':
      'package q\n\nimport kotlin.test.Test\n\nclass CommonUtilTest { @Test fun it() { helper() } }\n',
    'lib/src/jvmTest/kotlin/q/UtilTest.kt':
      'package q\n\nimport kotlin.test.Test\n\nclass UtilTest { @Test fun it() { helper() } }\n',
    'lib/src/jvmTest/kotlin/q/OtherTest.kt':
      'package q\n\nimport kotlin.test.Test\n\nclass OtherTest { @Test fun it() { } }\n',
    'lib/src/jsTest/kotlin/q/JsUtilTest.kt':
      'package q\n\nimport kotlin.test.Test\n\nclass JsUtilTest { @Test fun it() { helper() } }\n',
    'lib/src/androidTest/kotlin/q/DeviceTest.kt':
      'package q\n\nimport kotlin.test.Test\n\nclass DeviceTest { @Test fun it() { } }\n',
  });
  // commonTest runs under every target's task and androidTest needs a device: no task Forge can name.
  assert.match(kmp.modules.nodes.get('lib/src/commonTest/kotlin/q/CommonUtilTest.kt').whole, /commonTest/);
  assert.equal(kmp.select(['lib/src/commonMain/kotlin/q/Util.kt']).command, 'gradle :lib:test');
  // Without the commonTest class, a change reaches only target test sets with a declared target.
  const targets = {
    'settings.gradle.kts': 'include(":lib")\n',
    'lib/build.gradle.kts':
      'plugins { kotlin("multiplatform") }\n\nkotlin {\n  jvm()\n  js { nodejs() }\n}\n',
    'lib/src/commonMain/kotlin/q/Util.kt': 'package q\n\nfun helper(): Int = 1\n',
    'lib/src/jvmTest/kotlin/q/UtilTest.kt':
      'package q\n\nimport kotlin.test.Test\n\nclass UtilTest { @Test fun it() { helper() } }\n',
    'lib/src/jvmTest/kotlin/q/OtherTest.kt':
      'package q\n\nimport kotlin.test.Test\n\nclass OtherTest { @Test fun it() { } }\n',
    'lib/src/jsTest/kotlin/q/JsUtilTest.kt':
      'package q\n\nimport kotlin.test.Test\n\nclass JsUtilTest { @Test fun it() { helper() } }\n',
  };
  const jvm = head(targets);
  assert.equal(
    jvm.select(['lib/src/commonMain/kotlin/q/Util.kt']).command,
    'gradle :lib:jsTest --tests q.JsUtilTest :lib:jvmTest --tests q.UtilTest',
  );
  assert.equal(
    jvm.select(['lib/src/jvmTest/kotlin/q/UtilTest.kt']).command,
    'gradle :lib:jvmTest --tests q.UtilTest',
  );
  // A renamed target names its own task; an undeclared target (or a build file Forge cannot read as
  // multiplatform) keeps the project whole.
  const renamed = head({
    ...targets,
    'lib/build.gradle.kts': 'plugins { kotlin("multiplatform") }\n\nkotlin { jvm("desktop") }\n',
    'lib/src/desktopTest/kotlin/q/DesktopTest.kt':
      'package q\n\nimport kotlin.test.Test\n\nclass DesktopTest { @Test fun it() { helper() } }\n',
  });
  assert.equal(
    renamed.select(['lib/src/desktopTest/kotlin/q/DesktopTest.kt']).command,
    'gradle :lib:desktopTest --tests q.DesktopTest',
  );
  assert.equal(
    renamed.select(['lib/src/jvmTest/kotlin/q/UtilTest.kt']).command,
    'gradle :lib:test',
    'jvm is renamed, so jvmTest names no declared target',
  );
  const plain = head({ ...targets, 'lib/build.gradle.kts': 'plugins { kotlin("jvm") }\n' });
  assert.equal(plain.select(['lib/src/commonMain/kotlin/q/Util.kt']).command, 'gradle :lib:test');
  // The root project of a build names the bare task.
  const root = head({
    'settings.gradle.kts': 'rootProject.name = "r"\n',
    'build.gradle.kts': 'plugins { kotlin("multiplatform") }\nkotlin { jvm() }\n',
    'src/commonMain/kotlin/q/Util.kt': 'package q\n\nfun helper(): Int = 1\n',
    'src/jvmTest/kotlin/q/UtilTest.kt':
      'package q\n\nimport kotlin.test.Test\n\nclass UtilTest { @Test fun it() { helper() } }\n',
  });
  assert.equal(root.select(['src/commonMain/kotlin/q/Util.kt']).command, 'gradle jvmTest --tests q.UtilTest');
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
