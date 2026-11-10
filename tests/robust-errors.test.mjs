// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ForgeError } from '../dist/errors.js';
import { cleanHostedCheckout } from '../dist/hosted-checkout-files.js';
import {
  DIAGNOSTICS_FILES,
  DIAGNOSTICS_MAX_BYTES,
  describeFailure,
  recordFailure,
  writeDiagnostics,
} from '../dist/system-errors.js';

const workers = new WeakMap();
const temp = (t, name) => {
  const root = mkdtempSync(join(tmpdir(), `forge-${name}-`));
  t.after(async () => {
    // after hooks run in registration order: stop/reap children before removing any fixture tree.
    for (const running of workers.get(t) ?? []) {
      if (running.child.exitCode === null && running.child.signalCode === null) running.child.kill();
      assert.equal(await within(running.exited, 5000), true, 'fixture worker was reaped');
    }
    try {
      chmodSync(root, 0o700);
    } catch {
      /* Already removed. */
    }
    rmSync(root, { recursive: true, force: true });
  });
  return root;
};
const within = async (promise, ms) => {
  let timer;
  try {
    return await Promise.race([
      promise.then(() => true),
      new Promise(resolve => {
        timer = setTimeout(() => resolve(false), ms);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
};

test('diagnostics never land in an owner or checkout root', t => {
  const base = temp(t, 'diagnostics-parent');
  const forge = join(base, 'owner', '.forge');
  mkdirSync(forge, { recursive: true });
  writeFileSync(join(forge, 'hosted-lane.json'), '{}');
  const failure = recordFailure(new Error('x'), join(base, 'owner'));
  assert.equal(failure.diagnostics?.startsWith(base), false);
  assert.deepEqual(readdirSync(forge), ['hosted-lane.json']);
  // The CLI's own log is not local work: pull's clean check must not refuse on it (friction 6f1880c6).
  assert.deepEqual(cleanHostedCheckout(join(base, 'owner'), [], 'hosted-lane.json', true), []);
});

test('queues and locks under a deleted owner fail instead of recreating it', async t => {
  const base = temp(t, 'queue-parent');
  const { withQueueSlot } = await import('../dist/landing-queue.js');
  const directory = join(base, 'owner', '.forge', 'work');
  await assert.rejects(
    withQueueSlot(join(directory, 'q'), async () => 1, { anchor: directory }),
    {
      code: 'ENOENT',
    },
  );
  assert.equal(existsSync(join(base, 'owner')), false);
});

test('system errors map to a code, syscall, path and hint', () => {
  const error = Object.assign(new Error('EPERM: operation not permitted, mkdir'), {
    code: 'EPERM',
    syscall: 'mkdir',
    path: `${process.env.HOME}/.forge/check-queue/1.x`,
  });
  const failure = describeFailure(error);
  assert.equal(failure.code, 'SYSTEM_EPERM');
  assert.match(failure.message, /^mkdir .*\/\.forge\/check-queue\/1\.x: operation not permitted\./);
  assert.match(failure.message, /No successful result is claimed\./);
  assert.match(failure.hint, /write access to ~\/\.forge.*FORGE_CHECK_QUEUE_DIR/);
  for (const code of ['EACCES', 'ENOSPC', 'EMFILE', 'ENFILE', 'EROFS', 'ENOENT'])
    assert.equal(
      describeFailure(Object.assign(new Error(code), { code, syscall: 'open', path: '/x' })).code,
      `SYSTEM_${code}`,
    );
  assert.deepEqual(describeFailure(new ForgeError('BAD_ARGUMENT', 'Bad.')), {
    code: 'BAD_ARGUMENT',
    message: 'Bad.',
  });
  assert.equal(describeFailure(Object.assign(new Error('x'), { code: 'EOTHER' })).code, 'INTERNAL_ERROR');
});

test('unexpected errors stay INTERNAL_ERROR but name a diagnostics log with the stack', t => {
  const root = temp(t, 'diagnostics');
  mkdirSync(join(root, '.forge'));
  const failure = recordFailure(new Error('boom-secretless'));
  assert.equal(failure.code, 'INTERNAL_ERROR');
  assert.equal(failure.message, 'Unexpected failure; no successful result is claimed.');
  assert.equal(failure.diagnostics, join(process.env.HOME, '.forge', 'logs', 'diagnostics.log'));
  assert.equal(existsSync(join(root, '.forge', 'logs')), false);
  assert.match(readFileSync(failure.diagnostics, 'utf8'), /INTERNAL_ERROR[\s\S]*boom-secretless[\s\S]*at /);
});

test('the diagnostics log rotates and stays bounded', t => {
  const directory = join(temp(t, 'rotate'), 'logs');
  const entry = 'x'.repeat(DIAGNOSTICS_MAX_BYTES / 8);
  for (let index = 0; index < 80; index++) writeDiagnostics(directory, entry);
  const files = readdirSync(directory).sort();
  assert.deepEqual(files, ['diagnostics.log', 'diagnostics.log.1', 'diagnostics.log.2']);
  assert.equal(files.length, DIAGNOSTICS_FILES);
});
