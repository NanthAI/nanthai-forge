// SPDX-License-Identifier: Apache-2.0
import assert from 'node:assert/strict';
import test from 'node:test';
import { testImportGraph } from '../scripts/test-import-graph.mjs';
import { selectTests } from '../scripts/test-impact.mjs';

const api = "import { api, internal } from './_generated/api.js';";
const fixture = (extra = {}) =>
  new Map(
    Object.entries({
      'package.json': '{"scripts":{}}',
      'package-lock.json': '{"packages":{"node_modules/convex":{}}}',
      'convex/_generated/api.js': 'export const api = anyApi; export const internal = anyApi;',
      'convex/schema.ts': 'export default 1;',
      'convex/callee.ts': 'export const run = 1;',
      'convex/caller.ts': `${api} export const go = ctx => ctx.runMutation(internal.callee.run, {});`,
      'convex/other.ts': 'export const run = 1;',
      'convex/hostedSaves.ts': 'export const progress = 1;',
      'convex/hostedSync.ts': 'export const progress = 1;',
      'convex/hostedCompose.ts': 'export const progress = 1;',
      'tests/caller.test.mjs': "await import(moduleUrl('../convex/caller.ts'));",
      'tests/callee.test.mjs': "await import(moduleUrl('../convex/callee.ts'));",
      'tests/other.test.mjs': "await import(moduleUrl('../convex/other.ts'));",
      'tests/schema.test.mjs': "await import(moduleUrl('../convex/schema.ts'));",
      ...extra,
    }),
  );
const tests = (files, path) => selectTests({ files, paths: [path] }).tests;
const edge = (graph, from, to) => graph.evidence.get(from)?.get(to);

test('a Convex module selects its importers and function-name callers, not the whole backend', () => {
  const files = fixture();
  const selected = tests(files, 'convex/callee.ts');
  assert.ok(selected.includes('tests/callee.test.mjs'));
  assert.ok(selected.includes('tests/caller.test.mjs'), 'internal.callee.run reaches the caller');
  assert.ok(!selected.includes('tests/other.test.mjs'));
  assert.ok(!tests(files, 'convex/other.ts').includes('tests/caller.test.mjs'));
  // Schema and the generated API still share the backend namespace.
  for (const path of ['convex/schema.ts', 'convex/_generated/api.js'])
    assert.ok(tests(files, path).includes('tests/other.test.mjs'), path);
});

test('api chains, aliases and folder modules resolve to the longest module path', () => {
  const graph = testImportGraph(
    fixture({
      'convex/nested/deep.ts': 'export const fn = 1;',
      'convex/alias.ts': `import { internal as fns } from './_generated/api.js'; fns.nested.deep.fn; fns['callee'].run;`,
      'convex/folder.ts': `${api} const group = internal.nested; group;`,
      'convex/whole.ts': `${api} register(internal);`,
      'convex/typed.ts': `import type { api } from './_generated/api.js'; type T = typeof api.other.run;`,
    }),
  );
  assert.equal(edge(graph, 'convex/nested/deep.ts', 'convex/alias.ts')?.kind, 'function-reference');
  assert.equal(edge(graph, 'convex/callee.ts', 'convex/alias.ts')?.kind, 'function-reference');
  assert.equal(edge(graph, 'convex/nested/deep.ts', 'convex/folder.ts')?.kind, 'dynamic');
  assert.equal(edge(graph, 'convex/callee.ts', 'convex/folder.ts'), undefined);
  // The whole API object passed away can name any module.
  assert.equal(edge(graph, 'convex/other.ts', 'convex/whole.ts')?.kind, 'dynamic');
  // Type-only references are erased; static checks cover them.
  assert.equal(edge(graph, 'convex/other.ts', 'convex/typed.ts'), undefined);
});

