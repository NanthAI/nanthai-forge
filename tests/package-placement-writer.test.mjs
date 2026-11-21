// SPDX-License-Identifier: Apache-2.0
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { checkedPackagePlacement } from '../dist/package-placement-pin.js';
import { pinnedPackagePlacement } from '../dist/package-placement.js';
import { buildPackageGraph, packageSelection } from '../dist/package-graph.js';
import { IMPORT_GRAPH_LIMITS } from '../dist/js-import-graph.js';

const vendor = '.repos/vendor';
const root = {
  'package.json': '{"name":"root","scripts":{"test":"node --test"}}',
  'package-lock.json': '{}',
};
const source = (dir = vendor) => ({
  ...root,
  [dir + '/package.json']: '{"name":"vendor"}',
  [dir + '/src/index.ts']: 'export const x = 1;',
});
const defaults = { checkEntries: [], commandLines: [] };
const pin = (tree, inputs = defaults) =>
  checkedPackagePlacement(Object.keys(tree), path => tree[path], inputs).packagePlacement;
const rows = value => value?.packages.filter(row => row[5] === 1) ?? [];
const certified = (tree, inputs) => rows(pin(tree, inputs)).map(row => row[1]);

test('placement only adds the outermost .repos rows, keeping the package selection graph byte-identical', () => {
  const tree = {
    ...source(),
    '.repos/vendor/package-lock.json': '{}',
    '.repos/vendor/packages/internal/package.json': '{"name":"internal"}',
    '.repos/second/package.json': '{"name":"second"}',
    'repos/no-lock/package.json': '{"name":"no-lock"}',
    'tools/pinned/package.json': '{"name":"pinned"}',
    'tools/pinned/package-lock.json': '{}',
    'tools/pinned/main.ts': 'export const y = 1;',
  };
  const select = paths =>
    JSON.stringify(
      packageSelection(
        buildPackageGraph(Object.keys(tree), path => tree[path]),
        paths,
      ),
    );
  const changes = Object.keys(tree).map(path => [path]);
  const before = changes.map(select);
  const off = checkedPackagePlacement(Object.keys(tree), path => tree[path]).packagePlacement;
  assert.equal(
    JSON.stringify(off),
    '{"rule":"package-placement-v2","packages":[["js","",0,1,[]],["js","tools/pinned",0,0,[]]],"unresolved":[]}',
  );
  const on = pin(tree);
  assert.equal(on.rule, 'package-placement-v3');
  assert.deepEqual(
    rows(on),
    ['.repos/second', vendor, 'repos/no-lock'].map(dir => ['js', dir, 0, 0, [], 1, 'js-non-member']),
  );
  assert.ok(pinnedPackagePlacement({ packagePlacement: on }));
  assert.deepEqual(changes.map(select), before);
});

