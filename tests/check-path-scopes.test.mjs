// SPDX-License-Identifier: Apache-2.0
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readdirSync, readFileSync } from 'node:fs';
import { selectTests, standardSelection } from '../scripts/test-impact.mjs';
import { topLevelFolders } from '../scripts/check-path-scopes.mjs';

const files = new Map(
  Object.entries({
    'src/plugin-config.ts': 'export const config = 1;',
    'web/src/App.tsx': 'export const App = 1;',
    'convex/schema.ts': 'export const schema = 1;',
    'convex/first.ts': 'export const first = 1;',
    'convex/second.ts': 'export const second = 1;',
    'convex/_generated/api.d.ts': 'export declare const api: unknown;',
    'tests/core.test.mjs': "import '../dist/plugin-config.js'",
    'tests/ui-flow.test.mjs': "readFileSync('../web/src/App.tsx')",
    'tests/first.test.mjs': "await import(moduleUrl('../convex/first.ts'))",
    'tests/second.test.mjs': "await import(moduleUrl('../convex/second.ts'))",
    'tests/boundaries.test.mjs': '',
    'tests/unrelated.test.mjs': '',
    'tests/files.test.mjs': '',
    'tests/ci-scope.test.mjs': '',
    'tests/test-impact.test.mjs': '',
    'tests/check-path-scopes.test.mjs': '',
  }),
);
const select = (paths, extra = {}) => selectTests({ files, paths, ...extra });

test('a pinned Markdown-only change reaches the docs path without enabling behavior scoping', () => {
  const docs = standardSelection({ files, paths: ['docs/development.md'], env: {} });
  assert.equal(docs.scope, 'docs');
  assert.deepEqual(docs.tests, []);
  assert.equal(standardSelection({ files, paths: null, env: {} }).scope, 'full');
  for (const paths of [['../docs/hidden.md'], ['docs/development.md', 'package.json']])
    assert.equal(standardSelection({ files, paths, env: {} }).scope, 'full');
  assert.equal(
    standardSelection({ files, paths: ['docs/development.md'], env: { FORGE_CHECK_FULL: '1' } }).scope,
    'full',
  );
});

test('docs/evals and root non-Markdown files require the full suite, including deletions', () => {
  const all = [...files.keys()].filter(path => /^tests\/[^/]+\.test\.mjs$/.test(path)).sort();
  for (const path of [
    'docs/runtime.json',
    'docs/tool.mjs',
    'evals/run.py',
    'package.json',
    'package-lock.json',
    'tsconfig.json',
    '.gitignore',
    '.oxlintrc.json',
    '.oxfmtrc.json',
  ]) {
    const result = select([path]);
    assert.equal(result.scope, 'full', path);
    assert.deepEqual(result.tests, all, path);
  }
  for (const path of ['docs/guide.md', 'README.md']) {
    assert.equal(select([path]).scope, 'docs', path);
    assert.deepEqual(select([path]).tests, [], path);
  }
});

