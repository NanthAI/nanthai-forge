// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { fork } from 'node:child_process';
import { once } from 'node:events';
import { hostname } from 'node:os';
import { initNative } from '../dist/native-work.js';
import { processIdentity } from '../dist/local-process.js';

for (const worker of ['post-accept-main', 'presence-worker'])
  test(`${worker} handles SIGTERM with a busy owner and leaves retained work intact`, async t => {
    const root = mkdtempSync(join(tmpdir(), 'forge-worker-term-'));
    t.after(() => rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }));
    writeFileSync(join(root, 'a.txt'), 'source');
    initNative(root);
    const directory = join(root, '.forge/work');
    mkdirSync(directory, { recursive: true });
    const lock = join(directory, 'synthetic-busy-lock');
    const holder = JSON.stringify({ ...processIdentity(), host: hostname() });
    writeFileSync(lock, holder);
    const child = fork(resolve('tests/detached-worker-fixture.mjs'), [root, worker], {
      execArgv: [],
      env: { PATH: process.env.PATH, HOME: root },
      stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
    });
    t.after(() => {
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    });
    let stderr = '';
    child.stderr.on('data', chunk => {
      stderr += chunk;
    });
    const exited = once(child, 'exit');
    const deadline = AbortSignal.timeout(8000);
    const messages = [];
    for (;;) {
      const [message] = await once(child, 'message', { signal: deadline });
      messages.push(message);
      if (message === 'ready') break;
    }
    if (worker === 'post-accept-main') assert.ok(messages.includes('contended'));
    child.kill('SIGTERM');
    const [code, signal] = await exited;
    assert.equal(signal, null);
    assert.equal(code, 0, stderr);
    assert.equal(readFileSync(lock, 'utf8'), holder);
    assert.equal(readFileSync(join(root, 'a.txt'), 'utf8'), 'source');
  });

test('detached worker lock admission yields instead of blocking signal delivery', async t => {
  const { detachedWorker } = await import('../dist/detached-worker-shutdown.js');
  const { workLocked } = await import('../dist/work-lock.js');
  const root = mkdtempSync(join(tmpdir(), 'forge-worker-lock-'));
  t.after(() => rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }));
  const lock = join(root, 'lock');
  writeFileSync(lock, JSON.stringify({ ...processIdentity(), host: hostname() }));
  await detachedWorker(async () => {
    // Presence callbacks run on later event-loop turns, retaining lock context.
    await new Promise(resolve => setImmediate(resolve));
    assert.throws(() => workLocked(lock, () => assert.fail('busy lock acquired')), { code: 'WORK_BUSY' });
  });
});
