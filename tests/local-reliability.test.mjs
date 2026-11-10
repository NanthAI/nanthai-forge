// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { CheckQueue } from '../dist/check-queue.js';
import { diskGuard } from '../dist/disk-guard.js';

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(fn) {
  const end = Date.now() + 10000;
  while (!fn()) {
    assert.ok(Date.now() < end, 'Timed out waiting for fixture');
    await sleep(50);
  }
}
function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'forge-local-reliability-'));
  const previous = { ...process.env };
  process.env.FORGE_CHECK_QUEUE_DIR = join(root, 'queue');
  process.env.FORGE_MAX_CONCURRENT_CHECKS = '1';
  delete process.env.FORGE_DISK_WARN_GB;
  delete process.env.FORGE_DISK_BLOCK_GB;
  t.after(() => {
    for (const key of [
      'FORGE_CHECK_QUEUE_DIR',
      'FORGE_MAX_CONCURRENT_CHECKS',
      'FORGE_DISK_WARN_GB',
      'FORGE_DISK_BLOCK_GB',
    ]) {
      if (previous[key] === undefined) delete process.env[key];
      else process.env[key] = previous[key];
    }
    rmSync(root, { recursive: true, force: true });
  });
  return root;
}
function child(t, script, environment = {}) {
  const proc = spawn(process.execPath, ['--input-type=module', '-e', script], {
    env: { ...process.env, ...environment },
    stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
  });
  let errors = '';
  proc.stderr.on('data', chunk => {
    errors += chunk;
  });
  const messages = [];
  proc.on('message', value => messages.push(value));
  t.after(() => {
    if (proc.exitCode === null && proc.signalCode === null) proc.kill('SIGKILL');
  });
  return { proc, messages, errors: () => errors };
}
const queueModule = new URL('../dist/check-queue.js', import.meta.url).href;
const processModule = new URL('../dist/local-process.js', import.meta.url).href;
function holder(t, group = false) {
  return child(
    t,
    `
    import { CheckQueue } from ${JSON.stringify(queueModule)};
    import { processIdentity } from ${JSON.stringify(processModule)};
    import { spawn } from 'node:child_process';
    const queue = new CheckQueue();
    process.send({state:'queued'});
    const poll = setInterval(() => {
      if (!queue.tryAcquire()) return;
      clearInterval(poll);
      ${group ? `const child = spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{detached:true,stdio:'ignore'});queue.child(child.pid,processIdentity(child.pid).startTime);process.send({state:'acquired',pid:child.pid});` : `process.send({state:'acquired'});`}
    }, 50);
    process.on('message', () => { queue.release(); process.send({state:'released'}); process.exit(); });
  `,
  );
}

test('machine queue enforces one slot across processes, then admits the next ticket', async t => {
  fixture(t);
  const a = holder(t);
  await until(() => a.messages.some(m => m.state === 'acquired'));
  const b = holder(t);
  await until(() => b.messages.some(m => m.state === 'queued'));
  await sleep(300);
  assert.equal(
    b.messages.some(m => m.state === 'acquired'),
    false,
    b.errors(),
  );
  a.proc.send('release');
  await until(() => b.messages.some(m => m.state === 'acquired'));
  b.proc.send('release');
  await once(b.proc, 'exit');
});

test('a crashed holder is reclaimed, while an orphaned process group retains capacity', async t => {
  fixture(t);
  const a = holder(t);
  await until(() => a.messages.some(m => m.state === 'acquired'));
  const next = new CheckQueue();
  assert.equal(next.tryAcquire(), false);
  a.proc.kill('SIGKILL');
  await once(a.proc, 'exit');
  assert.equal(next.tryAcquire(), true);
  next.release();
  if (process.platform === 'win32') return;
  const orphan = holder(t, true);
  await until(() => orphan.messages.some(m => m.state === 'acquired'));
  const pid = orphan.messages.find(m => m.state === 'acquired').pid;
  t.after(() => {
    try {
      process.kill(-pid, 'SIGKILL');
    } catch {}
  });
  orphan.proc.kill('SIGKILL');
  await once(orphan.proc, 'exit');
  const queued = new CheckQueue();
  assert.equal(queued.tryAcquire(), false);
  process.kill(-pid, 'SIGKILL');
  await until(() => queued.tryAcquire());
  queued.release();
});

test('disk guard probes owner free space, warns at 5 GB, refuses below 2 GB, and never deletes', t => {
  const root = fixture(t);
  writeFileSync(join(root, 'keep.txt'), 'retained');
  let probed;
  const probe = bytes => owner => {
    probed = owner;
    return bytes;
  };
  assert.deepEqual(diskGuard(root, probe(6e9)), []);
  assert.equal(probed, root);
  assert.match(diskGuard(root, probe(5e9))[0], /5.00 GB free/);
  assert.equal(diskGuard(root, probe(2e9)).length, 1);
  assert.throws(
    () => diskGuard(root, probe(2e9 - 1)),
    e => e.code === 'DISK_LOW' && /clean \(dry run\)/.test(e.message),
  );
  process.env.FORGE_DISK_WARN_GB = '8';
  process.env.FORGE_DISK_BLOCK_GB = '3';
  assert.equal(diskGuard(root, probe(7e9)).length, 1);
  assert.throws(
    () => diskGuard(root, probe(2.5e9)),
    e => e.code === 'DISK_LOW',
  );
  assert.equal(readFileSync(join(root, 'keep.txt'), 'utf8'), 'retained');
});