test('Markdown outside code folders selects the code naming it; product code naming it keeps full', () => {
  const tree = new Map([
    ...files,
    ['scripts/bench/env.mjs', "throw new Error('see evals/bench/README.md');"],
    ['scripts/evals.mjs', "read(join('evals/bench/', 'README.md'));"],
    ['scripts/rules.mjs', "path.startsWith('evals/')"],
    ['tests/bench.test.mjs', "import '../scripts/bench/env.mjs';"],
    ['tests/evals.test.mjs', "import '../scripts/evals.mjs';"],
    ['tests/rules.test.mjs', "import '../scripts/rules.mjs';"],
  ]);
  const at = (paths, inventory = tree) => selectTests({ files: inventory, paths });
  // Named by path, or by folder and file name: those scripts' tests run.
  const named = at(['evals/bench/README.md']);
  assert.equal(named.scope, 'scoped', named.reason);
  assert(named.tests.includes('tests/bench.test.mjs'), 'the script naming the file');
  assert(named.tests.includes('tests/evals.test.mjs'), 'the script naming its folder and name');
  // Code that only names a parent folder (a path rule) and unrelated tests stay out.
  assert(!named.tests.includes('tests/rules.test.mjs'));
  assert(!named.tests.includes('tests/core.test.mjs') && !named.tests.includes('tests/first.test.mjs'));
  // Deleted, or named by nothing: still not full (static checks always run).
  assert.equal(at(['notes/old.md']).scope, 'scoped');
  assert.equal(select(['evals/case.md']).scope, 'scoped');
  // Product code or the package manifest naming it may ship or load it: full.
  const product = new Map([...tree, ['src/prompt.ts', "readFileSync('evals/bench/README.md')"]]);
  assert.equal(at(['evals/bench/README.md'], product).scope, 'full');
  const packaged = new Map([...tree, ['package.json', '{"files":["evals/"]}']]);
  assert.equal(at(['evals/bench/README.md'], packaged).scope, 'full');
  // Non-Markdown files there, and .github Markdown, keep their existing rules.
  assert.equal(at(['evals/bench/run.py']).scope, 'full');
  assert.equal(at(['.github/notes.md']).scope, 'full');
});

test('manual QA/browser fixtures, including deletions, select UI regression coverage', () => {
  for (const path of [
    'tests/browser/planning-code.html',
    'tests/fixtures/qa-m-code.tsx',
    'scripts/qa-h-preview.mjs',
  ]) {
    const result = select([path]);
    assert.equal(result.scope, 'scoped', path);
    assert.equal(result.domain, 'web', path);
    assert.ok(result.tests.includes('tests/ui-flow.test.mjs'), path);
    assert.ok(!result.tests.includes('tests/core.test.mjs'), path);
  }
});

test('Convex schema and generated API share backend coverage; a function module selects its graph', () => {
  for (const path of ['convex/schema.ts', 'convex/_generated/api.js']) {
    const result = select([path]);
    assert.equal(result.scope, 'scoped');
    assert.equal(result.domain, 'convex');
    assert.ok(result.tests.includes('tests/first.test.mjs'));
    assert.ok(result.tests.includes('tests/second.test.mjs'));
    assert.ok(!result.tests.includes('tests/core.test.mjs'));
    if (path.includes('_generated')) assert.ok(result.tests.includes('tests/ui-flow.test.mjs'));
  }
  const module = select(['convex/first.ts']);
  assert.equal(module.domain, 'convex');
  assert.ok(module.tests.includes('tests/first.test.mjs'));
  assert.ok(!module.tests.includes('tests/second.test.mjs'));
});

test('core config-named modules stay core; TypeScript/Vite config widens only to its domain', () => {
  for (const path of ['src/plugin-config.ts']) {
    const result = select([path]);
    assert.equal(result.scope, 'scoped');
    assert.equal(result.domain, 'core');
    assert.ok(result.tests.includes('tests/core.test.mjs'));
    assert.ok(!result.tests.includes('tests/first.test.mjs'));
  }
  for (const path of ['web/vite.config.ts', 'web/tsconfig.json', 'web/index.html', 'web/app.html']) {
    const result = select([path]);
    assert.equal(result.domain, 'web');
    assert.ok(result.tests.includes('tests/ui-flow.test.mjs'));
    assert.ok(!result.tests.includes('tests/core.test.mjs'));
  }
});

test('helper/data fixtures follow consuming tests and an orphan still forces full', () => {
  const consumers = new Map([
    ...files,
    ['tests/helper.mjs', 'export const value = 1;'],
    ['tests/fixtures/input.json', '{}'],
    [
      'tests/helper.test.mjs',
      "import './helper.mjs'; readFileSync(new URL('./fixtures/input.json', import.meta.url))",
    ],
  ]);
  for (const path of ['tests/helper.mjs', 'tests/fixtures/input.json']) {
    const result = select([path], { files: consumers });
    assert.equal(result.scope, 'scoped');
    assert.ok(result.tests.includes('tests/helper.test.mjs'));
    assert.ok(!result.tests.includes('tests/core.test.mjs'));
  }
  consumers.set('tests/fixtures/orphan.json', '{}');
  assert.equal(select(['tests/fixtures/orphan.json'], { files: consumers }).scope, 'full');
  assert.equal(select(['src/deleted.ts']).scope, 'full');
  assert.equal(select(['unknown.txt']).scope, 'full');
});

