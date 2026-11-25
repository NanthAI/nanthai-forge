// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Ferdinando Valsecchi
// One-step failing-first proof (friction ccf1d4b0): run the new tests against main's sources.
//
//   node scripts/failing-first.mjs [--lane LANE_PATH] TEST_FILE...
//
// Copies the Lane to a temporary folder, puts main's bytes back over every changed non-test file
// (a file the Lane added is removed), and runs the tests there under `nforge heavy`. Exit 0 means the tests
// FAIL on main (they prove the change); exit 1 means they pass on main (they prove nothing). The Lane itself
// is never edited. Reads only: `diff`, `status`, `show` of main (one page each, no Convex write).
import { cpSync, mkdtempSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { mkdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { childEnv } from './child-env.mjs';

/** The paths whose bytes go back to main's: changed files that are neither tests nor the named test files. */
export function overlayPlan(changes, tests) {
  const named = new Set(tests.map(path => path.replace(/^\.\//, '')));
  const seen = new Map();
  for (const { path, change } of changes)
    if (!path.startsWith('tests/') && !named.has(path)) seen.set(path, change);
  return [...seen].map(([path, change]) => ({ path, action: change === 'added' ? 'remove' : 'restore' }));
}

function nforge(lane, action, command, binary = false) {
  const run = spawnSync('nforge', ['agent', lane, action, JSON.stringify(command)], {
    env: childEnv({ allow: ['FORGE_HOME', 'XDG_CONFIG_HOME', 'XDG_CACHE_HOME'] }),
    maxBuffer: 256 * 1024 * 1024,
    encoding: binary ? 'buffer' : 'utf8',
  });
  if (run.status !== 0) throw new Error(`nforge ${action} failed: ${String(run.stderr).slice(0, 300)}`);
  return run.stdout;
}
const json = text => JSON.parse(String(text).slice(String(text).indexOf('{')));

/** Saved changes against the Lane's base plus unsaved local ones, as {path, change}. */
function laneChanges(lane) {
  const pin = json(nforge(lane, 'diff', { summary: true })).result;
  if (pin?.base && pin?.main && pin.base !== pin.main)
    throw new Error(
      `FAILING_FIRST_BEHIND: main moved since this Lane's base (${String(pin.base).slice(0, 8)} -> ${String(pin.main).slice(0, 8)}); run save --sync first so the copy holds all of main.`,
    );
  const changes = [];
  let cursor;
  do {
    const reply = json(nforge(lane, 'diff', { byteBudget: 1, ...(cursor ? { cursor } : {}) }));
    for (const item of reply.result?.items ?? []) changes.push({ path: item.path, change: item.status });
    cursor = reply.result?.nextCursor;
  } while (cursor);
  const status = json(nforge(lane, 'status', { files: true }));
  for (const { path, change } of status.result?.unsaved?.paths ?? [])
    if (!changes.some(item => item.path === path)) changes.push({ path, change });
  return changes;
}

export function failingFirst(argv, deps = {}) {
  const lane = resolve(argv.includes('--lane') ? argv[argv.indexOf('--lane') + 1] : '.');
  const tests = argv.filter((arg, at) => !arg.startsWith('--') && argv[at - 1] !== '--lane');
  if (!tests.length) throw new Error('FAILING_FIRST_ARGS: name the test files, e.g. tests/x.test.mjs');
  const plan = overlayPlan((deps.changes ?? laneChanges)(lane), tests);
  const copy = mkdtempSync(join(tmpdir(), 'failing-first-'));
  try {
    for (const name of readdirSync(lane))
      if (!['.forge', 'node_modules', 'dist'].includes(name))
        cpSync(join(lane, name), join(copy, name), { recursive: true, verbatimSymlinks: true });
    symlinkSync(join(lane, 'node_modules'), join(copy, 'node_modules'));
    // The copy needs the Lane marker for nforge, and a built dist of its own sources: heavy rebuilds it.
    for (const { path, action } of plan) {
      const target = join(copy, path);
      // A copied link is replaced, never written through to the Lane.
      rmSync(target, { force: true });
      if (action === 'restore') {
        const bytes = (deps.main ?? (p => nforge(lane, 'show', { channel: 'main', path: p }, true)))(path);
        mkdirSync(dirname(target), { recursive: true });
        writeFileSync(target, bytes);
      }
    }
    console.log(
      `Failing-first: ${plan.length} source file${plan.length === 1 ? '' : 's'} put back to main's bytes${plan.length ? `: ${plan.map(item => item.path).join(', ')}` : ''}.`,
    );
    const run = spawnSync(
      'nforge',
      ['heavy', 'node', '--import', './tests/check-runtime.mjs', '--test', ...tests],
      {
        cwd: copy,
        encoding: 'utf8',
        maxBuffer: 64 * 1024 * 1024,
        env: childEnv({ allow: ['FORGE_HOME', 'XDG_CONFIG_HOME'] }),
      },
    );
    process.stdout.write(String(run.stdout ?? ''));
    process.stderr.write(String(run.stderr ?? ''));
    // Only a run that discovered tests and saw some fail counts; a launch, build or discovery error is not proof.
    const count = name => Number(new RegExp(`^ℹ ${name} (\\d+)`, 'm').exec(String(run.stdout))?.[1] ?? NaN);
    if (run.status === null || !(count('tests') > 0))
      throw new Error(
        'FAILING_FIRST_NO_RUN: the tests did not run (launch, build or test-discovery error); fix that first.',
      );
    const failed = count('fail') > 0;
    console.log(
      failed
        ? 'FAILING-FIRST OK: the tests fail on main sources, so they prove the change.'
        : 'FAILING-FIRST MISSED: the tests pass on main sources, so they prove nothing about the change.',
    );
    return failed ? 0 : 1;
  } finally {
    rmSync(copy, { recursive: true, force: true });
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  try {
    process.exitCode = failingFirst(process.argv.slice(2));
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 2;
  }
}