for (const [name, changes, options] of [
  ['one dependency without an own lock', { [vendor + '/package.json']: '{"dependencies":{"example":"1"}}' }],
  [
    'a dependency in an inner package without an outer lock',
    { [vendor + '/inner/package.json']: '{"optionalDependencies":{"example":"1"}}' },
  ],
  ['an enclosing workspace glob', { 'package.json': '{"workspaces":[".repos/*"]}' }],
  [
    'an enclosing workspace glob matching only an inner package',
    { 'package.json': '{"workspaces":[".repos/*/inner"]}', [vendor + '/inner/package.json']: '{}' },
  ],
  [
    'an inner workspace',
    {
      [vendor + '/package.json']: '{"workspaces":["packages/*"]}',
      [vendor + '/packages/core/package.json']: '{}',
    },
  ],
  [
    'an inner pnpm workspace',
    {
      [vendor + '/pnpm-workspace.yaml']: "packages:\n  - 'packages/*'\n",
      [vendor + '/packages/core/package.json']: '{}',
    },
  ],
  ['unknown workspace syntax', { 'pnpm-workspace.yaml': "packages: ['.repos/*']" }],
  [
    'an outside path dependency, even with no target',
    { 'package.json': '{"dependencies":{"vendor":"file:.repos/vendor/missing"}}' },
  ],
  [
    'a path dependency leaving the folder',
    {
      [vendor + '/package.json']: '{"dependencies":{"other":"portal:../../other"}}',
      [vendor + '/package-lock.json']: '{}',
    },
  ],
  ['an outside alias for the package name', { 'package.json': '{"dependencies":{"alias":"npm:vendor@1"}}' }],

  [
    'a root script names the folder',
    { 'package.json': '{"scripts":{"test":"cd .repos/vendor && npm test"}}' },
  ],
  ['a root script names an ancestor glob', { 'package.json': '{"scripts":{"test":"test .repos/**"}}' }],
  ['a CI file names the folder', { '.github/workflows/verify.yml': 'run: npm --prefix .repos/vendor test' }],
  ['a CI entrypoint that also counts as root configuration', { Jenkinsfile: 'cd .repos/vendor' }],
  [
    'a declared check entry glob whose matching script names the subtree',
    { 'scripts/verify-js.sh': 'cd .repos/vendor' },
    { ...defaults, checkEntries: ['scripts/verify-*.sh'] },
  ],
  ['an unreadable CI workflow', { '.github/workflows/verify.yml': undefined }],
  [
    'a check entry body names the folder',
    { 'scripts/check.sh': 'cd .repos/vendor' },
    { ...defaults, checkEntries: ['scripts/check.sh'] },
  ],
  ['a check declaration names an ancestor', {}, { ...defaults, checkEntries: ['.repos/**'] }],
  ['an unowned test', { [vendor + '/tests/unit.ts']: 'export {};' }],
  ['an invalid inner manifest', { [vendor + '/inner/package.json']: '{' }],
  ['an absent verification read', { [vendor + '/package.json']: undefined }],
]) {
  test(`placement refuses ${name}`, () =>
    assert.deepEqual(certified({ ...source(), ...changes }, options), []));
}

test('an unsupported workspace brace range cannot hide an enclosing workspace member', () => {
  const tree = {
    ...source('projects/v2'),
    'package.json': '{"workspaces":["packages/*","projects/v{1..3}"]}',
    'packages/known/package.json': '{}',
  };
  assert.deepEqual(certified(tree), []);
});

test('workspace exclusion ordering and noncanonical slashes cannot certify a member', () => {
  for (const [patterns, dir] of [
    [['packages/**', '!packages/b/**', 'packages/b/a'], 'packages/b/a'],
    [['packages//v2'], 'packages/v2'],
    [['/packages/v2'], 'packages/v2'],
  ]) {
    const tree = {
      ...source(dir),
      'package.json': JSON.stringify({ workspaces: ['seed/*', ...patterns] }),
      'seed/known/package.json': '{}',
    };
    assert.deepEqual(certified(tree), [], dir);
  }
});

test('a regular own lockfile permits dependencies that stay inside the package', () => {
  const tree = {
    ...source(),
    [vendor + '/package.json']:
      '{"dependencies":{"deps":"link:./internal"},"scripts":{"test":"node --test"}}',
    [vendor + '/package-lock.json']: '{}',
    [vendor + '/internal/package.json']: '{"name":"deps","devDependencies":{"external":"1"}}',
    [vendor + '/module.test.ts']: 'export {};',
  };
  assert.deepEqual(certified(tree), [vendor]);
  assert.deepEqual(
    certified(tree, { ...defaults, regularFile: path => !path.endsWith(vendor + '/package-lock.json') }),
    [],
  );
});

test('an ordinary pinned package below a nonmember prevents placement-only ownership', () => {
  const tree = {
    ...source('tools/vendor'),
    'tools/vendor/child/package.json': '{}',
    'tools/vendor/child/package-lock.json': '{}',
  };
  assert.deepEqual(pin(tree).packages, [
    ['js', '', 0, 1, []],
    ['js', 'tools/vendor/child', 0, 0, []],
  ]);
});

test('a captured node_modules subtree never earns placement ownership', () => {
  assert.deepEqual(certified(source('packages/node_modules/vendor')), []);
});

for (const dir of ['repos/vendor', '.repos/vendor']) {
  test(`a relative import into ${dir} refuses with or without an existing target`, () => {
    for (const target of ['index.ts', 'missing.ts']) {
      const tree = { ...source(dir), 'root.mjs': `import "./${dir}/src/${target}";` };
      assert.deepEqual(certified(tree), []);
    }
  });
}