test('a separate changed test cannot disguise a fixture with no consuming test', () => {
  const orphan = new Map([...files, ['tests/fixtures/orphan.json', '{}']]);
  assert.equal(
    select(['tests/fixtures/orphan.json', 'tests/core.test.mjs'], { files: orphan }).scope,
    'full',
  );
});

test('shared test runtime/scheduler changes select every test; mixed domains are explicit', () => {
  for (const path of ['tests/check-runtime.mjs', 'tests/worker-budget.mjs'])
    assert.deepEqual(select([path]).tests, [...files.keys()].filter(p => p.endsWith('.test.mjs')).sort());
  const mixed = select(['src/plugin-config.ts', 'web/src/App.tsx']);
  assert.equal(mixed.domain, 'mixed');
  assert.match(mixed.reason, /core\+web scope/);
});

test('non-source files in a scripts or tests folder select the code beside or naming them', () => {
  const tree = new Map([
    ...files,
    ['scripts/bench/run.mjs', "spawnSync('bash', [join(here, 'oracle.sh')]);"],
    ['scripts/bench/tasks.mjs', 'export const tasks = [];'],
    ['scripts/other.mjs', 'export const other = 1;'],
    ['tests/bench.test.mjs', "import '../scripts/bench/run.mjs';"],
    ['tests/tasks.test.mjs', "import '../scripts/bench/tasks.mjs';"],
    ['tests/other.test.mjs', "import '../scripts/other.mjs';"],
    ['tests/data.test.mjs', "readFileSync(new URL('./fixtures/notes/a.txt', import.meta.url));"],
  ]);
  const at = paths => selectTests({ files: tree, paths });
  const shell = at(['scripts/bench/oracle.sh']);
  assert.equal(shell.scope, 'scoped', shell.reason);
  // Siblings may spawn or walk it; unrelated scripts and their tests stay out.
  assert(shell.tests.includes('tests/bench.test.mjs') && shell.tests.includes('tests/tasks.test.mjs'));
  assert(!shell.tests.includes('tests/other.test.mjs') && !shell.tests.includes('tests/core.test.mjs'));
  const fixture = at(['tests/fixtures/notes/a.txt']);
  assert.equal(fixture.scope, 'scoped');
  assert(fixture.tests.includes('tests/data.test.mjs') && !fixture.tests.includes('tests/bench.test.mjs'));
  // A top-level file, or one named by product code or the package manifest, keeps the full suite.
  assert.equal(at(['scripts/release.sh']).scope, 'full');
  const named = new Map([...tree, ['src/run.ts', "const script = 'scripts/bench/oracle.sh';"]]);
  assert.equal(selectTests({ files: named, paths: ['scripts/bench/oracle.sh'] }).scope, 'full');
  const packaged = new Map([...tree, ['package.json', '{"files":["scripts/bench/"]}']]);
  assert.equal(selectTests({ files: packaged, paths: ['scripts/bench/oracle.sh'] }).scope, 'full');
});

for (const path of [
  'scripts/response-compat/main.json',
  'src/speed-budgets.json',
  'scripts/package-documents/operations/product-analytics.json',
]) {
  test(`JSON reader reach keeps ${path} scoped through a helper`, () => {
    const tree = new Map([
      ...files,
      ['package.json', JSON.stringify({ scripts: { test: 'node --test tests/*.test.mjs' } })],
      [path, '{}'],
      ['scripts/read-data.mjs', `export const data = readFileSync('${path}');`],
      ['src/consumer.ts', "import '../scripts/read-data.mjs';"],
      ['tests/data-reader.test.mjs', "import '../dist/consumer.js';"],
    ]);
    const selected = selectTests({ files: tree, paths: [path] });
    assert.equal(selected.scope, 'scoped', selected.reason);
    assert(selected.tests.includes('tests/data-reader.test.mjs'));
    assert(!selected.tests.includes('tests/core.test.mjs'));
  });
}

