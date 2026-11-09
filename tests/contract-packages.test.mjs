// SPDX-License-Identifier: Apache-2.0
// Any-ecosystem contract signal (Issue 7e97573d): code without import-level facts is never assumed
// independent. Synthetic fixtures only.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { initNative } from '../dist/native-work.js';
import { WorkStore } from '../dist/work-store.js';
import { NativeSource } from '../dist/native-source.js';
import { WorkService } from '../dist/work.js';
import { policyPreset } from '../dist/autonomy-policy.js';
import { prepareOptimistic } from '../dist/optimistic-landing.js';
import { contractDelta, declaredInterfaces } from '../dist/contract-deps.js';
import { structuralExports } from '../dist/contract-structural.js';
import { packageContracts, packageContractHold } from '../dist/contract-packages.js';
import { buildPackageGraph } from '../dist/package-graph.js';
import { assertContractsSynced } from '../dist/contract-gate.js';

const now = () => new Date().toISOString();
const GO = {
  'pkg/a/go.mod': 'module example.com/a\n\ngo 1.22\n',
  'pkg/a/a.go': 'package a\n\nfunc Greet(name string) string { return "hi " + name }\n',
  'pkg/b/go.mod':
    'module example.com/b\n\ngo 1.22\n\nrequire example.com/a v0.0.0\n\nreplace example.com/a => ../a\n',
  'pkg/b/b.go': 'package b\n\nimport "example.com/a"\n\nfunc Hello() string { return a.Greet("b") }\n',
  'pkg/c/go.mod': 'module example.com/c\n\ngo 1.22\n',
  'pkg/c/c.go': 'package c\n\nfunc C() int { return 1 }\n',
};

/** A native project on `files`, optimistic landing on, and helpers to open Lanes and Views. */
function project(t, files) {
  const root = mkdtempSync(join(tmpdir(), 'forge-contract-packages-'));
  t.after(() => rmSync(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 50 }));
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(join(root, dirname(path)), { recursive: true });
    writeFileSync(join(root, path), text);
  }
  const { head: base } = initNative(root),
    store = new WorkStore(root),
    source = new NativeSource(root);
  store.locked(() => {
    const data = store.load();
    data.autonomyPolicy = policyPreset('trusted');
    data.autonomyPolicy.acceptance.landing = 'optimistic';
    data.revision++;
    store.save(data);
  });
  const edit = changes => {
    const files = source.state(base).files.filter(file => !(file.path in changes));
    for (const [path, text] of Object.entries(changes))
      if (text !== null) files.push({ path, mode: 'file', blob: source.put(Buffer.from(text)) });
    return source.writeState(files, [base], 'Synthetic edit', now());
  };
  /** An open Lane whose saved head carries `changes`. */
  const lane = changes => {
    const intentId = randomUUID(),
      id = randomUUID(),
      head = edit(changes);
    store.locked(() => {
      const data = store.load();
      data.intents.push({
        id: intentId,
        outcome: 'Peer',
        constraints: '',
        base,
        status: 'active',
        notes: [],
        createdAt: now(),
      });
      data.lanes.push({
        id,
        intentId,
        name: 'peer',
        base,
        head,
        state: 'active',
        assignment: '',
        target: '',
        checkpoints: [],
      });
      data.revision++;
      store.save(data);
    });
    return id;
  };
  /** The checked View a finishing Lane lands with `changes`. */
  const view = changes => {
    const head = edit(changes),
      laneId = randomUUID(),
      value = {
        id: randomUUID(),
        intentId: randomUUID(),
        base,
        composedMain: base,
        head,
        inputs: [{ laneId, head }],
        dependencies: [],
        status: 'clean',
        details: '',
        at: now(),
      };
    store.locked(() => {
      const data = store.load();
      data.views.push(value);
      data.revision++;
      store.save(data);
    });
    return value;
  };
  const work = new WorkService(root, { kind: 'agent', id: 'synthetic' });
  const optimistic = changes => {
    const held = [];
    const result = prepareOptimistic(work, { accept: { channel: 'main' } }, view(changes), reason =>
      held.push(reason),
    );
    return { result, held };
  };
  return { root, source, base, lane, optimistic };
}

