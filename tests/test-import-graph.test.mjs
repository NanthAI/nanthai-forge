// SPDX-License-Identifier: Apache-2.0
import assert from 'node:assert/strict';
import test from 'node:test';
import { testImportGraph } from '../scripts/test-import-graph.mjs';
import { selectTests, standardSelection } from '../scripts/test-impact.mjs';

const fixture = (extra = {}) =>
  new Map(
    Object.entries({
      'package.json': '{"scripts":{}}',
      'package-lock.json': '{"packages":{}}',
      'src/leaf.ts': 'export const leaf = 1;',
      'src/other.ts': 'export const other = 1;',
      'src/hub.ts': "export { leaf } from './leaf.js'; export { other } from './other.js';",
      'web/src/Leaf.tsx': 'export const Leaf = 1;',
      'convex/value.ts': 'export const value = 1;',
      'tests/leaf.test.mjs': "import '../dist/leaf.js';",
      'tests/hub.test.mjs': "import { other } from '../dist/hub.js';",
      'tests/other.test.mjs': "import '../dist/other.js';",
      ...extra,
    }),
  );
const selected = (files, paths = ['src/leaf.ts']) => selectTests({ files, paths });
const edge = (graph, from, to) => graph.evidence.get(from)?.get(to);

test('literal graph covers static imports, reexports, dist, runtime URLs and transitive fixtures', () => {
  const files = fixture({
    'tests/fixture.mjs': "export * from '../dist/leaf.js';",
    'tests/consumer.test.mjs': "import './fixture.mjs';",
    'tests/cli.test.mjs': "spawn(process.execPath, [new URL('../dist/hub.js', import.meta.url).pathname]);",
    'tests/source.test.mjs': "readFileSync('../src/leaf.ts');",
  });
  const graph = testImportGraph(files);
  assert.equal(edge(graph, 'src/leaf.ts', 'tests/leaf.test.mjs').kind, 'import');
  assert.equal(edge(graph, 'src/hub.ts', 'tests/cli.test.mjs').kind, 'runtime-path');
  assert.ok(selected(files).tests.includes('tests/consumer.test.mjs'));
  assert.ok(selected(files).tests.includes('tests/source.test.mjs'));
  // Runtime export hubs remain conservative, including initialization/shared state.
  assert.ok(selected(files).tests.includes('tests/hub.test.mjs'));
  assert.ok(!selected(files).tests.includes('tests/other.test.mjs'));
});

test('moduleUrl/moduleSource and web/Convex/extensionless and module-format imports resolve', () => {
  const files = fixture({
    'src/esm.mts': 'export const esm = 1;',
    'src/cjs.cts': 'export const cjs = 1;',
    'tests/esm.test.mjs': "import '../dist/esm.mjs';",
    'tests/cjs.test.mjs': "require('../dist/cjs.cjs');",
    'web/src/Parent.tsx': "export { Leaf } from './Leaf';",
    'tests/web.test.mjs': "await import(moduleUrl('../web/src/Parent.tsx'));",
    'tests/backend.test.mjs': "await import(moduleUrl('../convex/value.ts'));",
    'tests/backend-source.test.mjs': "moduleSource('../convex/value.ts');",
  });
  const graph = testImportGraph(files);
  for (const [from, to] of [
    ['src/esm.mts', 'tests/esm.test.mjs'],
    ['src/cjs.cts', 'tests/cjs.test.mjs'],
    ['web/src/Leaf.tsx', 'web/src/Parent.tsx'],
    ['web/src/Parent.tsx', 'tests/web.test.mjs'],
    ['convex/value.ts', 'tests/backend.test.mjs'],
    ['convex/value.ts', 'tests/backend-source.test.mjs'],
  ])
    assert.ok(edge(graph, from, to), `${from} -> ${to}`);
});