test('JSON folder loaders retain nested fixture readers through helpers without selecting unrelated tests', () => {
  const path = 'scripts/package-documents/operations/product-analytics.json';
  const tree = new Map([
    ...files,
    [path, '{}'],
    [
      'scripts/package-documents.mjs',
      "const directory = new URL('./package-documents/', import.meta.url); function walk(path) { for (const entry of readdirSync(path)) walk(entry); } walk(directory);",
    ],
    ['tests/manifest-helper.mjs', "import '../scripts/package-documents.mjs';"],
    ['tests/manifests.test.mjs', "import './manifest-helper.mjs';"],
  ]);
  const selected = selectTests({ files: tree, paths: [path] });
  assert.equal(selected.scope, 'scoped', selected.reason);
  assert(selected.tests.includes('tests/manifests.test.mjs'));
  assert(!selected.tests.includes('tests/core.test.mjs'));
  // Unknown data is never inferred independent from a folder or sibling name.
  tree.set('src/unobserved.json', '{}');
  const unknown = selectTests({ files: tree, paths: ['src/unobserved.json'] });
  assert.equal(unknown.scope, 'full');
  assert.match(unknown.reason, /No known consuming test/);
});

test('JSON asset basename reach does not confuse main.json with hosted-main.json', () => {
  const tree = new Map([
    ...files,
    ['package.json', JSON.stringify({ scripts: { test: 'node --test tests/*.test.mjs' } })],
    ['scripts/contracts/main.json', '{}'],
    ['scripts/contracts/read.mjs', "readFileSync(new URL('./main.json', import.meta.url));"],
    ['tests/contract-data.test.mjs', "import '../scripts/contracts/read.mjs';"],
    ['src/state.ts', "readFileSync('.forge/hosted-main.json');"],
    ['tests/state-data.test.mjs', "import '../dist/state.js';"],
  ]);
  const selected = selectTests({ files: tree, paths: ['scripts/contracts/main.json'] });
  assert.equal(selected.scope, 'scoped');
  assert(selected.tests.includes('tests/contract-data.test.mjs'));
  assert(!selected.tests.includes('tests/state-data.test.mjs'));
});

test('JSON document manifests stop at static check orchestration while their loader tests remain selected', () => {
  const path = 'scripts/package-documents/operations/product-analytics.json';
  const tree = new Map([
    ...files,
    [path, '{}'],
    ['scripts/package-documents.mjs', "export const folder = './package-documents/';"],
    ['scripts/check-documents.mjs', "import './package-documents.mjs';"],
    ['scripts/verify.mjs', "run('node', ['scripts/check-documents.mjs']);"],
    ['tests/manifest-reader.test.mjs', "import '../scripts/package-documents.mjs';"],
    ['tests/verify-fixture.mjs', "import '../scripts/verify.mjs';"],
    ['tests/orchestration.test.mjs', "import './verify-fixture.mjs';"],
  ]);
  const selected = selectTests({ files: tree, paths: [path] });
  assert.equal(selected.scope, 'scoped');
  assert(selected.tests.includes('tests/manifest-reader.test.mjs'));
  assert(!selected.tests.includes('tests/orchestration.test.mjs'));
});