test('Go: B importing pkg/a is not optimistic while Lane A changes an exported func there', t => {
  const p = project(t, GO);
  const a = p.lane({ 'pkg/a/a.go': GO['pkg/a/a.go'].replace('(name string)', '(name string, loud bool)') });
  const b = p.optimistic({ 'pkg/b/b.go': GO['pkg/b/b.go'].replace('"b"', '"bee"') });
  assert.equal(b.result, false);
  assert.equal(b.held.length, 1);
  assert.match(b.held[0], new RegExp(`Lane ${a}`));
  assert.match(b.held[0], /pkg\/a\/a\.go/);
});

test('Go: the reverse also holds; a body-only change and a disjoint package stay optimistic', t => {
  const p = project(t, GO);
  p.lane({ 'pkg/b/b.go': GO['pkg/b/b.go'].replace('"b"', '"bee"') });
  // Go has export facts (contract-structural): a body-only edit of pkg/a changes no contract.
  assert.equal(p.optimistic({ 'pkg/a/a.go': GO['pkg/a/a.go'].replace('"hi "', '"hello "') }).result, true);
  const a = p.optimistic({
    'pkg/a/a.go': GO['pkg/a/a.go'].replace('(name string)', '(name string, loud bool)'),
  });
  assert.equal(a.result, false, 'a signature change in pkg/a is a contract change for its dependent pkg/b');
  assert.match(a.held[0], /pkg\/b\/b\.go is in package example\.com\/b, which depends on pkg\/a/);
  const q = project(t, GO);
  q.lane({ 'pkg/a/a.go': GO['pkg/a/a.go'].replace('(name string)', '(name string, loud bool)') });
  const c = q.optimistic({ 'pkg/c/c.go': GO['pkg/c/c.go'].replace('1', '2') });
  assert.deepEqual(c, { result: true, held: [] });
});

test('Go test files export nothing; a docs-only peer never holds', t => {
  const p = project(t, GO);
  p.lane({ 'pkg/a/a_test.go': 'package a\n\nimport "testing"\n\nfunc TestGreet(t *testing.T) {}\n' });
  assert.equal(p.optimistic({ 'pkg/b/b.go': GO['pkg/b/b.go'].replace('"b"', '"x"') }).result, true);
  const q = project(t, GO);
  q.lane({ 'pkg/a/a.go': GO['pkg/a/a.go'].replace('"hi "', '"yo "') });
  assert.equal(q.optimistic({ 'pkg/b/README.md': '# b\n' }).result, true);
});

test('unplaced code: without a manifest, a Go change holds any other source change', t => {
  const files = { 'a/a.go': 'package a\nfunc A() {}\n', 'b/b.go': 'package b\nfunc B() {}\n' };
  const p = project(t, files);
  p.lane({ 'a/a.go': 'package a\nfunc A(x int) {}\n' });
  const b = p.optimistic({ 'b/b.go': 'package b\nfunc B() { _ = 1 }\n' });
  assert.equal(b.result, false);
  assert.match(b.held[0], /no package Forge can place/);
});

test('Python export facts: a body-only change stays optimistic, a signature change holds', t => {
  const files = {
    'pyproject.toml': '[tool.uv.workspace]\nmembers = ["libs/*"]\n',
    'libs/core/pyproject.toml': '[project]\nname = "core"\n',
    'libs/core/core/api.py': 'def greet(name):\n    return "hi " + name\n',
    'libs/app/pyproject.toml': '[project]\nname = "app"\ndependencies = ["core"]\n',
    'libs/app/app/main.py': 'from core.api import greet\n\nprint(greet("x"))\n',
  };
  const body = project(t, files);
  body.lane({ 'libs/core/core/api.py': 'def greet(name):\n    return "hello " + name\n' });
  assert.equal(
    body.optimistic({ 'libs/app/app/main.py': 'from core.api import greet\nprint(greet("y"))\n' }).result,
    true,
  );
  const sig = project(t, files);
  sig.lane({ 'libs/core/core/api.py': 'def greet(name, loud=False):\n    return "hi " + name\n' });
  const held = sig.optimistic({ 'libs/app/app/main.py': 'from core.api import greet\nprint(greet("y"))\n' });
  assert.equal(held.result, false);
  assert.match(held.held[0], /libs\/core\/core\/api\.py/);
});

