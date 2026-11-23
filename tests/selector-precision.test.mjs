// SPDX-License-Identifier: Apache-2.0
// 5dcfce75: precision fixes that cut the selector's floor (a new, unimported file selected 1,061 of
// ~1,276 tests). Each test pairs the narrower edge with the case that must still widen.
import assert from 'node:assert/strict';
import test from 'node:test';
import { testImportGraph } from '../scripts/test-import-graph.mjs';
import { selectTests } from '../scripts/test-impact.mjs';

const base = extra =>
  new Map(
    Object.entries({
      'package.json': '{"scripts":{}}',
      'package-lock.json': '{"packages":{"node_modules/convex":{}}}',
      'convex/_generated/api.js': 'export const api = anyApi; export const internal = anyApi;',
      'convex/_generated/server.js': 'export const query = q => q;',
      ...extra,
    }),
  );
const selected = (files, path) => selectTests({ files, paths: [path] }).tests;
const edge = (graph, from, to) => graph.evidence.get(from)?.get(to);
const loader = [
  "import { getFunctionName } from 'convex/server';",
  'export async function run(ref) {',
  '  const name = getFunctionName(ref);',
  "  const [file, method = 'default'] = name.split(':');",
  '  return (await import(moduleUrl(`../convex/${file}.ts`)))[method];',
  '}',
].join('\n');

test('by-name Convex selection: one function module selects only the tests that call it by name', () => {
  // Two unrelated function modules behind one by-name loader, plus a shared dispatcher whose names
  // come from a ternary and from a v.union(v.literal) args validator (the two wildcards behind the
  // hub report's floor: `${api}:complete` and `${kind}:listRows`).
  const files = base({
    'convex/alpha.ts': 'export const listRows = 1; export const complete = 1;',
    'convex/beta.ts': 'export const listRows = 1; export const complete = 1;',
    'convex/gamma.ts': 'export const listRows = 1;',
    'convex/dispatch.ts': [
      "import { v } from 'convex/values';",
      "import { makeFunctionReference } from 'convex/server';",
      "import { query } from './_generated/server';",
      'export const watch = query({',
      "  args: { kind: v.union(v.literal('alpha'), v.literal('beta')) },",
      '  handler: async (ctx, { kind }) => ctx.runQuery(makeFunctionReference(`${kind}:listRows`), {}),',
      '});',
      'export const finish = (ctx, job) => {',
      "  const api = job === 'a' ? 'alpha' : 'beta';",
      '  return ctx.scheduler.runAfter(0, makeFunctionReference(`${api}:complete`), {});',
      '};',
    ].join('\n'),
    'tests/convex-context.mjs': loader,
    'tests/alpha.test.mjs': "import { run } from './convex-context.mjs'; run('alpha:listRows');",
    'tests/beta.test.mjs': "import { run } from './convex-context.mjs'; run('beta:listRows');",
    'tests/dispatch.test.mjs': "import { run } from './convex-context.mjs'; run('dispatch:watch');",
  });
  const alpha = selected(files, 'convex/alpha.ts');
  assert.ok(alpha.includes('tests/alpha.test.mjs'));
  assert.ok(alpha.includes('tests/dispatch.test.mjs'), 'the dispatcher names alpha through both templates');
  assert.ok(!alpha.includes('tests/beta.test.mjs'));
  const gamma = selected(files, 'convex/gamma.ts');
  assert.ok(!gamma.includes('tests/dispatch.test.mjs'), 'no branch or validator value names gamma');
  assert.ok(!gamma.includes('tests/alpha.test.mjs'));
  const graph = testImportGraph(files);
  assert.equal(edge(graph, 'convex/alpha.ts', 'convex/dispatch.ts')?.kind, 'function-reference');
  assert.equal(edge(graph, 'convex/gamma.ts', 'convex/dispatch.ts'), undefined);
});