test('JSON read through a build helper does not flow through pure path classification comparisons', () => {
  const path = 'scripts/package-documents/operations/product-analytics.json';
  const tree = new Map([
    ...files,
    [path, '{}'],
    ['scripts/package-documents.mjs', "read(new URL('./package-documents/', import.meta.url));"],
    ['web/vite.config.ts', "import '../scripts/package-documents.mjs';"],
    ['scripts/path-rules.mjs', "export const isConfig = path => ['web/vite.config.ts'].includes(path);"],
    ['tests/classification.test.mjs', "import '../scripts/path-rules.mjs';"],
    ['tests/real-reader.test.mjs', "import '../web/vite.config.ts';"],
  ]);
  tree.set(
    'package.json',
    JSON.stringify({
      scripts: {
        'build:web': 'node web/vite.config.ts',
        build: 'npm run build:web',
        test: 'npm run build',
      },
    }),
  );
  tree.set('tests/check-process.mjs', "spawn('npm', ['test']);");
  tree.set('tests/check-process.test.mjs', "import './check-process.mjs';");
  const selected = selectTests({ files: tree, paths: [path] });
  assert.equal(selected.scope, 'scoped');
  assert(selected.tests.includes('tests/real-reader.test.mjs'));
  assert(!selected.tests.includes('tests/classification.test.mjs'));
  assert(!selected.tests.includes('tests/check-process.test.mjs'));
});

test('JSON imports into a product generator keep full pipeline coverage while static data reads use consumers', () => {
  const tree = new Map([
    ...files,
    [
      'package.json',
      JSON.stringify({ scripts: { build: 'node scripts/generate/build.mjs', test: 'npm run build' } }),
    ],
    ['scripts/generate/input.json', '{}'],
    ['scripts/generate/build.mjs', "readFileSync(new URL('./input.json', import.meta.url));"],
    ['tests/generator.test.mjs', "import '../scripts/generate/build.mjs';"],
  ]);
  const generator = selectTests({ files: tree, paths: ['scripts/generate/input.json'] });
  assert.equal(generator.scope, 'scoped');
  assert(generator.tests.includes('tests/generator.test.mjs'));
  tree.set('scripts/generate/build.mjs', "import './input.json' with { type: 'json' };");
  const imported = selectTests({ files: tree, paths: ['scripts/generate/input.json'] });
  assert.equal(imported.scope, 'full');
  assert.match(imported.reason, /Check pipeline/);
  tree.set('package.json', '{"scripts":{}}');
  tree.set('scripts/generate/build.mjs', "readFileSync(new URL('./input.json', import.meta.url));");
  tree.set('src/consumer.ts', "import '../scripts/generate/input.json' with { type: 'json' };");
  tree.set('tests/runtime-data.test.mjs', "import '../dist/consumer.js';");
  const runtime = selectTests({ files: tree, paths: ['scripts/generate/input.json'] });
  assert.equal(runtime.scope, 'scoped');
  assert(runtime.tests.includes('tests/runtime-data.test.mjs'));
  assert(!runtime.tests.includes('tests/core.test.mjs'));
});

const runtimeJsonTree = reader =>
  new Map([
    ...files,
    ['package.json', '{"scripts":{}}'],
    ['src/policy.json', '{}'],
    ['src/direct-json.ts', "readFileSync('src/policy.json');"],
    ['tests/direct-json.test.mjs', "import '../dist/direct-json.js';"],
    ['tests/readers/indirect.mjs', reader],
    ['tests/indirect-json.test.mjs', "import './readers/indirect.mjs';"],
  ]);
