// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, statSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { getFunctionName, makeFunctionReference } from 'convex/server';
import { ConvexError } from 'convex/values';
import { initNative } from '../dist/native-work.js';
import { WorkStore } from '../dist/work-store.js';
import { readHostState, updateHostState } from '../dist/host-binding.js';
import { compactAgentSync } from '../dist/agent-sync-state.js';
import { agentSyncError } from '../dist/agent-sync-error.js';
import { flushAgentSync } from '../dist/agent-hosted-sync.js';
import { runAgentSyncRetries, waitAgentSyncRetry } from '../dist/agent-sync-retry.js';
import { startAgentSyncWorker, markAgentSyncPrepared } from '../dist/agent-sync-worker.js';
import { CheckQueue } from '../dist/check-queue.js';
import { hostCli } from '../dist/host-command.js';
import { readPendingStatus } from '../dist/pending-status-read.js';
import { formatPendingStatus } from '../dist/pending-status-format.js';
import { PRESENCE } from '../dist/presence.js';

function entry(seq, session = `session-${seq}`, presence = false) {
  return {
    operationId: randomUUID(),
    projectId: 'project',
    deployment: 'http://127.0.0.1:1',
    activity: {
      sessionId: session,
      sequence: seq,
      activityAt: Date.now(),
      kind: 'activity',
      name: 'Synthetic',
      environment: 'Local Lane',
      status: 'working',
      summary: 'Synthetic activity',
      context: { laneId: session, intentId: 'intent', head: 'a'.repeat(64), paths: [] },
    },
    metadata: JSON.stringify({
      ownerId: 'owner',
      revision: seq,
      entries: presence
        ? []
        : [{ collection: 'lanes', key: session, parent: 'intent', value: { id: session, state: 'active' } }],
    }),
  };
}
function fixture(t, entries) {
  const root = mkdtempSync(join(tmpdir(), 'forge-sync-queue-'));
  t.after(() => rmSync(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 50 }));
  writeFileSync(join(root, 'hello.txt'), 'Synthetic\n');
  initNative(root);
  const store = new WorkStore(root);
  updateHostState(store, state => {
    state.binding = {
      operationId: randomUUID(),
      projectId: 'project',
      deployment: 'http://127.0.0.1:1',
      projectUrl: 'https://example.invalid/project',
      backupId: 'backup',
      name: 'Synthetic',
      visibility: 'private',
    };
    state.agentSync = { sequence: entries.length, pending: entries };
  });
  return store;
}

for (const phase of ['projectCoordination:publish', 'projectOwnerSync:publish']) {
  test(`permanent rejection at ${phase} records diagnostics and publishes later entries`, async t => {
    const first = entry(1),
      second = entry(2),
      store = fixture(t, [first, second]);
    const published = [];
    await flushAgentSync(store, {
      mutation: async (ref, args) => {
        if (args.operationId === first.operationId && getFunctionName(ref) === phase)
          throw new ConvexError({
            code: phase.includes('Owner') ? 'BAD_ARGUMENT' : 'COORDINATION_STALE',
            message: 'Synthetic rejected entry',
          });
        published.push(args.operationId);
      },
    });
    const queue = readHostState(store).agentSync;
    assert.equal(queue.pending.length, 0);
    assert.ok(published.includes(second.operationId));
    assert.equal(queue.rejected.length, 1);
    assert.equal(queue.headError.seq, 1);
    assert.equal(queue.headError.attempts, 1);
    assert.equal(queue.headError.message, 'Synthetic rejected entry');
    const host = await hostCli([store.root, '--status']);
    assert.deepEqual(host.agentSyncError, queue.headError);
    assert.deepEqual(
      JSON.parse(readFileSync(join(store.directory, 'hosted-binding.json'))).agentSync.headError,
      queue.headError,
    );
    const owner = readPendingStatus(store);
    assert.deepEqual(owner.hosted.metadataError, queue.headError);
    assert.match(formatPendingStatus(owner), /seq 1.*attempts 1.*Synthetic rejected entry/);
  });
}

