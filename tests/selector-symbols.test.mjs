// SPDX-License-Identifier: Apache-2.0
// 5dcfce75 item 3: symbol-level selection. Importing one export of a module selects only the tests
// that reach a changed export; every shape that could hide a real dependency stays selected.
import assert from 'node:assert/strict';
import test from 'node:test';
import { selectTests } from '../scripts/test-impact.mjs';

const fixture = extra =>
  new Map(
    Object.entries({
      'package.json': '{"scripts":{}}',
      'package-lock.json': '{"packages":{"node_modules/convex":{}}}',
      'convex/_generated/api.js': 'export const api = anyApi; export const internal = anyApi;',
      'src/leaf.ts': 'export const leaf = 1;',
      ...extra,
    }),
  );
const picks = (files, path = 'src/leaf.ts') => selectTests({ files, paths: [path] }).tests;
// The hub reaches the changed leaf only inside `late`, through a dynamic import.
const hub = {
  'src/hub.ts': [
    'export const early = () => 1;',
    "export function late() { return import('./leaf.js'); }",
    'export const later = () => late();',
  ].join('\n'),
};

test('a test importing an untouched export of a hub is not selected; one reaching the changed export is', () => {
  const files = fixture({
    ...hub,
    'tests/early.test.mjs': "import { early } from '../dist/hub.js'; early();",
    'tests/late.test.mjs': "import { late } from '../dist/hub.js'; late();",
    // Reaches `late` through another top-level declaration of the hub.
    'tests/later.test.mjs': "import { later } from '../dist/hub.js'; later();",
  });
  const selected = picks(files);
  assert.ok(!selected.includes('tests/early.test.mjs'));
  assert.ok(selected.includes('tests/late.test.mjs'));
  assert.ok(selected.includes('tests/later.test.mjs'));
});

test('a changed module is whole: every importer of any of its exports is selected (no base bytes)', () => {
  const files = fixture({
    ...hub,
    'tests/early.test.mjs': "import { early } from '../dist/hub.js'; early();",
    // A static import of a whole module is whole too: it loads it.
    'src/mid.ts':
      "import { early } from './hub.js'; export const unrelated = () => 2; export const e = early;",
    'tests/mid.test.mjs': "import { unrelated } from '../dist/mid.js'; unrelated();",
  });
  const selected = picks(files, 'src/hub.ts');
  assert.ok(selected.includes('tests/early.test.mjs'));
  assert.ok(selected.includes('tests/mid.test.mjs'));
});

test('re-exports, namespace and default imports follow the export they name', () => {
  const files = fixture({
    ...hub,
    'src/barrel.ts': "export { early, late as renamed } from './hub.js'; export * from './hub.js';",
    'src/star.ts': "export * as hubNs from './hub.js';",
    'src/default.ts': "import { late } from './hub.js'; export default function () { return late(); }",
    'tests/barrel-early.test.mjs': "import { early } from '../dist/barrel.js'; early();",
    'tests/barrel-renamed.test.mjs': "import { renamed } from '../dist/barrel.js'; renamed();",
    'tests/barrel-star.test.mjs': "import { later } from '../dist/barrel.js'; later();",
    'tests/namespace.test.mjs': "import * as all from '../dist/hub.js'; all.early();",
    'tests/star-ns.test.mjs': "import { hubNs } from '../dist/star.js'; hubNs.early();",
    'tests/default.test.mjs': "import run from '../dist/default.js'; run();",
  });
  const selected = picks(files);
  assert.ok(!selected.includes('tests/barrel-early.test.mjs'));
  for (const name of ['barrel-renamed', 'barrel-star', 'namespace', 'star-ns', 'default'])
    assert.ok(selected.includes(`tests/${name}.test.mjs`), name);
});

test('code that runs at load, or hands a tainted function to code, makes the whole module reach', () => {
  const shapes = {
    'a call at load': "import { late } from './hub.js'; export const v = late();",
    'a callback handed over at load': "import { late } from './hub.js'; process.on('exit', () => late());",
    'a registration call': "import { late } from './hub.js'; register({ run: late });",
    'a spread at load': "import * as h from './hub.js'; export const copy = { ...h };",
    'a destructuring read at load': "import * as h from './hub.js'; export const { late: own } = h;",
    'a template at load': "import { late } from './hub.js'; export const text = `${late}`;",
    'a class static block': "import { late } from './hub.js'; export class C { static { late(); } }",
    'a decorated member': "import { late } from './hub.js'; export class C { @late m() {} }",
    eval: "import { late } from './hub.js'; export const x = () => eval('late()');",
  };
  for (const [shape, source] of Object.entries(shapes)) {
    const files = fixture({
      ...hub,
      'src/user.ts': `${source}\nexport const untouched = 1;`,
      // Only a side-effect import: it observes the user module's load, never an export.
      'tests/loads.test.mjs': "import '../dist/user.js';",
      'tests/untouched.test.mjs': "import { untouched } from '../dist/user.js'; untouched;",
    });
    const selected = picks(files);
    assert.ok(selected.includes('tests/loads.test.mjs'), shape);
    assert.ok(selected.includes('tests/untouched.test.mjs'), shape);
  }
});

