// SPDX-License-Identifier: Apache-2.0
import { postAcceptMoves } from '../dist/post-accept-coverage.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { randomUUID } from 'node:crypto';
import { CheckQueue, queueEntries } from '../dist/check-queue.js';
import { controlQueue } from '../dist/queue-control.js';
import { processIdentity } from '../dist/local-process.js';
import { selectMainAudit } from '../dist/post-accept-selection.js';

function fixture(t) {
  const path = mkdtempSync(join(tmpdir(), 'forge-queue-control-'));
  t.after(() => rmSync(path, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }));
  const queues = [];
  return {
    path,
    queue(identity = {}) {
      const queue = new CheckQueue(path, { limit: 1, identity, serializeAdmission: true });
      queues.push(queue);
      t.after(() => queue.release());
      return queue;
    },
  };
}

test('prioritize moves the requested waiter first without displacing a running holder', t => {
  const f = fixture(t),
    holder = f.queue({ operationId: 'holder' });
  assert.equal(holder.tryAcquire(), true);
  const a = f.queue({ operationId: 'a', laneId: 'lane-a' });
  const b = f.queue({ operationId: 'b' });
  controlQueue('prioritize', 'b', f.path);
  assert.equal(b.tryAcquire(), false);
  assert.deepEqual(
    controlQueue('list', undefined, f.path).map(row => row.operation),
    ['holder', 'b', 'a'],
  );
  controlQueue('prioritize', 'a', f.path);
  assert.deepEqual(
    controlQueue('list', undefined, f.path).map(row => row.operation),
    ['holder', 'a', 'b'],
  );
  holder.release();
  assert.equal(a.tryAcquire(), true);
  assert.equal(b.tryAcquire(), false);
});

test('cancel is retry-safe, releases queued capacity and follows adopted run identities', t => {
  const f = fixture(t),
    driver = f.queue({ control: true, operationId: 'new-finish', runId: 'old-run' });
  const run = f.queue({ operationId: 'old-finish', runId: 'old-run' });
  const next = f.queue();
  controlQueue('cancel', 'new-finish', f.path);
  controlQueue('cancel', 'new-finish', f.path);
  assert.equal(driver.cancelled(), true);
  assert.equal(run.cancelled(), true);
  assert.equal(run.tryAcquire(), false);
  assert.equal(next.tryAcquire(), true);
});

test('dead-pid tickets are reaped by listing and admission', t => {
  const f = fixture(t);
  const stale = join(f.path, `2147483647.${Buffer.from('dead').toString('base64url')}.${randomUUID()}`);
  mkdirSync(stale);
  writeFileSync(join(stale, 'ticket.json'), JSON.stringify({ number: 1, limit: 1 }));
  assert.deepEqual(controlQueue('list', undefined, f.path), []);
  assert.equal(existsSync(stale), false);
  assert.equal(f.queue().tryAcquire(), true);
});

async function childGroup(t) {
  const child = spawn(
    process.execPath,
    [
      '--input-type=module',
      '-e',
      `
    import { spawn } from 'node:child_process';
    const child = spawn(process.execPath, ['-e', 'process.send("ready");process.on("message", () => {});'], { stdio: ['ignore','inherit','ignore','ipc'] });
    child.once('message', () => process.send({ pid: child.pid }));
    process.on('message', () => {});
  `,
    ],
    { detached: true, stdio: ['ignore', 'pipe', 'ignore', 'ipc'] },
  );
  t.after(() => {
    try {
      process.kill(-child.pid, 'SIGKILL');
    } catch {}
  });
  child.stdout.resume();
  const [ready] = await once(child, 'message');
  return { child, descendant: ready.pid };
}

test(
  'cancel kills a check group and its children; capacity is released after child exit',
  { skip: process.platform === 'win32' },
  async t => {
    const f = fixture(t),
      { child, descendant } = await childGroup(t);
    const { processAlive } = await import('../dist/local-process.js');
    assert.equal(processAlive({ pid: descendant }), true);
    const run = f.queue({ operationId: 'finish' });
    assert.equal(run.tryAcquire(), true);
    run.child(child.pid, processIdentity(child.pid).startTime);
    const closed = once(child, 'close');
    controlQueue('cancel', 'finish', f.path);
    await closed;
    assert.equal(run.cancelled(), true);
    // The grandchild inherits this pipe. close waits for both processes' descriptors,
    // unlike the leader's exit event or a single timing-dependent PID observation.
    assert.equal(child.stdout.readableEnded, true);
    run.release();
    assert.equal(queueEntries(f.path).length, 0);
    assert.equal(f.queue().tryAcquire(), true);
  },
);