test('structural exports: headers are contracts, bodies and private members are not', () => {
  const sigs = (path, text) =>
    Object.fromEntries([...structuralExports(path, text)].map(([name, value]) => [name, value.sig]));
  const py = sigs(
    'm.py',
    'X = 1\n_y = 2\ndef f(a):\n    return a\ndef _g(): pass\nclass C:\n    def m(self, a): pass\n    def _p(self): pass\n',
  );
  assert.deepEqual(Object.keys(py).sort(), ['C', 'X', 'f']);
  assert.equal(sigs('m.py', 'def f(a):\n    return a + 1\n').f, py.f, 'body-only');
  assert.notEqual(sigs('m.py', 'def f(a, b):\n    return a\n').f, py.f);
  assert.equal(
    sigs('m.py', 'class C:\n    def m(self, a): pass\n    def _p(self, z): pass\n').C,
    sigs('m.py', 'class C:\n    def m(self, a): return 1\n    def _p(self): pass\n').C,
  );
  const java = text => sigs('C.java', text).C;
  const base = 'public class C { public int m(int a) { return a; } private void p() {} }';
  assert.equal(java(base.replace('return a;', 'return a + 1;')), java(base));
  assert.equal(java(base.replace('void p()', 'void p(int x)')), java(base), 'private');
  assert.notEqual(java(base.replace('int m(int a)', 'int m(long a)')), java(base));
  const rs = sigs(
    'lib.rs',
    'pub fn f(a: i32) -> i32 { a }\nfn g() {}\npub struct S { pub a: i32 }\nimpl S { pub fn new() -> Self { S { a: 1 } } fn h(&self) {} }\n',
  );
  assert.deepEqual(Object.keys(rs).sort(), ['S', 'f', 'impl S::new']);
  assert.equal(sigs('lib.rs', 'pub fn f(a: i32) -> i32 { a + 1 }\n').f, rs.f);
  assert.equal(structuralExports('bad.py', 'def (:\n'), undefined, 'a syntax error has no facts');
});

test('contractDelta: Python, Java and Rust export changes; a syntax error is a whole-file change', () => {
  const store = new Map(),
    source = { object: blob => Buffer.from(store.get(blob)) },
    file = (path, text) => (store.set(`${path}:${text}`, text), { path, blob: `${path}:${text}` });
  const before = [
      file('a.py', 'def f(a): pass\n'),
      file('B.java', 'class B { void m() {} }'),
      file('c.rs', 'pub fn c() {}\n'),
    ],
    after = [
      file('a.py', 'def f(a, b): pass\n'),
      file('B.java', 'class B { void m() { int x; } }'),
      file('c.rs', 'pub fn c( {}\n'),
    ];
  assert.deepEqual(contractDelta(source, before, after), [
    { file: 'a.py', export: 'f', kind: 'changed' },
    { file: 'c.rs', export: '*', kind: 'changed' },
  ]);
});

test('contracts config: forge.json `contracts` is read from a captured State; .forge/ stays a fallback', t => {
  const root = mkdtempSync(join(tmpdir(), 'forge-contract-config-'));
  t.after(() => rmSync(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 50 }));
  writeFileSync(join(root, 'seed.txt'), 'seed\n');
  initNative(root);
  const source = new NativeSource(root),
    checkout = join(root, 'checkout');
  mkdirSync(join(checkout, 'api'), { recursive: true });
  mkdirSync(join(checkout, '.forge'), { recursive: true });
  writeFileSync(join(checkout, 'forge.json'), JSON.stringify({ contracts: { interfaces: ['api/**'] } }));
  writeFileSync(join(checkout, '.forge/contracts.json'), JSON.stringify({ interfaces: ['other/**'] }));
  writeFileSync(join(checkout, 'api/openapi.json'), '{"v":1}');
  const before = source.capture(checkout, true);
  assert.ok(before.some(file => file.path === 'forge.json'));
  assert.ok(!before.some(file => file.path.startsWith('.forge/')), 'a save never captures .forge/');
  assert.equal(declaredInterfaces(source, before)?.('api/openapi.json'), true);
  writeFileSync(join(checkout, 'api/openapi.json'), '{"v":2}');
  assert.deepEqual(contractDelta(source, before, source.capture(checkout, true)), [
    { file: 'api/openapi.json', export: '*', kind: 'changed' },
  ]);
  // A State that already holds the older file (an import) still reads it.
  const legacy = [
    { path: '.forge/contracts.json', blob: source.put(Buffer.from('{"interfaces":["x/**"]}')) },
  ];
  assert.equal(declaredInterfaces(source, legacy)?.('x/y'), true);
});