for (const [name, changes] of [
  ['an unreadable outside source file', { 'root.mjs': undefined }],
  ['an unparseable outside source file', { 'root.mjs': 'const broken = ;' }],
  ['an absolute specifier', { 'root.mjs': 'import module from "/elsewhere.js";' }],
  [
    'a complex relative specifier with a missing target and no full-path string',
    { 'other/root.ts': 'export * from "../.repos/x/../vendor/missing";' },
  ],
  ['an encoded relative import', { 'root.mjs': 'import "./%2erepos/vendor/src/index.js";' }],
  ['an import type', { '.repos/outside/types.ts': 'type Value = import("../vendor/x").Value;' }],
  [
    'a triple-slash reference',
    { '.repos/outside/types.ts': '/// <reference path="../vendor/missing.d.ts" />\nexport {};' },
  ],
  [
    'an alias in an alternate JSONC config',
    {
      'tsconfig.extra.json':
        '{ // comment\n"compilerOptions":{"paths":{"alias":["./.repos/x/../vendor/*"]}},\n}',
    },
  ],
  [
    'an ancestor baseUrl and a bare lexical target',
    {
      'jsconfig.extra.json': '{"compilerOptions":{"baseUrl":".repos"}}',
      'root.mjs': 'import "vendor/missing";',
    },
  ],
  ['a baseUrl points inside', { 'tsconfig.json': '{"compilerOptions":{"baseUrl":"./.repos/vendor/src"}}' }],
  [
    'package imports targets',
    { 'package.json': '{"imports":{"#alias":{"default":"./.repos/x/../vendor/missing.js"}}}' },
  ],
  ['a computed import prefix above the folder', { 'root.mjs': 'import("./.repos/" + choice);' }],
  [
    'a computed require prefix ending inside a segment',
    { '.repos/outside.cjs': 'require(`./ven${choice}/module.js`);' },
  ],
  [
    'a computed import inside a parenthesized conditional branch',
    { 'root.mjs': 'import((choice ? "./.repos/" + leaf : "./elsewhere/" + leaf));' },
  ],
  [
    'a relative prefix in a condition at the start of concatenation',
    { 'root.mjs': 'import((choice ? "./.repos/" : "./elsewhere/") + leaf);' },
  ],
  ['a require.context directory prefix', { 'root.cjs': 'require.context("./.repos", true, /x/);' }],
  ['an import.meta.glob array', { 'root.mjs': 'import.meta.glob(["./other/*", "./.repos/**/x"]);' }],
  [
    'a bundler alias given as raw source text',
    { 'root.mjs': 'const aliases = { vendor: ".repos/vendor" };' },
  ],
  ['an unreadable alternate config', { 'tsconfig.test.json': undefined }],
  ['an unparseable alternate config', { 'jsconfig.test.json': '{invalid' }],
  ['a file over the existing size bound', { 'root.mjs': ' '.repeat(IMPORT_GRAPH_LIMITS.fileBytes + 1) }],
]) {
  test(`inbound certification refuses ${name}`, () =>
    assert.deepEqual(certified({ ...source(), ...changes }), []));
}

test('computed imports without a literal prefix leave the package to the existing dynamic-read audit', () => {
  assert.deepEqual(certified({ ...source(), 'root.mjs': 'const read = name => import(name);' }), [vendor]);
});

test('the outside-file bound refuses before reading any JS source', () => {
  const tree = source();
  const code = Array.from({ length: IMPORT_GRAPH_LIMITS.files + 1 }, (_, i) => `code/file-${i}.js`);
  const result = checkedPackagePlacement(
    [...Object.keys(tree), ...code],
    path => {
      assert(!path.startsWith('code/'));
      return tree[path];
    },
    defaults,
  );
  assert.deepEqual(rows(result.packagePlacement), []);
});

test('a pin beyond the byte cap drops the added rows before ordinary placement', () => {
  const tree = { ...source(), 'pinned/package.json': '{}', 'pinned/package-lock.json': '{}' };
  for (let i = 0; i < 570; i++) tree['.repos/' + i + '-' + 'a'.repeat(205) + '/package.json'] = '{}';
  const off = checkedPackagePlacement(Object.keys(tree), path => tree[path]);
  assert.equal(JSON.stringify(pin(tree)), JSON.stringify(off.packagePlacement));
});
