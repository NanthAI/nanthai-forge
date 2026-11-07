// SPDX-License-Identifier: Apache-2.0
// Product lint rules in scripts/lint/forge-plugin.mjs (Issue 8b7b97ce): each rule fails on its
// incident fixture and accepts the bounded forms used on main.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import test from 'node:test';
import plugin from '../scripts/lint/forge-plugin.mjs';

function lint(t, files) {
  const root = mkdtempSync(join(tmpdir(), 'forge-lint-rules-'));
  t.after(() => rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }));
  for (const path of ['.oxlintrc.json', 'scripts/lint/forge-plugin.mjs']) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), readFileSync(path));
  }
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), text);
  }
  const result = spawnSync(
    process.execPath,
    [resolve('node_modules/oxlint/bin/oxlint'), '--threads', '2', '--format', 'json', ...Object.keys(files)],
    { cwd: root, encoding: 'utf8' },
  );
  assert.equal(result.error, undefined);
  const diagnostics = JSON.parse(result.stdout).diagnostics.filter(d => d.code.startsWith('forge('));
  return diagnostics.map(d => `${d.filename}:${d.labels[0].span.line}:${d.code}`).sort();
}

const header = "import { query } from './_generated/server';\n";

test('forge/no-convex-collect rejects .collect() in convex/, bounded reads pass', t => {
  const found = lint(t, {
    'convex/collect.ts': `${header}export const f = query({ args: {}, handler: async ctx =>
  ctx.db.query('rows').withIndex('by_project', q => q.eq('projectId', 'p')).collect() });
`,
    'convex/take.ts': `${header}export const f = query({ args: {}, handler: async ctx =>
  ctx.db.query('rows').withIndex('by_project', q => q.eq('projectId', 'p')).take(100) });
`,
    // Outside convex/ the rule does not apply (arrays, streams and iterators have their own collect).
    'src/collect.ts': 'export const f = (s: { collect(): number[] }) => s.collect();\n',
  });
  assert.deepEqual(found, ['convex/collect.ts:3:forge(no-convex-collect)']);
});

test('forge/convex-bounded-query rejects a query without index or limit (e32cb0e7, 1b66b35a)', t => {
  const found = lint(t, {
    'convex/scan.ts': `${header}export const f = query({ args: {}, handler: async ctx => {
  const out = [];
  for await (const row of ctx.db.query('rows')) out.push(row);
  return out;
} });
`,
    'convex/filter.ts': `${header}export const f = query({ args: {}, handler: async ({ db }) =>
  db.query('rows').filter(q => q.eq(q.field('projectId'), 'p')).order('desc') });
`,
    'convex/variable.ts': `${header}export const f = query({ args: {}, handler: async ctx => {
  const rows = ctx.db.query('rows');
  await rows.withIndex('by_project', q => q.eq('projectId', 'p')).first();
  return rows.order('desc');
} });
`,
  });
  assert.deepEqual(found, [
    'convex/filter.ts:3:forge(convex-bounded-query)',
    'convex/scan.ts:4:forge(convex-bounded-query)',
    'convex/variable.ts:3:forge(convex-bounded-query)',
  ]);
});

test('forge/convex-bounded-query accepts index, limit, pagination and an indexed variable', t => {
  const found = lint(t, {
    'convex/ok.ts': `${header}export const f = query({ args: {}, handler: async ctx => {
  const all = Math.random() > 0.5;
  const rows = ctx.db.query('rows');
  const scoped = all ? rows.withIndex('by_project') : rows.withIndex('by_parent');
  await ctx.db.system.query('_storage').order('desc').paginate({ cursor: null, numItems: 100 });
  await ctx.db.query('rows').order('desc').take(10);
  await ctx.db.query('rows').withSearchIndex('search', q => q.search('text', 'x')).take(5);
  await ctx.db.query('rows').withIndex('by_id', q => q.eq('id', 'x')).unique();
  // oxlint-disable-next-line forge/convex-bounded-query -- fixture: suppressions need a stated reason
  const raw = ctx.db.query('rows');
  return [scoped, raw];
} });
`,
  });
  assert.deepEqual(found, []);
});

test('every product rule documents itself and names the incident it guards', () => {
  for (const [name, rule] of Object.entries(plugin.rules)) {
    assert.match(rule.meta.docs.description, /incident/, name);
    assert.ok(readFileSync('docs/agents/lint-rules.md', 'utf8').includes(`forge/${name}`), name);
  }
});
