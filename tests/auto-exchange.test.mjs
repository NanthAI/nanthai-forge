// SPDX-License-Identifier: Apache-2.0
import './check-runtime.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { initNative } from '../dist/native-work.js';
import { WorkStore } from '../dist/work-store.js';
import { watcherRuntime } from '../dist/local-watcher.js';
import { FakeWatchWorker } from './local-watcher-fixture.mjs';
import { LONG_ACTION_DEADLINE_MS } from '../dist/long-action.js';
import { boundExchange } from '../dist/bound-exchange.js';
import { drainAutoExchange, autoExchangeDue, waitForPendingChange } from '../dist/auto-exchange.js';
import { readHostState, updateHostState } from '../dist/host-binding.js';
import { readPendingExchange, recordPendingExchange, exchangeBookkeeping } from '../dist/pending-exchange.js';
import { readAutoExchangeStatus } from '../dist/auto-exchange-status.js';
import { readPendingStatus } from '../dist/pending-status-read.js';
import { formatPendingStatus } from '../dist/pending-status-format.js';
import { ForgeError } from '../dist/errors.js';
import { hostCli } from '../dist/host-command.js';
import { USAGE_CACHE_MS } from '../dist/auto-exchange-usage-command.js';
import { SPEND_WINDOW_MS } from '../dist/auto-exchange-spend.js';