for (const phase of ['projectCoordination:publish', 'projectOwnerSync:publish']) {
  test(`unprepared Work at ${phase} backs off across restart, then preserves replay after prepare`, async t => {
    const first = entry(1),
      second = entry(2),
      store = fixture(t, [first, second]);
    t.mock.timers.enable({ apis: ['Date'], now: Date.now() });
    let prepared = false;
    const calls = [];
    const client = {
      mutation: async (ref, args) => {
        const name = getFunctionName(ref);
        calls.push({ name, args: structuredClone(args) });
        if (!prepared && name === phase)
          throw new ConvexError({ code: 'PROJECT_WORK_INDEX_MISSING', message: 'Prepare hosted Work.' });
      },
      action: async (ref, args) => {
        assert.equal(getFunctionName(ref), 'projectWorkIndexActions:ensure');
        assert.equal(args.projectId, first.projectId);
        prepared = true;
      },
    };
    await flushAgentSync(store, client);
    const before = calls.length;
    assert.equal(before, phase.includes('Owner') ? 2 : 1);
    assert.deepEqual(readHostState(store).agentSync.pending, [first, second]);
    assert.equal(readHostState(store).agentSync.rejected, undefined);
    assert.equal(readHostState(store).agentSync.nextAttemptAt, Date.now() + 1000);
    const restarted = new WorkStore(store.root);
    for (let attempt = 0; attempt < 5; attempt++) {
      t.mock.timers.tick(100);
      assert.equal(startAgentSyncWorker(restarted), false);
      await flushAgentSync(restarted, client);
    }
    const third = entry(3);
    updateHostState(restarted, state => {
      state.agentSync.pending.push(third);
    });
    assert.equal(startAgentSyncWorker(restarted), false);
    await flushAgentSync(restarted, client);
    assert.equal(calls.length, before);
    assert.deepEqual(readHostState(restarted).agentSync.pending, [first, second, third]);
    const sender = new CheckQueue(join(store.directory, 'hosted-agent-sync-spawn'), {
      limit: 1,
      anchor: store.directory,
    });
    assert.equal(sender.tryAcquire(), true);
    try {
      updateHostState(restarted, state =>
        markAgentSyncPrepared(state, { projectId: 'unrelated', deployment: first.deployment }),
      );
      await flushAgentSync(restarted, client);
      assert.equal(calls.length, before);
      // The owner-side prepare caller signals only after the fake action succeeds.
      await client.action(makeFunctionReference('projectWorkIndexActions:ensure'), {
        projectId: first.projectId,
      });
      updateHostState(restarted, state =>
        markAgentSyncPrepared(state, { projectId: first.projectId, deployment: first.deployment }),
      );
      await flushAgentSync(restarted, client);
    } finally {
      sender.release();
    }
    assert.deepEqual(
      calls.slice(before),
      [first, second, third].flatMap(item => [
        {
          name: 'projectCoordination:publish',
          args: { projectId: item.projectId, operationId: item.operationId, command: item.activity },
        },
        {
          name: 'projectOwnerSync:publish',
          args: { projectId: item.projectId, operationId: item.operationId, metadata: item.metadata },
        },
      ]),
    );
    assert.equal(readHostState(restarted).agentSync.pending.length, 0);
    assert.equal(readHostState(restarted).agentSync.unprepared, undefined);
    assert.equal(readHostState(restarted).agentSync.headError, undefined);
  });
}

test('source checkpoint change and explicit operator retry release the unprepared gate', async t => {
  const first = entry(1),
    store = fixture(t, [first]);
  const missing = {
    mutation: async () => {
      throw new ConvexError({ code: 'PROJECT_WORK_INDEX_MISSING' });
    },
  };
  await flushAgentSync(store, missing);
  updateHostState(store, state => {
    state.binding.backupId = 'prepared-source';
  });
  const published = [];
  await flushAgentSync(store, {
    mutation: async ref => {
      published.push(getFunctionName(ref));
    },
  });
  assert.deepEqual(published, ['projectCoordination:publish', 'projectOwnerSync:publish']);
  updateHostState(store, state => {
    state.agentSync.pending.push(entry(2));
  });
  await flushAgentSync(store, missing);
  const sender = new CheckQueue(join(store.directory, 'hosted-agent-sync-spawn'), {
    limit: 1,
    anchor: store.directory,
  });
  assert.equal(sender.tryAcquire(), true);
  try {
    await hostCli([store.root, '--auto-sync']);
    await flushAgentSync(store, { mutation: async () => {} });
  } finally {
    sender.release();
  }
  assert.equal(readHostState(store).agentSync.pending.length, 0);
});