test('never under-select: a Convex name whose values the file does not state keeps every module', () => {
  const dispatch = (handler, validators = 'convex/values') =>
    base({
      'convex/alpha.ts': 'export const listRows = 1;',
      'convex/gamma.ts': 'export const listRows = 1;',
      'convex/validators.ts': 'export const v = {};',
      'convex/dispatch.ts': [
        `import { v } from '${validators}';`,
        "import { makeFunctionReference } from 'convex/server';",
        "import { query } from './_generated/server';",
        handler,
      ].join('\n'),
    });
  const shapes = {
    'a validator that is not literal': `export const w = query({ args: { kind: v.string() }, handler: async (ctx, { kind }) => ctx.runQuery(makeFunctionReference(\`\${kind}:listRows\`), {}) });`,
    'a reassigned argument': `export const w = query({ args: { kind: v.literal('alpha') }, handler: async (ctx, { kind }) => { kind = pick(); return ctx.runQuery(makeFunctionReference(\`\${kind}:listRows\`), {}); } });`,
    'a destructuring default': `export const w = query({ args: { kind: v.literal('alpha') }, handler: async (ctx, { kind = other }) => ctx.runQuery(makeFunctionReference(\`\${kind}:listRows\`), {}) });`,
    'a ternary with an unknown branch': `export const f = (ctx, a, b) => { const m = a ? 'alpha' : b; return ctx.runQuery(makeFunctionReference(\`\${m}:listRows\`), {}); };`,
    'a validator from another module than convex/values': `export const w = query({ args: { kind: v.literal('alpha') }, handler: async (ctx, { kind }) => ctx.runQuery(makeFunctionReference(\`\${kind}:listRows\`), {}) });`,
    'the first handler argument (ctx)': `export const w = query({ args: { kind: v.literal('alpha') }, handler: async ({ kind }) => ctx.runQuery(makeFunctionReference(\`\${kind}:listRows\`), {}) });`,
  };
  // Review 02c2111d (finding 2): every shape below can make `kind` name convex/gamma.ts at runtime.
  const call = 'ctx.runQuery(makeFunctionReference(`${kind}:listRows`), {})';
  const literal = "args: { kind: v.literal('alpha') }";
  Object.assign(shapes, {
    'a spread in args': `export const w = query({ args: { kind: v.literal('alpha'), ...extra }, handler: async (ctx, { kind }) => ${call} });`,
    'a computed key in args': `export const w = query({ args: { kind: v.literal('alpha'), [k]: v.string() }, handler: async (ctx, { kind }) => ${call} });`,
    'a spread in the definition': `export const w = query({ ${literal}, ...override, handler: async (ctx, { kind }) => ${call} });`,
    'a duplicate args key': `export const w = query({ ${literal}, args: { kind: v.string() }, handler: async (ctx, { kind }) => ${call} });`,
    'a destructuring reassignment': `export const w = query({ ${literal}, handler: async (ctx, { kind }) => { ({ kind } = other); return ${call}; } });`,
    'an array destructuring reassignment': `export const w = query({ ${literal}, handler: async (ctx, { kind }) => { [kind] = pair; return ${call}; } });`,
    'a parenthesised reassignment': `export const w = query({ ${literal}, handler: async (ctx, { kind }) => { (kind) = 'gamma'; return ${call}; } });`,
    'a for-of reassignment': `export const w = query({ ${literal}, handler: async (ctx, { kind }) => { for (kind of list) await ${call}; } });`,
    'a for-in reassignment': `export const w = query({ ${literal}, handler: async (ctx, { kind }) => { for (kind in rows) await ${call}; } });`,
    'a var redeclaring the argument': `export const w = query({ ${literal}, handler: async (ctx, { kind }) => { if (ctx) { var kind = 'gamma'; } return ${call}; } });`,
    'a shadowed v': `export const w = (() => { const v = custom; return query({ ${literal}, handler: async (ctx, { kind }) => ${call} }); })();`,
    'a parameter default': `export const w = query({ ${literal}, handler: async (ctx, { kind } = { kind: 'gamma' }) => ${call} });`,
    'a TS this parameter': `export const w = query({ ${literal}, handler(this: Ctx, { kind }) { return ${call}; } });`,
    'a plain object, not a Convex builder': `export const w = { ${literal}, handler: async (ctx, { kind }) => ${call} };`,
    'a local builder': `const make = (d) => d; export const w = make({ ${literal}, handler: async (ctx, { kind }) => ${call} });`,
    'a shadowed builder': `export const w = ((query) => query({ ${literal}, handler: async (ctx, { kind }) => ${call} }))(id);`,
  });
  for (const [shape, handler] of Object.entries(shapes)) {
    const graph = testImportGraph(
      dispatch(handler, shape.includes('another module') ? './validators.ts' : undefined),
    );
    assert.equal(edge(graph, 'convex/gamma.ts', 'convex/dispatch.ts')?.kind, 'dynamic', shape);
  }
  // v.optional adds the absent value's text, which names no module; the literal still counts.
  const optional = testImportGraph(
    dispatch(
      `export const w = query({ args: { kind: v.optional(v.literal('alpha')) }, handler: async (ctx, { kind }) => ctx.runQuery(makeFunctionReference(\`\${kind}:listRows\`), {}) });`,
    ),
  );
  assert.equal(edge(optional, 'convex/alpha.ts', 'convex/dispatch.ts')?.kind, 'function-reference');
  assert.equal(edge(optional, 'convex/gamma.ts', 'convex/dispatch.ts'), undefined);
});

