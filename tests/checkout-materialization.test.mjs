// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import assert from 'node:assert/strict';
import { execFileSync, fork } from 'node:child_process';
import { once } from 'node:events';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { materializationDirectory, withCheckoutMaterialization } from '../dist/checkout-materialization.js';
import { checkoutIo, checkoutIoCapacity, checkoutVolumeCapacity } from '../dist/checkout-io.js';
import { CheckQueue, queueEntries } from '../dist/check-queue.js';
import { digest } from '../dist/hash.js';
import { readHostedLaneCheckout } from '../dist/hosted-lane-checkout-marker.js';

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'forge-materialization-test-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return root;
}

test(
  'a turn that expires while acquiring a later device still executes one job',
  { timeout: 10000 },
  async t => {
    const root = fixture(t),
      a = join(root, 'a'),
      b = join(root, 'b');
    mkdirSync(a);
    mkdirSync(b);
    const original = fs.statSync;
    fs.statSync = (path, ...args) => {
      const stat = original(path, ...args);
      if (path === a) stat.dev = 303;
      if (path === b) stat.dev = 404;
      return stat;
    };
    syncBuiltinESMExports();
    const first = materializationDirectory(a),
      later = materializationDirectory(b);
    const blocker = new CheckQueue(later, {
      limit: 1,
      serializeAdmission: false,
      identity: { phase: 'copy' },
    });
    assert(blocker.tryAcquire());
    let peer;
    t.signal.addEventListener(
      'abort',
      () => {
        peer?.release();
        blocker.release();
      },
      { once: true },
    );
    t.after(() => {
      peer?.release();
      blocker.release();
      fs.statSync = original;
      syncBuiltinESMExports();
    });
    const pending = withCheckoutMaterialization(a, () => checkoutIo(async () => 42), { paths: [b] });
    await new Promise(r => setImmediate(r));
    assert(queueEntries(first).some(entry => entry.ticket?.holding));
    // This older waiter keeps the first device contended after the second is free.
    peer = new CheckQueue(first, { limit: 1, serializeAdmission: false, identity: { phase: 'copy' } });
    assert.equal(peer.tryAcquire(), false);
    await new Promise(r => setTimeout(r, 1100));
    blocker.release();
    try {
      assert.equal(await pending, 42);
    } finally {
      peer.release();
    }
  },
);

test(
  'matching workers fill spare capacity behind an older incompatible waiter',
  {
    skip: checkoutVolumeCapacity() < 2,
    timeout: 10000,
  },
  async t => {
    const root = fixture(t),
      options = { directory: join(root, 'queue') };
    let release, ready;
    const hold = new Promise(r => (release = r)),
      entered = new Promise(r => (ready = r));
    t.signal.addEventListener('abort', () => release(), { once: true });
    const active = withCheckoutMaterialization(
      root,
      () =>
        checkoutIo(async () => {
          ready();
          await hold;
        }),
      options,
    );
    await entered;
    const incompatible = withCheckoutMaterialization(
      root,
      () => checkoutIo(async () => 42, 'durability'),
      options,
    );
    try {
      assert.equal(
        await withCheckoutMaterialization(root, () => checkoutIo(async () => 'compatible'), options),
        'compatible',
      );
    } finally {
      release();
      await Promise.all([active, incompatible]);
    }
  },
);
test(
  'queue changes invalidate a negative spare-capacity hint while a worker is busy',
  {
    skip: Math.min(checkoutIoCapacity(), checkoutVolumeCapacity()) < 2,
    timeout: 10000,
  },
  async t => {
    const root = fixture(t),
      directory = join(root, 'queue');
    const peers = Array.from({ length: checkoutVolumeCapacity() - 1 }, () => {
      const peer = new CheckQueue(directory, {
        limit: checkoutVolumeCapacity(),
        serializeAdmission: false,
        identity: { phase: 'copy' },
      });
      assert(peer.tryAcquire());
      return peer;
    });
    let entered, spare, release;
    const firstEntered = new Promise(r => (entered = r)),
      spareEntered = new Promise(r => (spare = r)),
      held = new Promise(r => (release = r));
    t.signal.addEventListener('abort', () => release(), { once: true });
    t.after(() => {
      release();
      for (const peer of peers) peer.release();
    });
    const operation = withCheckoutMaterialization(
      root,
      () =>
        Promise.all([
          checkoutIo(async () => {
            entered();
            await held;
          }),
          checkoutIo(async () => spare()),
        ]),
      { directory },
    );
    await firstEntered;
    for (const peer of peers) peer.release();
    try {
      await spareEntered;
    } finally {
      release();
      await operation;
    }
  },
);

