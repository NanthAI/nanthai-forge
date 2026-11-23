// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Ferdinando Valsecchi
import test from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import ts from 'typescript';
import { moduleUrl } from './convex-module.mjs';
const { cancelPendingTask } = await import(moduleUrl('../convex/schedulerCancel.ts'));
const wake = await import(moduleUrl('../convex/projectHostedLandingDesiredWake.ts'));
const finish = await import(moduleUrl('../convex/projectHostedFinishWake.ts'));
const audit = await import(moduleUrl('../convex/projectHostedMainAuditState.ts'));
const stall = await import(moduleUrl('../convex/projectHostedLandingStallWake.ts'));
const retention = await import(moduleUrl('../convex/projectRetention.ts'));

function fixture(owner = null, kind = 'pending') {
  const calls = { metadata: 0, reads: 0, cancelled: [], scheduled: [], patches: [] };
  const ctx = {
    meta: { getRequestMetadata: async () => (calls.metadata++, { scheduledFunctionId: owner }) },
    db: {
      system: { get: async id => (calls.reads++, { _id: id, state: { kind } }) },
      patch: async (id, fields) => calls.patches.push({ id, fields }),
    },
    scheduler: {
      cancel: async id => {
        assert.notEqual(id, owner, 'Convex 1.50 rejects a mutation cancelling itself');
        calls.cancelled.push(id);
      },
      runAfter: async (delay, ref, args) => {
        const id = `new-${calls.scheduled.length}`;
        calls.scheduled.push({ id, delay, args });
        return id;
      },
    },
  };
  return { ctx, calls };
}

test('incident ad80e037: scheduled mutation self-cancel is skipped even while its system row is pending, without DB I/O', async () => {
  const { ctx, calls } = fixture('own');
  assert.equal(await cancelPendingTask(ctx, 'own'), false);
  assert.equal(await cancelPendingTask(ctx, 'own', { state: { kind: 'pending' } }), false);
  assert.equal(await cancelPendingTask(ctx, null), false);
  assert.equal(calls.metadata, 1, 'one request metadata lookup per invocation');
  assert.equal(calls.reads, 0);
  assert.deepEqual(calls.cancelled, []);
});

for (const kind of ['pending', 'inProgress', 'success', 'failed', 'canceled']) {
  test(`safe cancellation retires only pending work: ${kind}, reusing known records`, async () => {
    const { ctx, calls } = fixture();
    assert.equal(await cancelPendingTask(ctx, 'other', { state: { kind } }), kind === 'pending');
    assert.equal(calls.reads, 0);
    assert.deepEqual(calls.cancelled, kind === 'pending' ? ['other'] : []);
  });
}

test('unknown task is read once; a known missing task is never reread', async () => {
  const { ctx, calls } = fixture();
  assert.equal(await cancelPendingTask(ctx, 'pending'), true);
  assert.equal(calls.reads, 1);
  assert.equal(await cancelPendingTask(ctx, 'expired', null), false);
  assert.equal(calls.reads, 1);
});

test('scheduler failures propagate without swallowing unrelated errors', async () => {
  const { ctx } = fixture();
  const failure = new Error('synthetic scheduling failure');
  ctx.scheduler.cancel = async () => {
    throw failure;
  };
  await assert.rejects(cancelPendingTask(ctx, 'other'), error => error === failure);
});

for (const [name, replace] of [
  ['desired controller', (ctx, row) => wake.scheduleDesired(ctx, row, 0)],
  ['finish controller', (ctx, row) => finish.scheduleFinish(ctx, row, 0, true)],
  ['audit cadence', (ctx, row) => audit.armAudit(ctx, row, Date.now() - 1)],
]) {
  test(`${name} replaces its own pending wake and retains a live successor`, async () => {
    const { ctx, calls } = fixture('own');
    await replace(ctx, {
      _id: 'row',
      projectId: 'project',
      submissionId: 'submission',
      wake: { taskId: 'own', id: 'generation', at: Date.now() + 10_000 },
    });
    assert.deepEqual(calls.cancelled, []);
    assert.equal(calls.reads, 0, 'request ownership avoids looking up its pending system row');
    assert.equal(calls.scheduled.length, 1);
    assert.equal(calls.patches.at(-1).fields.wake.taskId, 'new-0');
  });
}

