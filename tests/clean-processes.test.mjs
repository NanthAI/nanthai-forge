// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { workingProcesses, processBlocker } from '../dist/clean-processes.js';
import { randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { mkdtempSync, mkdirSync, writeFileSync, utimesSync, rmSync, existsSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gcNestedLanes } from '../dist/client-cache-gc.js';
import { laneHousekeeping } from '../dist/lane-prune.js';
import { recordLane } from '../dist/lane-registry.js';
import { mockProcessCoverage } from './cleanup-process-fixture.mjs';

// Exercise both backends on any host; no real /proc or lsof is consulted.
for (const platform of ['linux', 'darwin']) {
  const setup = t => {
    const descriptor = Object.getOwnPropertyDescriptor(process, 'platform');
    Object.defineProperty(process, 'platform', { ...descriptor, value: platform });
    t.after(() => Object.defineProperty(process, 'platform', descriptor));
    return mockProcessCoverage(t);
  };
  test(`${platform}: controlled scan reports exact and descendant working directories`, t => {
    const scan = setup(t);
    scan.paths = ['/synthetic/lane', '/synthetic/check/runtime/nested'];
    const observed = workingProcesses();
    assert.deepEqual(observed, { paths: scan.paths, unknown: false });
    assert.match(processBlocker('/synthetic/lane', observed), /process is working/);
    assert.match(processBlocker('/synthetic/check', observed), /process is working/);
    assert.equal(processBlocker('/synthetic/lan', observed), undefined);
    scan.paths = [];
    assert.deepEqual(workingProcesses(), { paths: [], unknown: false });
  });
  test(`${platform}: missing process probe fails closed`, t => {
    const scan = setup(t);
    scan.unavailable = true;
    const observed = workingProcesses();
    assert.deepEqual(observed, { paths: [], unknown: true });
    assert.match(processBlocker('/synthetic/lane', observed), /coverage is unavailable/);
  });
  test(`${platform}: d9eded54 automatic cleanup retains live and unknown roots, removes only unused roots through the OS probe`, async t => {
    const scan = setup(t);
    const directory = realpathSync(mkdtempSync(join(tmpdir(), 'forge-test-process-cleanup-')));
    const stateHome = process.env.XDG_STATE_HOME;
    process.env.XDG_STATE_HOME = join(directory, 'state');
    t.after(() => {
      if (stateHome === undefined) delete process.env.XDG_STATE_HOME;
      else process.env.XDG_STATE_HOME = stateHome;
      rmSync(directory, { recursive: true, force: true });
    });
    const now = Date.now(),
      old = new Date(now - 48 * 3_600_000);
    const address = { url: 'https://fixture.invalid', projectId: 'project' };
    for (const kind of ['cache', 'housekeeping']) {
      const laneId = randomUUID(),
        owner = join(directory, kind);
      const root = kind === 'cache' ? join(`${owner}.forge-client`, 'lanes', laneId) : owner;
      mkdirSync(join(root, '.forge'), { recursive: true });
      const marker = join(root, '.forge/hosted-lane.json');
      writeFileSync(
        marker,
        JSON.stringify({ url: address.url, selection: { laneId, projectId: address.projectId } }),
      );
      for (const path of [marker, join(root, '.forge'), root]) utimesSync(path, old, old);
      if (kind === 'housekeeping') recordLane({ laneId, root, ...address, lastActionAt: old.getTime() }, now);
      const run = () =>
        kind === 'cache'
          ? gcNestedLanes({
              root: owner,
              now,
              settings: { clientCacheMaxGB: 0, clientCacheMaxAgeHours: 1 },
              isDirty: () => false,
            })
          : laneHousekeeping({
              address,
              now,
              apply: true,
              settings: { autoPruneHours: 1, idleLaneHours: 1 },
              readStates: async () => new Map([[laneId, 'completed']]),
            });
      scan.paths = [join(root, 'nested')];
      let result = await run();
      assert.match(result.kept[0].reason, /process is working/, kind);
      assert(existsSync(root));
      scan.paths = [];
      scan.unavailable = true;
      result = await run();
      assert.match(result.kept[0].reason, /coverage is unavailable/, kind);
      assert(existsSync(root));
      scan.unavailable = false;
      result = await run();
      assert.equal((result.evicted ?? result.pruned).length, 1, kind);
      assert(!existsSync(root));
    }
  });
  if (platform === 'linux') {
    test('linux: unreadable earlier process makes coverage unknown before a later blocker', t => {
      const scan = setup(t);
      scan.paths = ['/synthetic/unrelated', '/synthetic/lane'];
      scan.errors[0] = 'EACCES';
      const observed = workingProcesses();
      assert.deepEqual(observed, { paths: [], unknown: true });
      assert.match(processBlocker('/synthetic/lane', observed), /coverage is unavailable/);
    });
    for (const code of ['ENOENT', 'ESRCH']) {
      test(`linux: process exit (${code}) does not hide later working directories`, t => {
        const scan = setup(t);
        scan.paths = ['/synthetic/exited', '/synthetic/lane'];
        scan.errors[0] = code;
        assert.deepEqual(workingProcesses(), { paths: ['/synthetic/lane'], unknown: false });
      });
    }
  }
}

// Run representative consumers in separate Node test processes, just like each CI shard.
// This fails if their fixture hooks are accidentally registered in another test file again.
test('d9eded54 gate parity: cleanup consumers pass with an unreadable Linux host process table', () => {
  const probe = `
    import fs from 'node:fs';
    import { syncBuiltinESMExports } from 'node:module';
    Object.defineProperty(process, 'platform', { value: 'linux', configurable: true });
    const readdir = fs.readdirSync, stat = fs.statSync, readlink = fs.readlinkSync;
    fs.readdirSync = (path, ...args) => path === '/proc' ? ['900000000'] : readdir(path, ...args);
    fs.statSync = (path, ...args) => path === '/proc/900000000' ? { uid: process.getuid() } : stat(path, ...args);
    fs.readlinkSync = (path, ...args) => {
      if (path === '/proc/900000000/cwd') throw Object.assign(new Error('Synthetic unreadable cwd'), { code: 'EACCES' });
      return readlink(path, ...args);
    };
    syncBuiltinESMExports();
  `;
  const childEnv = { ...process.env };
  delete childEnv.NODE_TEST_CONTEXT;
  const result = spawnSync(
    process.execPath,
    [
      '--import',
      fileURLToPath(new URL('./check-runtime.mjs', import.meta.url)),
      '--import',
      `data:text/javascript,${encodeURIComponent(probe)}`,
      '--test',
      '--test-reporter=tap',
      fileURLToPath(new URL('./parallel-work-defaults.test.mjs', import.meta.url)),
      fileURLToPath(new URL('./client-cache-bookkeeping.test.mjs', import.meta.url)),
    ],
    { encoding: 'utf8', env: childEnv, maxBuffer: 4 * 1024 * 1024 },
  );
  assert.equal(result.status, 0, result.error?.message ?? result.stdout + result.stderr);
  assert.match(result.stdout, /# Subtest: start lists idle open Lanes/);
  assert.match(result.stdout, /# Subtest: touch, inventory and eviction/);
  assert.match(result.stdout, /# fail 0/);
});
