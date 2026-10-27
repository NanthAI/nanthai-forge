// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, renameSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { indexRepository, capture, analyze, DEFAULT_LIMITS } from '../dist/index.js';
import { validateArtifact } from '../dist/artifact-validation.js';
import { identity, graphIdentity } from '../dist/hash.js';
import { RepositoryQuery } from '../dist/query.js';
import { fixture, write, code } from './helpers.mjs';
const sources = {
  'sample.ts': 'export const typed = 1; export function readTyped() { return typed; }',
  'sample.js': 'export function hello(name) { return name; } export const result = hello("world");',
  'pkg/util.py': 'def helper(value):\n    return value\n',
  'pkg/model.py':
    '# unicode 🦀\nfrom .util import helper as h\nclass Greeter:\n    def greet(self, name):\n        value = h(name)\n        return value\n',
  'java/Util.java':
    'package demo; public class Util { public static int helper(int value) { return value; } }',
  'java/Main.java':
    'package demo; import demo.Util; public class Main { public int run(int value) { return Util.helper(value); } }',
  'src/lib.rs': 'mod util; use crate::util::helper; pub fn run(value: i32) -> i32 { helper(value) }',
  'src/util.rs': 'pub fn helper(value: i32) -> i32 { value }',
};
const refsTo = (pack, name, file) =>
  pack.references.filter(ref =>
    pack.nodes.some(
      node => node.id === ref.target && node.name === name && (!file || node.locator.file === file),
    ),
  );
test('five pinned parsers expose source-backed declarations, imports and supported references without execution', t => {
  const root = fixture(t, { ...sources, 'never.py': 'open("should-not-exist", "w").write("no")\n' }),
    pack = indexRepository(root).pack;
  assert.deepEqual(
    pack.analysis.languages.map(item => item.language),
    ['typescript', 'javascript', 'python', 'java', 'rust'],
  );
  assert.equal(pack.analysis.coverage, 'partial');
  assert.equal(existsSync(join(root, 'should-not-exist')), false);
  validateArtifact(pack);
  for (const name of ['typed', 'hello', 'Greeter', 'greet', 'Util', 'Main', 'run', 'helper'])
    assert(
      pack.nodes.some(node => node.name === name),
      name,
    );
  for (const node of pack.nodes)
    assert.equal(
      capture(root).content.get(node.locator.file).slice(node.locator.start.offset, node.locator.end.offset),
      node.name,
    );
  assert(pack.imports.some(edge => edge.from === 'pkg/model.py' && edge.target === 'pkg/util.py'));
  assert(pack.imports.some(edge => edge.from === 'java/Main.java' && edge.target === 'java/Util.java'));
  assert(pack.imports.some(edge => edge.from === 'src/lib.rs' && edge.target === 'src/util.rs'));
  assert(refsTo(pack, 'hello', 'sample.js').length);
  assert(refsTo(pack, 'helper', 'pkg/util.py').some(ref => ref.locator.file === 'pkg/model.py'));
  assert(refsTo(pack, 'Util', 'java/Util.java').some(ref => ref.locator.file === 'java/Main.java'));
  assert(refsTo(pack, 'helper', 'src/util.rs').some(ref => ref.locator.file === 'src/lib.rs'));
  const immutable = analyze(capture(root));
  pack.analysis.languages[2].relationships.push('fabricated');
  assert(!analyze(capture(root)).analysis.languages[2].relationships.includes('fabricated'));
  assert.deepEqual(analyze(capture(root)), immutable);
});
test('structural syntax caches preserve cold results through edits, rename, deletion and exclusions', t => {
  const root = fixture(t, sources),
    session = {};
  indexRepository(root, undefined, session);
  const compare = () => {
    const value = indexRepository(root, undefined, session);
    assert.deepEqual(value.pack, analyze(capture(root)));
    return value;
  };
  write(root, 'pkg/util.py', 'def helper(value):\n    renamed = value\n    return renamed\n');
  assert.equal(new RepositoryQuery(root).status().freshness, 'stale');
  const edited = compare();
  assert.equal(edited.work.parsedFiles, 1);
  assert.equal(edited.work.reusedSyntaxFiles, 7);
  renameSync(join(root, 'pkg/util.py'), join(root, 'pkg/other.py'));
  let pack = compare().pack;
  assert.equal(pack.imports.find(edge => edge.from === 'pkg/model.py').resolution, 'unresolved');
  unlinkSync(join(root, 'pkg/other.py'));
  compare();
  write(root, '.gitignore', 'src/util.rs\njava/Util.java\n');
  pack = compare().pack;
  assert(!pack.source.files.some(file => ['src/util.rs', 'java/Util.java'].includes(file.path)));
  assert(!pack.nodes.some(node => node.locator.file === 'src/util.rs'));
});
test('invalid syntax, dynamic member dispatch, directives and ambiguous types stay unknown', t => {
  const root = fixture(t, {
    'bad.py': 'def broken(:\n',
    'Bad.java': 'class Bad { void broken( {',
    'bad.rs': 'fn broken( {',
    'scope.py': 'value = 1\ndef f():\n    global value\n    return value\n',
    'members.py': 'def helper():\n    return 1\ndef f(obj):\n    return obj.helper()\n',
    'a/A.java': 'package duplicate; public class A {}',
    'b/A.java': 'package duplicate; public class A {}',
    'Use.java': 'import duplicate.A; class Use { A field; }',
  });
  const pack = indexRepository(root).pack;
  for (const file of ['bad.py', 'Bad.java', 'bad.rs']) {
    assert(pack.issues.some(issue => issue.file === file));
    assert(!pack.nodes.some(node => node.locator.file === file));
  }
  assert(!refsTo(pack, 'helper', 'members.py').length);
  assert(pack.issues.some(issue => issue.code === 'PYTHON_SCOPE_DIRECTIVE_UNRESOLVED'));
  assert.equal(pack.imports.find(edge => edge.from === 'Use.java').resolution, 'unresolved');
});
test('legacy graph artifacts remain readable while new provider metadata and policy stay validated', () => {
  const body = {
    gitHead: null,
    scope: 'included-typescript-working-tree',
    files: [],
    inventoryDigest: identity([]),
    policy: { version: 1, limits: { ...DEFAULT_LIMITS } },
  };
  const source = { id: identity(body), ...body, excluded: {} };
  const graph = {
    schemaVersion: 1,
    source,
    analysis: {
      provider: 'typescript-compiler',
      version: '5.9.3',
      configVersion: 1,
      resolution: 'captured-relative-ts-only',
      coverage: 'partial',
      limitations: ['Legacy fixture'],
    },
    nodes: [],
    imports: [],
    references: [],
    issues: [],
  };
  const pack = { id: graphIdentity(graph), ...graph };
  assert.deepEqual(validateArtifact(pack), pack);
  const invalid = structuredClone(pack);
  invalid.source.policy.version = '1';
  assert.throws(() => validateArtifact(invalid), code('INVALID_ARTIFACT'));
});