test(
  'a foreground landing pre-empts an audit before admission',
  { skip: process.platform === 'win32' },
  async t => {
    const f = fixture(t),
      { child } = await childGroup(t);
    const audit = f.queue({ priority: 'audit', runId: 'audit' });
    assert.equal(audit.tryAcquire(), true);
    audit.child(child.pid, processIdentity(child.pid).startTime);
    const closed = once(child, 'close');
    const landing = f.queue({ priority: 'landing' });
    landing.tryAcquire();
    assert.equal(audit.cancelled(), true);
    await closed;
    audit.release();
    assert.equal(landing.tryAcquire(), true);
  },
);

function auditData() {
  const first = {
    id: randomUUID(),
    channel: 'main',
    head: 'first',
    status: 'accepted',
    viewId: 'original',
    postAccept: { checkId: 'verify' },
  };
  const last = { ...first, id: randomUUID(), head: 'latest' };
  return {
    schema: 13,
    schema: 13,
    channelMoves: [first, last],
    runs: [],
    views: [{ id: 'original', intentId: 'intent' }],
  };
}

test('audits coalesce to latest main and retry pre-empted work with a distinct run identity', () => {
  const data = auditData();
  const selected = selectMainAudit(data);
  assert.equal(selected.view.head, 'latest');
  assert.ok(postAcceptMoves(data.channelMoves).every(move => move.postAcceptRunId === selected.runId));
  data.runs.push({
    id: selected.runId,
    head: 'latest',
    mainCheck: { channel: 'main' },
    status: 'cancelled',
    endedAt: 'done',
  });
  const retry = selectMainAudit(data);
  assert.notEqual(retry.runId, selected.runId);
  assert.equal(retry.view.head, 'latest');
  data.runs.push({
    id: retry.runId,
    head: 'latest',
    mainCheck: { channel: 'main' },
    status: 'passed',
    endedAt: 'done',
  });
  assert.equal(selectMainAudit(data), undefined);
});

test('an active obsolete main audit is cancelled, never run alongside the newest audit', () => {
  const data = auditData();
  data.runs.push({ id: 'old', head: 'first', mainCheck: { channel: 'main' }, status: 'running' });
  assert.deepEqual(selectMainAudit(data), { wait: true });
  assert.equal(data.runs[0].cancelRequested, true);
  assert.equal(data.runs[0].cancellation.reason, 'superseded');
  assert.equal(data.runs[0].cancellation.actor.kind, 'system');
  const cancellation = data.runs[0].cancellation;
  selectMainAudit(data);
  assert.deepEqual(data.runs[0].cancellation, cancellation);
});

test('push audits an otherwise unchecked accepted main without changing acceptance policy', async () => {
  const { requestPushAudit } = await import('../dist/pre-push-audit.js');
  const data = { ...auditData(), checks: [{ id: 'verify', name: 'verify' }], schema: 13, revision: 1 };
  for (const move of data.channelMoves) delete move.postAccept;
  const store = { load: () => data };
  const request = requestPushAudit(store);
  assert.deepEqual(request, { channel: 'main', checkId: 'verify' });
  const selected = selectMainAudit(data, request);
  assert.equal(selected.view.head, 'latest');
  assert.equal(data.revision, 1);
  assert.equal(data.channelMoves.at(-1).postAccept, undefined);
  data.checks = [];
  assert.throws(
    () => requestPushAudit(store),
    error => error.code === 'CHECK_REQUIRED',
  );
});

test('cancelled finish aborts Work lock admission without invoking its mutation', async t => {
  const f = fixture(t);
  const { workLocked, withWorkLockOptions } = await import('../dist/work-lock.js');
  assert.throws(
    () =>
      withWorkLockOptions({ cancelled: () => true }, () =>
        workLocked(join(f.path, 'work.lock'), () => assert.fail('cancelled mutation ran')),
      ),
    error => error.code === 'CANCELLED',
  );
  assert.equal(existsSync(join(f.path, 'work.lock')), false);
});

test('checks created after a queue action inherit their finish cancellation or priority', t => {
  const directory = process.env.FORGE_CHECK_QUEUE_DIR;
  const control = new CheckQueue(undefined, { identity: { control: true, operationId: 'late-run' } });
  t.after(() => control.release());
  controlQueue('prioritize', 'late-run', directory);
  controlQueue('cancel', 'late-run', directory);
  const run = new CheckQueue(undefined, { identity: { operationId: 'late-run', runId: 'late-check' } });
  t.after(() => run.release());
  assert.equal(run.cancelled(), true);
  assert.equal(run.tryAcquire(), false);
});