test('serial write and read continuations reuse a worker ticket', async t => {
  const root = fixture(t),
    directory = join(root, 'queue'),
    original = fs.mkdirSync;
  let tickets = 0;
  fs.mkdirSync = (path, ...args) => {
    if (
      String(path).startsWith(directory + '/') &&
      !String(path)
        .slice(directory.length + 1)
        .includes('/')
    )
      tickets++;
    return original(path, ...args);
  };
  syncBuiltinESMExports();
  t.after(() => {
    fs.mkdirSync = original;
    syncBuiltinESMExports();
  });
  await withCheckoutMaterialization(
    root,
    async () => {
      for (let i = 0; i < 32; i++) {
        await checkoutIo(async () => i);
        await checkoutIo(async () => i, 'read');
      }
    },
    { directory },
  );
  assert.equal(tickets, 1, 'await continuations must not create per-file admission metadata');
});

test(
  'obsolete waiting workers retire without admitting a phase that has no jobs',
  {
    skip: Math.min(checkoutIoCapacity(), checkoutVolumeCapacity()) < 2,
    timeout: 10000,
  },
  async t => {
    const root = fixture(t),
      directory = join(root, 'queue');
    const blocker = new CheckQueue(directory, {
      limit: 1,
      serializeAdmission: false,
      identity: { phase: 'copy' },
    });
    assert(blocker.tryAcquire());
    const rename = fs.renameSync;
    let readAdmissions = 0,
      ceiling;
    fs.renameSync = (from, to) => {
      rename(from, to);
      if (String(to).startsWith(directory + '/') && String(to).endsWith('/ticket.json')) {
        const ticket = JSON.parse(readFileSync(to, 'utf8'));
        if (ticket.holding && ticket.phase === 'read') readAdmissions++;
      }
    };
    syncBuiltinESMExports();
    t.after(() => {
      blocker.release();
      ceiling?.release();
      fs.renameSync = rename;
      syncBuiltinESMExports();
    });
    const operation = withCheckoutMaterialization(
      root,
      async () => {
        await Promise.all(Array.from({ length: 16 }, () => checkoutIo(async () => 1, 'read')));
        ceiling.release();
        return checkoutIo(async () => 42);
      },
      { directory },
    );
    await new Promise(r => setImmediate(r));
    ceiling = new CheckQueue(directory, {
      limit: 1,
      serializeAdmission: false,
      identity: { phase: 'durability' },
    });
    blocker.release();
    assert.equal(await operation, 42);
    assert.equal(readAdmissions, 1, 'idle read reservations must not take turns before the actual copy');
  },
);

