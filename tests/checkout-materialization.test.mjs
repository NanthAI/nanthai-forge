// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import assert from 'node:assert/strict';
import { fork } from 'node:child_process';
import { once } from 'node:events';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { materializationDirectory, withCheckoutMaterialization } from '../dist/checkout-materialization.js';
import { checkoutIo, checkoutVolumeCapacity } from '../dist/checkout-io.js';
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

test('unrelated checkout roots on the same device share one volume coordinator', t => {
  const root = fixture(t);
  mkdirSync(join(root, 'other'));
  assert.equal(materializationDirectory(root), materializationDirectory(join(root, 'other')));
  const originalDirectory = materializationDirectory(root);
  const previous = process.env.XDG_CACHE_HOME;
  process.env.XDG_CACHE_HOME = join(root, 'different-cache');
  try {
    assert.equal(materializationDirectory(root), originalDirectory);
  } finally {
    if (previous === undefined) delete process.env.XDG_CACHE_HOME;
    else process.env.XDG_CACHE_HOME = previous;
  }
});

test('50 opens across ten processes all run, with one shared volume I/O budget', async t => {
  const root = fixture(t);
  const results = await Promise.all(Array.from({ length: 10 }, () => worker(t, ['queue', root, '5']).done));
  for (const result of results) assert.equal(result.code, 0, result.stderr);
  const events = readFileSync(join(root, 'events'), 'utf8')
    .trim()
    .split('\n')
    .map(line => {
      const [at, delta, phase] = line.split(' ');
      return { at: BigInt(at), delta: Number(delta), phase };
    })
    .sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : a.delta - b.delta));
  let active = 0,
    peak = 0;
  const phases = new Map();
  for (const event of events) {
    phases.set(event.phase, (phases.get(event.phase) || 0) + event.delta);
    assert(
      [...phases.values()].filter(count => count > 0).length <= 1,
      'copy and durability epochs must not overlap',
    );
    active += event.delta;
    peak = Math.max(peak, active);
    assert(active >= 0 && active <= checkoutVolumeCapacity(), `active=${active}`);
  }
  assert.equal(events.length, 100);
  assert.equal(active, 0);
  assert(peak >= Math.min(2, checkoutVolumeCapacity()) && peak <= checkoutVolumeCapacity());
  assert.deepEqual(queueEntries(join(root, 'queue')), []);
});

test('a failed pass releases capacity and independent volume queues proceed separately', async t => {
  const root = fixture(t),
    failure = new Error('synthetic failure');
  const options = { directory: join(root, 'queue') };
  await assert.rejects(
    withCheckoutMaterialization(
      root,
      async () => {
        return checkoutIo(async () => {
          throw failure;
        });
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
    () =>
      checkoutIo(async () => {
        entered();
        await gate;
      }),
    options,
  );
  await ready;
  try {
    assert.equal(
      await withCheckoutMaterialization(root, () => checkoutIo(async () => 'other volume'), {
        directory: join(root, 'other-volume'),
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
  assert.deepEqual(queueEntries(materializationDirectory(root)), []);
});

// Different device ids without requiring mounts or privileged setup.
test('cache and checkout devices are deduplicated and acquired in the same order', async t => {
  const root = fixture(t),
    a = join(root, 'a'),
    b = join(root, 'b');
  mkdirSync(a);
  mkdirSync(b);
  const original = fs.statSync;
  fs.statSync = (path, ...args) => {
    const stat = original(path, ...args);
    if (path === a) stat.dev = 101;
    if (path === b) stat.dev = 202;
    return stat;
  };
  syncBuiltinESMExports();
  t.after(() => {
    fs.statSync = original;
    syncBuiltinESMExports();
  });
  const seen = [];
  await Promise.all(
    [
      [a, b],
      [b, a],
    ].map(([stage, cache]) =>
      withCheckoutMaterialization(
        stage,
        () =>
          checkoutIo(async () => {
            for (const path of [a, b]) {
              const entries = queueEntries(materializationDirectory(path));
              assert(entries.some(entry => entry.ticket?.holding));
              assert(entries.filter(entry => entry.ticket?.holding).length <= checkoutVolumeCapacity());
            }
            seen.push(stage);
          }),
        { paths: [cache, stage, join(cache, 'not-created-yet')] },
      ),
    ),
  );
  assert.equal(seen.length, 2);
  for (const path of [a, b]) assert.deepEqual(queueEntries(materializationDirectory(path)), []);
});

test('CPU and network waits consume no volume permit and completion retires spare waiters', async t => {
  const root = fixture(t),
    directory = join(root, 'queue');
  let release, ready;
  const gate = new Promise(r => (release = r)),
    entered = new Promise(r => (ready = r));
  const waiting = withCheckoutMaterialization(
    root,
    async () => {
      ready();
      await gate;
    },
    { directory },
  );
  await entered;
  assert.deepEqual(queueEntries(directory), []);
  try {
    await withCheckoutMaterialization(
      root,
      () => Promise.all(Array.from({ length: 32 }, () => checkoutIo(async () => 42))),
      { directory },
    );
    assert.deepEqual(queueEntries(directory), [], 'no queued spare workers survive completion');
  } finally {
    release();
    await waiting;
  }
});

test('ten processes serialize editing write passes while every request completes', async t => {
  const root = fixture(t);
  const results = await Promise.all(Array.from({ length: 10 }, () => worker(t, ['writes', root]).done));
  for (const result of results) assert.equal(result.code, 0, result.stderr);
  const events = readFileSync(join(root, 'events'), 'utf8')
    .trim()
    .split('\n')
    .map(line => {
      const [at, delta] = line.split(' ');
      return { at: BigInt(at), delta: Number(delta) };
    })
    .sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : a.delta - b.delta));
  let active = 0;
  for (const event of events) {
    active += event.delta;
    assert(active >= 0 && active <= 1);
  }
  assert.equal(events.length, 20);
  assert.equal(active, 0);
  assert.deepEqual(queueEntries(join(root, 'queue')), []);
});
