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

test('forge/no-readonly-fsync rejects fsync through a read-only handle in src/ (89460350)', t => {
  const found = lint(t, {
    'src/dir.ts': `import { closeSync, fsyncSync, openSync } from 'node:fs';
export function f(path: string) {
  const directory = openSync(path, 'r');
  try {
    fsyncSync(directory);
  } finally {
    closeSync(directory);
  }
}
`,
    'src/async.ts': `import { open } from 'node:fs/promises';
const io = <T>(run: () => Promise<T>) => run();
export async function f(path: string) {
  const handle = await io(() => open(path));
  await handle.sync();
}
`,
    'src/ok.ts': `import { constants, fsyncSync, openSync } from 'node:fs';
import { open } from 'node:fs/promises';
const flags = () => (process.platform === 'win32' ? 'r+' : 'r');
export async function f(path: string) {
  const written = openSync(path, 'wx', 0o600);
  fsyncSync(written);
  const handle = await open(path, flags());
  await handle.sync();
  const both = openSync(path, constants.O_RDWR);
  fsyncSync(both);
}
`,
    // The rule covers the CLI in src/ only.
    'scripts/tool.mjs': `import { fsyncSync, openSync } from 'node:fs';
fsyncSync(openSync('.', 'r'));
`,
  });
  assert.deepEqual(found, [
    'src/async.ts:5:forge(no-readonly-fsync)',
    'src/dir.ts:5:forge(no-readonly-fsync)',
  ]);
});

test('forge/native-path-separator rejects a / after a native path call in src/ (89460350)', t => {
  const found = lint(t, {
    'src/sep.ts': `import { join, posix, sep } from 'node:path';
import path from 'node:path';
import { realpathSync } from 'node:fs';
import { dirname } from './repo-paths.js';
export const a = (o: string, r: string) => r.startsWith(join(o, 'work') + '/');
export const b = (o: string) => \`\${path.resolve(o)}/x\`;
export const c = (o: string) => \`\${realpathSync.native(o)}/x\`;
export const ok = (o: string, r: string) => [
  posix.join(o, 'a') + '/',
  ['a', 'b'].join('/') + '/',
  \`\${dirname(r)}/\`,
  r.startsWith(join(o, 'work') + sep),
];
`,
  });
  assert.deepEqual(found, [
    'src/sep.ts:5:forge(native-path-separator)',
    'src/sep.ts:6:forge(native-path-separator)',
    'src/sep.ts:7:forge(native-path-separator)',
  ]);
});

test('forge/no-raw-mode-bits rejects raw executable or group/other bit reads outside file-mode.ts (89460350)', t => {
  const found = lint(t, {
    'src/capture.ts': `export const mode = (stat: { mode: number }) => (stat.mode & 0o111 ? 'executable' : 'file');
`,
    'src/file-mode.ts': `export const bit = (mode: number) => mode & 0o111;
`,
    'src/other.ts': `export const read = (mode: number) => mode & 0o444;
`,
    'src/private.ts': `export const shared = (mode: number) => Boolean(mode & 0o077);
`,
  });
  assert.deepEqual(found, [
    'src/capture.ts:1:forge(no-raw-mode-bits)',
    'src/private.ts:1:forge(no-raw-mode-bits)',
  ]);
});

test('forge/raw-symlink rejects symlink calls outside source-links.ts (89460350)', t => {
  const found = lint(t, {
    'src/link.ts': `import { symlinkSync } from 'node:fs';
import { symlink } from 'node:fs/promises';
export const a = (t: string, p: string) => symlinkSync(t, p, 'dir');
export const b = (t: string, p: string) => symlink(t, p);
`,
    'src/source-links.ts': `import { symlinkSync } from 'node:fs';
export const ok = (t: string, p: string) => symlinkSync(t, p);
`,
  });
  assert.deepEqual(found, ['src/link.ts:3:forge(raw-symlink)', 'src/link.ts:4:forge(raw-symlink)']);
});

test('forge/rename-over-directory rejects renaming onto a just-claimed directory (89460350)', t => {
  const found = lint(t, {
    'src/publish.ts': `import { mkdirSync, renameSync } from 'node:fs';
export function publish(from: string, to: string, file: string, parent: string) {
  mkdirSync(to, { mode: 0o700 });
  renameSync(from, to);
  mkdirSync(parent, { recursive: true });
  renameSync(file, parent);
}
export function branches(from: string, to: string, directory: boolean) {
  if (directory) {
    mkdirSync(to);
    return;
  }
  renameSync(from, to);
}
`,
  });
  assert.deepEqual(found, ['src/publish.ts:4:forge(rename-over-directory)']);
});

test('every product rule documents itself and names the incident it guards', () => {
  for (const [name, rule] of Object.entries(plugin.rules)) {
    assert.match(rule.meta.docs.description, /incident/, name);
    assert.ok(readFileSync('docs/agents/lint-rules.md', 'utf8').includes(`forge/${name}`), name);
  }
});