test('a prepare completed during publication does not leave a stale unprepared gate', async t => {
  const first = entry(1),
    store = fixture(t, [first]);
  let calls = 0;
  await flushAgentSync(store, {
    mutation: async () => {
      if (++calls === 1) {
        updateHostState(store, state =>
          markAgentSyncPrepared(state, { projectId: first.projectId, deployment: first.deployment }),
        );
        throw new ConvexError({ code: 'PROJECT_WORK_INDEX_MISSING' });
      }
    },
  });
  assert.equal(calls, 3);
  assert.equal(readHostState(store).agentSync.pending.length, 0);
  assert.equal(readHostState(store).agentSync.unprepared, undefined);
});

test('transient failure backs off exact payloads and repeated commands do not spawn', async t => {
  const first = entry(1),
    store = fixture(t, [first, entry(2)]);
  t.mock.timers.enable({ apis: ['Date'], now: Date.now() });
  let calls = 0;
  const client = {
    mutation: async () => {
      calls++;
      throw new Error('network offline');
    },
  };
  await flushAgentSync(store, client);
  const saved = readHostState(store).agentSync;
  assert.deepEqual(saved.pending[0], first);
  assert.equal(saved.headError.code, 'HOSTED_SYNC_PENDING');
  assert.equal(saved.nextAttemptAt, Date.now() + 1000);
  for (let i = 0; i < 10; i++) {
    assert.equal(startAgentSyncWorker(store), false);
    await flushAgentSync(store, client);
  }
  assert.equal(calls, 1);
  t.mock.timers.tick(1000);
  await flushAgentSync(store, client);
  assert.equal(calls, 2);
  assert.equal(readHostState(store).agentSync.headError.attempts, 2);
  assert.equal(readHostState(store).agentSync.nextAttemptAt, Date.now() + 2000);
  t.mock.timers.tick(2000);
  const replayed = [];
  await flushAgentSync(store, { mutation: async (_ref, args) => replayed.push(args) });
  assert.equal(replayed[0].operationId, first.operationId);
  assert.deepEqual(replayed[0].command, first.activity);
  assert.equal(replayed[1].metadata, first.metadata);
  assert.equal(readHostState(store).agentSync.pending.length, 0);
  assert.equal(readHostState(store).agentSync.headError, undefined);
});

test('live spawn reservation and live drain both prevent a new worker', t => {
  const store = fixture(t, [entry(1)]);
  for (const name of ['hosted-agent-sync-spawn', 'hosted-agent-sync-queue']) {
    const guard = new CheckQueue(join(store.directory, name), { limit: 1, anchor: store.directory });
    try {
      assert.equal(guard.tryAcquire(), true);
      assert.equal(startAgentSyncWorker(store), false);
    } finally {
      guard.release();
    }
  }
});

test('two concurrent drain calls publish once without waiting behind an active drain', async t => {
  const store = fixture(t, [entry(1)]);
  let release, entered;
  const gate = new Promise(resolve => {
    release = resolve;
  });
  const started = new Promise(resolve => {
    entered = resolve;
  });
  let calls = 0;
  const client = {
    mutation: async () => {
      calls++;
      entered();
      await gate;
    },
  };
  const first = flushAgentSync(store, client);
  await started;
  const second = await flushAgentSync(store, client);
  assert.ok(second.waiting);
  release();
  await first;
  assert.equal(calls, 2); // One activity and one metadata publication.
});