test('hold: unrelated packages and non-source peers never hold; cost is one graph per call', () => {
  const read = path => GO[path];
  let built = 0;
  const graphOf = () => (built++, buildPackageGraph(Object.keys(GO), read));
  const blobs = new Map(),
    source = { object: blob => Buffer.from(blobs.get(blob)) },
    refs = files =>
      Object.entries(files).map(
        ([path, text]) => (blobs.set(`${path}:${text}`, text), { path, blob: `${path}:${text}` }),
      );
  const none = packageContracts(source, refs(GO), refs(GO), graphOf);
  assert.equal(none.packages.size, 0);
  assert.equal(built, 0, 'no signal builds no graph');
  assert.equal(packageContractHold(graphOf, none, ['pkg/b/b.go']), null);
  assert.equal(built, 0);
  const mine = packageContracts(source, refs(GO), refs({ ...GO, 'pkg/a/a.go': 'package a\n' }), graphOf);
  assert.deepEqual([...mine.packages.keys()], ['go:pkg/a']);
  assert.equal(packageContractHold(graphOf, mine, ['pkg/c/c.go', 'pkg/b/notes.md']), null);
  assert.match(packageContractHold(graphOf, mine, ['pkg/b/b.go']), /depends on pkg\/a/);
});

// The agent contract sync gate for code without import-level facts (Issue a6566fbe).
const GATE_GO = {
  'pkg/a/go.mod': 'module example.com/a\n\ngo 1.22\n',
  'pkg/a/a.go': 'package a\n\nfunc Greet(name string) string { return "hi " + name }\n',
  'pkg/b/go.mod':
    'module example.com/b\n\ngo 1.22\n\nrequire example.com/a v0.0.0\n\nreplace example.com/a => ../a\n',
  'pkg/b/b.go': 'package b\n\nimport "example.com/a"\n\nfunc Hello() string { return a.Greet("b") }\n',
  'pkg/c/go.mod': 'module example.com/c\n\ngo 1.22\n',
  'pkg/c/c.go': 'package c\n\nfunc C() int { return 1 }\n',
};
const PYTHON = {
  'pyproject.toml': '[tool.uv.workspace]\nmembers = ["libs/*"]\n',
  'libs/core/pyproject.toml': '[project]\nname = "core"\n',
  'libs/core/core/api.py': 'def greet(name):\n    return "hi " + name\n',
  'libs/app/pyproject.toml': '[project]\nname = "app"\ndependencies = ["core"]\n',
  'libs/app/app/main.py': 'from core.api import greet\n\nprint(greet("x"))\n',
  'libs/other/pyproject.toml': '[project]\nname = "other"\n',
  'libs/other/other/o.py': 'X = 1\n',
};
const RUST = {
  'Cargo.toml': '[workspace]\nmembers = ["crates/*"]\nresolver = "2"\n',
  'crates/core/Cargo.toml': '[package]\nname = "fx-core"\nversion = "0.1.0"\n',
  'crates/core/src/lib.rs': 'pub fn greet(name: &str) -> String { format!("hi {name}") }\n',
  'crates/api/Cargo.toml':
    '[package]\nname = "fx-api"\nversion = "0.1.0"\n\n[dependencies]\nfx-core = { path = "../core" }\n',
  'crates/api/src/lib.rs': 'pub fn hello() -> String { fx_core::greet("x") }\n',
  'crates/other/Cargo.toml': '[package]\nname = "fx-other"\nversion = "0.1.0"\n',
  'crates/other/src/lib.rs': 'pub fn other() -> i32 { 1 }\n',
};
const JAVA = {
  'settings.gradle.kts': 'rootProject.name = "fx"\ninclude(":core", ":app", ":misc")\n',
  'build.gradle.kts': '// root\n',
  'core/build.gradle.kts': 'plugins { `java-library` }\n',
  'core/src/main/java/fx/Core.java':
    'package fx;\npublic class Core { public int run(int a) { return a; } }\n',
  'app/build.gradle.kts': 'plugins { application }\ndependencies { implementation(project(":core")) }\n',
  'app/src/main/java/fx/App.java':
    'package fx;\npublic class App { int go() { return new Core().run(1); } }\n',
  'misc/build.gradle.kts': 'plugins { `java-library` }\n',
  'misc/src/main/java/fx/Misc.java': 'package fx;\npublic class Misc { }\n',
};
const CSHARP = {
  'core/core.csproj': '<Project Sdk="Microsoft.NET.Sdk"></Project>\n',
  'core/Core.cs': 'namespace Fx { public class Core { public int Run(int a) { return a; } } }\n',
  'app/app.csproj':
    '<Project Sdk="Microsoft.NET.Sdk"><ItemGroup><ProjectReference Include="../core/core.csproj" /></ItemGroup></Project>\n',
  'app/App.cs': 'namespace Fx { public class App { public int Go() { return new Core().Run(1); } } }\n',
  'misc/misc.csproj': '<Project Sdk="Microsoft.NET.Sdk"></Project>\n',
  'misc/Misc.cs': 'namespace Fx { public class Misc { } }\n',
};

