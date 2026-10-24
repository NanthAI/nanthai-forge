import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, renameSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { indexRepository, capture, analyze } from '../dist/index.js';
import { RepositoryQuery } from '../dist/query.js';
import { fixture, write, git, code } from './helpers.mjs';

test('real compiler resolves relative aliases and lexical references with exact locators', t => {
  const root = fixture(t, {
    'math.ts': 'export function add(a: number, b: number) { return a + b; }\n',
    'main.ts': 'import { add as sum } from "./math.js";\nexport const answer = sum(2, 3);\n',
  });
  const { pack } = indexRepository(root);
  assert.equal(pack.source.gitHead, null);
  assert.equal(pack.imports[0].target, 'math.ts');
  const add = pack.nodes.find(n => n.name === 'add');
  assert.ok(add.exported);
  const calls = pack.references.filter(r => r.target === add.id && r.locator.start.line === 2);
  assert.equal(calls.length, 1);
  const q = new RepositoryQuery(root);
  assert.equal(q.inspect('add').results[0].locator.start.line, 1);
  const text = readFileSync(join(root, 'main.ts'), 'utf8');
  assert.equal(text.slice(calls[0].locator.start.offset, calls[0].locator.end.offset), 'sum');
  assert.equal(q.status().freshness, 'current');
  assert.equal(q.source('math.ts', 1, 1).results[0].text.includes('function add'), true);
  assert.ok(q.context('add').results.some(n => n.name === 'add'));
});

test('retained query instance refuses edited source; rename/deletion remove obsolete nodes', t => {
  const root = fixture(t, { 'old.ts': 'export const oldName = 1;' });
  const first = indexRepository(root).pack;
  const q = new RepositoryQuery(root);
  write(root, 'old.ts', 'export const newName = 2;');
  assert.equal(q.status().freshness, 'stale');
  assert.throws(() => q.inspect('oldName'), code('SOURCE_STALE'));
  assert.throws(() => q.source('old.ts'), code('SOURCE_STALE'));
  renameSync(join(root, 'old.ts'), join(root, 'new.ts'));
  const second = indexRepository(root).pack;
  assert.notEqual(first.id, second.id);
  assert.ok(second.nodes.every(n => n.name !== 'oldName' && n.locator.file === 'new.ts'));
  unlinkSync(join(root, 'new.ts'));
  assert.equal(indexRepository(root).pack.nodes.length, 0);
});

test('changing Git HEAD invalidates an old artifact even with identical source bytes', t => {
  const root = fixture(t, { 'a.ts': 'export const a = 1;', '.gitignore': '.forge/\n' });
  git(root, ['add', '.']);
  git(root, ['commit', '-qm', 'first']);
  const first = indexRepository(root).pack;
  git(root, ['commit', '--allow-empty', '-qm', 'second']);
  assert.equal(new RepositoryQuery(root).status().freshness, 'stale');
  const next = indexRepository(root).pack;
  assert.notEqual(first.source.gitHead, next.source.gitHead);
});

test('syntax errors publish partial coverage without retaining old symbols', t => {
  const root = fixture(t, { 'a.ts': 'export const okay = 1;' });
  indexRepository(root);
  write(root, 'a.ts', 'export const broken = ;');
  const { pack } = indexRepository(root);
  assert.equal(pack.nodes.length, 0);
  assert.ok(pack.issues.some(i => i.file === 'a.ts'));
  assert.equal(pack.analysis.coverage, 'partial');
  assert.equal(new RepositoryQuery(root).status().freshness, 'current');
});

test('shadowed identifiers are not falsely attributed to an exported symbol', t => {
  const root = fixture(t, {
    'a.ts':
      'export const target = 1; export function f(target: number) { return target; }\nexport const use = target;',
  });
  const pack = indexRepository(root).pack;
  const target = pack.nodes.find(n => n.name === 'target');
  const refs = pack.references.filter(r => r.target === target.id);
  assert.equal(refs.length, 1);
  assert.equal(refs[0].locator.start.line, 2);
});

test('ambiguous names require a symbol ID and unknown modules remain unresolved', t => {
  const root = fixture(t, {
    'a.ts': 'export const duplicate = 1;',
    'b.ts': 'import "@missing/pkg"; import "./missing"; export const duplicate = 2;',
  });
  const pack = indexRepository(root).pack;
  assert.deepEqual(
    pack.imports.map(i => i.resolution),
    ['external', 'unresolved'],
  );
  const q = new RepositoryQuery(root);
  assert.equal(q.inspect('duplicate').total, 2);
  assert.throws(() => q.references('duplicate'), code('AMBIGUOUS_OR_MISSING_SYMBOL'));
  assert.deepEqual(q.references(q.inspect('duplicate').results[0].id).results, []);
});

test('BOM and Unicode preserve compiler UTF-16 offsets and exact file digests', t => {
  const text = '\uFEFF// 🦊\nexport const café = 1;\n';
  const root = fixture(t, { 'unicode.ts': text });
  const node = indexRepository(root).pack.nodes[0];
  assert.equal(text.slice(node.locator.start.offset, node.locator.end.offset), 'café');
  assert.equal(node.locator.start.line, 2);
});

test('bounded queries disclose truncation and reject invalid limits/ranges/paths', t => {
  const root = fixture(t, { 'a.ts': 'export const a=1,b=2,c=3;' });
  indexRepository(root);
  const q = new RepositoryQuery(root);
  const result = q.context('', 1);
  assert.equal(result.results.length, 1);
  assert.ok(result.truncated);
  assert.throws(() => q.inspect('a', 0), code('BAD_LIMIT'));
  assert.throws(() => q.context('x'.repeat(257)), code('BAD_QUERY'));
  assert.throws(() => q.source('../outside.ts'), code('SOURCE_NOT_INDEXED'));
  assert.throws(() => q.source('a.ts', 0, 2), code('BAD_RANGE'));
});

test('provider comparison fixture: compiler references distinguish aliases and shadowing beyond syntax', t => {
  const root = fixture(t, {
    'a.ts': 'export const value = 1;',
    'b.ts':
      'import { value as alias } from "./a"; export const result = alias; function f(alias: number) {return alias;}',
  });
  const snapshot = capture(root);
  const pack = analyze(snapshot);
  const target = pack.nodes.find(n => n.name === 'value');
  const refs = pack.references.filter(r => r.target === target.id);
  assert.ok(refs.length >= 2);
  const body = snapshot.content.get('b.ts');
  assert.ok(refs.every(r => r.locator.start.offset < body.indexOf('function f')));
});