test('values only bound at load keep symbol reach: aliases, object and array members, methods, classes', () => {
  const files = fixture({
    ...hub,
    'src/user.ts': [
      "import { late } from './hub.js';",
      'export const alias = late;',
      'export const table = { run: late, list: [late], method() { return late(); } };',
      'export class Box { open() { return late(); } static field = late; }',
      'export const pick = flag => (flag ? late : null) ?? late;',
      'export const untouched = () => 1;',
    ].join('\n'),
    'tests/alias.test.mjs': "import { alias } from '../dist/user.js'; alias();",
    'tests/table.test.mjs': "import { table } from '../dist/user.js'; table.run();",
    'tests/box.test.mjs': "import { Box } from '../dist/user.js'; new Box().open();",
    'tests/pick.test.mjs': "import { pick } from '../dist/user.js'; pick(true)();",
    'tests/untouched.test.mjs': "import { untouched } from '../dist/user.js'; untouched();",
    'tests/loads.test.mjs': "import '../dist/user.js';",
  });
  const selected = picks(files);
  for (const name of ['alias', 'table', 'box', 'pick'])
    assert.ok(selected.includes(`tests/${name}.test.mjs`), name);
  assert.ok(!selected.includes('tests/untouched.test.mjs'));
  assert.ok(!selected.includes('tests/loads.test.mjs'));
});

test('dynamic imports, requires and by-name loaders keep their reach', () => {
  const files = fixture({
    ...hub,
    'tests/dynamic.test.mjs': "test('x', async () => (await import('../dist/hub.js')).early());",
    'tests/top-dynamic.test.mjs': "const { early } = await import('../dist/hub.js'); early();",
    'tests/require.test.mjs': "const { early } = require('../dist/hub.js'); early();",
    'tests/fixture-helper.mjs': "export const load = () => import('../dist/hub.js');",
    'tests/through-fixture.test.mjs':
      "import { load } from './fixture-helper.mjs'; test('x', async () => (await load()).early());",
    'tests/unused-fixture.test.mjs': "import './fixture-helper.mjs';",
  });
  const selected = picks(files);
  // A dynamic import's result is a namespace: any reached export counts.
  for (const name of ['dynamic', 'top-dynamic', 'require', 'through-fixture'])
    assert.ok(selected.includes(`tests/${name}.test.mjs`), name);
  // The helper's loader never runs here.
  assert.ok(!selected.includes('tests/unused-fixture.test.mjs'));
});

test('a by-name Convex reference inside a plain helper reaches only that helper; inside a registered function, the module', () => {
  const files = fixture({
    'convex/target.ts': 'export const sweep = 1;',
    'convex/pause.ts': [
      "import { makeFunctionReference } from 'convex/server';",
      "export const flag = 'PAUSE';",
      "export async function resume(ctx) { await ctx.scheduler.runAfter(0, makeFunctionReference('target:sweep'), {}); }",
    ].join('\n'),
    'convex/registered.ts': [
      "import { makeFunctionReference } from 'convex/server';",
      "export const run = mutation({ handler: async ctx => ctx.runMutation(makeFunctionReference('target:sweep'), {}) });",
      'export const other = 1;',
    ].join('\n'),
    'convex/server.ts': "import { flag } from './pause'; export const builder = () => flag;",
    'tests/flag.test.mjs': "import { builder } from '../convex/server.ts'; builder();",
    'tests/resume.test.mjs': "import { resume } from '../convex/pause.ts'; await resume(ctx);",
    'tests/registered-other.test.mjs': "import { other } from '../convex/registered.ts'; other;",
  });
  const selected = picks(files, 'convex/target.ts');
  assert.ok(!selected.includes('tests/flag.test.mjs'), 'imports only the flag constant');
  assert.ok(selected.includes('tests/resume.test.mjs'));
  // `mutation({ handler })` is a call at load: what the module registers may differ.
  assert.ok(selected.includes('tests/registered-other.test.mjs'));
});

test('a product path template inside a function reaches only the importers that call it', () => {
  const files = fixture({
    'src/aliases.ts': [
      'export const aliases = name => [name, `dist/${name}.js`];',
      'export const stem = path => path.replace(/\\.ts$/, "");',
    ].join('\n'),
    'tests/stem.test.mjs': "import { stem } from '../dist/aliases.js'; stem('a'); process.cwd();",
    'tests/aliases.test.mjs': "import { aliases } from '../dist/aliases.js'; aliases('a'); process.cwd();",
  });
  const selected = picks(files);
  assert.ok(!selected.includes('tests/stem.test.mjs'));
  assert.ok(selected.includes('tests/aliases.test.mjs'));
});

