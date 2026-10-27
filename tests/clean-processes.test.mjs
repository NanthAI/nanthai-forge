// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { workingProcesses, processBlocker } from '../dist/clean-processes.js';
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
