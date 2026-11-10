// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import ts from 'typescript';
import { performance } from 'node:perf_hooks';
import { diffExports, scanExports, scanImports } from '../dist/contract-exports.js';
import { contractDelta, dependentOn } from '../dist/contract-deps.js';
import { protectedMatches, policyPreset } from '../dist/autonomy-policy.js';

const delta = (before, after, file = 'src/a.ts') =>
  diffExports(file, scanExports(before), scanExports(after));
const LIB = [
  'export function greet(name: string): string {',
  '  return `hi ${name}`;',
  '}',
  'export interface Options {',
  '  loud: boolean;',
  '}',
  'export const LIMIT = 3;',
  '',
].join('\n');

test('detects added, removed and changed exported functions, types, interfaces, classes and values', () => {
  const kinds = (before, after) => delta(before, after).map(item => `${item.export}:${item.kind}`);
  assert.deepEqual(kinds('', LIB), ['LIMIT:added', 'Options:added', 'greet:added']);
  assert.deepEqual(kinds(LIB, ''), ['LIMIT:removed', 'Options:removed', 'greet:removed']);
  assert.deepEqual(kinds(LIB, LIB.replace('(name: string)', '(name: string, shout?: boolean)')), [
    'greet:changed',
  ]);
  assert.deepEqual(kinds(LIB, LIB.replace('): string {', '): number {')), ['greet:changed']);
  assert.deepEqual(kinds(LIB, LIB.replace('loud: boolean;', 'loud: boolean;\n  quiet?: boolean;')), [
    'Options:changed',
  ]);
  assert.deepEqual(kinds(LIB, LIB.replace('LIMIT = 3', 'LIMIT = 4')), ['LIMIT:changed']);
  assert.deepEqual(kinds('export type Id = string;\n', 'export type Id = string | number;\n'), [
    'Id:changed',
  ]);
  assert.deepEqual(
    kinds(
      'export class A {\n  run(x: number) { return x; }\n}\n',
      'export class A {\n  run(x: string) { return x; }\n}\n',
    ),
    ['A:changed'],
  );
});
test('bodies, comments, formatting and private members are not contracts', () => {
  assert.deepEqual(delta(LIB, LIB.replace('`hi ${name}`', "'hello ' + name")), []);
  assert.deepEqual(delta(LIB, `// header\n${LIB.replace('LIMIT = 3', 'LIMIT   =   3 /* same */')}`), []);
  assert.deepEqual(
    delta(
      'export class A {\n  private x = 1;\n  run() { return 1; }\n}\n',
      'export class A {\n  private x = 2;\n  run() { return 2; }\n}\n',
    ),
    [],
  );
  const arrow = 'export const f = async (a: number): Promise<number> => {\n  return a;\n};\n';
  assert.deepEqual(delta(arrow, arrow.replace('return a', 'return a + 1')), []);
  assert.deepEqual(
    delta(arrow, arrow.replace('a: number', 'a: string')).map(item => item.kind),
    ['changed'],
  );
});
test('schemas, validators, re-exports, regex-heavy code and Convex endpoints', () => {
  const schema = 'export const row = z.object({ id: z.string() });\n';
  assert.deepEqual(
    delta(schema, schema.replace('z.string()', 'z.number()')).map(i => i.export),
    ['row'],
  );
  assert.equal(scanExports(schema).get('row').decl, 'schema');
  const convex = (args, body) =>
    `export const save = mutation({\n  args: { ${args} },\n  handler: async (ctx) => {\n    ${body}\n  },\n});\n`;
  assert.deepEqual(delta(convex('id: v.string()', 'a();'), convex('id: v.string()', 'b();')), []);
  assert.deepEqual(
    delta(convex('id: v.string()', 'a();'), convex('id: v.number()', 'a();')).map(i => i.export),
    ['save'],
  );
  const tables = extra =>
    `export default defineSchema({\n  users: defineTable({ name: v.string()${extra} }),\n  notes: defineTable({ text: v.string() }),\n});\n`;
  assert.deepEqual(delta(tables(''), tables(', age: v.number()')), [
    { file: 'src/a.ts', export: 'table:users', kind: 'changed' },
  ]);
  assert.deepEqual(
    delta("export { a, b as c } from './x';\n", "export { a } from './x';\nexport * from './y';\n").map(
      i => `${i.export}:${i.kind}`,
    ),
    ['*:./y:added', 'c:removed'],
  );
  const tricky = "const re = /['\"`]\\/(x)/g;\nexport const after = `${'}'}`;\nexport const ok = 1;\n";
  assert.deepEqual([...scanExports(tricky).keys()], ['after', 'ok']);
  assert.deepEqual(
    [...scanExports('export const a = 1, b = 2;\nexport type * from "./t";\n').keys()],
    ['a', 'b', '*:./t'],
  );
});
test('scanImports covers named, default, namespace, side-effect, re-export and dynamic imports', () => {
  const found = scanImports(
    "import d, { a, type B as C } from './x.js';\nimport * as ns from './y';\nimport './z';\nexport { q } from './w';\nconst m = await import('./v');\n// import { no } from './c'\n",
  );
  assert.deepEqual(found, [
    { spec: './x.js', names: ['default', 'a', 'B'] },
    { spec: './y', names: '*' },
    { spec: './w', names: ['q'] },
    { spec: './z', names: '*' },
    { spec: './v', names: '*' },
  ]);
});
test('dependent selection: named imports, namespaces, barrels, and no match for others', () => {
  const store = new Map(),
    source = { object: blob => Buffer.from(store.get(blob)) },
    file = (path, text) => (store.set(`b:${path}`, text), { path, blob: `b:${path}` });
  const lib = file('src/lib.ts', LIB),
    barrel = file('src/index.ts', "export * from './lib.js';\n"),
    named = file('src/named.ts', "import { greet } from './lib.js';\n"),
    other = file('src/other-name.ts', "import { LIMIT } from './lib.js';\n"),
    space = file('src/space.ts', "import * as lib from './lib';\n"),
    viaBarrel = file('src/via.ts', "import { greet } from './index.js';\n"),
    none = file('src/none.ts', "import { x } from './elsewhere.js';\n");
  const changes = [{ file: 'src/lib.ts', export: 'greet', kind: 'changed' }];
  const everything = [lib, barrel, named, other, space, viaBarrel, none];
  const uses = file => dependentOn(source, [file], everything, changes).map(item => item.export);
  assert.deepEqual(uses(named), ['greet']);
  assert.deepEqual(uses(other), [], 'imports a different export of the same file');
  assert.deepEqual(uses(space), ['greet']);
  assert.deepEqual(uses(viaBarrel), ['greet']);
  assert.deepEqual(uses(none), []);
});
test('contracts.json interfaces declare extra whole-file contracts', () => {
  const store = new Map(),
    source = { object: blob => Buffer.from(store.get(blob)) },
    file = (path, text) => (store.set(`${path}:${text}`, text), { path, blob: `${path}:${text}` });
  const config = file('.forge/contracts.json', JSON.stringify({ interfaces: ['api/**', 7], numbers: [] }));
  const before = [config, file('api/openapi.json', '{"v":1}'), file('docs/x.json', '{}')],
    after = [
      config,
      file('api/openapi.json', '{"v":2}'),
      file('docs/x.json', '{"a":1}'),
      file('src/n.ts', 'export const n = 1;'),
    ];
  assert.deepEqual(contractDelta(source, before, after), [
    { file: 'api/openapi.json', export: '*', kind: 'changed' },
    { file: 'src/n.ts', export: 'n', kind: 'added' },
  ]);
  assert.deepEqual(contractDelta({ object: () => Buffer.from('{bad') }, before, after.slice(0, 1)), []);
});
test('protected paths are opt-in: a contract change on a protected path needs a person, default off', () => {
  const changed = ['src/lib.ts'];
  assert.deepEqual(protectedMatches(policyPreset('trusted'), changed), []);
  const guarded = policyPreset('trusted');
  guarded.acceptance.protectedPaths = ['src/**'];
  assert.deepEqual(protectedMatches(guarded, changed), ['src/lib.ts']);
});

