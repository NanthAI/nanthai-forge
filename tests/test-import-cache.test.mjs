// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, readdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pinImportFacts } from '../scripts/test-import-cache.mjs';
import { testImportGraph } from '../scripts/test-import-graph.mjs';
import { selectTests } from '../scripts/test-impact.mjs';

const sha = text => createHash('sha256').update(text).digest('hex');
const base = {
  'package.json': JSON.stringify({ name: 'sample', exports: { './target': './src/first.ts' }, scripts: {} }),
  'src/first.ts': 'export const target = 0;',
  'src/second.ts': 'export const target = 1;',
  'src/hub.ts': "import { target } from 'sample/target'; export const affected = () => target;",
  'tests/consumer.test.mjs': "import { affected } from '../src/hub.ts'; affected();",
};
function fixture(t) {
  const directory = mkdtempSync(join(tmpdir(), 'selector-facts-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const cachePath = join(directory, 'facts');
  const read = (sources = base, excluded = []) => {
    const entries = Object.entries(sources);
    const opened = new Set();
    const files = new (class extends Map {
      get(path) {
        opened.add(path);
        return super.get(path);
      }
    })(entries);
    pinImportFacts(
      files,
      new Map(entries.filter(([path]) => !excluded.includes(path)).map(([path, text]) => [path, sha(text)])),
      cachePath,
    );
    return { files, opened };
  };
  return { cachePath, read };
}

test('warm symbol facts re-resolve package exports and read source only for changed modules', t => {
  const { read } = fixture(t);
  const initial = read();
  assert.deepEqual(selectTests({ paths: ['src/first.ts'], files: initial.files }).affectedTests, [
    'tests/consumer.test.mjs',
  ]);
  const next = {
    ...base,
    'package.json': base['package.json'].replace('first.ts', 'second.ts'),
    'src/second.ts': 'export const target = 42;',
  };
  const { files, opened } = read(next);
  const graph = testImportGraph(files);
  assert.deepEqual([...graph.symbols.get('src/hub.ts').imports.keys()], ['src/second.ts']);
  assert.deepEqual([...graph.reverse.get('src/second.ts')], ['src/hub.ts']);
  assert.equal(graph.reverse.has('src/first.ts'), false);
  assert.deepEqual(
    [...opened].filter(path => /\.[cm]?[jt]s$/.test(path)),
    ['src/second.ts'],
  );
  assert.deepEqual(selectTests({ paths: ['src/second.ts'], files }).affectedTests, [
    'tests/consumer.test.mjs',
  ]);
});

test('cached loader, Convex and glob facts keep the current inventory after renames and deletions', t => {
  const { read } = fixture(t);
  const sources = {
    'package.json': '{"scripts":{}}',
    'convex/one.ts': '',
    'src/old.ts': '',
    'src/glob.ts': "export const mods = import.meta.glob('./*.ts');",
    'tests/helper.mjs': 'export function moduleUrl(path) { return new URL(path, import.meta.url); }',
    'tests/nested/load.mjs': "import {moduleUrl} from '../helper.mjs'; import(moduleUrl('../src/old.ts'));",
    'tests/names.test.mjs':
      "const {api} = await import('../convex/_generated/api.js'); const f = 'one:read';",
    'convex/_generated/api.js': '',
  };
  const first = testImportGraph(read(sources).files);
  assert.equal(first.evidence.get('src/old.ts').get('tests/nested/load.mjs').kind, 'import');
  assert.equal(first.evidence.get('convex/one.ts').get('tests/names.test.mjs').kind, 'function-reference');
  const { 'src/old.ts': old, 'convex/one.ts': one, ...retained } = sources;
  const next = { ...retained, 'src/new.ts': old, 'convex/two.ts': one };
  const cached = read(next);
  const second = testImportGraph(cached.files);
  const cold = testImportGraph(new Map(Object.entries(next)));
  assert.deepEqual(second.reverse, cold.reverse);
  assert.deepEqual(second.evidence, cold.evidence);
  assert.deepEqual(second.sites, cold.sites);
  assert.equal(second.reverse.has('src/old.ts'), false);
  assert.equal(second.reverse.has('convex/one.ts'), false);
  assert.equal(second.evidence.get('src/new.ts').get('src/glob.ts').kind, 'import');
  assert.equal(second.evidence.get('src/new.ts').get('tests/nested/load.mjs').kind, 'dynamic');
});

test('missing pins and damaged cache bytes reparse and opaque input stays conservative', t => {
  const { cachePath, read } = fixture(t);
  const initial = read();
  assert.equal(testImportGraph(initial.files).error, undefined);
  const malformed = { ...base, 'src/hub.ts': 'export const =' };
  const unknown = read(malformed, ['src/hub.ts']);
  assert.match(testImportGraph(unknown.files).error, /Unparseable module: src\/hub.ts/);
  assert.ok(unknown.opened.has('src/hub.ts'));

  for (const bucket of readdirSync(cachePath)) writeFileSync(join(cachePath, bucket), 'damaged');
  const reparsed = read();
  assert.equal(testImportGraph(reparsed.files).error, undefined);
  assert.ok(reparsed.opened.has('src/hub.ts'));

  const opaque = read({
    ...base,
    'src/hub.ts': base['src/hub.ts'] + '\nexport const indirect = (eval)("target");',
  });
  assert.ok(testImportGraph(opaque.files).symbols.get('src/hub.ts').opaque);
});

test('removing a locked external package widens a cached dynamic import', t => {
  const { read } = fixture(t);
  const sources = {
    'package.json': '{"scripts":{}}',
    'package-lock.json': '{"packages":{"node_modules/@scope/plugin":{}}}',
    'src/entry.ts': "export const load = () => import('@scope/plugin/subpath');",
    'src/affected.ts': 'export const changed = true;',
  };
  const before = testImportGraph(read(sources).files);
  assert.equal(before.reverse.has('src/affected.ts'), false);
  const after = testImportGraph(read({ ...sources, 'package-lock.json': '{"packages":{}}' }).files);
  assert.equal(after.evidence.get('src/affected.ts').get('src/entry.ts').kind, 'dynamic');
});

test('a browser-only parse retains type reach and leaves symbols to the runtime selector', t => {
  const { read } = fixture(t);
  const next = {
    ...base,
    'src/first.ts': 'export type Shape = string; export const target = 0;',
    'src/hub.ts': "import type { Shape } from './first.ts'; export const affected = (): Shape => '';",
    'scripts/workspace.jsx': 'export const root = process.cwd();',
  };
  const browser = testImportGraph(read(next).files, [], { typeImports: true });
  assert.deepEqual([...browser.reverse.get('src/first.ts')], ['src/hub.ts']);
  assert.ok(browser.workspaceUsers.has('scripts/workspace.jsx'));
  const { files, opened } = read(next);
  const runtime = testImportGraph(files);
  assert.equal(runtime.reverse.has('src/first.ts'), false);
  assert.ok(runtime.symbols.get('src/hub.ts').exports.has('affected'));
  assert.ok(opened.has('src/hub.ts'));
});
