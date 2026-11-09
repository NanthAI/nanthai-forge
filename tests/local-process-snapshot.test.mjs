// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import childProcess, { spawn } from 'node:child_process';
import { once } from 'node:events';
import { syncBuiltinESMExports } from 'node:module';
import {
  processIdentity,
  processesAlive,
  WINDOWS_START_SCRIPT,
  windowsPowerShell,
  windowsStartArgs,
} from '../dist/local-process.js';
import { LAUNCHER_WINDOWS_START_SCRIPT } from '../dist/cli-launcher.js';

test('fresh queue liveness distinguishes live, reused, legacy and exited identities', async t => {
  const child = spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)']);
  t.after(() => child.kill());
  await once(child, 'spawn');
  const self = processIdentity(),
    peer = processIdentity(child.pid);
  assert.deepEqual(
    processesAlive([self, peer, { ...peer, startTime: 'different-start' }, { pid: child.pid }]),
    [true, true, false, true],
  );
  const exited = once(child, 'exit');
  child.kill();
  await exited;
  assert.deepEqual(processesAlive([self, peer]), [true, false]);
});

test(
  'Unix queue scan batches ps once and preserves ambiguous observations',
  { skip: process.platform === 'linux' || process.platform === 'win32' },
  t => {
    const self = processIdentity(),
      original = childProcess.execFileSync;
    let calls = 0,
      observation = `${self.pid} ${self.startTime} S\n`;
    childProcess.execFileSync = (file, args, options) => {
      if (file !== '/bin/ps') return original(file, args, options);
      calls++;
      if (observation instanceof Error) throw observation;
      return observation;
    };
    syncBuiltinESMExports();
    t.after(() => {
      childProcess.execFileSync = original;
      syncBuiltinESMExports();
    });
    const identities = [self, { ...self, startTime: 'wrong-start' }, { pid: self.pid }];
    assert.deepEqual(processesAlive(identities), [true, false, true]);
    assert.equal(calls, 1);
    observation = '';
    assert.deepEqual(processesAlive(identities), [true, true, true]);
    observation = new Error('unavailable');
    assert.deepEqual(processesAlive(identities), [true, true, true]);
    observation = `${self.pid} ${self.startTime} Z\n`;
    assert.deepEqual(processesAlive(identities), [false, false, false]);
    assert.equal(calls, 4);
  },
);

test('positive liveness cache avoids repeated process snapshots and still detects ESRCH immediately', async t => {
  const { processesAliveCached } = await import('../dist/local-process.js');
  const child = spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)']);
  t.after(() => child.kill());
  await once(child, 'spawn');
  const peer = processIdentity(child.pid),
    original = childProcess.execFileSync;
  let calls = 0;
  childProcess.execFileSync = (...args) => {
    calls++;
    return original(...args);
  };
  syncBuiltinESMExports();
  t.after(() => {
    childProcess.execFileSync = original;
    syncBuiltinESMExports();
  });
  for (let i = 0; i < 8; i++) assert.deepEqual(processesAliveCached([peer]), [true]);
  if (process.platform !== 'linux') assert.equal(calls, 1);
  const exited = once(child, 'exit');
  child.kill();
  await exited;
  assert.deepEqual(processesAliveCached([peer]), [false]);
});

test('Windows start identity loads no PowerShell module and the launcher reads it the same way', () => {
  // Get-Process autoloads a module and hangs without PSModulePath, which childEnv omits.
  assert.equal(LAUNCHER_WINDOWS_START_SCRIPT, WINDOWS_START_SCRIPT);
  assert.doesNotMatch(WINDOWS_START_SCRIPT, /Get-Process/);
  assert.deepEqual(windowsStartArgs(42), [
    '-NoProfile',
    '-NonInteractive',
    '-Command',
    '[System.Diagnostics.Process]::GetProcessById(42).StartTime.ToFileTimeUtc()',
  ]);
  assert.equal(windowsPowerShell('D:\\Win'), 'D:\\Win\\System32\\WindowsPowerShell\\v1.0\\powershell.exe');
});