test('directory names do not pollute selector, foundation or cleanup hubs', () => {
  const files = fixture({
    'scripts/selector.mjs':
      "export const domain = value => ['dist','../dist','web/src','../convex'].includes(value);",
    'scripts/foundation.mjs':
      "const skip = new Set(['dist', 'web-dist']); export const ignored = x => skip.has(x);",
    'tests/cleanup.mjs':
      "import {resolve,join} from 'node:path'; function match(dir) { const script = join(dir, name); return 'worker'.includes(script); } export function cleanup(dir = resolve('dist')) { match(dir); }",
    'tests/pipeline.test.mjs':
      "import '../scripts/selector.mjs'; import '../scripts/foundation.mjs'; import './cleanup.mjs';",
  });
  const result = selected(files);
  assert.ok(!result.tests.includes('tests/pipeline.test.mjs'));
  assert.ok(selected(files, ['tests/cleanup.mjs']).tests.includes('tests/pipeline.test.mjs'));
});

test('directory enumeration, built web bundles and directory aliases keep their domain coverage', () => {
  for (const text of [
    "readdirSync(new URL('../dist', import.meta.url))",
    "const dir = resolve('dist'); readdirSync(dir)",
    "function load(dir) { return readdirSync(dir); } load(resolve('dist'))",
    "unknown('dist')",
  ]) {
    const files = fixture({ 'tests/enumerate.test.mjs': text });
    assert.ok(selected(files).tests.includes('tests/enumerate.test.mjs'), text);
  }
  const files = fixture({ 'tests/bundle.test.mjs': "readFileSync('web-dist/assets/app.js')" });
  assert.ok(selected(files, ['web/src/Leaf.tsx']).tests.includes('tests/bundle.test.mjs'));
  assert.ok(!selected(files).tests.includes('tests/bundle.test.mjs'));
});

test('unknown and partially known loaders stay broad across source and helper domains', () => {
  for (const text of [
    'await import(variable)',
    'require(variable)',
    'moduleUrl(variable)',
    'moduleSource(variable)',
    "await import(flag ? '../dist/leaf.js' : variable)",
    'await import(flag ? `../dist/${name}.js` : variable)',
    "await import(unknown('../dist/leaf.js'))",
    "import.meta.glob('./*.tsx')",
  ]) {
    const files = fixture({ 'tests/dynamic.test.mjs': text, 'tests/fixture.mjs': 'export const x = 1;' });
    for (const path of ['src/other.ts', 'web/src/Leaf.tsx', 'tests/fixture.mjs']) {
      const result = selected(files, [path]);
      assert.ok(result.tests.includes('tests/dynamic.test.mjs'), `${text}: ${path}`);
      assert.equal(result.reasons['tests/dynamic.test.mjs'].kind, 'dynamic');
    }
  }
});

test('bounded computed loader domains remain broad within their source domain', () => {
  for (const text of [
    'await import(`../dist/${name}.js`)',
    "await import(pathToFileURL(join(root, 'dist', name + '.js')).href)",
  ]) {
    const files = fixture({ 'tests/dynamic.test.mjs': text });
    assert.ok(selected(files).tests.includes('tests/dynamic.test.mjs'));
    assert.ok(!selected(files, ['web/src/Leaf.tsx']).tests.includes('tests/dynamic.test.mjs'));
  }
});

test('unresolved value imports, parse errors and malformed/local lock metadata fail closed', () => {
  for (const extra of [
    { 'src/alias.ts': "import '@local/unknown';" },
    { 'src/broken.ts': 'export const = ;' },
    { 'tests/broken.test.mjs': 'import (' },
    { 'package-lock.json': '{' },
    { 'package-lock.json': '{"packages":{"node_modules/local":{"link":true}}}' },
  ]) {
    const files = fixture(extra),
      result = selected(files);
    assert.equal(result.scope, 'full');
    assert.deepEqual(result.tests, [...files.keys()].filter(p => p.endsWith('.test.mjs')).sort());
    assert.ok(
      Object.values(result.reasons).every(
        reason => reason.kind === 'full' && reason.detail === result.reason,
      ),
    );
  }
});

test('package/lock/config/tooling changes and shared runtime keep broad selection', () => {
  const files = fixture({ 'tests/check-runtime.mjs': '', 'tests/worker-budget.mjs': '' });
  for (const path of ['package.json', 'package-lock.json', 'unknown.config.mjs', 'scripts/test-impact.mjs'])
    assert.equal(selected(files, [path]).scope, 'full', path);
  for (const path of ['tests/check-runtime.mjs', 'tests/worker-budget.mjs'])
    assert.deepEqual(
      selected(files, [path]).tests,
      [...files.keys()].filter(p => p.endsWith('.test.mjs')).sort(),
    );
  assert.ok(selected(files, ['tsconfig.json']).tests.includes('tests/other.test.mjs'));
});

