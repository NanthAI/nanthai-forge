// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { indexRepository, capture, analyze } from '../dist/index.js';
import { validateArtifact } from '../dist/artifact-validation.js';
import { sourceLanguage, analysisManifest } from '../dist/languages.js';
import { fixture } from './helpers.mjs';

const go = {
  'go.mod': 'module example.com/app\n\ngo 1.22\n',
  'main.go':
    'package main\n\nimport (\n\t"fmt"\n\tu "example.com/app/util"\n\t"example.com/app/store"\n)\n\nfunc main() {\n\tx := u.Helper(1)\n\ts := store.New()\n\tfmt.Println(x, s, local(x))\n}\n\nfunc local(n int) int {\n\tif true {\n\t\tn := n + 1\n\t\treturn n\n\t}\n\treturn n\n}\n',
  'util/util.go':
    'package util\n\nconst Pi = 3\n\nfunc Helper(v int) int { return v + Pi }\n\nfunc unexported() {}\n\ntype T struct{ Name string; age int }\n\nfunc (t *T) Greet() string { return t.Name }\n',
  'store/a.go': 'package store\n\nfunc New() *Store { return &Store{} }\n',
  'store/b.go': 'package store\n\ntype Store struct{ items []int }\n',
  'never.go': 'package main\n\nimport "os"\n\nfunc init() { os.WriteFile("should-not-exist", nil, 0o644) }\n',
};
const cs = {
  'Svc/Program.cs':
    'using System;\nusing static System.Math;\nusing Lib = App.Lib;\nusing App.Lib;\nnamespace App.Svc\n{\n  [Serializable]\n  public class Program : IDisposable\n  {\n    public const int Max = 10;\n    private readonly List<int> _a = new List<int>(), _b = new List<int>();\n    public int Count { get; set; } = 5;\n    public Program() { }\n    public static async Task<int> Main(string[] args) { var s = "}{ class Fake"; /* } */ return 0; }\n    public string this[int i] => "x";\n    public static Program operator +(Program a, Program b) => a;\n    internal enum Color { Red, Green = 2, Blue }\n    public record Point(int X, int Y);\n  }\n  public interface IThing { void Do(); int P { get; } }\n}\n',
  'Lib/Lib.cs': 'namespace App.Lib;\n\npublic struct Helper { public int Go() => 1; }\n',
};
const names = (pack, file) => pack.nodes.filter(n => n.locator.file === file).map(n => `${n.kind}:${n.name}`);
const refs = (pack, file, name) =>
  pack.references.filter(r =>
    pack.nodes.some(n => n.id === r.target && n.name === name && n.locator.file === file),
  );

test('languages are named in one place', () => {
  assert.equal(sourceLanguage('a/b.go'), 'go');
  assert.equal(sourceLanguage('A.cs'), 'csharp');
  assert.equal(sourceLanguage('README.md'), undefined);
  assert(analysisManifest('svc/go.mod'));
});

test('Go: parser-backed declarations, exports, module-path package imports and references', t => {
  const root = fixture(t, go);
  const { pack } = indexRepository(root);
  validateArtifact(pack);
  assert.equal(existsSync(join(root, 'should-not-exist')), false);
  assert(pack.analysis.languages.some(l => l.language === 'go' && l.parser === '@lezer/go'));
  const util = Object.fromEntries(
    pack.nodes.filter(n => n.locator.file === 'util/util.go').map(n => [n.name, n]),
  );
  assert.equal(util.Helper.kind, 'FunctionDeclaration');
  assert.equal(util.Helper.exported, true);
  assert.equal(util.unexported.exported, false);
  assert.equal(util.T.kind, 'StructDeclaration');
  assert.equal(util.Name.exported, true);
  assert.equal(util.age.exported, false);
  assert.equal(util.Greet.kind, 'MethodDeclaration');
  for (const node of pack.nodes.filter(n => n.kind !== 'File'))
    assert.equal(
      capture(root).content.get(node.locator.file).slice(node.locator.start.offset, node.locator.end.offset),
      node.name,
    );
  // A package import points at each non-test file of the package; std and unknown paths are external.
  const edges = pack.imports.filter(e => e.from === 'main.go');
  assert.deepEqual(
    edges
      .filter(e => e.target)
      .map(e => `${e.specifier}>${e.target}`)
      .sort(),
    [
      'example.com/app/store>store/a.go',
      'example.com/app/store>store/b.go',
      'example.com/app/util>util/util.go',
    ],
  );
  assert.equal(edges.find(e => e.specifier === 'fmt').resolution, 'external');
  // Qualified (alias.Name), same-package cross-file and lexical references.
  assert(refs(pack, 'util/util.go', 'Helper').some(r => r.locator.file === 'main.go'));
  assert(refs(pack, 'store/a.go', 'New').some(r => r.locator.file === 'main.go'));
  assert(refs(pack, 'store/b.go', 'Store').some(r => r.locator.file === 'store/a.go'));
  assert(refs(pack, 'util/util.go', 'Pi').some(r => r.locator.file === 'util/util.go'));
  // Reverse imports of a package file are found through the edges (impact).
  assert(pack.imports.some(e => e.target === 'util/util.go' && e.from === 'main.go'));
  // `n := n + 1` reads the parameter on its right side; later uses read the new local, and after
  // the block the parameter is visible again.
  const param = pack.nodes.find(n => n.kind === 'Parameter' && n.name === 'n');
  const local = pack.nodes.find(n => n.kind === 'VariableDeclaration' && n.name === 'n');
  const at = line =>
    pack.references.filter(r => r.locator.file === 'main.go' && r.locator.start.line === line);
  assert.deepEqual(
    at(17).map(r => r.target),
    [param.id],
  );
  assert.deepEqual(
    at(18).map(r => r.target),
    [local.id],
  );
  assert.deepEqual(
    at(20).map(r => r.target),
    [param.id],
  );
  assert.deepEqual(analyze(capture(root)), analyze(capture(root)));
});