test('moduleUrl from a nested test folder resolves from its helper, not every file', () => {
  const files = base({
    'convex/order.ts': 'export const order = 1;',
    'convex/other.ts': 'export const other = 1;',
    'tests/convex-module.mjs': 'export const moduleUrl = path => new URL(path, import.meta.url).href;',
    'tests/sim/invariants.mjs': [
      "import { moduleUrl } from '../convex-module.mjs';",
      "export const order = await import(moduleUrl('../convex/order.ts'));",
    ].join('\n'),
    'tests/sim.test.mjs': "import './sim/invariants.mjs';",
  });
  assert.ok(selected(files, 'convex/order.ts').includes('tests/sim.test.mjs'));
  assert.ok(!selected(files, 'convex/other.ts').includes('tests/sim.test.mjs'));
  // A locally defined wrapper keeps the caller's folder, and an unresolved path still widens.
  files.set(
    'tests/sim/invariants.mjs',
    "const moduleUrl = name => new URL(`../dist/${name}.js`, import.meta.url).href; await import(moduleUrl('file-mode'));",
  );
  assert.ok(selected(files, 'convex/other.ts').includes('tests/sim.test.mjs'));
});

test('Node internals and installed-package paths are not repository loads; aliases and wrapped names still widen', () => {
  const files = base({
    'src/a.ts': 'export const a = 1;',
    'tests/internal.test.mjs': "const { x } = require('internal/fs/watchers');",
    'tests/alias.test.mjs': "await import('@local/a');",
    'tests/installed.test.mjs':
      "import { moduleUrl } from './convex-module.mjs'; await import(moduleUrl('../node_modules/pkg/src/crypto.ts'));",
    'tests/convex-module.mjs': 'export const moduleUrl = path => new URL(path, import.meta.url).href;',
    'tests/wrapped.test.mjs': "await import(new URL('a.js', process.env.DIST));",
    'tests/unknown.test.mjs': 'await import(process.argv[2]);',
  });
  const picked = selected(files, 'src/a.ts');
  assert.ok(!picked.includes('tests/internal.test.mjs'));
  assert.ok(!picked.includes('tests/installed.test.mjs'));
  // An unlocked bare name may be a local alias: every module it could be.
  assert.ok(picked.includes('tests/alias.test.mjs'));
  // `new URL('a.js', dist)` names a built module: still every module it could be.
  assert.ok(picked.includes('tests/wrapped.test.mjs'));
  assert.ok(picked.includes('tests/unknown.test.mjs'));
});

test('a path template in product code is workspace data, like a product literal; tests keep it as a load', () => {
  const files = base({
    'src/a.ts': 'export const a = 1;',
    'src/aliases.ts': 'export const aliases = name => [name, `dist/${name}.js`];',
    'tests/aliases.test.mjs': "import { aliases } from '../src/aliases.ts'; aliases('a');",
    'tests/reader.test.mjs': 'const name = pick(); readFileSync(`src/${name}.ts`);',
  });
  const graph = testImportGraph(files);
  assert.equal(edge(graph, 'src/a.ts', 'src/aliases.ts')?.kind, 'workspace-path');
  const picked = selected(files, 'src/a.ts');
  assert.ok(!picked.includes('tests/aliases.test.mjs'), 'not a workspace user: no cwd read reaches it');
  assert.ok(picked.includes('tests/reader.test.mjs'), 'a test template is still a dynamic read');
  // A workspace user (it runs product code with this repository as cwd) still gets it.
  files.set(
    'tests/aliases.test.mjs',
    "import { aliases } from '../src/aliases.ts'; aliases('a'); process.cwd();",
  );
  assert.ok(selected(files, 'src/a.ts').includes('tests/aliases.test.mjs'));
});

