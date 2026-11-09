// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import childProcess, { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { syncBuiltinESMExports } from 'node:module';
import {
  processIdentity,
  processIdentityIfKnown,
  processLiveness,
  windowsLookup,
  windowsStart,
  processesAlive,
  stopProcessTree,
  WINDOWS_START_SCRIPT,
  windowsPowerShell,
  windowsStartArgs,
  windowsTaskkill,
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

const alive = pid => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === 'EPERM';
  }
};

// Descendant cleanup (Issue 1444471f): a check command's own children stop with it on every platform.
// Windows has no process groups, so this runs taskkill /T on the windows-latest smoke.
test('stopping a check command also stops the descendants it started (1444471f)', async t => {
  const child = spawn(
    process.execPath,
    [
      '-e',
      "const c=require('node:child_process').spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore'});console.log(c.pid);setInterval(()=>{},1000)",
    ],
    { detached: process.platform !== 'win32', stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true },
  );
  let grandchild;
  t.after(() => {
    child.kill('SIGKILL');
    if (grandchild && alive(grandchild)) process.kill(grandchild, 'SIGKILL');
  });
  const [line] = await once(child.stdout, 'data');
  grandchild = Number(String(line).trim());
  assert(Number.isInteger(grandchild) && alive(grandchild), 'the descendant runs');
  const exited = once(child, 'exit');
  stopProcessTree(child);
  await exited;
  for (let i = 0; i < 100 && alive(grandchild); i++) await new Promise(done => setTimeout(done, 100));
  assert.equal(alive(grandchild), false, 'the descendant stopped with its command');
});

test('Windows never signals the PID of a command that already exited (1444471f)', () => {
  const original = childProcess.execFileSync;
  let tools = 0,
    kills = 0;
  childProcess.execFileSync = () => {
    tools++;
  };
  syncBuiltinESMExports();
  try {
    // Windows may hand an exited command's PID to an unrelated process.
    stopProcessTree({ pid: 4242, exitCode: 0, signalCode: null, kill: () => kills++ }, 'SIGKILL', 'win32');
    stopProcessTree(
      { pid: 4242, exitCode: null, signalCode: 'SIGTERM', kill: () => kills++ },
      'SIGKILL',
      'win32',
    );
    assert.deepEqual([tools, kills], [0, 0]);
    stopProcessTree({ pid: 4242, exitCode: null, signalCode: null, kill: () => kills++ }, 'SIGKILL', 'win32');
    assert.deepEqual([tools, kills], [1, 0]);
  } finally {
    childProcess.execFileSync = original;
    syncBuiltinESMExports();
  }
  assert.equal(windowsTaskkill('D:\\Win'), 'D:\\Win\\System32\\taskkill.exe');
});

test('SM-C M15: one liveness answer names alive, dead, reused and legacy/unknown processes', async t => {
  const child = spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)']); // test-signal: allow child process has no event to wait on
  t.after(() => child.kill());
  await once(child, 'spawn');
  const peer = processIdentity(child.pid);
  assert.equal(processLiveness(peer), 'alive');
  assert.equal(processLiveness({ pid: child.pid, startTime: 'different-start' }), 'reused');
  assert.equal(processLiveness({ pid: child.pid }), 'alive', 'a legacy record never guesses reuse');
  const exited = once(child, 'exit');
  child.kill();
  await exited;
  assert.equal(processLiveness(peer), 'dead');
});

test('Windows CLI smoke 42676003944: a slow first start-time lookup is retried, never failing the command', t => {
  const original = windowsLookup.run;
  t.after(() => {
    windowsLookup.run = original;
  });
  const timeouts = [];
  // A cold PowerShell outruns the first bound; the retry succeeds.
  windowsLookup.run = (pid, timeout) => {
    timeouts.push(timeout);
    if (timeouts.length === 1)
      throw Object.assign(new Error('spawnSync powershell ETIMEDOUT'), { code: 'ETIMEDOUT' });
    return '133800000000000000\r\n';
  };
  assert.equal(windowsStart(4242), '133800000000000000');
  assert.deepEqual(timeouts, windowsLookup.bounds, 'one retry, with the longer bound');
  // Always slow: an unconfirmed start time (undefined), not a thrown error.
  windowsLookup.run = () => {
    throw Object.assign(new Error('ETIMEDOUT'), { code: 'ETIMEDOUT' });
  };
  assert.equal(windowsStart(4242), undefined);
  // A refused exec is not retried.
  let calls = 0;
  windowsLookup.run = () => {
    calls++;
    throw Object.assign(new Error('EPERM'), { code: 'EPERM' });
  };
  assert.equal(windowsStart(4242), undefined);
  assert.equal(calls, 1);
});

test('an unconfirmable start time is unknown for records that only name their owner; strict records still refuse', () => {
  const gone = 2 ** 22 + 54321; // beyond the default pid range: no process, no start time
  assert.deepEqual(processIdentityIfKnown(gone), { pid: gone });
  assert.throws(() => processIdentity(gone), { code: 'PROCESS_IDENTITY_UNAVAILABLE' });
  assert.equal(typeof processIdentityIfKnown().startTime, 'string');
});

test('the CLI reads its own start time from the launcher instead of shelling out', () => {
  const module = new URL('../dist/local-process.js', import.meta.url).href;
  const script = `globalThis[Symbol.for('forge.ownProcessStart')] = { pid: process.pid, startTime: 'LAUNCHER-START' };
    const { processStartTime } = await import(${JSON.stringify(module)});
    process.stdout.write(String(processStartTime(process.pid)));`;
  const child = spawnSync(process.execPath, ['--input-type=module', '-e', script], { encoding: 'utf8' });
  assert.equal(child.stdout, 'LAUNCHER-START', child.stderr);
});