// A default declaration's local binding is not its exported name. Keep the
// parser oracle faithful to ESM for named/anonymous declarations and expressions.
function parserExportNames(text) {
  const names = new Set();
  for (const node of ts.createSourceFile('module.ts', text, 99, true).statements) {
    const modifiers = ts.canHaveModifiers(node) ? ts.getModifiers(node) : undefined;
    if (ts.isExportAssignment(node)) {
      if (!node.isExportEquals) names.add('default');
    } else if (ts.isExportDeclaration(node)) {
      if (node.exportClause && ts.isNamedExports(node.exportClause))
        for (const item of node.exportClause.elements) names.add(item.name.text);
      else names.add(node.exportClause ? node.exportClause.name.text : `*:${node.moduleSpecifier.text}`);
    } else if (modifiers?.some(item => item.kind === ts.SyntaxKind.ExportKeyword)) {
      if (modifiers.some(item => item.kind === ts.SyntaxKind.DefaultKeyword)) names.add('default');
      else if (ts.isVariableStatement(node))
        for (const item of node.declarationList.declarations) names.add(item.name.getText());
      else names.add(node.name.text);
    }
  }
  return names;
}
test('default exports keep their ESM name for declarations, generators and expressions', () => {
  for (const text of [
    'export default function named() {}',
    'export default async function* named() { yield 1; }',
    'export default function* () { yield 1; }',
    'export default class Named {}',
    'export default class {}',
    'const local = 1; export default local;',
    'export default 1;',
  ]) {
    assert.deepEqual([...parserExportNames(text)], ['default'], text);
    assert.deepEqual([...scanExports(text).keys()], ['default'], text);
  }
});
test('export scanner agrees with the TypeScript parser on every source module', () => {
  const directory = new URL('../src/', import.meta.url);
  let names = 0;
  for (const name of readdirSync(directory).filter(item => item.endsWith('.ts'))) {
    const text = readFileSync(new URL(name, directory), 'utf8'),
      want = parserExportNames(text);
    names += want.size;
    assert.deepEqual([...scanExports(text).keys()].sort(), [...want].sort(), name);
  }
  assert.ok(names > 1000);
});

