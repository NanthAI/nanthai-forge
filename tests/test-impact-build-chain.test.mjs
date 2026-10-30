// SPDX-License-Identifier: Apache-2.0
import assert from 'node:assert/strict';
import test from 'node:test';
import { testImportGraph } from '../scripts/test-import-graph.mjs';
import { selectTests, sourceFiles } from '../scripts/test-impact.mjs';

// Product source reaches tests through what they actually load. Readers that treat
// the tree as data (package smoke, fixture paths, workspace paths, workflows) do not
// make every test depend on every module.
const fixture = (extra = {}) =>
  new Map(
    Object.entries({
      'package.json': JSON.stringify({
        name: '@acme/pkg',
        exports: { '.': { types: './dist/index.d.ts', default: './dist/index.js' } },
        scripts: { 'smoke:package': 'node scripts/package-smoke.mjs' },
      }),
      'package-lock.json': '{"packages":{}}',
      'src/index.ts': "export * from './a.js';",
      'src/a.ts': 'export const a = 1;',
      'src/b.ts': 'export const b = 1;',
      'tests/a.test.mjs': "import { a } from '../dist/a.js'; a;",
      'tests/b.test.mjs': "import { b } from '../dist/b.js'; b;",
      ...extra,
    }),
  );
const selected = (files, path) => selectTests({ files, paths: [path] });
const edge = (graph, from, to) => graph.evidence.get(from)?.get(to);

test('package smoke loads the package by its own name, not every file in the tree', () => {
  const files = fixture({
    'scripts/package-smoke.mjs': `import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
const resolver = createRequire(process.argv[2]);
await import(pathToFileURL(resolver.resolve('@acme/pkg')));`,
    'tests/helper.mjs': 'export const helper = 1;',
    'tests/helper.test.mjs': "import { helper } from './helper.mjs'; helper;",
  });
  const graph = testImportGraph(files);
  assert.equal(edge(graph, 'src/index.ts', 'scripts/package-smoke.mjs')?.kind, 'runtime-path');
  assert.equal(edge(graph, 'tests/helper.mjs', 'scripts/package-smoke.mjs'), undefined);
  assert.equal(edge(graph, 'src/b.ts', 'scripts/package-smoke.mjs'), undefined);
  // A test helper no longer reaches the package scripts through the smoke reader.
  const helper = selected(files, 'tests/helper.mjs');
  assert.equal(helper.scope, 'scoped');
  assert.deepEqual(
    helper.tests.filter(path => !/files|ci-scope|test-impact|check-path-scopes/.test(path)),
    ['tests/helper.test.mjs'],
  );
  // An export the manifest does not map stays an unknown loader.
  const unknown = testImportGraph(
    fixture({
      'scripts/package-smoke.mjs': `import { createRequire } from 'node:module';
await import(createRequire(process.argv[2]).resolve('@acme/pkg/missing'));`,
    }),
  );
  assert.equal(edge(unknown, 'src/b.ts', 'scripts/package-smoke.mjs')?.kind, 'dynamic');
});

test('a local helper named require loads nothing; a createRequire binding still does', () => {
  const graph = testImportGraph(
    fixture({
      'tests/browser/page.tsx': `function require(value: unknown, message: string) { if (!value) throw new Error(message); }
require(document.body, 'Missing body');`,
      'tests/loader.mjs': `import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
export const load = name => require(name);`,
      'tests/both.mjs': `import { createRequire } from 'node:module';
function check(require) { return require; }
const require = createRequire(import.meta.url);
require(process.argv[2]); check;`,
    }),
  );
  assert.equal(edge(graph, 'src/a.ts', 'tests/browser/page.tsx'), undefined);
  assert.equal(edge(graph, 'src/a.ts', 'tests/loader.mjs')?.kind, 'dynamic');
  assert.equal(edge(graph, 'src/a.ts', 'tests/both.mjs')?.kind, 'dynamic');
});

