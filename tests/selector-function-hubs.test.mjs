// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Ferdinando Valsecchi
// 5dcfce75, remaining Convex hubs: a shared wrapper (convex/cliServer.ts) names one function of
// another module (`deviceStore:authorize`); every test behind the wrapper sat 1 hop from every edit to
// that module. Preflight now drops the wrapper when the altered exports exclude the named function.
// Landing coverage is unchanged: the graph edge stays whole.
import assert from 'node:assert/strict';
import test from 'node:test';
import { testImportGraph } from '../scripts/test-import-graph.mjs';
import { alteredSurface } from '../scripts/test-impact.mjs';
import { closenessIndex } from '../scripts/test-closeness.mjs';

const files = extra =>
  new Map(
    Object.entries({
      'package.json': '{"scripts":{}}',
      'package-lock.json': '{"packages":{"node_modules/convex":{}}}',
      'convex/_generated/api.js': 'export const api = anyApi; export const internal = anyApi;',
      'convex/store.ts': 'export const authorize = 1; export const poll = 2;',
      'convex/wrapper.ts': [
        "import { makeFunctionReference } from 'convex/server';",
        "export const guard = ctx => ctx.runQuery(makeFunctionReference('store:authorize'), {});",
      ].join('\n'),
      'convex/endpoint.ts': "import { guard } from './wrapper';\nexport const run = guard;",
      'tests/endpoint.test.mjs': "import { run } from '../convex/endpoint.ts'; run();",
      'tests/poll.test.mjs': "import { internal } from '../convex/_generated/api.js'; internal.store.poll;",
      ...extra,
    }),
  );
const consumers = (graph, altered) => [
  ...closenessIndex(graph).consumers('convex/store.ts', { maxHops: 2, altered }).keys(),
];

test('an edit to one function of a module does not rank the tests behind a wrapper that names another', () => {
  const graph = testImportGraph(files());
  assert.deepEqual([...graph.functions.get('convex/store.ts').get('convex/wrapper.ts')], ['authorize']);
  assert.ok(consumers(graph).includes('tests/endpoint.test.mjs'), 'no altered names: the wrapper counts');
  assert.ok(consumers(graph, new Set(['authorize'])).includes('tests/endpoint.test.mjs'));
  const poll = consumers(graph, new Set(['poll']));
  assert.ok(!poll.includes('tests/endpoint.test.mjs'));
  assert.deepEqual(poll, ['tests/poll.test.mjs'], 'the test that references poll by name stays');
});

test('any other edge between the pair makes the module whole again', () => {
  const whole = {
    'static import': {
      'convex/wrapper.ts': "import { authorize } from './store';\nexport const guard = () => authorize;",
    },
    'unnamed API object': {
      'convex/wrapper.ts': "import { api } from './_generated/api';\nexport const guard = () => api.store;",
    },
  };
  for (const [label, extra] of Object.entries(whole)) {
    const graph = testImportGraph(files(extra));
    assert.equal(graph.functions.get('convex/store.ts')?.get('convex/wrapper.ts') ?? null, null, label);
    assert.ok(consumers(graph, new Set(['poll'])).includes('tests/endpoint.test.mjs'), label);
  }
  const both = testImportGraph(
    files({
      'convex/wrapper.ts': [
        "import { makeFunctionReference } from 'convex/server';",
        "export const guard = () => [makeFunctionReference('store:authorize'), makeFunctionReference('store:poll')];",
      ].join('\n'),
    }),
  );
  assert.deepEqual([...both.functions.get('convex/store.ts').get('convex/wrapper.ts')].sort(), [
    'authorize',
    'poll',
  ]);
  assert.ok(
    consumers(both, new Set(['poll'])).includes('tests/endpoint.test.mjs'),
    'every named function counts',
  );
});

test('altered surface: helpers reach their exports; a statement that declares nothing is the whole module', () => {
  const before = [
    'const helper = () => 1;',
    'export const a = () => helper();',
    'export const b = () => 2;',
  ].join('\n');
  assert.deepEqual(alteredSurface('convex/x.ts', before, before.replace('=> 1', '=> 3')), ['a']);
  assert.deepEqual(alteredSurface('convex/x.ts', before, before.replace('=> 2', '=> 4')), ['b']);
  assert.deepEqual(alteredSurface('convex/x.ts', before, before), []);
  assert.deepEqual(alteredSurface('convex/x.ts', before, `${before}\nregister(a);`), ['*']);
  assert.deepEqual(alteredSurface('convex/x.ts', before, before.replace('export const b = () => 2;', '')), [
    'b',
  ]);
});

test('altered surface never prunes on effects it cannot see: deleted side effects, load calls, literals, mutable state', () => {
  const v = 'import { internalQuery } from "convex/server";\n';
  const base = `${v}let enabled = true;\nexport const a = internalQuery({ x: 'read  only' });\nexport const b = internalQuery({});`;
  assert.deepEqual(alteredSurface('convex/x.ts', base, base.replace('{}', '{ y: 1 }')), ['*'], 'a let');
  const pure = `${v}export const a = internalQuery({ x: 'read  only' });\nexport const b = internalQuery({});`;
  assert.deepEqual(alteredSurface('convex/x.ts', pure, pure.replace('{}', '{ y: 1 }')), ['b']);
  assert.deepEqual(
    alteredSurface('convex/x.ts', pure, pure.replace('read  only', 'read only')),
    ['a'],
    'literals',
  );
  const local = `${v}const make = n => n;\nexport const a = internalQuery({ x: make(2) });\nexport const b = 1;`;
  assert.deepEqual(
    alteredSurface('convex/x.ts', local, local.replace('make(2)', 'make(3)')),
    ['*'],
    'load call',
  );
  const effect = `${v}enable();\nexport const a = internalQuery({});\nexport const b = internalQuery({});`;
  assert.deepEqual(
    alteredSurface('convex/x.ts', effect, effect.replace('enable();\n', '')),
    ['*'],
    'deleted effect',
  );
});

test('a module that names its own functions is never narrowed', () => {
  const graph = testImportGraph(
    files({
      'convex/store.ts': [
        "import { internal } from './_generated/api';",
        'export const authorize = ctx => ctx.runQuery(internal.store.poll, {});',
        'export const poll = 2;',
      ].join('\n'),
    }),
  );
  assert.ok(graph.functions.get('convex/store.ts').has('convex/store.ts'));
  assert.ok(consumers(graph, new Set(['poll'])).includes('tests/endpoint.test.mjs'));
});
