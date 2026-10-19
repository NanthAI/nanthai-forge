// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import childProcess, { spawn } from 'node:child_process';
import { once } from 'node:events';
import { syncBuiltinESMExports } from 'node:module';
import { processIdentity, processesAlive } from '../dist/local-process.js';

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
