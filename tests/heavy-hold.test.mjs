// SPDX-License-Identifier: Apache-2.0
// Item 7008ff18: load 65 on 10 cores. Heavy capped only the command it started, so an npm script or
// `sh -c` ran its node --test with up to cores - 1 workers per slot, typechecks were unbounded and
// the 32 undated, unattributed holds could not say what loaded the machine.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { availableParallelism, tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { commandKind, holdSummary, testWorkersPerSlot, treeCpu } from '../dist/heavy-hold.js';
import { readHoldHistory, readHolds, recordHold } from '../dist/heavy-queue.js';

const cli = resolve('dist/cli-entry.js');
const FILES = 20;
const share = testWorkersPerSlot(availableParallelism(), 2);
const lane = '0d7c5a1e-7008-4f18-9f4b-128012345678';

/** The outer runner's own slot, cap and test context must not leak into a fixture's heavy. */
function heavyEnv(root) {
  const env = {
    ...process.env,
    FORGE_HEAVY_DIR: join(root, 'slots'),
    FORGE_CLIENT_SETTINGS: join(root, 'client.json'),
  };
  for (const name of [
    'FORGE_HEAVY_PARENT',
    'FORGE_HEAVY_TEST_CONCURRENCY',
    'NODE_OPTIONS',
    'NODE_TEST_CONTEXT',
    'GOMAXPROCS',
    'RAYON_NUM_THREADS',
  ])
    delete env[name];
  return env;
}

/** A project in a Lane-shaped folder whose 20 test files each report the worker setting their
 * runner gave them and how many test files were running when they started. */