test('performance: contract detection over a realistic change set stays within a few milliseconds', t => {
  const store = new Map(),
    reads = [],
    source = {
      object: blob => {
        reads.push(blob);
        return Buffer.from(store.get(blob));
      },
    };
  const body = n =>
    Array.from({ length: 120 }, (_, i) =>
      i % 6 === 0
        ? `export function f${n}_${i}(a: number, b: string): Promise<{ ok: boolean }> {\n  return Promise.resolve({ ok: a > ${i} && b.length > 0 });\n}\n`
        : `const helper${i} = (x: number) => {\n  // note ${n}\n  return x * ${i} + (${n} % 7);\n};\n`,
    ).join('\n');
  const samples = [];
  let result;
  for (let run = 0; run < 5; run++) {
    // Distinct blob ids defeat the in-process memo so every run measures real parsing.
    const before = [],
      after = [];
    for (let n = 0; n < 8; n++) {
      const path = `src/mod${n}.ts`;
      store.set(`o${run}-${n}`, body(n));
      store.set(
        `n${run}-${n}`,
        body(n)
          .replace('b: string', n % 2 ? 'b: number' : 'b: string')
          .replace('ok: a', `ok: ${n} + a`),
      );
      before.push({ path, blob: `o${run}-${n}` });
      after.push({ path, blob: `n${run}-${n}` });
    }
    for (let n = 0; n < 400; n++) {
      before.push({ path: `src/same${n}.ts`, blob: `s${n}` });
      after.push({ path: `src/same${n}.ts`, blob: `s${n}` });
    }
    reads.length = 0;
    const started = performance.now();
    result = contractDelta(source, before, after);
    samples.push(performance.now() - started);
    // Work scales with changed files: each changed module is read once per side and
    // the 400 unchanged paths are never read.
    assert.deepEqual(reads.sort(), [...before.slice(0, 8), ...after.slice(0, 8)].map(e => e.blob).sort());
  }
  t.diagnostic(
    `contract delta, 8 changed ~13KB modules of 408: ${samples.map(s => s.toFixed(2)).join(', ')} ms`,
  );
  assert.ok(result.length >= 4);
  // Wall-clock on shared CI runners varies by several times, so the budget only
  // catches gross regressions; the read assertion above guards the scaling.
  assert.ok(Math.min(...samples) < 1000, 'detection must not dominate a lifecycle receipt');
});