test('type-only imports never reach; an import of only types still loads the module', () => {
  const files = fixture({
    'src/types.ts': 'export type T = 1; export const value = 1;',
    'tests/type-only.test.mjs': "import type { T } from '../dist/types.js';",
    'tests/type-specifier.test.mjs': "import { type T } from '../dist/types.js';",
  });
  const selected = picks(files, 'src/types.ts');
  assert.ok(!selected.includes('tests/type-only.test.mjs'));
  // `import { type T }` keeps an import of the module at runtime: a changed module is whole.
  assert.ok(selected.includes('tests/type-specifier.test.mjs'));
});

test('a by-name loader fixture keeps every test that names the module, whatever it imports from it', () => {
  // Like tests/hosted-finish-fixture.mjs: the fixture runs whatever Convex name a test hands it.
  const files = fixture({
    'convex/alpha.ts': 'export const listRows = 1;',
    'convex/beta.ts': 'export const listRows = 1;',
    'tests/finish-fixture.mjs': [
      "import { getFunctionName } from 'convex/server';",
      'export const unrelated = () => 1;',
      'export async function run(ref) {',
      '  const name = getFunctionName(ref);',
      "  const [file, method = 'default'] = name.split(':');",
      '  return (await import(moduleUrl(`../convex/${file}.ts`)))[method];',
      '}',
    ].join('\n'),
    'tests/names-alpha.test.mjs':
      "import { run, unrelated } from './finish-fixture.mjs'; unrelated(); run('alpha:listRows');",
    'tests/names-beta.test.mjs': "import { run } from './finish-fixture.mjs'; run('beta:listRows');",
  });
  const selected = picks(files, 'convex/alpha.ts');
  assert.ok(selected.includes('tests/names-alpha.test.mjs'));
  assert.ok(!selected.includes('tests/names-beta.test.mjs'));
});

// Review 02c2111d findings 4-8: each shape runs tainted code at load, so the whole module reaches.
const loadShapes = {
  'a tainted && left side': "import { late } from './hub.js'; export const ok = late && register();",
  'a tainted || left side': "import { late } from './hub.js'; export const ok = late || register();",
  'a tainted ?? left side': "import { late } from './hub.js'; export const ok = late ?? register();",
  'a tainted condition': "import { late } from './hub.js'; export const ok = late ? register() : null;",
  'a tainted comma left side': "import { late } from './hub.js'; export const ok = (late, register());",
  'a static field gated by a tainted value':
    "import { late } from './hub.js'; export class C { static ok = late && register(); }",
  'a class decorator':
    "import { late } from './hub.js'; @registerClass export class C { m() { return late(); } }",
  'a parameter decorator': "import { late } from './hub.js'; export class C { m(@late x) { return x; } }",
  'a constructor parameter decorator':
    "import { late } from './hub.js'; export class C { constructor(@late x) { this.x = x; } }",
  'an import alias of a namespace member': "import * as h from './hub.js'; export import alias = h.late;",
  'a parenthesised eval': "import { late } from './hub.js'; export const x = () => (eval)('late()');",
  'an eager glob inside a function':
    "export const load = () => import.meta.glob('./leaf.ts', { eager: true });",
};
for (const [shape, source] of Object.entries(loadShapes))
  test(`whole module at load: ${shape}`, () => {
    const files = fixture({
      ...hub,
      'src/user.ts': `${source}\nexport const untouched = 1;`,
      'tests/loads.test.mjs': "import '../dist/user.js';",
      'tests/untouched.test.mjs': "import { untouched } from '../dist/user.js'; untouched;",
    });
    const selected = picks(files);
    assert.ok(selected.includes('tests/loads.test.mjs'), shape);
    assert.ok(selected.includes('tests/untouched.test.mjs'), shape);
  });

test('a chosen value and a lazy glob keep symbol reach; a destructuring default is a reference', () => {
  const files = fixture({
    ...hub,
    'src/user.ts': [
      "import { late } from './hub.js';",
      'export const chosen = globalThis.flag ? late : null;',
      'export const fallback = globalThis.value ?? late;',
      "export const lazy = () => import.meta.glob('./leaf.ts', { eager: false });",
      'const helper = () => late();',
      'export function pick(opts) { let fn; ({ fn = late } = opts); return fn(); }',
      'export function pickHelper(opts) { let fn; ({ fn = helper } = opts); return fn(); }',
      'export const untouched = 1;',
    ].join('\n'),
    'tests/chosen.test.mjs': "import { chosen } from '../dist/user.js'; chosen;",
    'tests/fallback.test.mjs': "import { fallback } from '../dist/user.js'; fallback;",
    'tests/lazy.test.mjs': "import { lazy } from '../dist/user.js'; lazy();",
    'tests/pick.test.mjs': "import { pick } from '../dist/user.js'; pick({});",
    'tests/pick-helper.test.mjs': "import { pickHelper } from '../dist/user.js'; pickHelper({});",
    'tests/untouched.test.mjs': "import { untouched } from '../dist/user.js'; untouched;",
  });
  const selected = picks(files);
  for (const name of ['chosen', 'fallback', 'lazy', 'pick', 'pick-helper'])
    assert.ok(selected.includes(`tests/${name}.test.mjs`), name);
  assert.ok(!selected.includes('tests/untouched.test.mjs'));
});