function worker(t, args, extra = {}) {
  const child = fork(new URL('./fixtures/checkout-materialization-worker.mjs', import.meta.url), args, {
    execArgv: [],
    env: { ...process.env, ...extra },
    silent: true,
  });
  let stderr = '';
  child.stderr.on('data', value => (stderr += value));
  const journal =
    args[0] === 'journal'
      ? once(child.stdout, 'data').then(([bytes]) => {
          assert.equal(String(bytes), 'journal\n');
          return { journal: true };
        })
      : undefined;
  const done = once(child, 'exit').then(([code, signal]) => ({ code, signal, stderr }));
  t.after(() => {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
  });
  const message = () =>
    Promise.race([
      journal ?? once(child, 'message').then(([value]) => value),
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

test('a killed shared-cache fill releases its recoverable ticket', async t => {
  const root = fixture(t),
    killed = worker(t, ['fill', root]);
  assert.equal((await killed.message()).fill, true);
  killed.child.kill('SIGKILL');
  assert.equal((await killed.done).signal, 'SIGKILL');
  const retry = worker(t, ['fill-retry', root]);
  assert.equal((await retry.message()).fill, true);
  assert.equal((await retry.done).code, 0);
  assert.deepEqual(queueEntries(join(root, 'fill')), []);
});

test('50 mixed-phase opens across ten processes all run within one shared volume I/O budget', async t => {
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
    assert([...phases.values()].every(count => count >= 0));
    assert(
      !((phases.get('copy') || 0) > 0 && (phases.get('durability') || 0) > 0),
      'write and fsync jobs drain before switching phase',
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

test(
  'independent initial journals share the I/O ceiling without taking the tree mutation queue',
  {
    skip: process.platform === 'win32' || checkoutVolumeCapacity() < 2,
    timeout: 10000,
  },
  async t => {
    const root = fixture(t),
      objects = join(root, 'objects');
    mkdirSync(objects);
    const bytes = Buffer.from(
      JSON.stringify({
        schema: 1,
        kind: 'forge-source-state',
        parents: [],
        files: [],
        message: 'synthetic',
        at: '2026-01-01T00:00:00Z',
      }),
    );
    const head = digest(bytes);
    writeFileSync(join(objects, head), bytes, { mode: 0o600 });
    const start = name => {
      const directory = join(root, name);
      mkdirSync(directory);
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
      writeFileSync(join(directory, 'request.json'), JSON.stringify({ request, selection }));
      return worker(t, ['journal', directory], { FORGE_OBJECT_CACHE: objects });
    };
    const first = start('one');
    let second;
    const stopped = async worker => {
      // Readiness precedes SIGSTOP. SIGCONT before that stop would be lost,
      // leaving a correctly admitted journal suspended until the test expires.
      while (!t.signal.aborted) {
        const state = execFileSync('/bin/ps', ['-p', String(worker.child.pid), '-o', 'stat='], {
          encoding: 'utf8',
          timeout: 1000,
        }).trim();
        if (state.startsWith('T')) return;
        await new Promise(resolve => setImmediate(resolve));
      }
      throw new Error('journal worker did not stop before the test ended');
    };
    const resume = () => {
      for (const w of [first, second]) if (w && w.child.exitCode === null) w.child.kill('SIGCONT');
    };
    t.signal.addEventListener('abort', resume, { once: true });
    try {
      assert.equal((await first.message()).journal, true);
      await stopped(first);
      second = start('two');
      assert.equal(
        (await second.message()).journal,
        true,
        'a stopped journal must not serialize another root',
      );
      await stopped(second);
    } finally {
      resume();
    }
    for (const w of [first, second]) if (w) assert.equal((await w.done).code, 0);
    assert.deepEqual(queueEntries(materializationDirectory(root)), []);
  },
);

test(
  'loss of the coordinator root rejects a waiting worker instead of retrying without yielding',
  { timeout: 10000 },
  async t => {
    const root = fixture(t),
      directory = join(root, 'queue');
    let ready, release;
    const entered = new Promise(r => (ready = r)),
      held = new Promise(r => (release = r));
    t.signal.addEventListener('abort', () => release(), { once: true });
    const owner = withCheckoutMaterialization(
      root,
      () =>
        checkoutIo(async () => {
          ready();
          await held;
        }),
      { directory },
    );
    await entered;
    const waiting = withCheckoutMaterialization(
      root,
      () => checkoutIo(async () => assert.fail('lost coordinator admitted I/O'), 'durability'),
      { directory },
    );
    const rejected = assert.rejects(waiting, error => error.code === 'ENOENT');
    await new Promise(r => setImmediate(r));
    rmSync(directory, { recursive: true, force: true });
    try {
      await rejected;
    } finally {
      release();
      await owner;
    }
  },
);

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
  assert.deepEqual(queueEntries(`${materializationDirectory(root)}.writes`), []);
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

test(
  'read-only verification progresses while a durability worker is stalled',
  { timeout: 10000 },
  async t => {
    const root = fixture(t),
      options = { directory: join(root, 'queue') };
    let release, ready;
    const hold = new Promise(r => (release = r)),
      entered = new Promise(r => (ready = r));
    const barrier = withCheckoutMaterialization(
      root,
      () =>
        checkoutIo(async () => {
          ready();
          await hold;
        }, 'durability'),
      options,
    );
    await entered;
    try {
      const copy = withCheckoutMaterialization(root, () => checkoutIo(async () => 'copied', 'read'), options);
      if (checkoutVolumeCapacity() > 1) assert.equal(await copy, 'copied');
      else {
        release();
        await copy;
      }
    } finally {
      release();
      await barrier;
    }
    assert.deepEqual(queueEntries(options.directory), []);
  },
);

test(
  'a continuous mixed-phase producer yields its finite turns to older waiters',
  { timeout: 15000 },
  async t => {
    const root = fixture(t),
      directory = join(root, 'queue');
    let release,
      ready,
      iterations = 0,
      observedAt = Infinity;
    const hold = new Promise(r => (release = r)),
      entered = new Promise(r => (ready = r));
    const producers = Array.from({ length: checkoutVolumeCapacity() }, (_, producer) =>
      withCheckoutMaterialization(
        root,
        async () => {
          await checkoutIo(async () => {
            ready();
            await hold;
          });
          while (!t.signal.aborted && observedAt === Infinity)
            await checkoutIo(
              async () => {
                iterations++;
                await new Promise(r => setTimeout(r, 10));
              },
              producer % 2 ? 'copy' : 'durability',
            );
          if (!t.signal.aborted)
            await checkoutIo(
              async () => {
                iterations++;
              },
              producer % 2 ? 'copy' : 'durability',
            );
        },
        { directory },
      ),
    );
    t.signal.addEventListener('abort', () => release(), { once: true });
    await entered;
    const waiter = withCheckoutMaterialization(
      root,
      () =>
        checkoutIo(async () => {
          observedAt = iterations;
        }, 'durability'),
      { directory },
    );
    release();
    await Promise.all([...producers, waiter]);
    assert(observedAt < iterations, 'a queued peer runs before continuing producers exhaust their work');
    assert.deepEqual(queueEntries(directory), []);
  },
);