test('a script path or command name that is only compared runs nothing; any other use still does', () => {
  const files = base({
    'package.json': '{"scripts":{"verify":"node scripts/run.mjs"}}',
    'scripts/run.mjs': 'export const run = 1;',
    'scripts/compare.mjs':
      "export const root = path => path === 'scripts/run.mjs' || ['verify'].includes(path);",
    'scripts/spawn.mjs': "spawnSync(process.execPath, ['scripts/run.mjs']); const cmd = 'verify'; run(cmd);",
  });
  const graph = testImportGraph(files);
  assert.equal(edge(graph, 'scripts/run.mjs', 'scripts/compare.mjs'), undefined);
  assert.equal(edge(graph, 'package-script:verify', 'scripts/compare.mjs'), undefined);
  assert.ok(edge(graph, 'scripts/run.mjs', 'scripts/spawn.mjs'), 'a spawned script path is a run');
  assert.equal(edge(graph, 'package-script:verify', 'scripts/spawn.mjs')?.kind, 'package-command');
});

test('moduleUrl from a nested folder: branches, casts and templates are edges; unknown homes widen', () => {
  // Review 02c2111d (finding 1): each argument shape below names convex/order.ts through the helper.
  const files = shape =>
    base({
      'convex/order.ts': 'export const order = 1;',
      'convex/other.ts': 'export const other = 1;',
      'tests/convex-module.mjs': 'export const moduleUrl = path => new URL(path, import.meta.url).href;',
      'tests/sim/invariants.mjs': [
        "import { moduleUrl } from '../convex-module.mjs';",
        `export const order = await ${shape};`,
      ].join('\n'),
      'tests/sim.test.mjs': "import './sim/invariants.mjs';",
    });
  for (const shape of [
    "import(moduleUrl(flag ? '../convex/order.ts' : '../convex/order.ts'))",
    "import(moduleUrl(('../convex/order.ts')))",
    "import(moduleUrl('../convex/order.ts' as string))",
    "Promise.all(['order'].map(n => import(moduleUrl(`../convex/${n}.ts`))))",
  ]) {
    assert.ok(selected(files(shape), 'convex/order.ts').includes('tests/sim.test.mjs'), shape);
    assert.ok(!selected(files(shape), 'convex/other.ts').includes('tests/sim.test.mjs'), shape);
  }
  // A template it cannot enumerate names every module under the helper's ../convex/.
  const open = files('import(moduleUrl(`../convex/${pick()}.ts`))');
  assert.ok(selected(open, 'convex/other.ts').includes('tests/sim.test.mjs'));
  // A local declaration may shadow the import: the call's home is unknown, so it widens.
  const shadow = files(
    "(() => { const moduleUrl = p => new URL(p, 'file:///elsewhere/x/'); return import(moduleUrl('../convex/order.ts')); })()",
  );
  assert.ok(selected(shadow, 'convex/other.ts').includes('tests/sim.test.mjs'));
  // A re-exported loader resolves from its defining module, which this file does not name: widen.
  const reexport = base({
    'tests/convex-module.mjs': 'export const moduleUrl = path => new URL(path, import.meta.url).href;',
    'convex/order.ts': 'export const order = 1;',
    'tests/convex/order.ts': 'export const decoy = 1;',
    'tests/sub/reexport.mjs': "export { moduleUrl } from '../convex-module.mjs';",
    'tests/sub/x.mjs':
      "import { moduleUrl } from './reexport.mjs'; await import(moduleUrl('../convex/order.ts'));",
    'tests/sub.test.mjs': "import './sub/x.mjs';",
  });
  assert.ok(selected(reexport, 'convex/order.ts').includes('tests/sub.test.mjs'));
});