test('unsupported bindings never manufacture references to same-named outer declarations', t => {
  const root = fixture(t, {
    'scope.py': 'x=1\ny=[x for x in items]\nwith resource() as x:\n    print(x)\n',
    'imports.py':
      'def helper():\n    return 1\nimport external as helper\ndef call():\n    return helper()\n',
    'defaults.py': 'x=1\ndef call(x=x):\n    return x\n',
    'src/lib.rs': 'const X:i32=1; fn f(){ for X in items { X; } if let Some(X)=item { X; } }',
  });
  const pack = indexRepository(root).pack;
  assert.equal(refsTo(pack, 'x', 'scope.py').length, 0);
  assert.equal(refsTo(pack, 'helper', 'imports.py').length, 0);
  assert.equal(refsTo(pack, 'X', 'src/lib.rs').length, 0);
  const defaultRoot = pack.nodes.find(
    node => node.name === 'x' && node.locator.file === 'defaults.py' && node.kind === 'VariableDeclaration',
  );
  assert(!pack.references.some(ref => ref.target === defaultRoot.id));
  assert(pack.issues.some(issue => issue.code === 'RUST_BINDING_UNRESOLVED'));
});

test('JavaScript file imports and Rust type declarations retain their language meaning', t => {
  const root = fixture(t, {
    'a.js': 'export const value = 3;',
    'b.mjs': 'import { value } from "./a.js"; export const result = value;',
    'types.rs':
      'pub struct Person { pub name: String } pub trait Named { fn name(&self); } pub(crate) struct Internal {}',
  });
  const pack = indexRepository(root).pack;
  assert(pack.imports.some(edge => edge.from === 'b.mjs' && edge.target === 'a.js'));
  assert(refsTo(pack, 'value', 'a.js').some(ref => ref.locator.file === 'b.mjs'));
  assert.equal(pack.nodes.find(node => node.name === 'Person').kind, 'StructDeclaration');
  assert.equal(pack.nodes.find(node => node.name === 'Named').kind, 'TraitDeclaration');
  assert.equal(pack.nodes.find(node => node.name === 'Person').exported, true);
  assert.equal(pack.nodes.find(node => node.name === 'Internal').exported, false);
});

test('type names bypass same-named values and Rust generic types bind locally', t => {
  const root = fixture(t, {
    'Foo.java': 'class Foo { void f(){ int Foo=1; Foo x; } }',
    'types.rs': 'trait Bound {} struct Foo {} fn f<T: Bound>(x:T){ let Foo=1; let x:Foo; }',
  });
  const pack = indexRepository(root).pack;
  for (const file of ['Foo.java', 'types.rs']) {
    const value = pack.nodes.find(
      node => node.name === 'Foo' && node.kind === 'VariableDeclaration' && node.locator.file === file,
    );
    assert(value);
    assert(!pack.references.some(ref => ref.target === value.id));
    const type = pack.nodes.find(
      node =>
        node.name === 'Foo' &&
        ['ClassDeclaration', 'StructDeclaration'].includes(node.kind) &&
        node.locator.file === file,
    );
    assert(pack.references.some(ref => ref.target === type.id));
  }
  assert.equal(pack.nodes.filter(node => node.name === 'Bound').length, 1);
  assert(refsTo(pack, 'Bound', 'types.rs').length);
  const generic = pack.nodes.find(node => node.name === 'T' && node.kind === 'TypeParameter');
  assert(generic);
  assert(pack.references.some(ref => ref.target === generic.id));
});
