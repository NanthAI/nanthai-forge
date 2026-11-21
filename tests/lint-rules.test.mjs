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
import { lower, serialize } from '../scripts/lint-test-hygiene.mjs';
import { TEST_HYGIENE_CANDIDATE } from '../scripts/oxc.mjs';
import { plants, sleeps } from './lint-test-hygiene-plants.mjs';

function lint(t, files, extra = {}) {
  const root = mkdtempSync(join(tmpdir(), 'forge-lint-rules-'));
  t.after(() => rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }));
  for (const path of ['.oxlintrc.json', 'scripts/lint/forge-plugin.mjs']) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), readFileSync(path));
  }
  for (const [path, text] of Object.entries({ ...files, ...extra })) {
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

// Guard 7 (Item 611a1795): the four test-hygiene rules and their frozen-count allowlist. The planted
// sources live in tests/lint-test-hygiene-plants.mjs, which the test-signal ratchet does not scan.
test('forge/test-no-fixed-sleep rejects a fixed sleep used as a wait, accepts events and yields', t => {
  assert.deepEqual(lint(t, plants.sleep), [
    'tests/atomics.test.mjs:3:forge(test-no-fixed-sleep)',
    'tests/callback.test.mjs:3:forge(test-no-fixed-sleep)',
    'tests/helper.test.mjs:3:forge(test-no-fixed-sleep)',
    'tests/promise.test.mjs:3:forge(test-no-fixed-sleep)',
    'tests/spawned.test.mjs:3:forge(test-no-fixed-sleep)',
    'tests/timers.test.mjs:3:forge(test-no-fixed-sleep)',
  ]);
});

test('forge/test-no-retries rejects a retry option on a test, a suite or a hook', t => {
  assert.deepEqual(lint(t, plants.retry), [
    'tests/jest.test.mjs:2:forge(test-no-retries)',
    'tests/option.test.mjs:2:forge(test-no-retries)',
    'tests/suite.test.mjs:2:forge(test-no-retries)',
  ]);
});

test('forge/test-no-raised-timeout rejects a per-test timeout over 10 s, accepts short ones and spawn options', t => {
  assert.deepEqual(lint(t, plants.timeout), [
    'tests/config.test.mjs:2:forge(test-no-raised-timeout)',
    'tests/config.test.mjs:3:forge(test-no-raised-timeout)',
    'tests/hook.test.mjs:2:forge(test-no-raised-timeout)',
    'tests/raised.test.mjs:2:forge(test-no-raised-timeout)',
  ]);
});

test('forge/test-no-unsignaled-polling rejects timer polling, a sleep in a loop and poll(fn) helpers', t => {
  assert.deepEqual(lint(t, plants.poll), [
    'tests/helper.test.mjs:2:forge(test-no-unsignaled-polling)',
    'tests/interval.test.mjs:2:forge(test-no-unsignaled-polling)',
    'tests/loop.test.mjs:2:forge(test-no-unsignaled-polling)',
  ]);
});

test('test-hygiene allowlist: a file keeps its count and no more, and must shrink when it drops below', t => {
  const files = {
    'tests/same.test.mjs': sleeps(2),
    'tests/more.test.mjs': sleeps(3),
    'tests/less.test.mjs': sleeps(1),
  };
  const allowlist = {
    version: 1,
    files: {
      'tests/same.test.mjs': { sleep: 2 },
      'tests/more.test.mjs': { sleep: 2 },
      'tests/less.test.mjs': { sleep: 2 },
    },
  };
  assert.deepEqual(lint(t, files, { 'tests/test-hygiene-allowlist.json': JSON.stringify(allowlist) }), [
    // The one that dropped below its allowance must shrink the entry; the extra sleep fails on its own line.
    'tests/less.test.mjs:1:forge(test-no-fixed-sleep)',
    'tests/more.test.mjs:4:forge(test-no-fixed-sleep)',
  ]);
  // Without an allowlist nothing is allowed.
  assert.equal(lint(t, { 'tests/same.test.mjs': sleeps(2) }).length, 2);
});

test('the lint pre-filter keeps every planted test-hygiene example, so skipped test files cannot hide a hit', () => {
  for (const [rule, files] of Object.entries(plants))
    for (const [path, text] of Object.entries(files))
      if (path.startsWith('tests/') && !path.endsWith('ok.test.mjs'))
        assert.match(text, TEST_HYGIENE_CANDIDATE, `${rule}: ${path}`);
});

test('the allowlist updater only lowers: it drops deleted and cleared files and reports a file above its entry', () => {
  const allowed = {
    'tests/a.test.mjs': { sleep: 3, poll: 1 },
    'tests/gone.test.mjs': { sleep: 1 },
    'tests/clean.test.mjs': { retry: 1 },
    'tests/up.test.mjs': { sleep: 1 },
  };
  const current = {
    'tests/a.test.mjs': { sleep: 2, poll: 1 },
    'tests/up.test.mjs': { sleep: 2 },
    'tests/new.test.mjs': { timeout: 1 },
  };
  const { files, above } = lower(allowed, current);
  assert.deepEqual(files, { 'tests/a.test.mjs': { sleep: 2, poll: 1 }, 'tests/up.test.mjs': { sleep: 1 } });
  assert.deepEqual(above, [
    'tests/up.test.mjs: 2 sleep, allowed 1',
    'tests/new.test.mjs: not in the allowlist, {"timeout":1}',
  ]);
  assert.deepEqual(JSON.parse(serialize(files)), { version: 1, files });
});

test('forge/test-no-implicit-date rejects new ambient clock reads, including in an existing test file', t => {
  const sources = {
    'tests/calendar.test.mjs': [
      'const previous = Date.now;',
      'const timestamp = globalThis.Date["now"]();',
      'const today = new window.Date();',
      'const text = Date(0);',
      'const noParens = new Date;',
      'const fixed = new Date(Date.UTC(2026, 10, 10, 12));',
      'Date.now = () => fixed.getTime();',
      'function local(Date) { return new Date(); }',
      '// Date.now() and new Date() in a comment are not clock reads.',
    ].join('\n'),
    'tests/new.test.mjs': 'const time = Date.now();',
  };
  const allowlist = serialize({ 'tests/calendar.test.mjs': { date: 1 } });
  for (const source of Object.values(sources)) assert.match(source, TEST_HYGIENE_CANDIDATE);
  assert.deepEqual(lint(t, sources, { 'tests/test-hygiene-allowlist.json': allowlist }), [
    'tests/calendar.test.mjs:2:forge(test-no-implicit-date)',
    'tests/calendar.test.mjs:3:forge(test-no-implicit-date)',
    'tests/calendar.test.mjs:4:forge(test-no-implicit-date)',
    'tests/calendar.test.mjs:5:forge(test-no-implicit-date)',
    'tests/new.test.mjs:1:forge(test-no-implicit-date)',
  ]);
});