test('audit wake clearing leaves the currently running pending mutation alone', async () => {
  const { ctx, calls } = fixture('own');
  await audit.clearAuditWake(ctx, { _id: 'audit', wake: { taskId: 'own' } });
  assert.deepEqual(calls.cancelled, []);
  assert.deepEqual(calls.patches, [{ id: 'audit', fields: { wake: undefined } }]);
});

for (const kind of ['pending', 'inProgress', 'success', 'failed', 'canceled']) {
  test(`overdue audit wake recovers a finished start and coalesces live work: ${kind}`, async () => {
    const { ctx, calls } = fixture(null, kind);
    const at = Date.now() - 120_000;
    await audit.armAudit(
      ctx,
      {
        _id: 'audit',
        projectId: 'project',
        wake: { taskId: 'old-start', at },
      },
      at + 60_000,
    );
    const live = kind === 'pending' || kind === 'inProgress';
    assert.equal(calls.reads, 1, 'the overdue task is read once, including replacement');
    assert.deepEqual(calls.cancelled, [], 'completed and running tasks are left alone');
    assert.equal(calls.scheduled.length, live ? 0 : 1);
    assert.equal(calls.patches.length, live ? 0 : 1);
  });
}

test('audit rearm reuses the overdue pending task for safe cancellation', async () => {
  const { ctx, calls } = fixture();
  const at = Date.now() - 120_000;
  await audit.armAudit(
    ctx,
    {
      _id: 'audit',
      projectId: 'project',
      wake: { taskId: 'old-start', at },
    },
    at - 1,
  );
  assert.equal(calls.reads, 1);
  assert.deepEqual(calls.cancelled, ['old-start']);
  assert.equal(calls.scheduled.length, 1);
});

test('a running pending stall alarm can replace itself with the next progress deadline', async () => {
  const { ctx, calls } = fixture('own');
  const next = await stall.landingAlarmPatch(
    ctx,
    {
      projectId: 'project',
      id: 'submission',
      at: '2026-01-01T00:00:00.000Z',
      observation: { state: 'pending', pendingReason: 'checking' },
    },
    undefined,
    { _id: 'row', alarm: { taskId: 'own', lastProgressAt: '2025-12-31T00:00:00.000Z' } },
  );
  assert.equal(next.alarm.taskId, 'new-0');
  assert.equal(calls.reads, 0);
  assert.deepEqual(calls.cancelled, []);
});

test('retention cleanup skips its pending owner while cancelling another pending timer', async () => {
  const { ctx, calls } = fixture('own');
  await retention.stopRetention(ctx, { retention: { task: 'own', measure: { task: 'other' } } });
  assert.deepEqual(calls.cancelled, ['other']);
  assert.equal(calls.reads, 1);
  assert.equal(calls.metadata, 1);
});

test('raw scheduler cancellation stays confined to the shared pending-only helper', () => {
  const violations = [];
  function walk(directory) {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = new URL(`${entry.name}${entry.isDirectory() ? '/' : ''}`, directory);
      if (entry.isDirectory()) walk(path);
      else if (
        entry.name.endsWith('.ts') &&
        path.href !== new URL('../convex/schedulerCancel.ts', import.meta.url).href
      ) {
        const source = ts.createSourceFile(
          path.pathname,
          readFileSync(path, 'utf8'),
          ts.ScriptTarget.Latest,
          true,
        );
        function visit(node) {
          const member = ts.isPropertyAccessExpression(node)
            ? node.name.text
            : ts.isElementAccessExpression(node) && ts.isStringLiteral(node.argumentExpression)
              ? node.argumentExpression.text
              : null;
          if (member === 'cancel' && /scheduler/.test(node.expression.getText(source)))
            violations.push(`${path.pathname}:${source.getLineAndCharacterOfPosition(node.pos).line + 1}`);
          ts.forEachChild(node, visit);
        }
        visit(source);
      }
    }
  }
  walk(new URL('../convex/', import.meta.url));
  assert.deepEqual(violations, [], 'use cancelPendingTask; direct scheduler cancellation can strand a job');
});