test('597 legacy snapshots migrate to 85 sessions without rewriting the binding on drain', async t => {
  const store = fixture(t, []),
    pending = Array.from({ length: 597 }, (_, i) => {
      const item = entry(i + 1, `session-${i % 85}`);
      const metadata = JSON.parse(item.metadata);
      metadata.entries[0].value.summary = 'Synthetic live-shape payload '.repeat(130);
      item.metadata = JSON.stringify(metadata);
      return item;
    });
  const bindingPath = join(store.directory, 'hosted-binding.json'),
    queuePath = join(store.directory, 'hosted-agent-sync.json');
  rmSync(queuePath);
  const presence = Object.fromEntries(
    Array.from({ length: 402 }, (_, i) => [
      `local-${i}`,
      {
        sessionId: `local-${i}`,
        name: 'Synthetic',
        environment: 'Local Lane',
        status: 'working',
        summary: 'Synthetic presence',
        fingerprint: 'Synthetic local fingerprint '.repeat(85),
        lastSeen: Date.now(),
        lastActivity: Date.now(),
        activityKind: 'saved',
        context: { laneId: `local-${i}`, intentId: 'intent', head: 'a'.repeat(64) },
      },
    ]),
  );
  const observations = Object.fromEntries(
    Array.from({ length: 85 }, (_, i) => [`session-${i}`, 'Synthetic legacy fingerprint '.repeat(225)]),
  );
  const legacy = { ...readHostState(store), presence, agentSync: { sequence: 597, pending, observations } };
  writeFileSync(bindingPath, JSON.stringify(legacy) + '\n');
  const before = statSync(bindingPath).size;
  updateHostState(store, () => {});
  assert.equal(readHostState(store).agentSync.pending.length, 85);
  assert.deepEqual(JSON.parse(readFileSync(bindingPath)).agentSync.pending, []);
  assert.ok(statSync(queuePath).size < 512 * 1024);
  assert.ok(statSync(bindingPath).size + statSync(queuePath).size < before / 2);
  const afterBinding = statSync(bindingPath).size,
    afterQueue = statSync(queuePath).size;
  updateHostState(store, state => {
    state.agentSync.pending.push(entry(598, 'session-0'));
    state.agentSync.sequence = 598;
  });
  assert.ok(statSync(queuePath).size < 512 * 1024);
  assert.equal(readHostState(store).agentSync.pending.length, 85);
  const pin = statSync(bindingPath).mtimeNs ?? statSync(bindingPath).mtimeMs;
  await flushAgentSync(store, { mutation: async () => {} });
  assert.equal(statSync(bindingPath).mtimeNs ?? statSync(bindingPath).mtimeMs, pin);
  t.diagnostic(
    JSON.stringify({
      fixtureEntries: 597,
      sessions: 85,
      beforeBytes: before,
      migratedBindingBytes: afterBinding,
      migratedQueueBytes: afterQueue,
      drainedQueueBytes: statSync(queuePath).size,
    }),
  );
});

test('presence expiry, highest revision, count/byte bounds and bounded rejection diagnostics', () => {
  const old = entry(1, 'session', true);
  old.activity.activityAt = Date.now() - PRESENCE.workingMs - 1;
  const high = entry(3, 'same'),
    low = entry(4, 'same');
  low.metadata = high.metadata.replace('"revision":3', '"revision":2');
  const fresh = entry(5, 'same', true);
  const queue = { sequence: 5, pending: [old, high, low, fresh] };
  compactAgentSync(queue);
  assert.deepEqual(
    queue.pending.map(item => item.operationId),
    [high.operationId, fresh.operationId],
  );
  assert.equal(queue.pending[1].activity.sequence, 5);
  queue.pending = Array.from({ length: 120 }, (_, i) => entry(i + 1));
  queue.pending.push(entry(121, 'presence', true));
  compactAgentSync(queue);
  assert.equal(queue.pending.length, 100);
  assert.ok(queue.pending.every(item => item.activity.sessionId !== 'presence'));
  queue.pending = [entry(1)];
  queue.pending[0].metadata = 'x'.repeat(600 * 1024);
  compactAgentSync(queue);
  assert.equal(queue.pending.length, 0);
  queue.rejected = Array.from({ length: 30 }, (_, i) => ({
    code: 'BAD_ARGUMENT',
    message: 'Synthetic',
    seq: i,
    at: Date.now(),
    attempts: 1,
    operationId: randomUUID(),
  }));
  compactAgentSync(queue);
  assert.equal(queue.rejected.length, 20);
  assert.equal(queue.rejected[0].seq, 10);
});

test('network/timeout/5xx/rate limit retry; structured application and validation failures reject', () => {
  for (const error of [
    new Error('offline'),
    { name: 'TimeoutError' },
    { status: 503 },
    { status: 429 },
    { code: 'ECONNRESET' },
    new ConvexError({ code: 'RATE_LIMITED' }),
    ...['HOSTED_ACTION_FAILED', 'HOSTED_REQUEST_FAILED', 'HOSTED_CONFLICT', 'INTERNAL_ERROR'].map(
      code => new ConvexError({ code }),
    ),
  ])
    assert.equal(agentSyncError(error).transient, true);
  for (const error of [
    new ConvexError({ code: 'COORDINATION_STALE' }),
    { status: 400 },
    { name: 'ArgumentValidationError' },
  ])
    assert.equal(agentSyncError(error).transient, false);
});