test('a Node internal is bare only inside require() or import(), never inside a module loader', () => {
  // Review 02c2111d (finding 3).
  const files = base({
    'src/a.ts': 'export const a = 1;',
    'tests/convex-module.mjs':
      'export const moduleUrl = path => new URL(path, import.meta.url).href; export const moduleSource = moduleUrl;',
    'tests/internal.test.mjs': "await import('internal/fs/watchers');",
    'tests/url.test.mjs':
      "import { moduleUrl } from './convex-module.mjs'; const u = moduleUrl('internal/foo'); runWorker(u);",
    'tests/source.test.mjs':
      "import { moduleSource } from './convex-module.mjs'; const s = moduleSource('internal/foo'); run(s);",
  });
  const picked = selected(files, 'src/a.ts');
  assert.ok(!picked.includes('tests/internal.test.mjs'));
  assert.ok(picked.includes('tests/url.test.mjs'));
  assert.ok(picked.includes('tests/source.test.mjs'));
});

test('incident 196d5e4e: a Convex module index from the inventory reaches no test; a computed read still widens', () => {
  // The selector named Convex modules as `convex/${name}.ts`: a computed read to its own graph, so every
  // Convex file reached the ~400 tests that load the selector, and re-checks ran most of the suite.
  const files = base({
    'convex/alpha.ts': 'export const a = 1;',
    'scripts/computed.mjs': [
      "import { readFileSync } from 'node:fs';",
      "export const load = name => readFileSync(`convex/${name}.ts`, 'utf8');",
    ].join('\n'),
    'scripts/indexed.mjs': [
      'export function modules(paths) {',
      '  const found = new Map();',
      '  for (const file of paths) {',
      '    const [, name] = file.match(/^convex\\/(.+)\\.ts$/) ?? [];',
      '    if (name) found.set(name, file);',
      '  }',
      '  return found;',
      '}',
    ].join('\n'),
    'tests/computed.test.mjs': "import { load } from '../scripts/computed.mjs'; load('alpha');",
    'tests/indexed.test.mjs': "import { modules } from '../scripts/indexed.mjs'; modules([]);",
  });
  const alpha = selected(files, 'convex/alpha.ts');
  assert.ok(alpha.includes('tests/computed.test.mjs'), 'a computed path read stays every matching file');
  assert.ok(!alpha.includes('tests/indexed.test.mjs'), 'an index built from the path list reads no file');
});

test('a tooling walk of named folders selects the tests that call it, not every module above it', () => {
  // sourceFiles() reads every file of the walked folders. A test calling it reads this tree; a tool
  // that loads the walker at run time usually runs on a fixture tree (Item 196d5e4e).
  const files = base({
    'convex/alpha.ts': 'export const a = 1;',
    'web/src/gamma.ts': 'export const g = 1;',
    'scripts/inventory.mjs': [
      "import { readdirSync, readFileSync } from 'node:fs';",
      "import { join, posix } from 'node:path';",
      "export function inventory(root = '.') {",
      '  const files = new Map();',
      '  function walk(dir) {',
      '    for (const entry of readdirSync(join(root, dir), { withFileTypes: true })) {',
      '      const path = posix.join(dir, entry.name);',
      '      if (entry.isDirectory()) walk(path);',
      "      else files.set(path, readFileSync(join(root, path), 'utf8'));",
      '    }',
      '  }',
      "  for (const dir of ['convex', 'scripts']) walk(dir);",
      '  return files;',
      '}',
      "export const label = 'inventory';",
    ].join('\n'),
    'scripts/other.mjs': 'export const other = 1;',
    'scripts/tool.mjs':
      "export const run = async root => (await import('./inventory.mjs')).inventory(root).size;",
    'tests/reader.test.mjs': "import { inventory } from '../scripts/inventory.mjs'; inventory();",
    'tests/label.test.mjs': "import { label } from '../scripts/inventory.mjs'; label;",
    'tests/tool.test.mjs': "import { run } from '../scripts/tool.mjs'; run('fixture');",
    'tests/other.test.mjs': "import { other } from '../scripts/other.mjs'; other;",
  });
  const graph = testImportGraph(files);
  assert.equal(edge(graph, 'convex/alpha.ts', 'tests/reader.test.mjs')?.kind, 'runtime-path');
  assert.equal(edge(graph, 'convex/alpha.ts', 'scripts/inventory.mjs'), undefined, 'no edge into the walker');
  const alpha = selected(files, 'convex/alpha.ts');
  assert.ok(alpha.includes('tests/reader.test.mjs'));
  assert.ok(!alpha.includes('tests/label.test.mjs'), 'an unrelated export of the walker');
  assert.ok(!alpha.includes('tests/tool.test.mjs'), 'a tool that loads the walker at run time');
  assert.ok(
    !selected(files, 'web/src/gamma.ts').includes('tests/reader.test.mjs'),
    'a folder it does not walk',
  );
  const other = selectTests({ files, paths: ['scripts/other.mjs'] });
  assert.equal(other.scope, 'scoped', other.reason);
  assert.ok(other.tests.includes('tests/reader.test.mjs') && other.tests.includes('tests/other.test.mjs'));
});

