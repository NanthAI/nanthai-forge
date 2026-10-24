// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, statSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { getFunctionName } from 'convex/server';
import { ConvexError } from 'convex/values';
import { initNative } from '../dist/native-work.js';
import { WorkStore } from '../dist/work-store.js';
import { readHostState, updateHostState } from '../dist/host-binding.js';
import { compactAgentSync } from '../dist/agent-sync-state.js';
import { agentSyncError } from '../dist/agent-sync-error.js';
import { flushAgentSync } from '../dist/agent-hosted-sync.js';
import { startAgentSyncWorker } from '../dist/agent-sync-worker.js';
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
            code: phase.includes('Owner') ? 'PROJECT_WORK_INDEX_MISSING' : 'COORDINATION_STALE',
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