test('missing index retries on its deadline and drains 84 entries within the existing call/byte budget', async t => {
  const store = fixture(
    t,
    Array.from({ length: 84 }, (_, i) => entry(i + 1)),
  );
  t.mock.timers.enable({ apis: ['Date'], now: Date.now() });
  let indexReady = false,
    calls = 0,
    batches = 0,
    peakHeapBytes = process.memoryUsage().heapUsed;
  const client = {
    mutation: async ref => {
      calls++;
      peakHeapBytes = Math.max(peakHeapBytes, process.memoryUsage().heapUsed);
      if (getFunctionName(ref) === 'projectOwnerSync:publish' && !indexReady)
        throw new ConvexError({ code: 'PROJECT_WORK_INDEX_MISSING', message: 'Index building' });
    },
  };
  const started = performance.now(),
    heapBefore = process.memoryUsage().heapUsed;
  const result = await runAgentSyncRetries(
    store,
    async () => {
      batches++;
      return flushAgentSync(store, client);
    },
    async deadline => {
      const host = await hostCli([store.root, '--status']);
      assert.equal(host.agentSyncError.code, 'PROJECT_WORK_INDEX_MISSING');
      assert.equal(host.agentSyncNextAttemptAt, deadline);
      assert.equal(deadline, Date.now() + 1000);
      assert.ok(statSync(join(store.directory, 'hosted-agent-sync.json')).size < 512 * 1024);
      indexReady = true;
      t.mock.timers.tick(deadline - Date.now());
    },
  );
  assert.equal(result.value.pending, 0);
  assert.equal(batches, 2);
  assert.ok(peakHeapBytes - heapBefore < 128 * 1024 * 1024);
  assert.equal(calls, 170); // 2 failed-attempt calls + exactly 2 per retained item.
  const host = await hostCli([store.root, '--status']);
  assert.equal(host.agentSyncError, null);
  assert.equal(host.agentSyncNextAttemptAt, null);
  assert.equal(host.pendingAgentSync, 0);
  t.diagnostic(
    JSON.stringify({
      items: 84,
      calls,
      batches,
      wallMs: performance.now() - started,
      peakHeapBytes,
      peakHeapGrowthBytes: Math.max(0, peakHeapBytes - heapBefore),
    }),
  );
});

test('local prepare wakes a sleeping retry immediately and permanent errors leave no timer', async t => {
  const store = fixture(t, [entry(1)]);
  updateHostState(store, state => {
    state.agentSync.nextAttemptAt = Date.now() + 300_000;
  });
  const waiting = waitAgentSyncRetry(store, readHostState(store).agentSync.nextAttemptAt);
  updateHostState(store, state => markAgentSyncPrepared(state, state.binding));
  await waiting;
  let waits = 0,
    calls = 0;
  await runAgentSyncRetries(
    store,
    () =>
      flushAgentSync(store, {
        mutation: async () => {
          calls++;
          throw new ConvexError({ code: 'BAD_ARGUMENT', message: 'Synthetic permanent rejection' });
        },
      }),
    async () => {
      waits++;
    },
  );
  assert.equal(calls, 1);
  assert.equal(waits, 0);
  assert.equal((await hostCli([store.root, '--status'])).agentSyncError.code, 'BAD_ARGUMENT');
});

test('entries for a previous project after a rebind are dropped instead of blocking the queue', async t => {
  // Dogfood shape (2026-10-27): 84 entries for the pre-reseed project ahead of 2 for the new one,
  // head failing PROJECT_WORK_INDEX_MISSING with a future retry.
  const store = fixture(t, []);
  const stale = Array.from({ length: 84 }, (_, i) => ({ ...entry(i + 1), projectId: 'previous-project' }));
  const current = [entry(85), entry(86)];
  writeFileSync(
    join(store.directory, 'hosted-agent-sync.json'),
    JSON.stringify({
      sequence: 86,
      pending: [...stale, ...current],
      headError: {
        code: 'PROJECT_WORK_INDEX_MISSING',
        message: 'Prepare hosted Work before syncing metadata.',
        seq: 1,
        at: Date.now(),
        attempts: 9,
        operationId: stale[0].operationId,
      },
      nextAttemptAt: Date.now() + 300_000,
      unprepared: 'previous',
    }),
  );
  const calls = [];
  await flushAgentSync(store, {
    mutation: async (ref, args) => {
      assert.equal(args.projectId, 'project');
      calls.push(getFunctionName(ref));
    },
  });
  const queue = readHostState(store).agentSync;
  assert.equal(calls.length, 4); // two calls per current entry, none for the previous project
  assert.equal(queue.pending.length, 0);
  assert.equal(queue.headError, undefined);
  assert.equal(queue.nextAttemptAt, undefined);
  assert.equal(queue.discarded, 84);
  assert.equal((await hostCli([store.root, '--status'])).agentSyncError ?? null, null);
});
