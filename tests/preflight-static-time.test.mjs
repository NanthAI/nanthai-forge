// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Ferdinando Valsecchi
import assert from 'node:assert/strict';
import test from 'node:test';
import { spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runStaticChecks } from '../dist/agent-preflight-static.js';
import { spawnCaptured } from '../dist/agent-preflight-capture.js';
import {
  convexGraphDigest,
  convexPassStillHolds,
  convexPreflightHints,
  recordConvexPass,
  touchesConvexGraph,
} from '../scripts/check-convex-runtime.mjs';
import { changedOxcPaths } from '../scripts/oxc.mjs';

// 7772aa23: local static preflight took ~17.8 s because every selected command ran in full for any
// saved change. Forge now names the saved paths (and a cache folder) to each static command, the Convex
// guard reuses its last full pass, the foundation scan covers only changed files, long commands print
// while they run, and an inferred (undeclared) format check advises instead of refusing.

const temp = t => {
  const dir = mkdtempSync(join(tmpdir(), 'forge-static-time-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
};
const node = (name, code, extra = {}) => ({
  name,
  command: [process.execPath, '-e', code],
  inputs: null,
  source: 'declared',
  ...extra,
});

test('static commands read the saved paths from a NUL-terminated file and get a cache folder of their own', t => {
  const dir = temp(t);
  const cache = join(dir, 'cache');
  const dump = join(dir, 'seen.json');
  const code = `require('fs').writeFileSync(${JSON.stringify(dump)}, JSON.stringify({ file: process.env.FORGE_PREFLIGHT_CHANGED_FILE, paths: require('fs').readFileSync(process.env.FORGE_PREFLIGHT_CHANGED_FILE, 'utf8'), cache: process.env.FORGE_PREFLIGHT_CACHE_DIR }))`;
  const paths = ['src/a.ts', 'docs/with space.md', 'odd\nname.ts'];
  const [first, second] = runStaticChecks(
    dir,
    [node('one', code), node('two', 'process.exit(0)')],
    process.env,
    10_000,
    {
      changed: paths,
      cache,
    },
  );
  assert.equal(first.outcome, 'passed');
  assert.equal(second.outcome, 'passed');
  const seen = JSON.parse(readFileSync(dump, 'utf8'));
  assert.deepEqual(seen.paths.split('\0').filter(Boolean), paths, 'every path, exactly, NUL-terminated');
  assert.ok(seen.cache.startsWith(cache) && seen.cache !== cache, 'a folder of its own inside the cache');
  assert.ok(existsSync(seen.cache));
  assert.equal(existsSync(seen.file), false, 'the paths file is removed when the run ends');
});

test('unknown paths, no scope and the base comparison run get no hints: they check everything', t => {
  const dir = temp(t);
  const probe = node(
    'probe',
    `if (process.env.FORGE_PREFLIGHT_CHANGED_FILE || process.env.FORGE_PREFLIGHT_CACHE_DIR) process.exit(7)`,
  );
  assert.equal(runStaticChecks(dir, [probe], process.env, 10_000)[0].outcome, 'passed');
  assert.equal(
    runStaticChecks(dir, [probe], process.env, 10_000, { changed: null, cache: join(dir, 'c') })[0].outcome,
    'passed',
  );
  // Fails on a hinted run (the change's file is named), passes on the base copy: the base run is unhinted.
  writeFileSync(join(dir, 'f.txt'), 'new\n');
  const check = node(
    'hinted',
    `if (process.env.FORGE_PREFLIGHT_CHANGED_FILE) { console.error('f.txt is wrong'); process.exit(1) }`,
  );
  const verdict = runStaticChecks(dir, [check], process.env, 10_000, {
    changed: ['f.txt'],
    base: () => Buffer.from('old\n'),
    scratch: join(dir, 'scratch'),
  })[0];
  assert.equal(verdict.outcome, 'failed');
});

test('an inferred (undeclared) check advises on failure; a declared one still refuses', t => {
  const dir = temp(t);
  const fail = 'console.error("bad.ts is not formatted"); process.exit(1)';
  const [inferred, declared] = runStaticChecks(
    dir,
    [node('format:check', fail, { source: 'conventional' }), node('format:check', fail)],
    process.env,
    10_000,
    { changed: ['bad.ts'] },
  );
  assert.equal(inferred.outcome, 'unjudged');
  assert.match(inferred.advisory, /inferred from a conventional script name.*advice only.*Declare it/);
  assert.match(inferred.excerpt, /bad\.ts is not formatted/, 'the diagnostic is still kept');
  assert.equal(declared.outcome, 'failed');
  // Also with no scope: an inferred check never blocks, a declared one always does.
  assert.equal(
    runStaticChecks(dir, [node('x', fail, { source: 'conventional' })], process.env, 10_000)[0].outcome,
    'unjudged',
  );
  assert.equal(runStaticChecks(dir, [node('x', fail)], process.env, 10_000)[0].outcome, 'failed');
});

test('a long static command prints while it runs, keeps its tail, and a timeout stops it', t => {
  const dir = temp(t);
  const gate = join(dir, 'gate');
  // The command prints, then waits for the file that only this test creates when it has SEEN the print:
  // finishing at all proves the output arrived while the command was still running.
  const waiting = `const fs = require('fs'); console.error('first'); const end = Date.now() + 20000; while (!fs.existsSync(${JSON.stringify(gate)}) && Date.now() < end); console.error(fs.existsSync(${JSON.stringify(gate)}) ? 'second' : 'never released'); process.exit(4)`;
  const run = spawnCaptured(
    process.execPath,
    ['-e', waiting],
    { cwd: dir, env: process.env, timeout: 30_000 },
    false,
    {
      echo: false,
      onText: text => {
        if (text.includes('first')) writeFileSync(gate, '');
      },
    },
  );
  assert.equal(run.status, 4);
  assert.equal(run.errorCode, null);
  assert.match(run.tail, /first\nsecond/);
  const spin = spawnCaptured(
    process.execPath,
    ['-e', `console.error('started'); for (;;);`],
    { cwd: dir, env: process.env, timeout: 300 },
    false,
    { echo: false },
  );
  assert.equal(spin.errorCode, 'ETIMEDOUT');
  assert.equal(spin.status, null);
  assert.match(spin.tail, /started/);
  const missing = spawnCaptured('forge-no-such-program-7772aa23', [], { cwd: dir, env: process.env }, false, {
    echo: false,
  });
  assert.equal(missing.status, 127, 'a program that is not installed reports the shell status');
  const gone = spawnCaptured(
    process.execPath,
    ['-e', ''],
    { cwd: join(dir, 'missing'), env: process.env },
    false,
    { echo: false },
  );
  assert.equal(gone.errorCode, 'ENOENT', 'a missing directory is reported, never thrown');
});

// A small Convex-shaped tree: convex/a.ts reaches src/used.ts; src/unused.ts is not reached.
function convexTree(t) {
  const root = temp(t);
  const write = (path, body) => {
    mkdirSync(join(root, path, '..'), { recursive: true });
    writeFileSync(join(root, path), body);
  };
  write('package.json', '{}');
  write('package-lock.json', '{"lock":1}');
  write('convex/a.ts', "import { used } from '../src/used';\nexport const a = used;\n");
  write('src/used.ts', 'export const used = 1;\n');
  write('src/unused.ts', 'export const unused = 1;\n');
  write('scripts/check-convex-runtime.mjs', '// guard\n');
  write('scripts/check-convex-bundle.mjs', '// guard\n');
  return { root, write, reached: ['convex/a.ts', 'src/used.ts'] };
}

test('the Convex guard exits early only when no changed path can touch its graph and the graph still matches', t => {
  const { root, write, reached } = convexTree(t);
  const env = (changed, extra = {}) => {
    const file = join(root, `.changed-${Math.random()}`);
    writeFileSync(file, changed.map(path => `${path}\0`).join(''));
    return { FORGE_PREFLIGHT_CHANGED_FILE: file, FORGE_PREFLIGHT_CACHE_DIR: join(root, '.cache'), ...extra };
  };
  const holds = (changed, extra) => {
    const hints = convexPreflightHints(env(changed, extra), root);
    return hints ? convexPassStillHolds(hints, root) : false;
  };
  // No record yet: full pass.
  assert.equal(holds(['src/unused.ts']), false);
  recordConvexPass(convexPreflightHints(env(['src/unused.ts']), root), root, [
    ...reached,
    'node_modules/x/index.js',
  ]);
  assert.equal(holds(['src/unused.ts']), true, 'an unrelated source change');
  assert.equal(holds(['docs/readme.md', 'src/brand-new.ts']), true, 'docs and new files that shadow nothing');
  // A change that can touch the graph forces a full pass.
  for (const path of [
    'src/used.ts',
    'convex/b.ts',
    'package.json',
    'package-lock.json',
    'scripts/check-convex-runtime.mjs',
    'tsconfig.json',
  ])
    assert.equal(holds([path]), false, path);
  // A new file that would shadow a reached module's resolution (same name, another extension, or an index).
  assert.equal(touchesConvexGraph(['src/used.tsx'], reached), true);
  assert.equal(touchesConvexGraph(['src/used/index.ts'], reached), true);
  assert.equal(touchesConvexGraph(['src/other.ts'], reached), false);
  // Unknown paths (no file) never exit early; a lock change invalidates the record.
  assert.equal(holds(['src/unused.ts'], { FORGE_PREFLIGHT_CHANGED_FILE: join(root, 'missing') }), false);
  write('package-lock.json', '{"lock":2}');
  assert.equal(holds(['src/unused.ts']), false, 'a changed lockfile');
  write('package-lock.json', '{"lock":1}');
  assert.equal(holds(['src/unused.ts']), true);
  // The base moved on and brought a change to a reached module the changed paths do not name:
  // the digest catches it, so the guard runs in full.
  write('src/used.ts', "import 'node:fs';\nexport const used = 1;\n");
  assert.equal(holds(['src/unused.ts']), false, 'a reached module changed underneath');
  write('src/used.ts', 'export const used = 1;\n');
  assert.equal(holds(['src/unused.ts']), true);
  // Likewise a Convex module that now reaches another file.
  write(
    'convex/a.ts',
    "import { used } from '../src/used';\nimport { unused } from '../src/unused';\nexport const a = used + unused;\n",
  );
  assert.equal(holds(['src/unused.ts']), false, 'a changed Convex module');
  // Corrupt or unreadable records run the full pass.
  const hints = convexPreflightHints(env(['src/unused.ts']), root);
  writeFileSync(join(hints.directory, 'convex-reached.json'), 'not json');
  assert.equal(convexPassStillHolds(hints, root), false);
  // Without the cache folder (the hosted check, a direct run) nothing is ever reused.
  assert.equal(
    convexPreflightHints({ FORGE_PREFLIGHT_CHANGED_FILE: env([]).FORGE_PREFLIGHT_CHANGED_FILE }, root),
    null,
  );
});

test('the Convex graph digest sees contents, missing modules and shadowing siblings, not unrelated files', t => {
  const { root, write, reached } = convexTree(t);
  const base = convexGraphDigest(root, reached);
  write('src/unused.ts', 'export const unused = 2;\n');
  write('docs/x.md', 'new\n');
  assert.equal(convexGraphDigest(root, reached), base, 'unrelated files do not move it');
  write('src/used.tsx', 'export const used = 2;\n');
  assert.notEqual(convexGraphDigest(root, reached), base, 'a sibling that could shadow a reached module');
  rmSync(join(root, 'src/used.tsx'));
  assert.equal(convexGraphDigest(root, reached), base);
  rmSync(join(root, 'src/used.ts'));
  assert.notEqual(convexGraphDigest(root, reached), base, 'a reached module that is gone');
});

test('the Convex guard script runs in full without hints and records and reuses a pass with them', t => {
  // The real path: the script runs its main block only when it is the entry point by that name.
  const root = realpathSync(convexTree(t).root);
  // A real run needs esbuild and typescript: link this repository's copies.
  const modules = new URL('../node_modules', import.meta.url).pathname;
  spawnSync('ln', ['-s', modules, join(root, 'node_modules')]);
  const scripts = new URL('../scripts/', import.meta.url).pathname;
  for (const name of ['check-convex-runtime.mjs', 'check-convex-bundle.mjs'])
    writeFileSync(join(root, 'scripts', name), readFileSync(join(scripts, name)));
  const registered =
    "import { queryGeneric } from 'convex/server';\nexport const a = queryGeneric({ args: {}, handler: async () => 1 });\n";
  writeFileSync(join(root, 'convex/a.ts'), registered);
  const changed = join(root, 'changed');
  writeFileSync(changed, 'docs/x.md\0');
  const run = extra =>
    spawnSync(process.execPath, [join(root, 'scripts/check-convex-runtime.mjs')], {
      cwd: root,
      encoding: 'utf8',
      env: { PATH: process.env.PATH, ...extra },
    });
  const hinted = { FORGE_PREFLIGHT_CHANGED_FILE: changed, FORGE_PREFLIGHT_CACHE_DIR: join(root, 'cache') };
  const plain = run({});
  assert.equal(plain.status, 0, plain.stderr);
  assert.match(plain.stdout, /Convex V8 graph/);
  assert.equal(existsSync(join(root, 'cache')), false, 'a direct run keeps no cache');
  const first = run(hinted);
  assert.equal(first.status, 0, first.stderr);
  assert.match(first.stdout, /Convex V8 graph/, 'first hinted run is a full pass that records');
  const second = run(hinted);
  assert.equal(second.status, 0, second.stderr);
  assert.match(second.stdout, /Convex V8 guard skipped/);
  assert.doesNotMatch(second.stdout, /Convex V8 graph/);
  // A violation is never cached over: a Convex module reaching a Node builtin fails in full.
  writeFileSync(join(root, 'convex/a.ts'), `import 'node:fs';\n${registered}`);
  const broken = run(hinted);
  assert.equal(broken.status, 1);
  assert.match(broken.stderr, /CONVEX_RUNTIME_IMPORT/);
});

test('oxc format and lint read only the changed files, unless tool configuration changed', t => {
  const dir = temp(t);
  const named = paths => {
    const file = join(dir, `c-${Math.random()}`);
    writeFileSync(file, paths.map(path => `${path}\0`).join(''));
    return { FORGE_PREFLIGHT_CHANGED_FILE: file };
  };
  assert.deepEqual([...changedOxcPaths(named(['src/a.ts', 'docs/x.md']))], ['src/a.ts', 'docs/x.md']);
  for (const path of [
    '.oxfmtrc.json',
    '.oxlintrc.json',
    '.gitignore',
    'package.json',
    'package-lock.json',
    'scripts/oxc.mjs',
    'scripts/lint/forge-plugin.mjs',
  ])
    assert.equal(changedOxcPaths(named(['src/a.ts', path])), null, path);
  assert.equal(changedOxcPaths({}), null);
  assert.equal(changedOxcPaths({ FORGE_PREFLIGHT_CHANGED_FILE: join(dir, 'missing') }), null);
});

test('the foundation scan covers only changed files when paths are named, and everything otherwise', t => {
  const dir = temp(t);
  const named = paths => {
    const file = join(dir, `c-${Math.random()}`);
    writeFileSync(file, paths.map(path => `${path}\0`).join(''));
    return { PATH: process.env.PATH, FORGE_PREFLIGHT_CHANGED_FILE: file };
  };
  const run = env => spawnSync(process.execPath, ['scripts/check-foundation.mjs'], { encoding: 'utf8', env });
  const scoped = run(named(['src/agent-preflight-static.ts']));
  assert.equal(scoped.status, 0, scoped.stderr);
  assert.match(scoped.stdout, /^Foundation checks passed: 1 changed of \d+ files;/);
  // A scanner changed, or a path is gone (a link elsewhere may now be dead): the whole tree is scanned.
  for (const paths of [['scripts/check-spdx.mjs'], ['docs/no-such-file-7772aa23.md']]) {
    const full = run(named(paths));
    assert.equal(full.status, 0, full.stderr);
    assert.match(full.stdout, /^Foundation checks passed: \d+ files;/, paths[0]);
  }
});