for (const [name, reader] of [
  ['joined single-quoted segments', "readFileSync(join(root, 'src', 'policy.json'));"],
  ['joined double-quoted segments', 'readFileSync(join(root, "src", "policy.json"));'],
  ['variable-first template', 'readFileSync(`${root}/src/policy.json`);'],
  ['bare directory', "readdirSync('src').map(name => readFileSync(join(root,'src',name)));"],
  ['dot directory', "readdirSync('./src').map(name => readFileSync(join(root,'src',name)));"],
  ['aliased directory reader', "import {readdirSync as entries} from 'node:fs'; entries('src').map(read);"],
  [
    'directory function alias',
    "import {readdirSync} from 'node:fs'; const entries=readdirSync; entries('src').map(read);",
  ],
  ['directory method alias', "const entries=fs.readdirSync; entries('src').map(read);"],
  ['arrow directory helper', "const load = folder => readdirSync(folder).map(read); load('src');"],
  ['helper directory reader', "function load(folder) { return readdirSync(folder).map(read); } load('src');"],
  ['fs wildcard', "globSync('src/*.json').map(read);"],
  ['fs glob variable', "const pattern='src/*.json'; globSync(pattern).map(read);"],
  ['fs globstar', "globSync('src/**/*.json').map(read);"],
  ['fs brace glob', "globSync('src/*.{json,txt}').map(read);"],
])
  test(`product JSON retains a second ${name} reader when another importer resolves`, () => {
    const selected = selectTests({ files: runtimeJsonTree(reader), paths: ['src/policy.json'] });
    assert.equal(selected.scope, 'scoped', selected.reason);
    assert(selected.tests.includes('tests/direct-json.test.mjs'));
    assert(
      selected.tests.includes('tests/indirect-json.test.mjs'),
      `${name} must not disappear behind the resolving importer`,
    );
    assert(!selected.tests.includes('tests/core.test.mjs'));
  });
for (const folder of ['convex', 'netlify', 'web/src'])
  test(`JSON basename readers also cover ${folder} data`, () => {
    const path = `${folder}/policy.json`;
    const tree = runtimeJsonTree(`readFileSync(\`${'${root}'}/${path}\`);`);
    tree.delete('src/policy.json');
    tree.set(path, '{}');
    tree.set('src/direct-json.ts', `readFileSync('${path}');`);
    const selected = selectTests({ files: tree, paths: [path] });
    assert.equal(selected.scope, 'scoped', selected.reason);
    assert(selected.tests.includes('tests/indirect-json.test.mjs'));
  });

test('JSON directory comparison and a glob matching another folder do not read its bytes', () => {
  for (const reader of [
    "const isSource = path => ['src'].includes(path);",
    "globSync('other/*.json').map(read);",
  ]) {
    const selected = selectTests({ files: runtimeJsonTree(reader), paths: ['src/policy.json'] });
    assert.equal(selected.scope, 'scoped', selected.reason);
    assert(!selected.tests.includes('tests/indirect-json.test.mjs'));
  }
});

for (const [file, text] of [
  [
    'package.json',
    '{"scripts":{"test":"node --test --experimental-config-file=scripts/runner/node.config.json tests/*.test.mjs"}}',
  ],
  ['package-lock.json', '{"packages":{},"config":"scripts/runner/node.config.json"}'],
  ['scripts/runner/run.sh', 'cat node.config.json'],
  ['.github/workflows/check.yml', 'config: scripts/runner/node.config.json'],
  ['scripts/runner/settings.yaml', 'config: node.config.json'],
])
  test(`scripts JSON named by unparsed ${file} keeps the full suite`, () => {
    const tree = new Map([
      ...files,
      ['package.json', '{"scripts":{}}'],
      ['scripts/runner/node.config.json', '{}'],
      ['scripts/runner/read.mjs', 'export const value=1;'],
      ['tests/config-reader.test.mjs', "import '../scripts/runner/read.mjs';"],
      [file, text],
    ]);
    const selected = selectTests({ files: tree, paths: ['scripts/runner/node.config.json'] });
    assert.equal(selected.scope, 'full', `${file}: ${selected.reason}`);
  });