/** A native project on `files`; `gate(main, lane)` runs the agent gate for a Lane that predates `main`. */
function gateProject(t, files) {
  const root = mkdtempSync(join(tmpdir(), 'forge-contract-gate-packages-'));
  t.after(() => rmSync(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 50 }));
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(join(root, dirname(path)), { recursive: true });
    writeFileSync(join(root, path), text);
  }
  const { head: base } = initNative(root),
    source = new NativeSource(root);
  const edit = changes => {
    const kept = source.state(base).files.filter(file => !(file.path in changes));
    for (const [path, text] of Object.entries(changes))
      if (text !== null) kept.push({ path, mode: 'file', blob: source.put(Buffer.from(text)) });
    return source.writeState(kept, [base], 'Synthetic edit', now());
  };
  const gate = (mainChanges, laneChanges) => {
    const main = edit(mainChanges),
      head = edit(laneChanges);
    return assertContractsSynced(
      source,
      { channelMoves: [] },
      'main',
      { head, base, composedMain: base },
      main,
    );
  };
  return { gate };
}
const resync = pattern => error => {
  assert.equal(error.code, 'CONTRACT_RESYNC_REQUIRED');
  assert.match(error.message, pattern);
  assert.ok(error.changes.length > 0);
  assert.match(error.message, /Sync main, then recheck/);
  return true;
};

test('Go: a dependent Lane must resync after main changes an exported signature; body-only and disjoint do not', t => {
  const p = gateProject(t, GATE_GO);
  const signature = {
    'pkg/a/a.go': GATE_GO['pkg/a/a.go'].replace('(name string)', '(name string, loud bool)'),
  };
  const dependent = { 'pkg/b/b.go': GATE_GO['pkg/b/b.go'].replace('"b"', '"bee"') };
  assert.throws(() => p.gate(signature, dependent), resync(/pkg\/a\/a\.go/));
  // The package's own other file, and a new exported declaration, are contracts too.
  assert.throws(
    () =>
      p.gate(signature, { 'pkg/a/extra.go': 'package a\n\nfunc Extra() int { return Greet("x", true) }\n' }),
    resync(/package/),
  );
  assert.throws(
    () => p.gate({ 'pkg/a/a2.go': 'package a\n\nfunc Added() {}\n' }, dependent),
    resync(/pkg\/a\/a2\.go/),
  );
  // Body-only: Go has export facts, so nothing changed that a dependent could use.
  assert.doesNotThrow(() =>
    p.gate({ 'pkg/a/a.go': GATE_GO['pkg/a/a.go'].replace('"hi "', '"hello "') }, dependent),
  );
  // A Lane in an unrelated package, or touching only docs, is never gated.
  assert.doesNotThrow(() => p.gate(signature, { 'pkg/c/c.go': GATE_GO['pkg/c/c.go'].replace('1', '2') }));
  assert.doesNotThrow(() => p.gate(signature, { 'pkg/b/README.md': '# b\n' }));
});

test('Python: an export change gates a dependent package; a body-only change does not', t => {
  const p = gateProject(t, PYTHON);
  const lane = { 'libs/app/app/main.py': 'from core.api import greet\nprint(greet("y"))\n' };
  assert.throws(
    () =>
      p.gate({ 'libs/core/core/api.py': 'def greet(name, loud=False):\n    return "hi " + name\n' }, lane),
    resync(/libs\/core\/core\/api\.py/),
  );
  assert.doesNotThrow(() =>
    p.gate({ 'libs/core/core/api.py': 'def greet(name):\n    return "hello " + name\n' }, lane),
  );
  assert.doesNotThrow(() =>
    p.gate(
      { 'libs/core/core/api.py': 'def greet(name, loud=False):\n    return "hi " + name\n' },
      { 'libs/other/other/o.py': 'X = 2\n' },
    ),
  );
});