// Explicit drivers below use synthetic owners and transports; no detached workers.
process.env.FORGE_AUTO_EXCHANGE_WORKER = '1';
const deferred = () => {
  let resolve;
  const promise = new Promise(r => {
    resolve = r;
  });
  return { promise, resolve };
};
function fixture(t, policy = {}) {
  const root = mkdtempSync(join(tmpdir(), 'forge-auto-exchange-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  writeFileSync(join(root, 'source.txt'), 'synthetic\n');
  initNative(root);
  const store = new WorkStore(root);
  let now = Date.now(),
    publications = 0;
  const attempts = [],
    objects = new Map(),
    receipts = new Map();
  const f = {
    root,
    store,
    attempts,
    objects,
    receipts,
    sleeps: [],
    now: () => now,
    advance: ms => {
      now += ms;
    },
    queue: () => readPendingExchange(store.directory),
    state: () => readHostState(store),
    save: () =>
      store.locked(() => {
        now++;
        const data = store.load();
        data.revision++;
        exchangeBookkeeping(() => store.save(data));
        recordPendingExchange(store.directory, data.revision, new Date(now).toISOString());
      }),
    editPolicy: patch =>
      store.locked(() => {
        const data = store.load();
        Object.assign(data.autonomyPolicy.autoExchange, patch);
        data.revision++;
        store.save(data);
      }),
    usage: async context => ({
      kind: 'measured',
      scope: 'team',
      subject: 'synthetic-team',
      ...context,
      observedAt: now,
      totalUsd: f.usd,
    }),
    usd: 10,
  };
  f.editPolicy({ enabled: true, debounceMs: 30_000, maxPendingAgeMs: 300_000, ...policy });
  now = Date.now() + 1;
  updateHostState(store, host => {
    host.binding = {
      projectId: 'synthetic-project',
      deployment: 'https://synthetic.invalid',
      projectUrl: 'https://synthetic.invalid/project',
      operationId: randomUUID(),
      name: 'Synthetic',
      visibility: 'private',
      backupId: 'seed',
    };
  });
  const exchange = (_deployment, projectId, operationId) => ({
    metadataTrees: true,
    checkpointKey: backup => JSON.stringify([projectId, backup ?? 'seed']),
    client: { query: async () => ({ currentBackup: 'seed' }) },
    published: async () => receipts.get(operationId) ?? null,
    missing: async pins => pins.filter(pin => !objects.has(pin.sha256)).map(pin => pin.sha256),
    upload: async (pin, bytes) => {
      objects.set(pin.sha256, Buffer.from(bytes));
      await f.onUpload?.();
    },
    publish: async () => {
      attempts.push(operationId);
      if (f.beforePublish) await f.beforePublish();
      const receipt = `backup-${++publications}`;
      receipts.set(operationId, receipt);
      if (f.lostReply) throw new ForgeError('EXCHANGE_UPLOAD_UNKNOWN', 'Synthetic lost reply');
      return receipt;
    },
  });
  f.exchange = exchange;
  f.manual = () => boundExchange(root, 'push', undefined, false, { exchange });
  f.run = (options = {}) =>
    drainAutoExchange(new WorkStore(root), {
      now: f.now,
      sleep: async ms => {
        f.sleeps.push(ms);
        now += ms;
      },
      usage: f.usage,
      push: admission =>
        boundExchange(root, 'push', undefined, false, {
          beforePush: admission,
          exchange: f.exchange,
        }),
      ...options,
    });
  return f;
}

test('trailing debounce coalesces bursts and max pending age prevents starvation', async t => {
  const f = fixture(t);
  let changes = 0;
  await f.run({
    sleep: async ms => {
      f.sleeps.push(ms);
      f.advance(ms);
      if (++changes <= 20) f.save();
    },
  });
  assert.equal(f.attempts.length, 1);
  assert.ok(f.sleeps.length > 1);
  assert.ok(f.sleeps.reduce((a, b) => a + b, 0) <= 300_000);
  assert.deepEqual(f.queue().pending, []);
  const status = readAutoExchangeStatus(f.store, f.now());
  assert.equal(status.status, 'idle');
  assert.equal(status.transport.billedUsd, null);
  assert.equal(status.transport.estimatedUsd, null);
  assert.equal(status.transport.measured.rpcRequests, 0); // in-memory fake
});

test('quiet burst waits 30 seconds and idle drain has no sleep, push or usage reads', async t => {
  const f = fixture(t);
  const expected = autoExchangeDue(f.queue(), 30_000, 300_000) - f.now();
  await f.run();
  assert.deepEqual(f.sleeps, [expected]);
  const revision = f.store.revision(),
    sequence = f.queue().sequence;
  f.sleeps.length = 0;
  await f.run({
    usage: () => {
      assert.fail('idle usage read');
    },
  });
  assert.deepEqual(f.sleeps, []);
  assert.equal(f.attempts.length, 1);
  assert.equal(f.store.revision(), revision);
  assert.equal(f.queue().sequence, sequence);
});

test('Work changed during transfer gets one follow-up snapshot; bookkeeping does not requeue', async t => {
  const f = fixture(t);
  let changed = false;
  f.onUpload = () => {
    if (!changed) {
      changed = true;
      f.save();
    }
  };
  await f.run();
  assert.equal(f.attempts.length, 2);
  assert.notEqual(f.attempts[0], f.attempts[1]);
  assert.deepEqual(f.queue().pending, []);
  assert.equal(f.state().autoExchange.status, 'pushed');
  assert.equal(f.state().autoExchange.worker, undefined);
});

test('lost reply and process loss resume the original operation before sending later saves', async t => {
  const f = fixture(t, { debounceMs: 0 });
  const crash = new Error('synthetic runtime disappeared');
  f.lostReply = true;
  await assert.rejects(
    f.run({
      sleep: async () => {
        throw crash;
      },
    }),
    crash,
  );
  const pending = f.state().push,
    capture = pending.captureId;
  assert.ok(pending.operationId);
  assert.equal(f.attempts.length, 1);
  f.save();
  f.lostReply = false;
  await f.run();
  assert.equal(f.attempts.length, 2); // receipt replay did not publish original twice
  assert.notEqual(f.attempts[1], pending.operationId);
  assert.ok(readFileSync(join(f.store.directory, `exchange-${capture}`, 'manifest.json')));
  assert.deepEqual(f.queue().pending, []);
  assert.equal(f.state().push, undefined);
});

test('two drivers never publish concurrently or duplicate the saved snapshot', async t => {
  const f = fixture(t, { debounceMs: 0 }),
    entered = deferred(),
    release = deferred();
  f.beforePublish = async () => {
    entered.resolve();
    await release.promise;
  };
  const first = f.run();
  await entered.promise;
  const second = await f.run();
  assert.ok('waiting' in second);
  assert.equal(f.attempts.length, 1);
  release.resolve();
  await first;
  await f.run();
  assert.equal(f.attempts.length, 1);
});

test('manual push and auto driver share the bound queue and clear covered work once', async t => {
  const f = fixture(t, { debounceMs: 0 }),
    entered = deferred(),
    release = deferred();
  f.beforePublish = async () => {
    entered.resolve();
    await release.promise;
  };
  const manual = f.manual();
  await entered.promise;
  const automatic = f.run();
  release.resolve();
  await Promise.all([manual, automatic]);
  assert.equal(f.attempts.length, 1);
  assert.deepEqual(f.queue().pending, []);
});

test('threshold boundary, visible pause, unchanged manual capability, and automatic window resume', async t => {
  const f = fixture(t, { debounceMs: 0, pauseOnDailySpend: true });
  await f.run();
  f.usd += 0.99;
  f.save();
  await f.run();
  assert.equal(f.attempts.length, 2);
  f.usd += 0.02;
  f.save();
  const stop = new Error('observe pause');
  await assert.rejects(
    f.run({
      sleep: async () => {
        throw stop;
      },
    }),
    stop,
  );
  const paused = readAutoExchangeStatus(f.store, f.now());
  assert.equal(paused.status, 'paused');
  assert.ok(Math.abs(paused.spend.deltaUsd - 1.01) < 1e-8);
  assert.match(paused.resume, /automatically/);
  assert.match(formatPendingStatus(readPendingStatus(f.store)), /paused.*1.009|paused.*1.01/);
  assert.equal(f.attempts.length, 2);
  await f.manual();
  assert.equal(f.attempts.length, 3);
  f.save();
  f.advance(SPEND_WINDOW_MS);
  await f.run();
  assert.equal(f.attempts.length, 4);
  assert.equal(f.state().autoExchange.spend.paused, false);
});

test('spend increase never cancels an in-flight push; the next automatic push pauses', async t => {
  const f = fixture(t, { debounceMs: 0, pauseOnDailySpend: true });
  let changed = false;
  f.onUpload = () => {
    if (!changed) {
      changed = true;
      f.usd += 1.01;
      f.save();
    }
  };
  const stop = new Error('paused after first');
  await assert.rejects(
    f.run({
      sleep: async () => {
        throw stop;
      },
    }),
    stop,
  );
  assert.equal(f.attempts.length, 1);
  assert.equal(f.receipts.size, 1);
  assert.equal(f.state().push, undefined);
  assert.equal(f.state().autoExchange.status, 'paused');
  assert.ok(f.queue().pending.length);
});

test('unknown usage defers automatic pushes; manual push works and provider errors are never retained', async t => {
  const f = fixture(t, { debounceMs: 0, pauseOnDailySpend: true });
  await f.run({
    usage: async () => {
      throw new Error('token=synthetic-secret');
    },
  });
  assert.equal(f.attempts.length, 0);
  assert.equal(f.state().autoExchange.status, 'paused');
  assert.equal(f.state().autoExchange.code, 'AUTO_EXCHANGE_SPEND_UNAVAILABLE');
  assert.match(readAutoExchangeStatus(f.store).resume, /fresh measured observation/);
  assert.match(formatPendingStatus(readPendingStatus(f.store)), /paused.*unavailable.*Fix/);
  await f.manual();
  assert.equal(f.attempts.length, 1);
  assert.equal(f.state().autoExchange.spend.availability, 'unknown');
  assert.equal(f.state().autoExchange.spend.paused, false);
  assert.doesNotMatch(JSON.stringify(f.state()), /synthetic-secret/);
});

test('policy disabled or binding changed while queued is reread before automatic transport', async t => {
  const f = fixture(t);
  await f.run({
    sleep: async ms => {
      f.advance(ms);
      f.editPolicy({ enabled: false });
    },
  });
  assert.equal(f.attempts.length, 0);
  f.editPolicy({ enabled: true, debounceMs: 0, pauseOnDailySpend: true });
  await f.run({
    usage: async () => {
      updateHostState(f.store, state => {
        state.binding.projectId = 'new-synthetic-project';
      });
      f.editPolicy({ enabled: false });
      return undefined;
    },
  });
  assert.equal(f.attempts.length, 0);
  assert.equal(f.state().autoExchange.projectId, 'synthetic-project');
});

test('revoked auth and journal conflicts retain pending saves and report the safe code', async t => {
  const f = fixture(t, { debounceMs: 0 });
  for (const code of ['AUTH_REQUIRED', 'FORBIDDEN', 'WORK_CONFLICT']) {
    await f.run({
      push: async admission => {
        await admission();
        throw new ForgeError(code, 'synthetic');
      },
    });
    assert.equal(f.state().autoExchange.status, 'failed');
    assert.equal(f.state().autoExchange.code, code);
    assert.ok(f.queue().pending.length);
  }
});

test('an incomplete capture stays pending without repeatedly uploading identical saved work', async t => {
  const f = fixture(t, { debounceMs: 0 });
  let calls = 0;
  const push = async admission => {
    await admission();
    calls++;
  };
  await f.run({ push });
  await f.run({ push });
  assert.equal(calls, 1);
  assert.equal(f.state().autoExchange.status, 'incomplete');
  assert.ok(f.queue().pending.length);
  f.save();
  await f.run({ push });
  assert.equal(calls, 2);
});

test('wakeups coalesce, respect opt-out/live workers, and recover a disappeared runtime identity', async t => {
  const { wakeAutoExchange } = await import('../dist/auto-exchange-wake.js');
  const { processIdentity } = await import('../dist/local-process.js');
  const f = fixture(t, { enabled: false });
  let launches = 0;
  const launch = () => {
    launches++;
    return { on() {}, unref() {} };
  };
  wakeAutoExchange(f.store, true, launch);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(launches, 0);
  f.editPolicy({ enabled: true });
  for (let i = 0; i < 3; i++) wakeAutoExchange(f.store, true, launch);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(launches, 1);
  updateHostState(f.store, host => {
    host.autoExchange = {
      projectId: host.binding.projectId,
      deployment: host.binding.deployment,
      status: 'queued',
      at: f.now(),
      worker: processIdentity(),
    };
  });
  wakeAutoExchange(f.store, true, launch);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(launches, 1);
  updateHostState(f.store, host => {
    host.autoExchange.worker.startTime = 'old-runtime-identity';
  });
  wakeAutoExchange(f.store, true, launch);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(launches, 2);
});

test('lifecycle notification wakes a pending timer when automatic pushing is disabled', async t => {
  const { openAutoExchangeNotifications } = await import('../dist/auto-exchange-notify.js');
  const { wakeAutoExchange } = await import('../dist/auto-exchange-wake.js');
  const { processIdentity } = await import('../dist/local-process.js');
  const f = fixture(t);
  const notifications = await openAutoExchangeNotifications();
  try {
    updateHostState(f.store, host => {
      host.autoExchange = {
        projectId: host.binding.projectId,
        deployment: host.binding.deployment,
        status: 'queued',
        at: f.now(),
        worker: processIdentity(),
        wakeEndpoint: notifications.endpoint,
      };
    });
    const waiting = waitForPendingChange(f.store, 30_000, notifications.subscribe);
    f.editPolicy({ enabled: false });
    wakeAutoExchange(f.store, true, () => {
      assert.fail('existing worker must be notified');
    });
    assert.equal(await waiting, 'changed');
    assert.equal(f.attempts.length, 0);
    assert.ok(f.queue().pending.length);
  } finally {
    await notifications.close();
  }
});

test('publication while installing the pending wake listener is observed without a timer tick', async t => {
  const f = fixture(t);
  const waiting = waitForPendingChange(f.store, 30_000, () => {
    f.editPolicy({ enabled: false });
    return () => {};
  });
  assert.equal(await waiting, 'changed');
  assert.ok(f.queue().pending.length);
});

test('local spend command config persists, caches on demand, and pauses strictly above one dollar', async t => {
  const f = fixture(t, { debounceMs: 0, pauseOnDailySpend: true });
  const command = join(f.root, 'synthetic-usage');
  const setSample = () =>
    writeFileSync(
      command,
      `#!${process.execPath}\nconsole.log(${JSON.stringify(
        JSON.stringify({
          kind: 'measured',
          scope: 'team',
          subject: 'synthetic-team',
          projectId: 'synthetic-project',
          deployment: 'https://synthetic.invalid',
          observedAt: f.now(),
          totalUsd: f.usd,
        }),
      )});\n`,
      { mode: 0o700 },
    );
  await assert.rejects(hostCli([f.root, '--spend-command', 'relative']), { code: 'BAD_ARGUMENT' });
  setSample();
  await hostCli([f.root, '--spend-command', command]);
  assert.equal(f.state().binding.spendCommand, command);
  await f.run({ usage: undefined });
  assert.equal(f.attempts.length, 1);
  // A changed command output is not consulted again during the cache minute.
  f.usd += 1;
  f.save();
  setSample();
  await f.run({ usage: undefined });
  assert.equal(f.state().autoExchange.spend.deltaUsd, 0);
  f.advance(USAGE_CACHE_MS);
  f.save();
  setSample();
  await f.run({ usage: undefined });
  assert.equal(f.state().autoExchange.spend.deltaUsd, 1);
  assert.equal(f.attempts.length, 3);
  f.advance(USAGE_CACHE_MS);
  f.usd += 0.01;
  f.save();
  setSample();
  const stop = new Error('observed command pause');
  await assert.rejects(
    f.run({
      usage: undefined,
      sleep: async () => {
        throw stop;
      },
    }),
    stop,
  );
  assert.equal(f.state().autoExchange.status, 'paused');
  assert.equal(f.attempts.length, 3);
  await f.manual();
  assert.equal(f.attempts.length, 4);
  // Neither idle drains nor status execute even a command that would fail.
  writeFileSync(command, `#!${process.execPath}\nprocess.exit(1);\n`);
  await f.run({ usage: undefined });
  assert.equal(readAutoExchangeStatus(f.store, f.now()).status, 'idle');
  assert.equal(f.state().autoExchange.spend.availability, 'measured');
  await hostCli([f.root, '--no-spend-command']);
  assert.equal(f.state().binding.spendCommand, undefined);
});

test('unconfigured, unavailable, invalid and stale command output defer automatic attempts without polling', async t => {
  const f = fixture(t, { debounceMs: 0, pauseOnDailySpend: true });
  const command = join(f.root, 'synthetic-usage');
  for (const [body, reason] of [
    [undefined, 'unconfigured'],
    [null, 'unavailable'],
    ['process.exit(1);', 'unavailable'],
    ['console.log("garbage");', 'unavailable'],
    [
      `console.log(${JSON.stringify(JSON.stringify({ kind: 'measured', scope: 'team', subject: 'team', projectId: 'synthetic-project', deployment: 'https://synthetic.invalid', observedAt: 0, totalUsd: 1 }))});`,
      'stale',
    ],
    ['setInterval(() => {}, 1000);', 'unavailable'],
  ]) {
    if (body === undefined) await hostCli([f.root, '--no-spend-command']);
    else {
      if (body !== null) writeFileSync(command, `#!${process.execPath}\n${body}\n`, { mode: 0o700 });
      await hostCli([f.root, '--spend-command', command]);
    }
    await f.run({
      usage: undefined,
      sleep: async () => {
        throw new Error('must not poll');
      },
    });
    assert.equal(f.attempts.length, 0);
    const status = readAutoExchangeStatus(f.store, f.now());
    assert.equal(status.status, 'paused');
    assert.equal(status.spend.reason, reason);
    assert.match(status.resume, /Manual exchange push remains available/);
    assert.match(formatPendingStatus(readPendingStatus(f.store)), new RegExp(`paused.*${reason}`));
  }
  await f.manual();
  assert.equal(f.attempts.length, 1);
});

test('a silent Convex publication times out, retries its exact operation and completes on recovery', async t => {
  const { createServer } = await import('node:http');
  const { ConvexExchange } = await import('../dist/exchange-client.js');
  const { PUSH_STALL_MS } = await import('../dist/push-progress-state.js');
  const { LONG_ACTION_DEADLINE_MS } = await import('../dist/long-action.js');
  const f = fixture(t, { debounceMs: 0 });
  const realTimeout = globalThis.setTimeout;
  let deadlineExpirations = 0;
  // Compress the current production deadline, retaining real HTTP abort/retry.
  t.mock.method(globalThis, 'setTimeout', (fn, ms, ...args) => {
    if (ms !== LONG_ACTION_DEADLINE_MS) return realTimeout(fn, ms, ...args);
    return realTimeout(() => {
      deadlineExpirations++;
      fn(...args);
    }, 1250);
  });
  const requests = [],
    sockets = new Set();
  let firstProgress,
    status,
    publications = 0;
  const committed = new Map();
  const server = createServer(async (req, res) => {
    const chunks = [];
    for await (const part of req) chunks.push(part);
    requests.push(Buffer.concat(chunks).toString());
    const originalId = JSON.parse(requests.at(-1)).args[0].operationId;
    if (!committed.has(originalId)) {
      publications++;
      committed.set(originalId, 'backup-recovered');
    }
    if (requests.length === 1) {
      const progress = f.state().pushProgress;
      firstProgress = progress.lastProgressAt;
      assert.equal(progress.phase, 'projectExchangeActions:publish');
      status = readAutoExchangeStatus(f.store, progress.lastProgressAt + PUSH_STALL_MS);
      assert.equal(status.status, 'stalled');
      assert.match(status.resume, /retained operation/);
      assert.equal(status.operationId, f.state().push.operationId);
      return; // Accept the complete request; leave the socket open without headers.
    }
    assert.equal(f.state().pushProgress.lastProgressAt, firstProgress, 'a silent retry is not progress');
    res.end(JSON.stringify({ status: 'success', value: committed.get(originalId) }));
  });
  server.on('connection', socket => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => {
    for (const socket of sockets) socket.destroy();
    await new Promise(resolve => server.close(resolve));
  });
  const base = f.exchange;
  f.exchange = (...args) => {
    const transport = base(...args);
    const rpc = new ConvexExchange(
      `http://127.0.0.1:${server.address().port}`,
      'synthetic',
      args[1],
      args[2],
      null,
    );
    transport.publish = pin => rpc.publish(pin);
    return transport;
  };
  await f.run();
  assert.equal(deadlineExpirations, 1, 'the silent request must expire before its retry');
  assert.equal(requests.length, 2);
  assert.equal(publications, 1);
  assert.equal(requests[0], requests[1]);
  assert.equal(JSON.parse(requests[0]).args[0].operationId, status.operationId);
  assert.deepEqual(f.queue().pending, []);
  assert.equal(f.state().push, undefined);
  assert.equal(f.state().pushProgress, undefined);
  assert.equal(readAutoExchangeStatus(f.store).status, 'idle');
});

test('stalled wake cooperatively yields both queue slots; successor resumes the same pending operation', async t => {
  const { exchangeFetch } = await import('../dist/exchange-request.js');
  const { notifyAutoExchange } = await import('../dist/auto-exchange-notify.js');
  const { wakeAutoExchange } = await import('../dist/auto-exchange-wake.js');
  const { PUSH_STALL_MS } = await import('../dist/push-progress-state.js');
  const f = fixture(t, { debounceMs: 0 }),
    entered = deferred();
  const base = f.exchange;
  let active = 0,
    maximum = 0,
    pendingId,
    phases = [];
  t.mock.method(globalThis, 'fetch', async (_url, init) => {
    active++;
    maximum = Math.max(maximum, active);
    entered.resolve();
    return new Promise((_resolve, reject) => {
      init.signal.addEventListener(
        'abort',
        () => {
          active--;
          reject(init.signal.reason);
        },
        { once: true },
      );
    });
  });
  f.exchange = (...args) => {
    const transport = base(...args),
      publish = transport.publish;
    transport.publish = async pin => {
      if (!pendingId) {
        pendingId = args[2];
        return exchangeFetch('synthetic blocked publication', 'https://fixture.invalid');
      }
      assert.equal(args[2], pendingId);
      phases.push('successor');
      return publish(pin);
    };
    return transport;
  };
  const first = f.run();
  await entered.promise;
  // Move only the test clock. Console heartbeats do not change last progress.
  const progress = f.state().pushProgress;
  f.advance(progress.lastProgressAt + PUSH_STALL_MS - f.now());
  updateHostState(f.store, host => {
    host.pushProgress.lastProgressAt = Date.now() - PUSH_STALL_MS;
  });
  let second;
  wakeAutoExchange(f.store, true, () => {
    phases.push('launched');
    second = f.run();
    return { on() {}, unref() {} };
  });
  // Exercise the same private wake channel as startup/save recovery.
  notifyAutoExchange(f.state().autoExchange.wakeEndpoint);
  await first;
  await new Promise(resolve => setImmediate(resolve));
  assert.ok(second);
  await second;
  assert.deepEqual(phases, ['launched', 'successor']);
  assert.equal(maximum, 1);
  assert.equal(active, 0);
  assert.equal(f.attempts[0], pendingId);
  assert.deepEqual(f.queue().pending, []);
});

test('manual push phase and stale progress are visible even when automatic pushing is disabled', async t => {
  const { PUSH_STALL_MS } = await import('../dist/push-progress-state.js');
  const f = fixture(t, { enabled: false }),
    entered = deferred(),
    release = deferred();
  f.beforePublish = async () => {
    entered.resolve();
    await release.promise;
  };
  const pending = f.manual();
  await entered.promise;
  const progress = f.state().pushProgress;
  const fresh = readAutoExchangeStatus(f.store, progress.lastProgressAt);
  assert.equal(fresh.status, 'pushing');
  assert.equal(fresh.enabled, false);
  assert.match(fresh.phase, /uploading/);
  const stale = readAutoExchangeStatus(f.store, progress.lastProgressAt + PUSH_STALL_MS);
  assert.equal(stale.status, 'stalled');
  const value = readPendingStatus(f.store);
  value.hosted.autoExchange = stale;
  assert.match(formatPendingStatus(value), /stalled.*last progress.*Retry/);
  release.resolve();
  await pending;
});

test('unbound push keeps its structured setup error and creates no progress record', async t => {
  const f = fixture(t, { enabled: false });
  updateHostState(f.store, host => {
    delete host.binding;
  });
  await assert.rejects(f.manual(), error => error.code === 'HOST_NOT_BOUND');
  assert.equal(f.state().pushProgress, undefined);
});

test('degraded pending watch retains its existing deadline and makes no Convex or network calls', async t => {
  const f = fixture(t);
  let calls = 0;
  t.mock.method(globalThis, 'fetch', () => {
    calls++;
    throw new Error('network forbidden');
  });
  t.mock.method(watcherRuntime, 'createWorker', () => new FakeWatchWorker({ code: 'EMFILE' }));
  assert.equal(await waitForPendingChange(f.store, 20), 'deadline');
  assert.equal(calls, 0);
  assert.equal(f.attempts.length, 0);
});