test('Markdown JSON mentions and a different basename do not force full coverage', () => {
  const tree = new Map([
    ...files,
    ['package.json', '{"scripts":{}}'],
    ['scripts/runner/node.config.json', '{}'],
    ['scripts/runner/read.mjs', 'export const value=1;'],
    ['tests/config-reader.test.mjs', "import '../scripts/runner/read.mjs';"],
    ['docs/config.md', 'Use `scripts/runner/node.config.json`.'],
    ['scripts/other.sh', 'cat hosted-node.config.json'],
  ]);
  assert.equal(selectTests({ files: tree, paths: ['scripts/runner/node.config.json'] }).scope, 'scoped');
});
for (const quote of ['"', '`'])
  test(`scripts JSON directory segments in ${quote} quotes retain their reader`, () => {
    const path = 'scripts/response-compat/main.json';
    const tree = new Map([
      ...files,
      ['package.json', '{"scripts":{}}'],
      [path, '{}'],
      ['scripts/response-compat/read.mjs', 'export const value=1;'],
      ['tests/direct-reader.test.mjs', "import '../scripts/response-compat/read.mjs';"],
      [
        'tests/folder-helper.mjs',
        `const folder=join(root,${quote}scripts${quote},${quote}response-compat${quote}); readdirSync(folder).map(read);`,
      ],
      ['tests/folder-reader.test.mjs', "import './folder-helper.mjs';"],
    ]);
    const selected = selectTests({ files: tree, paths: [path] });
    assert.equal(selected.scope, 'scoped', selected.reason);
    assert(selected.tests.includes('tests/folder-reader.test.mjs'));
  });
for (const path of ['scripts/check-documents.mjs', 'scripts/package-documents.mjs'])
  test(`non-JSON ${path} keeps its verify pipeline coverage`, () => {
    const tree = new Map([
      ...files,
      [
        'package.json',
        JSON.stringify({
          scripts: { verify: 'node scripts/verify.mjs', test: 'node --test tests/*.test.mjs' },
        }),
      ],
      [path, 'export const value=1;'],
      ['scripts/verify.mjs', `run('node',['${path}']);`],
      ['tests/docs-reader.test.mjs', `import '../${path}';`],
    ]);
    const selected = selectTests({ files: tree, paths: [path] });
    assert.equal(selected.scope, 'full', selected.reason);
    assert.match(selected.reason, /pipeline/i);
  });

test('a slash separator in a script path formatter is not a JSON directory read', () => {
  const path = 'scripts/contracts/main.json';
  const tree = new Map([
    ...files,
    ['package.json', '{"scripts":{}}'],
    [path, '{}'],
    ['scripts/contracts/read.mjs', 'export const value=1;'],
    ['tests/data-reader.test.mjs', "import '../scripts/contracts/read.mjs';"],
    ['scripts/build.mjs', "export const format = segments => segments.join('/');"],
    ['tests/formatter.test.mjs', "import '../scripts/build.mjs';"],
  ]);
  const selected = selectTests({ files: tree, paths: [path] });
  assert.equal(selected.scope, 'scoped', selected.reason);
  assert(!selected.tests.includes('tests/formatter.test.mjs'));
});

test('an unparsed non-Markdown product JSON reader also keeps broad coverage', () => {
  const tree = runtimeJsonTree("readFileSync(join(root,'src','policy.json'));");
  tree.set('scripts/read-policy.sh', 'cat src/policy.json');
  assert.equal(selectTests({ files: tree, paths: ['src/policy.json'] }).scope, 'full');
});

for (const [name, reader] of [
  [
    'joined locale names',
    "import { join } from 'node:path'; for (const l of ['en', 'fr']) readFileSync(join(root, 'src', 'locales', `${l}.json`));",
  ],
  ['concatenated locale names', "for (const l of ['en', 'fr']) readFileSync('src/locales/' + l + '.json');"],
  [
    'aliased computed paths passed to a loader',
    "import { join } from 'node:path'; const file = join(root, 'src/locales', name + '.json'); loadJson(file);",
  ],
  [
    'namespace path joins',
    "import path from 'node:path'; readFileSync(path.join(root, 'src/locales', name + '.json'));",
  ],
])
  test(`computed JSON reader reach retains ${name} beside a resolving importer`, () => {
    const tree = new Map([
      ...files,
      ['package.json', '{"scripts":{}}'],
      ['src/locales/en.json', '{"greeting":"hello"}'],
      ['src/locales/fr.json', '{}'],
      ['src/i18n.ts', "import en from './locales/en.json' with { type: 'json' }; export const locale = en;"],
      ['tests/i18n.test.mjs', "import '../dist/i18n.js';"],
      ['tests/helpers/locale-reader.mjs', reader],
      ['tests/locale-parity.test.mjs', "import './helpers/locale-reader.mjs';"],
    ]);
    const selected = selectTests({ files: tree, paths: ['src/locales/en.json'] });
    assert.equal(selected.scope, 'scoped', selected.reason);
    assert(selected.tests.includes('tests/i18n.test.mjs'));
    assert(selected.tests.includes('tests/locale-parity.test.mjs'), name);
    assert(!selected.tests.includes('tests/unrelated.test.mjs'));
  });

