// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { CheckQueue } from '../dist/check-queue.js';
import { processStartTime } from '../dist/local-process.js';

test('denied audit preemption keeps cancellation and capacity until its controller stops the child', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'forge-preemption-'));
  const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
    detached: process.platform !== 'win32',
    stdio: 'ignore',
  });
  const closed = once(child, 'close');
  let audit, foreground, signal;
  try {
    await once(child, 'spawn');
    audit = new CheckQueue(directory, {
      limit: 1,
      serializeAdmission: true,
      identity: { priority: 'audit' },
    });
    assert.equal(audit.tryAcquire(), true);
    audit.child(child.pid, processStartTime(child.pid));
    foreground = new CheckQueue(directory, { limit: 1, serializeAdmission: true });
    const kill = process.kill.bind(process);
    let denied = 0,
      code = 'EPERM';
    signal = t.mock.method(process, 'kill', (pid, requested) => {
      if (pid === (process.platform === 'win32' ? child.pid : -child.pid) && requested === 'SIGKILL') {
        denied++;
        throw Object.assign(new Error('Synthetic audit signal failure'), { code });
      }
      return kill(pid, requested);
    });
    assert.equal(foreground.tryAcquire(), false, 'a live audit still consumes capacity');
    assert.equal(denied, 1);
    assert.equal(audit.cancelled(), true, 'the controller can observe the durable cancellation');
    assert.equal(child.exitCode, null);
    assert.equal(child.signalCode, null);
    code = 'EIO';
    assert.throws(() => foreground.tryAcquire(), { code: 'EIO' }, 'other signal errors remain visible');
    signal.mock.restore();
    // The controller owns this handle and can stop its child even when an
    // external process-group signal was denied.
    child.kill('SIGKILL');
    await closed;
    audit.release();
    assert.equal(foreground.tryAcquire(), true, 'admission resumes only after the audit releases capacity');
  } finally {
    signal?.mock.restore();
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    await closed;
    foreground?.release();
    audit?.release();
    rmSync(directory, { recursive: true, force: true });
  }
});