test('function-name strings and templates name exact modules, prefixes or everything', () => {
  const graph = testImportGraph(
    fixture({
      'convex/literal.ts': "makeFunctionReference('callee:run'); ctx.runQuery(ref('other:run'));",
      'convex/union.ts':
        "export const wait = (kind: 'Saves' | 'Sync') => makeFunctionReference(`hosted${kind}:progress`);",
      'convex/alias.ts':
        "type Kind = 'Compose'; export const read = (kind: Kind) => client.query(`hosted${kind}:progress`);",
      'convex/table.ts':
        "const kind = { a: 'Saves', b: 'Sync' }[mode]; client.query(`hosted${kind}:progress`);",
      'convex/prefix.ts': 'export const read = kind => client.query(`hosted${kind}:progress`);',
      'convex/unknown.ts': 'export const read = name => makeFunctionReference(`${name}:list`);',
      'convex/malformed.ts': "makeFunctionReference('not a name');",
      'convex/absent.ts': "makeFunctionReference('gone:run');",
      'convex/key.ts': 'export const key = (a, b) => `${a}:${b}` + `${a}:payload`;',
      'convex/shadowed.ts':
        "export const read = (kind: 'Saves') => { for (const [kind] of rows) kind; return client.query(`hosted${kind}:progress`); };",
    }),
  );
  const named = (from, to) => edge(graph, `convex/${to}.ts`, `convex/${from}.ts`)?.kind;
  assert.equal(named('literal', 'callee'), 'function-reference');
  assert.equal(named('literal', 'other'), 'function-reference');
  assert.equal(named('union', 'hostedSaves'), 'function-reference');
  assert.equal(named('union', 'hostedSync'), 'function-reference');
  assert.equal(named('union', 'hostedCompose'), undefined);
  assert.equal(named('alias', 'hostedCompose'), 'function-reference');
  assert.equal(named('alias', 'hostedSaves'), undefined);
  assert.equal(named('table', 'hostedSync'), 'function-reference');
  assert.equal(named('table', 'hostedCompose'), undefined);
  assert.equal(named('shadowed', 'hostedSaves'), 'function-reference');
  assert.equal(named('shadowed', 'hostedSync'), undefined);
  // An unreadable span keeps every module the literal prefix can name.
  for (const module of ['hostedSaves', 'hostedSync', 'hostedCompose'])
    assert.equal(named('prefix', module), 'dynamic');
  assert.equal(named('prefix', 'callee'), undefined);
  // An unreadable module name in a reference names every module; so does a malformed one.
  for (const from of ['unknown', 'malformed']) assert.equal(named(from, 'other'), 'dynamic', from);
  // A well-formed name of an absent module loads nothing; keys are not names.
  assert.equal([...graph.evidence.values()].filter(m => m.has('convex/absent.ts')).length, 0);
  assert.equal([...graph.evidence.values()].filter(m => m.has('convex/key.ts')).length, 0);
});

test('product clients name functions over the network; only a by-name loader makes those names count', () => {
  const files = fixture({
    'src/client.ts':
      "export const save = client => client.mutation(makeFunctionReference('callee:run'), {});",
    'tests/client.test.mjs': "import '../dist/client.js';",
    'tests/convex-context.mjs': [
      "import { getFunctionName } from 'convex/server';",
      'export async function check(ref) {',
      '  const name = getFunctionName(ref);',
      "  const [file, method = 'default'] = name.split(':');",
      '  return (await import(moduleUrl(`../convex/${file}.ts`)))[method];',
      '}',
    ].join('\n'),
    'tests/harness.test.mjs': "import './convex-context.mjs'; import '../dist/client.js';",
    'tests/context-only.test.mjs': "import './convex-context.mjs';",
  });
  const selected = tests(files, 'convex/callee.ts');
  // A fake client never runs the module: the client test is not selected.
  assert.ok(!selected.includes('tests/client.test.mjs'));
  // The by-name loader runs whatever the client names: that test is selected.
  assert.ok(selected.includes('tests/harness.test.mjs'));
  assert.equal(
    edge(testImportGraph(files), 'convex/callee.ts', 'tests/harness.test.mjs')?.kind,
    'function-reference',
  );
  // The loader itself no longer widens to every module.
  assert.ok(!selected.includes('tests/context-only.test.mjs'));
  assert.ok(!tests(files, 'convex/other.ts').includes('tests/harness.test.mjs'));
  // Any other computed Convex loader still widens.
  files.set(
    'tests/convex-context.mjs',
    'export const load = file => import(moduleUrl(`../convex/${file}.ts`));',
  );
  assert.ok(tests(files, 'convex/other.ts').includes('tests/context-only.test.mjs'));
});

test('literal module lists load exactly their modules; mutated or computed lists stay broad', () => {
  const load = 'name => import(moduleUrl(`../convex/${name}.ts`))';
  const files = fixture({
    'tests/list.test.mjs': `await Promise.all(['callee', 'other'].map(${load}));`,
    'tests/const.test.mjs': `const names = ['callee']; await Promise.all(names.map(${load}));`,
    'tests/loop.test.mjs': "for (const name of ['other']) await import(moduleUrl(`../convex/${name}.ts`));",
    'tests/mutated.test.mjs': `const names = ['callee']; names.push(extra); await Promise.all(names.map(${load}));`,
  });
  const callee = tests(files, 'convex/callee.ts'),
    hosted = tests(files, 'convex/hostedSync.ts');
  for (const path of ['tests/list.test.mjs', 'tests/const.test.mjs', 'tests/mutated.test.mjs'])
    assert.ok(callee.includes(path), path);
  assert.ok(!callee.includes('tests/loop.test.mjs'));
  assert.ok(tests(files, 'convex/other.ts').includes('tests/loop.test.mjs'));
  assert.deepEqual(
    ['tests/list.test.mjs', 'tests/const.test.mjs', 'tests/loop.test.mjs'].filter(path =>
      hosted.includes(path),
    ),
    [],
  );
  assert.ok(hosted.includes('tests/mutated.test.mjs'));
});

