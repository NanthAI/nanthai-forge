// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { fork } from 'node:child_process';
import { once } from 'node:events';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import {
  materializationDirectory,
  materializationSlots,
  withCheckoutMaterialization,
} from '../dist/checkout-materialization.js';
import { queueEntries } from '../dist/check-queue.js';
import { digest } from '../dist/hash.js';
import { readHostedLaneCheckout } from '../dist/hosted-lane-checkout-marker.js';

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'forge-materialization-test-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return root;
}
function worker(t, args, extra = {}) {
  const child = fork(new URL('./fixtures/checkout-materialization-worker.mjs', import.meta.url), args, {
    execArgv: [],
    env: { ...process.env, ...extra },
    silent: true,
  });
  let stderr = '';
  child.stderr.on('data', value => (stderr += value));
  const done = once(child, 'exit').then(([code, signal]) => ({ code, signal, stderr }));
  t.after(() => {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
  });
  const message = () =>
    Promise.race([
      once(child, 'message').then(([value]) => value),
      done.then(result => {
        throw Error(`worker exited before its message: ${JSON.stringify(result)}`);
      }),
    ]);
  return { child, done, message };
}

test('CPU-derived work phasing shares a destination volume across unrelated checkout roots', t => {
  const root = fixture(t);
  mkdirSync(join(root, 'other'));
  assert.equal(materializationDirectory(root), materializationDirectory(join(root, 'other')));
  assert.deepEqual([1, 2, 3, 6, 10, 64].map(materializationSlots), [1, 1, 1, 2, 3, 3]);
});

test('50 opens across ten processes all run, with no more than three materializations at once', async t => {
  const root = fixture(t);
  const results = await Promise.all(Array.from({ length: 10 }, () => worker(t, ['queue', root, '5']).done));
  for (const result of results) assert.equal(result.code, 0, result.stderr);
  const events = readFileSync(join(root, 'events'), 'utf8')
    .trim()
    .split('\n')
    .map(line => {
      const [at, delta] = line.split(' ');
      return { at: BigInt(at), delta: Number(delta) };
    })
    .sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : a.delta - b.delta));
  let active = 0,
    peak = 0;
  for (const event of events) {
    active += event.delta;
    peak = Math.max(peak, active);
    assert(active >= 0 && active <= 3, `active=${active}`);
  }
  assert.equal(events.length, 100);
  assert.equal(active, 0);
  assert(peak > 1, 'the volume is not serialized');
  assert.deepEqual(queueEntries(join(root, 'queue')), []);
});

test('a failed pass releases capacity and independent volume queues proceed separately', async t => {
  const root = fixture(t),
    failure = new Error('synthetic failure');
  const options = { directory: join(root, 'queue'), slots: 1 };
  await assert.rejects(
    withCheckoutMaterialization(
      root,
      async () => {
        throw failure;
      },
      options,
    ),
    error => error === failure,
  );
  let release;
  const gate = new Promise(resolve => {
    release = resolve;
  });
  let entered;
  const ready = new Promise(resolve => {
    entered = resolve;
  });
  const first = withCheckoutMaterialization(
    root,
    async () => {
      entered();
      await gate;
    },
    options,
  );
  await ready;
  try {
    assert.equal(
      await withCheckoutMaterialization(root, async () => 'other volume', {
        directory: join(root, 'other-volume'),
        slots: 1,
      }),
      'other volume',
    );
  } finally {
    release();
    await first;
  }
  assert.deepEqual(queueEntries(options.directory), []);
});

test('SIGKILL during checkout durability releases its process ticket; the original open recovers', async t => {
  const root = fixture(t),
    objects = join(root, 'objects');
  mkdirSync(objects);
  const put = bytes => {
    const hash = digest(bytes);
    writeFileSync(join(objects, hash), bytes, { mode: 0o600 });
    return hash;
  };
  const bytes = Buffer.from('anonymous crash recovery bytes\n');
  const blob = put(bytes);
  const files = Array.from({ length: 24 }, (_, i) => ({ path: `src/file${i}`, blob, mode: 'file' }));
  const head = put(
    Buffer.from(
      JSON.stringify({
        schema: 1,
        kind: 'forge-source-state',
        parents: [],
        files,
        message: 'synthetic',
        at: '2026-01-01T00:00:00Z',
      }),
    ),
  );
  const request = {
    url: 'https://fixture.invalid',
    projectId: 'project',
    laneId: randomUUID(),
    operationId: randomUUID(),
  };
  const selection = {
    schema: 2,
    projectId: 'project',
    laneId: request.laneId,
    intentId: randomUUID(),
    head,
    version: 0,
    sourceVersion: 0,
    lifecycleVersion: 0,
    state: 'active',
    base: { head, receiptId: 'base' },
    authority: { mode: 'server', epoch: 1 },
  };
  writeFileSync(join(root, 'request.json'), JSON.stringify({ request, selection }));
  const extra = { FORGE_OBJECT_CACHE: objects, XDG_CACHE_HOME: join(root, 'cache') };
  const killed = worker(t, ['crash', root], extra);
  const message = await killed.message();
  assert.equal(message.barrier, true);
  killed.child.kill('SIGKILL');
  assert.equal((await killed.done).signal, 'SIGKILL');
  assert.equal(readHostedLaneCheckout(join(root, 'client')), null, 'an unflushed stage is never installed');
  const retry = worker(t, ['retry', root], extra);
  const completed = await retry.message();
  assert.equal((await retry.done).code, 0);
  assert.equal(completed.result.replayed, false);
  assert.equal(completed.result.downloadedObjects, 0);
  assert.deepEqual(completed.calls, { select: 2, objects: 0, downloads: 0 });
  const installed = readHostedLaneCheckout(join(root, 'client'));
  assert.equal(installed.operationId, request.operationId);
  for (const file of files) assert.deepEqual(readFileSync(join(root, 'client', file.path)), bytes);
  const volumeQueues = join(extra.XDG_CACHE_HOME, 'forge', 'materialization-v1');
  for (const name of readdirSync(volumeQueues)) assert.deepEqual(queueEntries(join(volumeQueues, name)), []);
});