test('JSON reach stops at a static JS-only walker through a runtime folder edge', () => {
  const tree = new Map([
    ...files,
    [
      'package.json',
      JSON.stringify({
        scripts: {
          lint: 'node scripts/walker.mjs',
          test: 'node --test tests/*.test.mjs',
          verify: 'npm run lint && npm test',
        },
      }),
    ],
    ['scripts/data/value.json', '{}'],
    ['scripts/read-value.mjs', "readFileSync('scripts/data/value.json');"],
    [
      'scripts/walker.mjs',
      "import { readdirSync } from 'node:fs'; function walk(dir) { return readdirSync(dir, { recursive: true }).filter(name => name.endsWith('.js')); } walk('.');",
    ],
    ['tests/value.test.mjs', "import '../scripts/read-value.mjs';"],
    ['tests/walker.test.mjs', "import '../scripts/walker.mjs';"],
  ]);
  const selected = selectTests({ files: tree, paths: ['scripts/data/value.json'] });
  assert.equal(selected.scope, 'scoped', selected.reason);
  assert(selected.tests.includes('tests/value.test.mjs'));
  assert(!selected.tests.includes('tests/walker.test.mjs'));
  assert(!selected.tests.includes('tests/unrelated.test.mjs'));
  tree.set('scripts/walker.mjs', "import value from './data/value.json' with { type: 'json' };");
  assert.equal(
    selectTests({ files: tree, paths: ['scripts/data/value.json'] }).scope,
    'full',
    'an actual JSON import into a static tool retains pipeline reach',
  );
});

test('computed roots and matching expressions do not read every JSON in a folder', () => {
  for (const reader of [
    "const pattern = new RegExp('src/' + name); pattern.test(candidate);",
    "import { join } from 'node:path'; readFileSync(join(root, 'src', 'not-json.txt'));",
  ]) {
    const tree = runtimeJsonTree(reader);
    const selected = selectTests({ files: tree, paths: ['src/policy.json'] });
    assert.equal(selected.scope, 'scoped');
    assert(selected.tests.includes('tests/direct-json.test.mjs'));
    assert(!selected.tests.includes('tests/indirect-json.test.mjs'));
  }
});

test('every top-level folder of this repository has a classification (5dcfce75)', () => {
  const root = new URL('..', import.meta.url);
  // Ignored top-level folders (`name/` lines) are build output or local state, never a change path.
  const ignored = new Set(
    readFileSync(new URL('.gitignore', root), 'utf8')
      .split('\n')
      .map(line => /^([^/*!#\s]+)\/$/.exec(line.trim())?.[1])
      .filter(Boolean),
  );
  const folders = readdirSync(root, { withFileTypes: true })
    .filter(entry => entry.isDirectory() && entry.name !== '.git' && !ignored.has(entry.name))
    .map(entry => entry.name);
  const missing = folders.filter(name => !Object.hasOwn(topLevelFolders, name));
  assert.deepEqual(missing, [], 'list each new folder in topLevelFolders, scripts/check-path-scopes.mjs');
  // A path in an unlisted folder keeps the full suite, and the receipt names the folder.
  const unknown = select(['newfolder/data.bin']);
  assert.equal(unknown.scope, 'full');
  assert.match(unknown.reason, /Unclassified top-level folder newfolder\/ \(list it in topLevelFolders/);
  assert.match(select(['docs/diagram.png']).reason, /^Unclassified or deleted path: docs\/diagram\.png/);
});