test('a file path inside a message names that file, not its folder', () => {
  const files = fixture({
    'src/report.ts': 'export const at = line => `convex/schema.ts:${line}: duplicate index`;',
    'tests/report.test.mjs': "import '../dist/report.js';",
  });
  assert.ok(!tests(files, 'convex/other.ts').includes('tests/report.test.mjs'));
  assert.equal(edge(testImportGraph(files), 'convex/schema.ts', 'src/report.ts')?.kind, 'runtime-path');
});

test('7967038f: a test enumerating ../convex/ depends on every module; data strings do not', () => {
  const files = fixture({
    'tests/generated.test.mjs': [
      "import { readdirSync } from 'node:fs'; import { fileURLToPath } from 'node:url';",
      "const convex = fileURLToPath(new URL('../convex/', import.meta.url));",
      'readdirSync(convex);',
    ].join('\n'),
    'tests/paths.test.mjs': "const row = { paths: ['convex/'] }; assert(row.paths);",
  });
  for (const path of ['convex/other.ts', 'convex/_generated/api.js'])
    assert.ok(tests(files, path).includes('tests/generated.test.mjs'), path);
  assert.ok(!tests(files, 'convex/other.ts').includes('tests/paths.test.mjs'));
});

test('product source stops at static tools that read it; scripts that run it keep their consumers', () => {
  const files = fixture({
    'package.json': JSON.stringify({
      scripts: {
        'build:core': 'node scripts/build-hook.mjs',
        lint: 'node scripts/lint.mjs',
        qa: 'node scripts/qa.mjs',
      },
    }),
    'src/leaf.ts': 'export const leaf = 1;',
    'scripts/build-hook.mjs': "await build({ build: { ssr: 'src/leaf.ts', outDir: 'dist' } });",
    'scripts/lint.mjs': "for (const file of walk('../src')) lint(file);",
    'scripts/qa.mjs': "import '../src/leaf.ts';",
    'scripts/verify.mjs': "run('npm run build:core'); run('npm run lint'); run('scripts/lint.mjs');",
    'tests/verify.test.mjs': "import '../scripts/verify.mjs';",
    'tests/qa.test.mjs': "exec('npm run qa');",
    'tests/leaf.test.mjs': "import '../dist/leaf.js';",
  });
  const selected = tests(files, 'src/leaf.ts');
  assert.ok(selected.includes('tests/leaf.test.mjs'));
  assert.ok(selected.includes('tests/qa.test.mjs'), 'a non-static command that runs product code');
  assert.ok(!selected.includes('tests/verify.test.mjs'), 'build and lint run on every Candidate');
  // A changed static tool is still the check pipeline itself.
  assert.equal(selectTests({ files, paths: ['scripts/build-hook.mjs'] }).scope, 'full');
});

test('Convex function names stay cheap at dogfood scale', () => {
  // ~830 backend modules, ~1,300 tests, a by-name loader reached by 600 of them.
  const extra = {
    'tests/convex-context.mjs': [
      "import { getFunctionName } from 'convex/server';",
      'export const check = async ref => {',
      "  const [file] = getFunctionName(ref).split(':');",
      '  return import(moduleUrl(`../convex/${file}.ts`));',
      '};',
    ].join('\n'),
    'tests/hosted-fixture.mjs': "import './convex-context.mjs';",
  };
  for (let i = 0; i < 830; i++)
    extra[`convex/m${i}.ts`] =
      `${api} export const f = ctx => ctx.runQuery(internal.m${(i + 1) % 830}.f, {}); makeFunctionReference(\`m${i}:\${'f'}\`);`;
  for (let i = 0; i < 1300; i++)
    extra[`tests/t${i}.test.mjs`] =
      `await import(moduleUrl('../convex/m${i % 830}.ts'));${i < 600 ? " import './hosted-fixture.mjs';" : ''}`;
  const files = fixture(extra);
  const before = process.memoryUsage().heapUsed,
    started = performance.now();
  const graph = testImportGraph(files);
  const elapsed = performance.now() - started,
    grown = process.memoryUsage().heapUsed - before;
  assert.equal(graph.error, undefined);
  // The ring of internal references makes every by-name test depend on every module.
  assert.equal(graph.reverse.get('convex/m0.ts').has('tests/t599.test.mjs'), true);
  assert.equal(graph.reverse.get('convex/m0.ts').has('tests/t600.test.mjs'), false);
  assert.ok(elapsed < 30_000, `graph took ${Math.round(elapsed)} ms`);
  assert.ok(grown < 512 * 1024 * 1024, `heap grew ${Math.round(grown / 1e6)} MB`);
});