test('a tooling walk: wrapper defaults, bare and dynamic imports read; a folder read never hides a load', () => {
  // GPT review of Item 196d5e4e: each case would drop a reader, or turn a load into a data read.
  const walker = (folders, top = false) =>
    [
      "import { readdirSync, readFileSync } from 'node:fs';",
      "import { join, posix } from 'node:path';",
      "export function inventory(root = '.') {",
      '  const files = new Map();',
      '  function walk(dir) {',
      '    for (const entry of readdirSync(join(root, dir), { withFileTypes: true })) {',
      '      const path = posix.join(dir, entry.name);',
      '      if (entry.isDirectory()) walk(path);',
      "      else files.set(path, readFileSync(join(root, path), 'utf8'));",
      '    }',
      '  }',
      `  for (const dir of ${JSON.stringify(folders)}) walk(dir);`,
      '  return files;',
      '}',
      "export const label = 'inventory';",
      top ? 'export const tree = inventory();' : '',
    ].join('\n');
  const files = base({
    'convex/alpha.ts': 'export const a = 1;',
    'scripts/jobs/run.mjs': 'export const job = 1;',
    'scripts/inventory.mjs': walker(['convex', 'scripts']),
    'scripts/top.mjs': walker(['convex'], true),
    'scripts/plan.mjs': [
      "import { inventory } from './inventory.mjs';",
      'export const plan = (files = inventory()) => files.size;',
      'export const other = 1;',
    ].join('\n'),
    'tests/data-walker.mjs': walker(['tests']),
    'tests/helper-walker.mjs': walker(['convex']),
    'tests/plan.test.mjs': "import { plan } from '../scripts/plan.mjs'; plan();",
    'tests/other.test.mjs': "import { other } from '../scripts/plan.mjs'; other;",
    'tests/bare.test.mjs': "import '../scripts/top.mjs';",
    'tests/mixed.test.mjs': [
      "import { label } from '../scripts/inventory.mjs';",
      "const { inventory } = await import('../scripts/inventory.mjs');",
      'inventory(label);',
    ].join('\n'),
    'tests/jobs.test.mjs': [
      "import { inventory } from '../scripts/inventory.mjs';",
      'inventory();',
      'export const run = name => import(`../scripts/jobs/${name}.mjs`);',
    ].join('\n'),
    'tests/lists.test.mjs': "import { inventory } from './data-walker.mjs'; inventory();",
  });
  const alpha = selected(files, 'convex/alpha.ts');
  for (const reader of ['plan', 'bare', 'mixed', 'jobs'])
    assert.ok(alpha.includes(`tests/${reader}.test.mjs`), `${reader}: reads the inventory`);
  assert.ok(!alpha.includes('tests/other.test.mjs'), 'an export of the wrapper that never walks');
  // tests/lists reads tests/ as data, so it holds a folder edge from tests/helper-walker.mjs: that
  // edge must not count as running the helper's Convex walk.
  assert.ok(!alpha.includes('tests/lists.test.mjs'), 'a data edge is no call');
  const graph = testImportGraph(files);
  assert.equal(
    edge(graph, 'scripts/jobs/run.mjs', 'tests/jobs.test.mjs')?.kind,
    'dynamic',
    'the load stays a load',
  );
});