test('product code resolves repository paths in its workspace; tests that use this repository still see them', () => {
  const files = fixture({
    'src/preview.ts': `import { join } from 'node:path';
export const schema = (root: string) => join(root, 'convex/schema.ts');`,
    'src/start.ts': "export const worker = () => new URL('./worker.js', import.meta.url);",
    'src/worker.ts': 'export {};',
    'convex/schema.ts': 'export default 1;',
    'tests/preview.test.mjs': `import { schema } from '../dist/preview.js';
schema('/tmp/fixture');`,
    'tests/repo.test.mjs': `import { fileURLToPath } from 'node:url';
import { schema } from '../dist/preview.js';
schema(fileURLToPath(new URL('..', import.meta.url)));`,
    'tests/spawned.test.mjs': `import { spawnSync } from 'node:child_process';
import '../dist/preview.js';
spawnSync(process.execPath, ['dist/cli.js']);`,
    'tests/start.test.mjs': "import { worker } from '../dist/start.js'; worker();",
  });
  const graph = testImportGraph(files);
  assert.equal(edge(graph, 'convex/schema.ts', 'src/preview.ts')?.kind, 'workspace-path');
  // A module-relative path names the module's own file.
  assert.equal(edge(graph, 'src/worker.ts', 'src/start.ts')?.kind, 'runtime-path');
  const schema = selected(files, 'convex/schema.ts');
  assert.ok(!schema.tests.includes('tests/preview.test.mjs'), 'a fixture workspace is not this repository');
  assert.ok(schema.tests.includes('tests/repo.test.mjs'), 'the repository root is a workspace');
  assert.ok(schema.tests.includes('tests/spawned.test.mjs'), 'a child in the inherited directory');
  assert.deepEqual(schema.reasons['tests/repo.test.mjs'].edges, ['workspace-path', 'import']);
  assert.ok(selected(files, 'src/worker.ts').tests.includes('tests/start.test.mjs'));
});

test('a workspace path is not code a by-name loader runs', () => {
  const files = fixture({
    'package-lock.json': '{"packages":{"node_modules/convex":{}}}',
    'convex/_generated/api.js': 'export const internal = anyApi;',
    'convex/callee.ts': 'export const run = 1;',
    'convex/caller.ts':
      "import { internal } from './_generated/api.js'; export const go = ctx => ctx.runMutation(internal.callee.run, {});",
    'src/report.ts':
      "import { join } from 'node:path'; export const at = root => join(root, 'convex/caller.ts');",
    'tests/convex-context.mjs': [
      "import { getFunctionName } from 'convex/server';",
      'export async function check(ref) {',
      "  const [file, method = 'default'] = getFunctionName(ref).split(':');",
      '  return (await import(moduleUrl(`../convex/${file}.ts`)))[method];',
      '}',
    ].join('\n'),
    'tests/report.test.mjs': "import './convex-context.mjs'; import '../dist/report.js';",
  });
  assert.equal(edge(testImportGraph(files), 'convex/callee.ts', 'tests/report.test.mjs'), undefined);
  assert.ok(!selected(files, 'convex/callee.ts').tests.includes('tests/report.test.mjs'));
});

test('a computed path widens only to files its literal skeleton can name', () => {
  const files = fixture({
    'src/nested/c.ts': 'export const c = 1;',
    'tests/data.test.mjs': `const paths = Array.from({ length: 3 }, (_, i) => ({ path: \`src/file-\${i}.ts\` }));
const notes = [\`src/synthetic-\${paths.length}.txt\`];`,
    'tests/built.test.mjs': `const load = name => import(new URL(\`../dist/\${name}.js\`, import.meta.url).href);
await load(process.argv[2]);`,
    'tests/folder.test.mjs': `import { readdirSync } from 'node:fs';
readdirSync(\`src/\${process.argv[2]}\`);`,
    'tests/prefix.test.mjs': `import { readFileSync } from 'node:fs';
readFileSync(\`src/nested/\${process.argv[2]}.ts\`);`,
  });
  const a = selected(files, 'src/a.ts').tests;
  assert.ok(!a.includes('tests/data.test.mjs'), 'no source file is named file-N.ts');
  assert.ok(a.includes('tests/built.test.mjs'), 'every built module matches ../dist/*.js');
  assert.ok(a.includes('tests/folder.test.mjs'), 'a template can name a folder');
  assert.ok(!a.includes('tests/prefix.test.mjs'));
  assert.ok(selected(files, 'src/nested/c.ts').tests.includes('tests/prefix.test.mjs'));
});

