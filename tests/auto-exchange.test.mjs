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
import { boundExchange } from '../dist/bound-exchange.js';
import { drainAutoExchange, autoExchangeDue, waitForPendingChange } from '../dist/auto-exchange.js';
import { readHostState, updateHostState } from '../dist/host-binding.js';
import { readPendingExchange, recordPendingExchange, exchangeBookkeeping } from '../dist/pending-exchange.js';
import { readAutoExchangeStatus } from '../dist/auto-exchange-status.js';
import { readPendingStatus } from '../dist/pending-status-read.js';
import { formatPendingStatus } from '../dist/pending-status-format.js';
import { ForgeError } from '../dist/errors.js';
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
          exchange,
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

test('unknown usage does not pause; provider errors and credentials are never retained', async t => {
  const f = fixture(t, { debounceMs: 0, pauseOnDailySpend: true });
  await f.run({
    usage: async () => {
      throw new Error('token=synthetic-secret');
    },
  });
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