test('every selected file has serializable explanation with a dependency witness or a broad rule', () => {
  const files = fixture({
    'tests/fixture.mjs': "import '../dist/leaf.js';",
    'tests/consumer.test.mjs': "import './fixture.mjs';",
  });
  const result = JSON.parse(JSON.stringify(selected(files)));
  assert.deepEqual(Object.keys(result.reasons), result.tests);
  assert.deepEqual(result.reasons['tests/consumer.test.mjs'].chain, [
    'src/leaf.ts',
    'tests/fixture.mjs',
    'tests/consumer.test.mjs',
  ]);
  assert.deepEqual(result.reasons['tests/consumer.test.mjs'].edges, ['import', 'import']);
  const recovered = standardSelection({
    files,
    paths: ['src/leaf.ts'],
    recovery: { tests: ['tests/other.test.mjs'] },
    env: { FORGE_CHECK_SCOPED: '1' },
  });
  assert.equal(recovered.reasons['tests/other.test.mjs'].kind, 'recovery');
  const audit = standardSelection({
    files,
    paths: [],
    mainCheck: { channel: 'main' },
    env: { FORGE_CHECK_SCOPED: '1' },
  });
  assert.ok(Object.values(audit.reasons).every(reason => reason.detail === audit.reason));
});

test('graph helpers used by the selector remain full pipeline dependencies', () => {
  const files = fixture({
    'scripts/test-impact.mjs': "import './test-import-graph.mjs';",
    'scripts/test-import-graph.mjs': "import './test-directory-path.mjs';",
    'scripts/test-directory-path.mjs': 'export const graph = 1;',
  });
  for (const path of ['scripts/test-import-graph.mjs', 'scripts/test-directory-path.mjs']) {
    const result = selected(files, [path]);
    assert.equal(result.scope, 'full');
    assert.match(result.reason, /Check pipeline/);
  }
});

test('selection witnesses are deterministic across inventory and comparison order', () => {
  const files = fixture({ 'tests/both.test.mjs': "import '../dist/hub.js';" });
  assert.deepEqual(
    selected(files, ['src/leaf.ts', 'src/other.ts']),
    selected(new Map([...files].reverse()), ['src/other.ts', 'src/leaf.ts']),
  );
});

test('runtime import-equals resolves literal dependencies and unknown aliases force full', () => {
  const files = fixture({
    'src/equals.ts': "import leaf = require('./leaf.js'); export { leaf };",
    'tests/equals.test.mjs': "import '../dist/equals.js';",
  });
  assert.equal(testImportGraph(files).evidence.get('src/leaf.ts').get('src/equals.ts').kind, 'import');
  assert.ok(selected(files).tests.includes('tests/equals.test.mjs'));
  files.set('src/equals.ts', "import leaf = require('@unknown/leaf'); export { leaf };");
  assert.equal(selected(files).scope, 'full');
});

test('known adapter filenames never hide unknown module loading', () => {
  const files = fixture({
    'package-lock.json': JSON.stringify({
      packages: { 'node_modules/typescript': { resolved: 'https://example.invalid/typescript.tgz' } },
    }),
    'tests/convex-module.mjs': "const ts = require('typescript'); export const moduleUrl = path => path;",
    'tests/consumer.test.mjs':
      "import { moduleUrl } from './convex-module.mjs'; await import(moduleUrl('../web/src/Leaf.tsx'));",
  });
  assert.ok(!selected(files).tests.includes('tests/consumer.test.mjs'));
  assert.ok(selected(files, ['web/src/Leaf.tsx']).tests.includes('tests/consumer.test.mjs'));
  files.set('tests/convex-module.mjs', 'export const moduleUrl = path => import(unknown);');
  assert.ok(selected(files).tests.includes('tests/consumer.test.mjs'));
  assert.equal(selected(files).reasons['tests/consumer.test.mjs'].kind, 'dynamic');
});
