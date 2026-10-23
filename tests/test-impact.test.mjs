// SPDX-License-Identifier: Apache-2.0
import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  selectTests,
  pinnedPaths,
  pinnedComparison,
  standardSelection,
  sourceFiles,
} from '../scripts/test-impact.mjs';
import { mkdtempSync, writeFileSync, rmSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
const files = new Map(
  Object.entries({
    'src/leaf.ts': 'export const leaf = 1',
    'src/middle.ts': "export { leaf } from './leaf.js'",
    'src/cli.ts': "import './middle.js'",
    'web/src/Leaf.tsx': 'export default 1',
    'web/src/App.tsx': "import Leaf from './Leaf'",
    'tests/leaf.test.mjs': "import '../dist/middle.js'",
    'tests/cli.test.mjs': "const cli = new URL('../dist/cli.js', import.meta.url)",
    'tests/web.test.mjs': "const text = readFileSync(new URL('../web/src/App.tsx', import.meta.url))",
    'tests/unrelated.test.mjs': 'export default 0',
    'tests/ci-scope.test.mjs': '',
    'tests/test-impact.test.mjs': '',
  }),
);
const select = (paths, extra = {}) => selectTests({ paths, files, ...extra });
test('src maps dist and includes transitive importers, CLI runtime paths and smoke', () => {
  assert.deepEqual(select(['src/leaf.ts']).tests, [
    'tests/ci-scope.test.mjs',
    'tests/cli.test.mjs',
    'tests/leaf.test.mjs',
    'tests/test-impact.test.mjs',
  ]);
});
test('web extensionless imports and source reads select web tests, independently of src', () => {
  assert.deepEqual(select(['web/src/Leaf.tsx']).tests, [
    'tests/ci-scope.test.mjs',
    'tests/test-impact.test.mjs',
    'tests/web.test.mjs',
  ]);
});
test('all Markdown including packaged docs and root documents uses docs checks', () => {
  assert.equal(select(['README.md', 'docs/concepts.md']).scope, 'docs');
  assert.deepEqual(select(['docs/concepts.md']).tests, []);
});
test('uncertain comparisons, infrastructure, helpers, schema, deletions and unknown files run full', () => {
  for (const paths of [
    null,
    [],
    ['../oops'],
    ['package.json'],
    ['package-lock.json'],
    ['scripts/verify.mjs'],
    ['tests/helpers.mjs'],
    ['tests/fixtures/file.ts'],
    ['tests/fixtures/example.test.mjs'],
    ['convex/schema.ts'],
    ['src/deleted.ts'],
    ['unknown.txt'],
    ['docs/example.js'],
  ]) {
    assert.equal(
      select(paths, { files: new Map([...files, ['tests/fixtures/example.test.mjs', '']]) }).scope,
      'full',
      JSON.stringify(paths),
    );
  }
  assert.equal(select(['docs/concepts.md'], { forceFull: true }).scope, 'full');
});
test('changed tests select themselves; mixed docs and code select affected code', () => {
  assert.ok(select(['tests/unrelated.test.mjs']).tests.includes('tests/unrelated.test.mjs'));
  assert.equal(select(['docs/concepts.md', 'src/leaf.ts']).scope, 'scoped');
});
test('computed module domains widen; unknown dynamic imports conservatively include their test', () => {
  const dynamic = new Map([
    ...files,
    ['tests/dynamic.test.mjs', 'await import(variable)'],
    ['tests/alias.test.mjs', 'await import("@local/leaf")'],
    ['tests/joined.test.mjs', "await import(pathToFileURL(join(root, 'dist', name + '.js')).href)"],
    ['tests/domain.test.mjs', 'await import(moduleUrl(`../web/src/${name}.tsx`))'],
  ]);
  const src = select(['src/leaf.ts'], { files: dynamic });
  assert.ok(src.tests.includes('tests/dynamic.test.mjs'));
  assert.ok(src.tests.includes('tests/alias.test.mjs'));
  assert.ok(src.tests.includes('tests/joined.test.mjs'));
  assert.ok(!src.tests.includes('tests/domain.test.mjs'));
  const web = select(['web/src/Leaf.tsx'], { files: dynamic });
  assert.ok(web.tests.includes('tests/domain.test.mjs'));
  assert.ok(!web.tests.includes('tests/joined.test.mjs'));
});
test('pins must match the runner inputs; malformed and absent manifests fall back', t => {
  const root = mkdtempSync(join(tmpdir(), 'forge-impact-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const path = join(root, 'changes.json');
  const base = 'a'.repeat(64),
    head = 'b'.repeat(64);
  const env = { FORGE_CHECK_CHANGES: path, FORGE_CHECK_BASE: base, FORGE_CHECK_HEAD: head };
  assert.equal(pinnedPaths(env), null);
  writeFileSync(path, JSON.stringify({ version: 1, comparison: 'main', base, head, paths: ['src/leaf.ts'] }));
  assert.deepEqual(pinnedPaths(env), ['src/leaf.ts']);
  writeFileSync(
    path,
    JSON.stringify({ version: 1, comparison: 'main', base, head, paths: [], mainCheck: { channel: 'main' } }),
  );
  assert.deepEqual(pinnedComparison(env).mainCheck, { channel: 'main' });
  assert.equal(pinnedPaths({ ...env, FORGE_CHECK_HEAD: base }), null);
  writeFileSync(
    path,
    JSON.stringify({ version: 1, comparison: 'view-base', base, head, paths: ['src/leaf.ts'] }),
  );
  assert.equal(pinnedPaths(env), null);
  writeFileSync(path, '{');
  assert.equal(pinnedPaths(env), null);
});

test('scoping is OFF by default; explicit full takes precedence over enable', () => {
  assert.equal(standardSelection({ paths: ['src/leaf.ts'], files, env: {} }).scope, 'full');
  assert.equal(
    standardSelection({ paths: ['src/leaf.ts'], files, env: { FORGE_CHECK_SCOPED: '1' } }).scope,
    'scoped',
  );
  assert.equal(
    standardSelection({
      paths: ['docs/concepts.md'],
      files,
      env: { FORGE_CHECK_SCOPED: '1', FORGE_CHECK_FULL: '1' },
    }).scope,
    'full',
  );
});
test('unresolved aliases are unknown coverage and force full', () => {
  const aliased = new Map([...files, ['src/alias.ts', "import leaf from '@local/leaf'"]]);
  assert.equal(select(['src/leaf.ts'], { files: aliased }).scope, 'full');
});

test('generated declaration imports stay in typechecks and JavaScript specifiers resolve TS outside src', () => {
  const generated = new Map([
    ...files,
    ['convex/schema.ts', 'export const schema = 1'],
    ['convex/_generated/types.d.ts', "import type schema from '../schema.js'"],
    ['web/src/schema.ts', "export { schema } from '../../convex/schema.js'"],
    ['tests/declarations.test.mjs', "readFileSync('../dist/leaf.d.ts')"],
  ]);
  assert.equal(select(['web/src/Leaf.tsx'], { files: generated }).scope, 'scoped');
  assert.ok(select(['src/leaf.ts'], { files: generated }).tests.includes('tests/declarations.test.mjs'));
});

test('erased type re-export hubs do not fan out to their runtime consumers', () => {
  for (const declaration of [
    "export type { Value } from './leaf.js'",
    "export type * from './leaf.js'",
    "export type * as Types from './leaf.js'",
    "import type Leaf = require('./leaf.js')",
  ]) {
    const fixture = new Map([
      ...files,
      ['src/type-hub.ts', `${declaration}; export const stable = 1;`],
      ['tests/hub.test.mjs', "import { stable } from '../dist/type-hub.js'"],
      ['tests/source.test.mjs', "readFileSync('../src/leaf.ts')"],
    ]);
    const result = select(['src/leaf.ts'], { files: fixture });
    assert.equal(result.scope, 'scoped');
    assert.ok(!result.tests.includes('tests/hub.test.mjs'), declaration);
    assert.ok(result.tests.includes('tests/leaf.test.mjs'));
    assert.ok(result.tests.includes('tests/source.test.mjs'));
  }
});

test('type syntax source strings and loader-shaped expressions do not create runtime edges', () => {
  for (const declaration of [
    "export type Source = '../dist/leaf.js'",
    "export interface Source { '../dist/leaf.js': string }",
    "export type Source = typeof import('../dist/leaf.js')",
    "export type Source = { path: '../dist/leaf.js' }; export const value = (x: Source) => x",
    "export const value = (x: '../dist/leaf.js') => x",
    "export const value = 1 as unknown as '../dist/leaf.js'",
    "export const value = '' satisfies '../dist/leaf.js'",
  ]) {
    const fixture = new Map([
      ...files,
      ['src/types.ts', declaration],
      ['tests/types.test.mjs', "import '../dist/types.js'"],
    ]);
    assert.ok(
      !select(['src/leaf.ts'], { files: fixture }).tests.includes('tests/types.test.mjs'),
      declaration,
    );
  }
});

test('runtime class heritage and expressions next to type annotations retain coverage', () => {
  for (const declaration of [
    "export class Derived extends load('../dist/leaf.js') {}",
    "export class Derived extends (await import('../dist/leaf.js')).Base<string> {}",
    "export const value = readFileSync('../dist/leaf.js') as string",
    "export const value = readFileSync('../dist/leaf.js') satisfies string",
    "export class Value { ['../dist/leaf.js'] = 1 }",
  ]) {
    const fixture = new Map([
      ...files,
      ['src/runtime.ts', declaration],
      ['tests/runtime.test.mjs', "import '../dist/runtime.js'"],
    ]);
    assert.ok(
      select(['src/leaf.ts'], { files: fixture }).tests.includes('tests/runtime.test.mjs'),
      declaration,
    );
  }
});

test('value, side-effect and inline-type import/export shells remain conservative', () => {
  for (const declaration of [
    "import './leaf.js'",
    "import { type Value } from './leaf.js'",
    "export { type Value } from './leaf.js'",
    "export { leaf as other } from './leaf.js'",
    "export * from './leaf.js'",
    "export * as values from './leaf.js'",
    "import type { Value } from './leaf.js'; import './leaf.js'",
    "export type { Value } from './leaf.js'; export * from './leaf.js'",
  ]) {
    const fixture = new Map([
      ...files,
      ['src/hub.ts', declaration],
      ['tests/hub.test.mjs', "import '../dist/hub.js'"],
    ]);
    assert.ok(select(['src/leaf.ts'], { files: fixture }).tests.includes('tests/hub.test.mjs'), declaration);
  }
});

test('unknown erased type dependencies stay in static checks; unresolved values still force full', () => {
  for (const declaration of [
    "export type { Missing } from '@local/missing'",
    "export type * from './missing.js'",
    "import type Missing = require('@local/missing')",
    "export type Missing = typeof import('@local/missing')",
  ]) {
    const fixture = new Map([...files, ['src/types.ts', declaration]]);
    assert.equal(select(['src/leaf.ts'], { files: fixture }).scope, 'scoped', declaration);
  }
  const fixture = new Map([...files, ['src/types.ts', "export { Missing } from '@local/missing'"]]);
  assert.equal(select(['src/leaf.ts'], { files: fixture }).scope, 'full');
});

test('core ignore and cleanup directory names do not imply runtime module dependencies', () => {
  const ignored = new Map([
    ...files,
    ['src/exclusions.ts', "const excluded = ['dist']; export const ignore = x => excluded.includes(x)"],
    ['tests/exclusions.test.mjs', "import '../dist/exclusions.js'"],
    ['tests/enumeration.test.mjs', "readdirSync(new URL('../dist', import.meta.url))"],
  ]);
  const selected = select(['src/leaf.ts'], { files: ignored });
  assert.ok(!selected.tests.includes('tests/exclusions.test.mjs'));
  assert.ok(selected.tests.includes('tests/enumeration.test.mjs'));
});

test('pinned main-audit role forces full even for docs, code and zero-diff manual reruns', () => {
  for (const paths of [[], ['docs/concepts.md'], ['src/leaf.ts']]) {
    const result = standardSelection({
      paths,
      files,
      mainCheck: { channel: 'main' },
      env: { FORGE_CHECK_SCOPED: '1' },
    });
    assert.equal(result.scope, 'full');
    assert.match(result.reason, /Pinned main audit View/);
  }
});

test('local and workspace package aliases conservatively run full', () => {
  for (const dependency of [
    { link: true, resolved: 'src/local' },
    { resolved: 'file:../local' },
    { resolved: '../local' },
    { resolved: '/local' },
    { resolved: 'workspace:*' },
  ]) {
    const linked = new Map([
      ...files,
      ['package-lock.json', JSON.stringify({ packages: { '': {}, 'node_modules/local': dependency } })],
    ]);
    const result = select(['src/leaf.ts'], { files: linked });
    assert.equal(result.scope, 'full');
    assert.match(result.reason, /Local or workspace package/);
  }
});

const interaction = (lanePaths, mainPaths, extra = {}) => ({
  version: 1,
  reusedRunId: '11111111-1111-4111-8111-111111111111',
  mainRunId: '22222222-2222-4222-8222-222222222222',
  base: 'a'.repeat(64),
  checkedHead: 'b'.repeat(64),
  main: 'c'.repeat(64),
  mergedHead: 'd'.repeat(64),
  eligible: true,
  reason: 'fixture',
  lanePaths: lanePaths.sort(),
  mainPaths: mainPaths.sort(),
  overlap: [
    ...new Set(
      [...lanePaths, ...mainPaths].filter(path =>
        lanePaths.some(a =>
          mainPaths.some(
            b => (a === b || a.startsWith(`${b}/`) || b.startsWith(`${a}/`)) && (path === a || path === b),
          ),
        ),
      ),
    ),
  ].sort(),
  ...extra,
});
const interact = (pins, extra = {}) =>
  standardSelection({ files, interaction: pins, env: { FORGE_CHECK_SCOPED: '1' }, ...extra });
test('interaction docs overlap runs no behavior files even with classified code on both sides', () => {
  const result = interact(
    interaction(['src/leaf.ts', 'docs/status.md'], ['web/src/Leaf.tsx', 'docs/status.md']),
  );
  assert.equal(result.scope, 'docs');
  assert.deepEqual(result.tests, []);
});
test('interaction intersects impacted sets, adds code overlap and smoke', () => {
  const result = interact(
    interaction(['src/leaf.ts', 'web/src/Leaf.tsx'], ['src/middle.ts', 'web/src/Leaf.tsx']),
  );
  assert.equal(result.scope, 'interaction');
  assert.deepEqual(result.tests, [
    'tests/ci-scope.test.mjs',
    'tests/cli.test.mjs',
    'tests/leaf.test.mjs',
    'tests/test-impact.test.mjs',
    'tests/web.test.mjs',
  ]);
});
test('interaction missing, malformed, ineligible, deleted and tooling pins fail full', () => {
  const good = interaction(['src/leaf.ts'], ['src/middle.ts']);
  for (const pins of [
    null,
    {},
    { ...good, mainRunId: undefined },
    { ...good, overlap: ['docs/status.md'] },
    interaction(['src/deleted.ts'], ['src/leaf.ts']),
    interaction(['docs/status.md', 'package.json'], ['docs/status.md']),
    interaction(['docs/status.md'], ['docs/status.md', 'scripts/verify.mjs']),
    interaction(['src/leaf.ts'], ['src/leaf.ts/nested.ts']),
  ])
    assert.equal(interact(pins).scope, 'full', JSON.stringify(pins));
  assert.equal(
    standardSelection({
      paths: ['docs/status.md'],
      files,
      env: { FORGE_CHECK_SCOPED: '1', FORGE_CHECK_INTERACTION: '1' },
    }).scope,
    'full',
  );
  for (const extra of [
    { env: {} },
    { env: { FORGE_CHECK_SCOPED: '1', FORGE_CHECK_FULL: '1' } },
    { mainCheck: { channel: 'main' } },
  ])
    assert.equal(interact(good, extra).scope, 'full');
});
test('malformed interaction envelope never becomes an ordinary scoped comparison', t => {
  const root = mkdtempSync(join(tmpdir(), 'forge-interaction-pins-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const path = join(root, 'changes.json'),
    pins = interaction(['src/leaf.ts'], ['src/middle.ts']);
  const input = {
    version: 1,
    comparison: 'main',
    base: pins.main,
    head: pins.mergedHead,
    paths: ['src/leaf.ts'],
    interaction: pins,
  };
  const env = { FORGE_CHECK_CHANGES: path, FORGE_CHECK_BASE: input.base, FORGE_CHECK_HEAD: input.head };
  writeFileSync(path, JSON.stringify(input));
  assert.deepEqual(pinnedComparison(env).interaction, pins);
  for (const patch of [
    { main: pins.base },
    { mergedHead: pins.checkedHead },
    { lanePaths: ['../escape'] },
    { reusedRunId: null },
  ]) {
    writeFileSync(path, JSON.stringify({ ...input, interaction: { ...pins, ...patch } }));
    assert.equal(pinnedComparison(env), null);
  }
});

test('valid ineligible interaction uses ordinary merged comparison selection only with scoped ON', () => {
  const pins = interaction(['src/leaf.ts'], ['src/middle.ts'], {
    eligible: false,
    mainRunId: undefined,
    reason: 'No exact passing full coverage of pinned main',
  });
  const paths = ['src/leaf.ts'];
  const result = interact(pins, { paths });
  const ordinary = standardSelection({ paths, files, env: { FORGE_CHECK_SCOPED: '1' } });
  assert.equal(result.scope, ordinary.scope);
  assert.deepEqual(result.tests, ordinary.tests);
  assert.match(result.reason, /Interaction ineligible: No exact passing full coverage/);
  for (const extra of [
    { env: {} },
    { env: { FORGE_CHECK_SCOPED: '1', FORGE_CHECK_FULL: '1' } },
    { mainCheck: { channel: 'main' } },
  ])
    assert.equal(interact(pins, { paths, ...extra }).scope, 'full');
});

test('docs overlap basis needs no main run but complete sides must still classify non-full', () => {
  const pins = interaction(['src/leaf.ts', 'docs/status.md'], ['web/src/Leaf.tsx', 'docs/status.md'], {
    basis: 'docs-overlap',
    mainRunId: undefined,
  });
  assert.equal(interact(pins).scope, 'docs');
  assert.deepEqual(interact(pins).tests, []);
  assert.equal(interact({ ...pins, basis: 'main-full-coverage' }).scope, 'full');
  assert.equal(
    interact(
      interaction(['package.json', 'docs/status.md'], ['docs/status.md'], {
        basis: 'docs-overlap',
        mainRunId: undefined,
      }),
    ).scope,
    'full',
  );
  assert.equal(
    interact(
      interaction(['src/leaf.ts'], ['src/leaf.ts'], {
        basis: 'docs-overlap',
        mainRunId: undefined,
      }),
    ).scope,
    'full',
  );
});

const scriptFiles = () =>
  new Map([
    ...files,
    ...['tests/files.test.mjs', 'tests/check-path-scopes.test.mjs'].map(path => [path, '']),
    [
      'package.json',
      JSON.stringify({
        scripts: {
          verify: 'node scripts/runner.mjs',
          test: 'npm run build && node --test tests/*.test.mjs',
          build: 'tsc',
          'check:fixture': 'node scripts/checker.mjs',
          measure: 'node scripts/measure.mjs',
          indirect: 'npm run measure',
        },
      }),
    ],
    ['scripts/runner.mjs', "import './runner-helper.js'"],
    ['scripts/runner-helper.js', 'export const run = 1;'],
    ['scripts/checker.mjs', 'export const check = 1;'],
    ['scripts/measure.mjs', 'export const measure = 1;'],
  ]);
const scriptSelect = (path, fixture = scriptFiles()) => selectTests({ paths: [path], files: fixture });

test('new scripts follow transitive importing and literal spawning tests plus smoke', () => {
  for (const extension of ['mjs', 'js', 'ts']) {
    const fixture = scriptFiles();
    fixture.set(`scripts/added.${extension}`, 'export const added = 1;');
    fixture.set('tests/script-helper.mjs', `export * from '../scripts/added.${extension}'`);
    fixture.set('tests/importing.test.mjs', "import './script-helper.mjs'");
    fixture.set('tests/spawning.test.mjs', `spawn(process.execPath, ['scripts/added.${extension}'])`);
    fixture.set('tests/command.test.mjs', `exec('node scripts/added.${extension} --json')`);
    const result = scriptSelect(`scripts/added.${extension}`, fixture);
    assert.equal(result.scope, 'scoped');
    assert.equal(result.domain, 'scripts');
    assert.deepEqual(result.tests, [
      'tests/check-path-scopes.test.mjs',
      'tests/ci-scope.test.mjs',
      'tests/command.test.mjs',
      'tests/files.test.mjs',
      'tests/importing.test.mjs',
      'tests/spawning.test.mjs',
      'tests/test-impact.test.mjs',
    ]);
    assert.match(result.reason, /3 importing\/runtime\/package-command test/);
  }
});
test('standalone new scripts select smoke and exact basename tests without unrelated coverage', () => {
  const fixture = scriptFiles();
  fixture.set('scripts/standalone.mjs', 'console.log(1)');
  assert.deepEqual(scriptSelect('scripts/standalone.mjs', fixture).tests, [
    'tests/check-path-scopes.test.mjs',
    'tests/ci-scope.test.mjs',
    'tests/files.test.mjs',
    'tests/test-impact.test.mjs',
  ]);
  fixture.set('tests/standalone.test.mjs', 'assert.ok(true)');
  const result = scriptSelect('scripts/standalone.mjs', fixture);
  assert.ok(result.tests.includes('tests/standalone.test.mjs'));
  assert.match(result.reason, /no importing tests; static checks and smoke; basename test coverage/);
});
test('package script references include command consumers through aliases and literal arguments', () => {
  const fixture = scriptFiles();
  fixture.set('tests/command.test.mjs', "exec('npm run indirect')");
  fixture.set('tests/arguments.test.mjs', "execFile('npm', ['run', 'measure'])");
  const result = scriptSelect('scripts/measure.mjs', fixture);
  assert.equal(result.scope, 'scoped');
  assert.ok(result.tests.includes('tests/command.test.mjs'));
  assert.ok(result.tests.includes('tests/arguments.test.mjs'));
  assert.ok(!result.tests.includes('tests/unrelated.test.mjs'));
});
test('runner import dependencies, check entrypoints, packaging, builds and lifecycle commands stay full', () => {
  const fixture = scriptFiles();
  for (const path of [
    'scripts/forge-check.mjs',
    'scripts/test-impact.mjs',
    'scripts/check-path-scopes.mjs',
    'scripts/package-fixture.mjs',
    'scripts/build-fixture.mjs',
  ])
    fixture.set(path, 'export const value = 1;');
  fixture.set('scripts/package-helper.ts', 'export const value = 1;');
  fixture.set('scripts/package-fixture.mjs', "import './package-helper.js'");
  fixture.set('scripts/preflight.mjs', 'export const value = 1;');
  const manifest = JSON.parse(fixture.get('package.json'));
  manifest.scripts.preverify = 'node scripts/preflight.mjs';
  fixture.set('package.json', JSON.stringify(manifest));
  for (const path of [
    'scripts/forge-check.mjs',
    'scripts/test-impact.mjs',
    'scripts/check-path-scopes.mjs',
    'scripts/package-helper.ts',
    'scripts/build-fixture.mjs',
    'scripts/runner-helper.js',
    'scripts/checker.mjs',
    'scripts/preflight.mjs',
  ]) {
    const result = scriptSelect(path, fixture);
    assert.equal(result.scope, 'full', path);
    assert.match(result.reason, /Check pipeline, packaging or build dependency/);
  }
});
test('script deletion, malformed syntax/package metadata and unresolved pipeline references fail full', () => {
  for (const patch of [
    ['scripts/measure.mjs', 'export const = ;'],
    ['scripts/measure.mjs', 'await import(variable)'],
    ['scripts/measure.mjs', "await import('./missing.mjs')"],
    ['package.json', '{'],
    ['package.json', JSON.stringify({ scripts: { verify: 'node scripts/missing.mjs' } })],
    ['package.json', JSON.stringify({ scripts: { verify: 'npm run missing' } })],
    ['package.json', JSON.stringify({ scripts: { verify: 'npm --prefix other run measure' } })],
    ['package.json', JSON.stringify({ scripts: { verify: 'node scripts/${name}.mjs' } })],
  ]) {
    const fixture = scriptFiles();
    fixture.set(...patch);
    assert.equal(scriptSelect('scripts/measure.mjs', fixture).scope, 'full', JSON.stringify(patch));
  }
  assert.equal(scriptSelect('scripts/deleted.mjs').scope, 'full');
  const fixture = scriptFiles();
  fixture.delete('package.json');
  assert.equal(scriptSelect('scripts/measure.mjs', fixture).scope, 'full');
});
test('a script used by product code keeps full coverage', () => {
  const fixture = scriptFiles();
  fixture.set('src/runtime.ts', "import '../scripts/measure.mjs'");
  assert.match(scriptSelect('scripts/measure.mjs', fixture).reason, /Product runtime dependency/);
});

test('forge-check dependencies and build config importers require full selection', () => {
  for (const [entrypoint, manifest] of [
    ['scripts/forge-check.mjs', { scripts: {} }],
    [
      'tests/check-runtime.mjs',
      { scripts: { test: 'node --import ./tests/check-runtime.mjs --test tests/*.test.mjs' } },
    ],
    ['web/vite.config.ts', { scripts: { 'build:web': 'vite build --config web/vite.config.ts' } }],
  ]) {
    const fixture = scriptFiles();
    fixture.set('package.json', JSON.stringify(manifest));
    fixture.set(entrypoint, "import '../scripts/measure.mjs'");
    // The root script imports from its own directory.
    if (entrypoint.startsWith('scripts/')) fixture.set(entrypoint, "import './measure.mjs'");
    assert.match(
      scriptSelect('scripts/measure.mjs', fixture).reason,
      /Check pipeline, packaging or build dependency/,
    );
  }
});

test('source inventory includes package commands for script selection', t => {
  const root = mkdtempSync(join(tmpdir(), 'forge-script-inventory-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  for (const dir of ['src', 'web', 'convex', 'netlify', 'tests', 'scripts']) mkdirSync(join(root, dir));
  writeFileSync(
    join(root, 'package.json'),
    JSON.stringify({ scripts: { inspect: 'node scripts/inspect.mjs' } }),
  );
  writeFileSync(join(root, 'package-lock.json'), JSON.stringify({ packages: {} }));
  writeFileSync(join(root, 'scripts/inspect.mjs'), 'export const value = 1;');
  writeFileSync(join(root, 'tests/consumer.test.mjs'), "exec('npm run inspect')");
  const inventory = sourceFiles(root);
  assert.ok(inventory.has('package.json'));
  assert.deepEqual(selectTests({ paths: ['scripts/inspect.mjs'], files: inventory }).tests, [
    'tests/consumer.test.mjs',
  ]);
});

test('computed script domains include their tests and keep runner dependencies full', () => {
  const fixture = scriptFiles();
  fixture.set('tests/computed.test.mjs', 'await import(`../scripts/${name}.mjs`)');
  assert.ok(scriptSelect('scripts/measure.mjs', fixture).tests.includes('tests/computed.test.mjs'));
  fixture.set('scripts/forge-check.mjs', 'await import(`./${name}.mjs`)');
  assert.equal(scriptSelect('scripts/measure.mjs', fixture).scope, 'full');
  const build = scriptFiles();
  build.set('scripts/build.mjs', 'export const build = 1;');
  assert.equal(scriptSelect('scripts/build.mjs', build).scope, 'full');
});

test('script domain labels and inventory directory names are not runtime dependencies', () => {
  const fixture = scriptFiles();
  fixture.set('scripts/check-path-scopes.mjs', "export const domain = 'scripts';");
  fixture.set('scripts/test-impact.mjs', "const directories = ['src', 'tests', 'scripts'];");
  const result = scriptSelect('scripts/measure.mjs', fixture);
  assert.equal(result.scope, 'scoped');
  assert.ok(!result.tests.includes('tests/unrelated.test.mjs'));
});

test('runner test lists do not turn a script consumer into a pipeline dependency', () => {
  const fixture = scriptFiles();
  fixture.set('tests/consumer.test.mjs', "import '../scripts/measure.mjs'");
  fixture.set('scripts/test-impact.mjs', "export const smoke = ['tests/consumer.test.mjs'];");
  const manifest = JSON.parse(fixture.get('package.json'));
  manifest.scripts.test = 'node --test tests/consumer.test.mjs';
  fixture.set('package.json', JSON.stringify(manifest));
  const result = scriptSelect('scripts/measure.mjs', fixture);
  assert.equal(result.scope, 'scoped');
  assert.ok(result.tests.includes('tests/consumer.test.mjs'));
  assert.ok(!result.tests.includes('tests/unrelated.test.mjs'));
});

test('npm aliases with short flags retain pipeline dependencies', () => {
  const fixture = scriptFiles();
  const manifest = JSON.parse(fixture.get('package.json'));
  manifest.scripts.verify = 'npm run -s indirect';
  fixture.set('package.json', JSON.stringify(manifest));
  assert.match(
    scriptSelect('scripts/measure.mjs', fixture).reason,
    /Check pipeline, packaging or build dependency/,
  );
});

const narrowFiles = (extra = {}) =>
  new Map([
    ...scriptFiles(),
    ['scripts/package-documents.mjs', 'export const packageDocuments = 1;'],
    ['scripts/check-documents.mjs', "import { packageDocuments } from './package-documents.mjs';"],
    ['scripts/check-documentation.mjs', "spawn('scripts/check-documents.mjs');"],
    ['scripts/forge-check.mjs', "import './check-documentation.mjs';"],
    ['scripts/package-local.mjs', 'export const local = 1;'],
    ['tests/interaction-static.test.mjs', "import '../scripts/check-documentation.mjs'"],
    ['tests/packaged-scripts.test.mjs', ''],
    ['tests/selfhost-notices.test.mjs', ''],
    ['convex/_generated/api.js', 'export const api = 1;'],
    ['convex/_generated/api.d.ts', 'export declare const api: number;'],
    ['convex/_generated/dataModel.d.ts', 'export type Id = string;'],
    ['convex/users.ts', "import { api } from './_generated/api.js'"],
    ['convex/other.ts', 'export const other = 1;'],
    ['tests/users.test.mjs', "import '../convex/users.ts'"],
    ['tests/other.test.mjs', "import '../convex/other.ts'"],
    ['scripts/thing.mjs', 'export const thing = 1;'],
    ['scripts/thing.d.mts', 'export declare const thing: number;'],
    ['tests/thing.test.mjs', "import '../scripts/thing.mjs'"],
    ['tests/tool-fixture.mjs', 'export const fixture = 1;'],
    ['tests/measure.mjs', "import './tool-fixture.mjs'"],
    ...Object.entries(extra),
  ]);
const narrow = (path, extra) => selectTests({ paths: [path], files: narrowFiles(extra) });

test('docs packagers select the docs-check tests, not the whole suite', () => {
  for (const path of ['scripts/package-documents.mjs', 'scripts/check-documents.mjs']) {
    const result = narrow(path);
    assert.equal(result.scope, 'scoped', path);
    for (const name of ['interaction-static', 'packaged-scripts', 'selfhost-notices', 'ci-scope'])
      assert.ok(result.tests.includes(`tests/${name}.test.mjs`), `${path} ${name}`);
    assert.ok(!result.tests.includes('tests/unrelated.test.mjs'));
    assert.ok(!result.tests.includes('tests/leaf.test.mjs'));
  }
});

test('docs packagers stay full when they reach the runner, product code or an unknown packager', () => {
  assert.equal(narrow('scripts/check-documentation.mjs').scope, 'full');
  assert.equal(narrow('scripts/package-local.mjs').scope, 'full');
  assert.equal(narrow('scripts/forge-check.mjs').scope, 'full');
  assert.equal(
    narrow('scripts/package-documents.mjs', {
      'scripts/forge-check.mjs': "import './check-documentation.mjs'; import './package-documents.mjs';",
    }).scope,
    'full',
  );
  assert.equal(
    narrow('scripts/package-documents.mjs', { 'src/reader.ts': "import '../scripts/package-documents.mjs'" })
      .scope,
    'full',
  );
});

test('skill documents select the tests that read them and fail safe when nothing does', () => {
  const skill = 'skills/forge-agent/SKILL.md';
  assert.equal(narrow(skill).scope, 'full');
  const readers = { 'tests/skill.test.mjs': `readFileSync('${skill}')` };
  const result = narrow(skill, readers);
  assert.equal(result.scope, 'scoped');
  assert.ok(result.tests.includes('tests/skill.test.mjs'));
  assert.ok(!result.tests.includes('tests/unrelated.test.mjs'));
  // Package manifests list the file but do not read it.
  assert.equal(narrow(skill, { 'package.json': JSON.stringify({ files: [skill] }) }).scope, 'full');
  // A product module that reads it selects the tests naming that module.
  const viaSource = narrow(skill, {
    'src/skill-reader.ts': `readFileSync('${skill}')`,
    'tests/skill-reader.test.mjs': "import '../dist/skill-reader.js'; // skill-reader",
  });
  assert.equal(viaSource.scope, 'scoped');
  assert.ok(viaSource.tests.includes('tests/skill-reader.test.mjs'));
});

test('declaration files select typecheck plus tests loading their module', () => {
  const api = narrow('convex/_generated/api.d.ts');
  assert.equal(api.scope, 'scoped');
  assert.ok(api.tests.includes('tests/users.test.mjs'));
  assert.ok(!api.tests.includes('tests/other.test.mjs'));
  const model = narrow('convex/_generated/dataModel.d.ts');
  assert.equal(model.scope, 'scoped');
  assert.ok(!model.tests.includes('tests/users.test.mjs'));
  const thing = narrow('scripts/thing.d.mts');
  assert.equal(thing.scope, 'scoped');
  assert.ok(thing.tests.includes('tests/thing.test.mjs'));
  assert.ok(!thing.tests.includes('tests/unrelated.test.mjs'));
  // The runtime twin keeps the whole backend; a deleted declaration keeps the wide backend scope.
  assert.ok(narrow('convex/_generated/api.js').tests.includes('tests/other.test.mjs'));
  const deleted = narrowFiles();
  deleted.delete('convex/_generated/api.d.ts');
  assert.ok(
    selectTests({ paths: ['convex/_generated/api.d.ts'], files: deleted }).tests.includes(
      'tests/other.test.mjs',
    ),
  );
});

test('fixtures select their importing tests; orphan fixtures stay full unless only tooling uses them', () => {
  const used = narrow('tests/tool-fixture.mjs', { 'tests/using.test.mjs': "import './tool-fixture.mjs'" });
  assert.equal(used.scope, 'scoped');
  assert.ok(used.tests.includes('tests/using.test.mjs'));
  assert.ok(!used.tests.includes('tests/unrelated.test.mjs'));
  // Used only by standalone measurement tooling: no test to run, static checks cover it.
  const tooling = narrow('tests/tool-fixture.mjs');
  assert.equal(tooling.scope, 'scoped');
  assert.ok(!tooling.tests.includes('tests/unrelated.test.mjs'));
  // Nothing uses it, tooling reaches the pipeline or product code uses it: full.
  assert.equal(narrow('tests/lonely-fixture.mjs', { 'tests/lonely-fixture.mjs': '' }).scope, 'full');
  assert.equal(
    narrow('tests/tool-fixture.mjs', { 'scripts/runner-helper.js': "import '../tests/tool-fixture.mjs'" })
      .scope,
    'full',
  );
  assert.equal(
    narrow('tests/tool-fixture.mjs', { 'src/untested.ts': "import '../tests/tool-fixture.mjs'" }).scope,
    'full',
  );
});

test('package.json, lockfile and the check-selection code itself always run full', () => {
  for (const path of [
    'package.json',
    'package-lock.json',
    'scripts/test-impact.mjs',
    'scripts/check-path-scopes.mjs',
    'scripts/script-impact.mjs',
    'scripts/verify.mjs',
    'unknown.d.ts',
    'skills/unknown/other.txt',
  ])
    assert.equal(narrow(path).scope, 'full', path);
});