function project(t) {
  const root = mkdtempSync(join(tmpdir(), 'forge-heavy-hold-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const cwd = join(root, 'lanes', lane);
  mkdirSync(join(cwd, 't'), { recursive: true });
  mkdirSync(join(cwd, 'out'));
  const body = `import { readdirSync, rmSync, writeFileSync } from 'node:fs';
const own = process.execArgv.findLast(arg => arg.startsWith('--test-concurrency='));
const running = new URL('../out/' + process.pid + '.running', import.meta.url);
writeFileSync(running, '');
const seen = readdirSync(new URL('../out/', import.meta.url)).filter(name => name.endsWith('.running')).length;
writeFileSync(new URL('../out/' + process.pid + '.json', import.meta.url), JSON.stringify({ own, seen }));
rmSync(running);
`;
  for (let index = 0; index < FILES; index++) writeFileSync(join(cwd, 't', `f${index}.test.mjs`), body);
  const files = Array.from({ length: FILES }, (_, index) => `t/f${index}.test.mjs`);
  const node = JSON.stringify(process.execPath);
  writeFileSync(
    join(cwd, 'package.json'),
    JSON.stringify({
      scripts: {
        x: `node --test ${files.join(' ')}`,
        own: `node --test --test-concurrency=1 ${files.join(' ')}`,
        spawned: `node -e "require('node:child_process').spawnSync(process.execPath, ['--test', ...process.argv.slice(1)], { stdio: 'inherit' })" ${files.join(' ')}`,
        nested: `${node} ${JSON.stringify(cli)} heavy npm run x`,
      },
    }),
  );
  const settings = join(root, 'client.json');
  writeFileSync(settings, JSON.stringify({ localHeavySlots: 2 }));
  const env = heavyEnv(root);
  const heavy = (args, extra = {}) => {
    rmSync(join(cwd, 'out'), { recursive: true, force: true });
    mkdirSync(join(cwd, 'out'));
    const result = spawnSync(process.execPath, [cli, 'heavy', '--no-build', ...args], {
      cwd,
      encoding: 'utf8',
      env: { ...env, ...extra },
    });
    assert.equal(result.status, 0, result.stderr);
    return result;
  };
  const reports = () =>
    readdirSync(join(cwd, 'out'))
      .filter(name => name.endsWith('.json'))
      .map(name => JSON.parse(readFileSync(join(cwd, 'out', name), 'utf8')));
  return { root, cwd, files, heavy, reports, slots: join(root, 'slots') };
}

test('incident 7008ff18: every node --test a slot starts gets the slot cap, however it is started, and its own --test-concurrency wins', t => {
  const { files, heavy, reports } = project(t);
  for (const [how, args] of [
    ['directly', [process.execPath, '--test', ...files]],
    ['through an npm script in a shell', ['sh', '-c', 'npm run x']],
    ['through a script spawning process.execPath', ['npm', 'run', 'spawned']],
    ['through a nested nforge heavy', ['sh', '-c', 'npm run nested']],
  ]) {
    heavy(args);
    const seen = reports();
    assert.equal(seen.length, FILES, how);
    for (const report of seen) {
      assert.equal(report.own, `--test-concurrency=${share}`, `${how}: the runner got the slot cap`);
      assert(report.seen <= share, `${how}: ${report.seen} test files ran at once, cap ${share}`);
    }
  }
  heavy(['sh', '-c', 'npm run own']);
  assert.deepEqual(
    new Set(reports().map(report => report.own)),
    new Set(['--test-concurrency=1']),
    'a command that sets its own --test-concurrency keeps it',
  );
});

test('where Node cannot restart a runner in place (Windows, older Node), the capped runner runs as a child and keeps the exit code', t => {
  const { root, cwd, files, heavy, reports } = project(t);
  const noExecve = join(root, 'no-execve.cjs');
  writeFileSync(noExecve, 'delete process.execve;\n');
  const extra = { NODE_OPTIONS: `--require=${noExecve}` };
  heavy(['sh', '-c', 'npm run x'], extra);
  const seen = reports();
  assert.equal(seen.length, FILES);
  for (const report of seen) assert.equal(report.own, `--test-concurrency=${share}`);
  writeFileSync(
    join(cwd, 't', 'failing.test.mjs'),
    "import test from 'node:test'; test('f', () => { throw new Error('x'); });\n",
  );
  const failed = spawnSync(
    process.execPath,
    [cli, 'heavy', '--no-build', 'sh', '-c', `node --test t/failing.test.mjs ${files[0]}`],
    {
      cwd,
      encoding: 'utf8',
      env: { ...heavyEnv(root), ...extra },
    },
  );
  assert.equal(failed.status, 1, 'a failing run still fails');
});

test('incident 7008ff18: a typecheck under heavy gets the slot core share for Go and Rust tools unless it sets its own', t => {
  const { heavy } = project(t);
  const print = ['sh', '-c', 'printf "%s %s" "$GOMAXPROCS" "$RAYON_NUM_THREADS"'];
  assert.equal(heavy(print).stdout, `${share} ${share}`);
  assert.equal(
    heavy(print, { GOMAXPROCS: '1', RAYON_NUM_THREADS: '2' }).stdout,
    '1 2',
    'its own setting wins',
  );
});

test('the cap preload loads only from a private folder this user owns, never from one another account could write', t => {
  const { root, heavy } = project(t);
  const temp = join(root, 'tmp');
  mkdirSync(temp);
  const print = ['sh', '-c', 'printf %s "$NODE_OPTIONS"'];
  const own = heavy(print, { TMPDIR: temp }).stdout;
  const stable = join(temp, `forge-heavy-cap-${process.getuid()}`);
  assert(own.includes(stable), 'the stable per-user folder');
  assert.equal(statSync(stable).mode & 0o777, 0o700);
  // A folder of that name anyone can write (planted, or made by another account) is never used.
  rmSync(stable, { recursive: true });
  mkdirSync(stable);
  chmodSync(stable, 0o777);
  const fallback = heavy(print, { TMPDIR: temp }).stdout;
  assert(fallback.includes('forge-heavy-cap-') && !fallback.includes(stable), fallback);
  assert.deepEqual(
    readdirSync(temp).filter(name => name.startsWith('forge-heavy-cap-')),
    [`forge-heavy-cap-${process.getuid()}`],
    'the fallback folder is removed after the command',
  );
});

test('incident 7008ff18: the hold history records when, which Lane, what kind and the peaks, and --status summarises the day', t => {
  const { root, files, heavy, slots } = project(t);
  // heavyEnv isolates the spawned CLI's clock from Node preloads on this process.
  const started = Math.floor(performance.timeOrigin + performance.now());
  heavy([process.execPath, '--test', files[0]]);
  heavy(['sh', '-c', 'echo npm run typecheck']);
  const holds = readHoldHistory(slots);
  assert.deepEqual(
    holds.map(hold => [hold.lane, hold.kind]),
    [
      [lane, 'test'],
      [lane, 'typecheck'],
    ],
  );
  for (const hold of holds) {
    assert(
      hold.at >= started && hold.at <= performance.timeOrigin + performance.now(),
      'dated by when the slot was taken',
    );
    assert(Number.isInteger(hold.ms) && hold.ms >= 0);
    assert('cpu' in hold && 'load' in hold);
  }
  const status = spawnSync(process.execPath, [cli, 'heavy', '--status'], {
    encoding: 'utf8',
    env: heavyEnv(root),
  });
  const today = JSON.parse(status.stdout).today;
  assert.equal(today.holds, 2);
  assert.equal(today.byKind.test.holds, 1);
  assert.equal(today.byKind.typecheck.holds, 1);
  assert.deepEqual(
    today.lanes.map(entry => entry.lane),
    [lane.slice(0, 8)],
  );
  assert(!status.stdout.includes(tmpdir()) && !status.stdout.includes('lanes/'), 'never a folder');
});

test('incident 7008ff18: the hold history stays bounded, keeps the newest holds and feeds wait estimates', t => {
  const directory = mkdtempSync(join(tmpdir(), 'forge-heavy-history-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const limits = { maxBytes: 4000, keep: 10 };
  for (let index = 0; index < 500; index++) recordHold(directory, index, { kind: 'test' }, limits);
  const size = statSync(join(directory, 'holds.jsonl')).size;
  assert(size <= limits.maxBytes, `${size} bytes`);
  const holds = readHoldHistory(directory);
  assert.equal(holds.at(-1).ms, 499, 'the newest hold is kept');
  assert(holds.length < 500);
  assert.deepEqual(readHolds(directory).at(-1), 499);
});

test('a hold is classed as test, typecheck, build or other from its command words', () => {
  for (const [args, kind] of [
    [['node', '--import', 'x.mjs', '--test', 'a.test.mjs'], 'test'],
    [['sh', '-c', 'npm run build:core && node --test tests/a.test.mjs'], 'test'],
    [['npm', 'test'], 'test'],
    [['npm', 'run', '-s', 'test'], 'test'],
    [['nforge', 'agent', '.', 'preflight', '{}'], 'test'],
    [['node', 'node_modules/@typescript/native/bin/tsc', '--noEmit'], 'typecheck'],
    [['npm', 'run', 'typecheck'], 'typecheck'],
    [['npm', 'run', 'build:core'], 'build'],
    [['node', '--test-concurrency=2', 'script.mjs'], 'other'],
    [['npm', 'run', 'lint'], 'other'],
  ])
    assert.equal(commandKind(args), kind, args.join(' '));
});

test('peak CPU counts the command and every descendant, never unrelated processes', () => {
  const ps = ['  10     1  50.0', '  11    10 120.0', '  12    11  80.0', '  13     1 300.0', ''].join('\n');
  assert.equal(treeCpu(ps, 10), 2.5);
  assert.equal(treeCpu(ps, 99), null, 'a finished command reads as unknown');
});

test('the daily summary names who held a slot at the CPU and load peaks and ignores older holds', () => {
  const now = Date.parse('2026-11-20T13:00:00Z');
  const hold = (hoursAgo, lane, kind, cpu, load, ms = 60_000) => ({
    at: now - hoursAgo * 3_600_000,
    ms,
    lane,
    kind,
    cpu,
    load,
  });
  const summary = holdSummary(
    [
      hold(30, 'aaaaaaaa-1111', 'test', 9.5, 60),
      hold(2, 'bbbbbbbb-2222', 'test', 4.8, 21.4, 600_000),
      hold(1, 'cccccccc-3333', 'typecheck', 3.1, 30.2),
      hold(0.5, null, 'build', null, null),
    ],
    now,
  );
  assert.equal(summary.holds, 3);
  assert.deepEqual(summary.byKind.test, { holds: 1, minutes: 10 });
  assert.deepEqual(summary.peakCpu, {
    cpu: 4.8,
    at: '2026-11-20T11:00:00.000Z',
    lane: 'bbbbbbbb',
    kind: 'test',
  });
  assert.deepEqual(summary.peakLoad, {
    load: 30.2,
    at: '2026-11-20T12:00:00.000Z',
    lane: 'cccccccc',
    kind: 'typecheck',
  });
  assert.deepEqual(summary.lanes[0], { lane: 'bbbbbbbb', minutes: 10 });
});