test('Rust: a public signature change gates a dependent crate; a body-only change does not', t => {
  const p = gateProject(t, RUST);
  const lane = { 'crates/api/src/lib.rs': 'pub fn hello() -> String { fx_core::greet("y") }\n' };
  assert.throws(
    () =>
      p.gate(
        {
          'crates/core/src/lib.rs':
            'pub fn greet(name: &str, loud: bool) -> String { format!("hi {name}") }\n',
        },
        lane,
      ),
    resync(/crates\/core\/src\/lib\.rs/),
  );
  assert.doesNotThrow(() =>
    p.gate(
      { 'crates/core/src/lib.rs': 'pub fn greet(name: &str) -> String { format!("yo {name}") }\n' },
      lane,
    ),
  );
  assert.doesNotThrow(() =>
    p.gate(
      {
        'crates/core/src/lib.rs': 'pub fn greet(name: &str, loud: bool) -> String { format!("hi {name}") }\n',
      },
      { 'crates/other/src/lib.rs': 'pub fn other() -> i32 { 2 }\n' },
    ),
  );
});

test('Java: a public member change gates a dependent module; a body-only change does not', t => {
  const p = gateProject(t, JAVA);
  const lane = {
    'app/src/main/java/fx/App.java':
      'package fx;\npublic class App { int go() { return new Core().run(2); } }\n',
  };
  assert.throws(
    () =>
      p.gate(
        {
          'core/src/main/java/fx/Core.java':
            'package fx;\npublic class Core { public long run(int a) { return a; } }\n',
        },
        lane,
      ),
    resync(/core\/src\/main\/java\/fx\/Core\.java/),
  );
  assert.doesNotThrow(() =>
    p.gate(
      {
        'core/src/main/java/fx/Core.java':
          'package fx;\npublic class Core { public int run(int a) { return a + 1; } }\n',
      },
      lane,
    ),
  );
  assert.doesNotThrow(() =>
    p.gate(
      {
        'core/src/main/java/fx/Core.java':
          'package fx;\npublic class Core { public long run(int a) { return a; } }\n',
      },
      { 'misc/src/main/java/fx/Misc.java': 'package fx;\npublic class Misc { int x; }\n' },
    ),
  );
});

test('C# has no export facts: any change to a package gates its dependents, never a disjoint package', t => {
  const p = gateProject(t, CSHARP);
  const lane = {
    'app/App.cs': 'namespace Fx { public class App { public int Go() { return new Core().Run(2); } } }\n',
  };
  const body = {
    'core/Core.cs': 'namespace Fx { public class Core { public int Run(int a) { return a + 1; } } }\n',
  };
  assert.throws(() => p.gate(body, lane), resync(/core\/Core\.cs/));
  assert.doesNotThrow(() =>
    p.gate(body, { 'misc/Misc.cs': 'namespace Fx { public class Misc { int X; } }\n' }),
  );
});

test('a file Forge cannot place in a package gates any source edit of the Lane, never silence', t => {
  const p = gateProject(t, { 'a/a.go': 'package a\nfunc A() {}\n', 'b/b.go': 'package b\nfunc B() {}\n' });
  assert.throws(
    () =>
      p.gate({ 'a/a.go': 'package a\nfunc A(x int) {}\n' }, { 'b/b.go': 'package b\nfunc B() { _ = 1 }\n' }),
    resync(/no package Forge can place/),
  );
});

test('the gate reads Go export facts: headers and type shapes are contracts, bodies are not', () => {
  const sigs = text =>
    Object.fromEntries([...structuralExports('a.go', text)].map(([name, value]) => [name, value.sig]));
  const base = sigs(
    'package a\n\ntype T struct{ X int }\nconst (\n\tC, D = 1, 2\n)\nvar V = 3\nfunc F(a int) int { return a }\nfunc (t *T) M(a int) int { return a }\nfunc init() {}\n',
  );
  assert.deepEqual(Object.keys(base).sort(), ['C', 'D', 'F', 'T', 'T.M', 'V']);
  const same = sigs(
    'package a\n\ntype T struct{ X int }\nconst (\n\tC, D = 1, 2\n)\nvar V = 3\nfunc F(a int) int { return a + 1 }\nfunc (t *T) M(a int) int { return 0 }\nfunc init() { println() }\n',
  );
  assert.deepEqual(same, base, 'bodies are not contracts');
  assert.notEqual(sigs('package a\n\ntype T struct{ X, Y int }\n').T, base.T);
  assert.notEqual(sigs('package a\n\nfunc F(a, b int) int { return a }\n').F, base.F);
  assert.equal(structuralExports('bad.go', 'package a\nfunc (:\n'), undefined, 'a syntax error has no facts');
});