test('workflows outside the landing check select their readers; the check workflow stays full', () => {
  const files = fixture({
    'src/dispatch.ts': "export const workflow = 'check.yml';",
    'scripts/backup-freshness.mjs': "export const name = 'backup.yml';",
    'tests/backup-freshness.test.mjs': "import { name } from '../scripts/backup-freshness.mjs'; name;",
    'tests/workflows.test.mjs': "import { readdirSync } from 'node:fs'; readdirSync('.github/workflows');",
    'tests/plans.test.mjs':
      "import { readFileSync } from 'node:fs'; readFileSync('plans/' + process.argv[2]);",
  });
  const backup = selected(files, '.github/workflows/backup.yml');
  assert.equal(backup.scope, 'scoped');
  assert.ok(backup.tests.includes('tests/backup-freshness.test.mjs'));
  assert.ok(backup.tests.includes('tests/workflows.test.mjs'));
  assert.ok(!backup.tests.includes('tests/a.test.mjs'));
  assert.equal(selected(files, '.github/workflows/check.yml').scope, 'full');
  const plan = selected(files, 'plans/next.md');
  assert.equal(plan.scope, 'scoped');
  assert.ok(plan.tests.includes('tests/plans.test.mjs'));
  assert.ok(!plan.tests.includes('tests/workflows.test.mjs'));
});

test('the selector scripts do not widen to the source they classify', () => {
  // A path template in the selector's own text would make every module reach every
  // test through test-impact.mjs; this happened once and selected about 500 files.
  const graph = testImportGraph(sourceFiles(new URL('..', import.meta.url).pathname));
  for (const script of [
    'scripts/test-impact.mjs',
    'scripts/test-import-graph.mjs',
    'scripts/test-directory-path.mjs',
    'scripts/check-path-scopes.mjs',
    'scripts/convex-function-names.mjs',
    'scripts/script-impact.mjs',
  ])
    assert.equal(edge(graph, 'src/hash.ts', script), undefined, script);
});

test('dogfood-scale graph with fixture templates and workspace paths stays within budget', () => {
  const extra = {};
  for (let i = 0; i < 1600; i++)
    extra[`src/m${i}.ts`] = `import { join } from 'node:path';
${i ? `import { v${i - 1} } from './m${i - 1}.js';` : ''}
export const v${i} = (root: string) => join(root, 'src/m${(i + 1) % 1600}.ts');`;
  for (let i = 0; i < 2600; i++)
    extra[`tests/t${i}.test.mjs`] = `import { v${i % 1600} } from '../dist/m${i % 1600}.js';
const files = Array.from({ length: 4 }, (_, n) => ({ path: \`src/fixture-${i}-\${n}.ts\` }));
v${i % 1600}(files);`;
  const files = fixture(extra);
  const started = performance.now(),
    heap = process.memoryUsage().heapUsed;
  const selection = selected(files, 'src/m1500.ts');
  const ms = performance.now() - started,
    growth = (process.memoryUsage().heapUsed - heap) / 2 ** 20;
  // Imports reach m1500..m1599 and their 100 tests; workspace paths and fixture names add none.
  assert.equal(selection.scope, 'scoped');
  assert.equal(selection.affectedTests.length, 100);
  assert.ok(ms < 30_000, `${ms} ms`);
  assert.ok(growth < 512, `${growth} MiB`);
});
