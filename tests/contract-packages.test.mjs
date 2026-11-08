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

test('Go: the reverse also holds; a disjoint package stays optimistic', t => {
  const p = project(t, GO);
  p.lane({ 'pkg/b/b.go': GO['pkg/b/b.go'].replace('"b"', '"bee"') });
  const a = p.optimistic({ 'pkg/a/a.go': GO['pkg/a/a.go'].replace('"hi "', '"hello "') });
  assert.equal(a.result, false, 'a change in pkg/a is unknown contract for its dependent pkg/b');
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