test('Go: a syntax error yields an issue and no nodes; shadowed package names are not guessed', t => {
  const root = fixture(t, {
    ...go,
    'bad.go': 'package main\nfunc broken( {\n',
    'shadow.go':
      'package main\n\nimport u "example.com/app/util"\n\nfunc shadow(u struct{ Helper int }) int { return u.Helper }\n',
  });
  const { pack } = indexRepository(root);
  assert(pack.issues.some(i => i.file === 'bad.go' && i.code === 'GO_SYNTAX'));
  assert.deepEqual(
    names(pack, 'bad.go').filter(n => !n.startsWith('File:')),
    [],
  );
  assert(!refs(pack, 'util/util.go', 'Helper').some(r => r.locator.file === 'shadow.go'));
});

test('C#: declarations from headers, usings resolved to namespace files, no body or string confusion', t => {
  const root = fixture(t, cs);
  const { pack } = indexRepository(root);
  validateArtifact(pack);
  assert(pack.analysis.languages.some(l => l.language === 'csharp'));
  const found = names(pack, 'Svc/Program.cs');
  for (const expected of [
    'ClassDeclaration:Program',
    'ConstantDeclaration:Max',
    'PropertyDeclaration:_a',
    'PropertyDeclaration:_b',
    'PropertyDeclaration:Count',
    'ConstructorDeclaration:Program',
    'MethodDeclaration:Main',
    'PropertyDeclaration:this',
    'MethodDeclaration:operator +',
    'EnumDeclaration:Color',
    'EnumMember:Green',
    'RecordDeclaration:Point',
    'InterfaceDeclaration:IThing',
    'MethodDeclaration:Do',
    'PropertyDeclaration:P',
  ])
    assert(found.includes(expected), expected);
  assert(!found.some(n => n.endsWith(':Fake')));
  const program = pack.nodes.find(n => n.name === 'Program' && n.kind === 'ClassDeclaration');
  assert.equal(program.exported, true);
  assert.equal(pack.nodes.find(n => n.name === 'Color').exported, false);
  assert.deepEqual(names(pack, 'Lib/Lib.cs'), ['StructDeclaration:Helper', 'MethodDeclaration:Go']);
  const edges = pack.imports.filter(e => e.from === 'Svc/Program.cs');
  assert(
    edges.some(e => e.specifier === 'App.Lib' && e.target === 'Lib/Lib.cs' && e.resolution === 'resolved'),
  );
  assert.equal(edges.find(e => e.specifier === 'System').resolution, 'external');
  for (const node of pack.nodes)
    assert.equal(
      capture(root).content.get(node.locator.file).slice(node.locator.start.offset, node.locator.end.offset),
      node.name === 'operator +' ? 'operator' : node.name,
    );
});

test('C#: unbalanced braces are a syntax issue with no nodes', t => {
  const root = fixture(t, { 'Bad.cs': 'namespace A { public class B { void M() { }\n', ...cs });
  const { pack } = indexRepository(root);
  assert(pack.issues.some(i => i.file === 'Bad.cs' && i.code === 'CSHARP_SYNTAX'));
  assert.deepEqual(names(pack, 'Bad.cs'), []);
  assert(names(pack, 'Lib/Lib.cs').length);
});

test('every text file has a file-level entry; binaries and over-budget files are counted, not read', t => {
  const root = fixture(t, {
    ...go,
    'README.md': '# Title\n\nbody\n',
    'config/app.yaml': 'a: 1\nb: 2',
    Makefile: 'all:\n\techo hi\n',
    'logo.png': 'not really an image',
    'blob.txt': 'x\0y',
  });
  const snapshot = capture(root);
  const { pack } = indexRepository(root);
  validateArtifact(pack);
  const files = pack.source.files.map(f => f.path);
  for (const path of ['README.md', 'config/app.yaml', 'Makefile', 'go.mod'])
    assert(files.includes(path), path);
  assert(!files.includes('logo.png') && !files.includes('blob.txt'));
  assert.equal(pack.source.excluded['unsupported-language'], 2);
  const entry = pack.nodes.find(n => n.kind === 'File' && n.locator.file === 'config/app.yaml');
  assert.equal(entry.name, 'app.yaml');
  assert.deepEqual(entry.locator.end, { offset: 9, line: 2, column: 5 });
  assert(!snapshot.content.has('README.md'), 'text-only files are never retained as content');
  // The code budget is spent first and never raised: a tight file limit drops inventory, not code.
  const tight = capture(root, {
    maxPaths: 1000,
    maxFiles: 7,
    maxFileBytes: 1024 * 1024,
    maxTotalBytes: 1024 * 1024,
  });
  assert(tight.source.files.some(f => f.path === 'main.go'));
  assert(tight.source.excluded['inventory-limit'] > 0);
  assert(tight.source.files.length <= 7);
});
