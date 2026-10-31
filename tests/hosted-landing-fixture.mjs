// SPDX-License-Identifier: Apache-2.0
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { getFunctionName } from 'convex/server';
import { checksFixture, code } from './hosted-checks-fixture.mjs';
import { moduleUrl } from './convex-module.mjs';
import { canonicalPayload } from '../dist/hosted-source-operation.js';
import { legacyPolicy } from '../dist/autonomy-policy.js';
export const api = await import(moduleUrl('../convex/projectHostedLanding.ts'));
export const driver = await import(moduleUrl('../convex/projectHostedLandingDriver.ts'));
export const control = await import(moduleUrl('../convex/projectHostedLandingControl.ts'));
export const store = await import(moduleUrl('../convex/projectHostedLandingStore.ts'));
export const wake = await import(moduleUrl('../convex/projectHostedLandingWake.ts'));
export const pins = await import(moduleUrl('../convex/projectHostedLandingPins.ts'));
const alarms = await import(moduleUrl('../convex/projectHostedLandingStall.ts'));
const stallAlerts = await import(moduleUrl('../convex/projectHostedLandingStallAlert.ts'));
const wouldConflict = await import(moduleUrl('../convex/projectHostedLandingWouldConflict.ts'));
const records = await import(moduleUrl('../convex/projectHostedRecords.ts'));
const schema = (await import(moduleUrl('../convex/schema.ts'))).default;
export { code };
export const maxima = {};
export async function landingFixture(source = null) {
  // H08's wrapper installs its source-job scheduler; use the shared raw transaction
  // once its Candidate is published so H13 owns this fixture's scheduler.
  const selected = source ? { ...source, store: { ...source.store, call: source.store.transaction } } : null;
  const f = await checksFixture(selected);
  f.tables._scheduled_functions = new Map();
  // Fake time jumps to each scheduled task; alerts have their own tests (hosted-stall-alerts.test.mjs).
  if (!f.tables.hostedProjects.get(f.projectId).autonomyPolicy)
    f.patch('hostedProjects', f.projectId, {
      autonomyPolicy: { ...legacyPolicy(), agentDefaults: { stallAlerts: { enabled: false } } },
    });
  let now = Date.now(),
    schedulerFailure = false;
  const metrics = {
    scheduled: 0,
    cancelled: 0,
    actionTransactions: [],
    actionTicks: [],
    metadataArgumentBytes: 0,
    calls: 0,
    stallDeliveries: [],
  };
  const main = {
    schema: 2,
    projectId: f.projectId,
    snapshotId: randomUUID(),
    sourceRevision: 0,
    authority: { mode: 'server', epoch: 1 },
    channel: 'main',
    head: f.candidate.base.head,
    receipt: { id: f.candidate.base.receiptId, kind: 'server', previousHead: null, previousReceiptId: null },
  };
  let mainRow = [...f.tables.projectHostedChannels.values()].find(r => r.projectId === f.projectId);
  const mainId =
    mainRow?._id ??
    f.insert('projectHostedChannels', {
      projectId: f.projectId,
      operationId: randomUUID(),
      name: 'main',
      selection: canonicalPayload(main),
    });
  f.decorateContext(ctx => {
    ctx.db.system = { get: ctx.db.get };
    ctx.scheduler = {
      runAfter: async (delay, ref, args) => {
        if (schedulerFailure) throw new Error('synthetic scheduler unavailable');
        metrics.scheduled++;
        return ctx.db.insert('_scheduled_functions', {
          name: getFunctionName(ref),
          args: [args],
          scheduledTime: now + delay,
          state: { kind: 'pending' },
        });
      },
      cancel: async id => {
        metrics.cancelled++;
        const task = await ctx.db.get(id);
        if (task && task.state.kind !== 'success' && task.state.kind !== 'failed')
          await ctx.db.patch(id, { state: { kind: 'canceled' } });
      },
    };
  });
  function measure(name) {
    for (const c of f.counts.filter(c => c.name === name)) {
      const page = name.endsWith('Page') || name === 'landingCheckWake';
      assert(c.ranges <= 80 && c.documents <= (page ? 140 : 80), `${name}: bounded reads`);
      assert(c.readBytes < 512 * 1024 && c.writeBytes < 512 * 1024, `${name}: bounded metadata`);
      assert(
        !c.touched.some(t =>
          [
            'projectWorkRecords',
            'projectBackups',
            'projectWorkGenerations',
            'projectWorkEvents',
            'projectHostedComposePages',
            'projectHostedComposeSelections',
            'projectHostedCheckShards',
          ].includes(t),
        ),
        `${name}: no source pages, shards or history hydration`,
      );
      const max = (maxima[name] ??= { ranges: 0, documents: 0, readBytes: 0, writes: 0, writeBytes: 0 });
      for (const k of Object.keys(max)) max[k] = Math.max(max[k], c[k]);
    }
    for (const [table, rows] of Object.entries(f.tables)) {
      if (!table.startsWith('projectHostedLanding')) continue;
      const fields = schema.tables[table].export().documentType.value;
      for (const row of rows.values()) {
        assert(
          Object.keys(row).every(k => ['_id', '_creationTime'].includes(k) || k in fields),
          `${table}: fields`,
        );
        for (const [key, field] of Object.entries(fields))
          assert(field.optional || key in row, `${table}.${key}`);
      }
    }
  }
  const call = async (name, fn, args, actor = 'owner') => {
    try {
      const value = await f.transaction(name, fn, args, actor);
      metrics.calls++;
      metrics.metadataArgumentBytes += Buffer.byteLength(JSON.stringify(args));
      return value;
    } finally {
      measure(name);
    }
  };
  const run = (name, fn, args) => call(name, { _handler: fn }, args);
  const request = overrides => ({
    operationId: randomUUID(),
    authorityEpoch: 1,
    channel: 'main',
    expectedMain: { head: main.head, receiptId: main.receipt.id },
    candidateId: f.candidate.id,
    expectedHead: f.candidate.result.status === 'clean' ? f.candidate.result.head : null,
    agent: true,
    check: null,
    ...overrides,
  });
  const enqueue = (r = request(), actor = 'owner') =>
    call('landingEnqueue', api.enqueue, { projectId: f.projectId, request: JSON.stringify(r) }, actor).then(
      JSON.parse,
    );
  const status = (submissionId, actor = 'owner') =>
    call('landingStatus', api.status, { projectId: f.projectId, submissionId, priorityInfo: 1 }, actor).then(
      JSON.parse,
    );
  const queue = () =>
    [...f.tables.projectHostedLandingQueues.values()].find(r => r.projectId === f.projectId);
  const pendingTasks = () =>
    [...f.tables._scheduled_functions.values()].filter(t => t.state.kind === 'pending');
  const nextTask = () => pendingTasks().sort((a, b) => a.scheduledTime - b.scheduledTime)[0];
  const claim = (task = nextTask()) =>
    run('landingClaim', (ctx, args) => control.claimLandingQueue(ctx, args, now), task.args[0]);
  const advance = c => run('landingAdvance', (ctx, args) => control.advanceLandingQueue(ctx, args, now), c);
  const recover = () =>
    run('landingRecover', (ctx, args) => control.recoverLandingQueue(ctx, args, now), {
      projectId: f.projectId,
      channel: 'main',
    });
  const execute = async (task = nextTask(), stopAfterClaim = false) => {
    assert(task, 'pending scheduled task');
    now = Math.max(now, task.scheduledTime, Date.now());
    f.patch('_scheduled_functions', task._id, { state: { kind: 'inProgress' } });
    try {
      let result;
      if (task.name === 'projectHostedLandingStall:alarm')
        result = await run(
          'landingAlarm',
          (ctx, input) => alarms.raiseLandingAlarm(ctx, input, now),
          task.args[0],
        );
      else if (task.name === 'projectHostedLandingStallAlert:alert')
        result = await run(
          'stallAlert',
          (ctx, input) => stallAlerts.raiseStallAlert(ctx, input, now),
          task.args[0],
        );
      else if (task.name === 'projectHostedLandingWouldConflict:mark')
        result = await run(
          'wouldConflict',
          (ctx, input) => wouldConflict.markWouldConflict(ctx, input, now),
          task.args[0],
        );
      else if (task.name === 'projectHostedLandingStallAlert:deliver') {
        // Owner channels are faked: record what would be sent, never call a network.
        metrics.stallDeliveries.push(task.args[0]);
        result = null;
      } else if (task.name === 'projectHostedLandingDriver:checkWake')
        result = await call('landingCheckWake', driver.checkWake, task.args[0]);
      else if (stopAfterClaim) result = await claim(task);
      else {
        const transactions = [];
        const started = performance.now(),
          rssBefore = process.memoryUsage().rss;
        const value = await driver.drive._handler(
          {
            runMutation: async (ref, args) => {
              const name = getFunctionName(ref);
              transactions.push(name);
              if (name.endsWith(':claim'))
                return run('landingClaim', (ctx, args) => control.claimLandingQueue(ctx, args, now), args);
              if (name.endsWith(':advance'))
                return run(
                  'landingAdvance',
                  (ctx, args) => control.advanceLandingQueue(ctx, args, now),
                  args,
                ).then(canonicalPayload);
              assert.fail(`unexpected driver call ${name}`);
            },
          },
          task.args[0],
        );
        metrics.actionTransactions.push(transactions);
        metrics.actionTicks.push({
          elapsedMs: performance.now() - started,
          rssBefore,
          rssAfter: process.memoryUsage().rss,
        });
        result = value === null ? null : JSON.parse(value);
      }
      f.patch('_scheduled_functions', task._id, { state: { kind: 'success' } });
      return result;
    } catch (error) {
      f.patch('_scheduled_functions', task._id, { state: { kind: 'failed', error: 'synthetic failure' } });
      throw error;
    }
  };
  const drain = async () => {
    let ticks = 0;
    while (nextTask()) {
      assert(++ticks <= 1000, 'finite pending work');
      await execute();
    }
    return ticks;
  };
  const candidate = async (overrides = {}) => {
    const c = { ...f.candidate, id: randomUUID(), ...overrides };
    await run('landingSeed', records.writeHostedRecord, { ...f.auth, expectedVersion: null, record: c });
    return c;
  };
  return {
    ...f,
    call,
    run,
    metrics,
    main,
    mainId,
    request,
    enqueue,
    status,
    queue,
    pendingTasks,
    nextTask,
    claim,
    advance,
    execute,
    drain,
    recover,
    candidate,
    rawChecks: f,
    now: () => now,
    elapse: ms => {
      now += ms;
    },
    schedulerFailure: value => {
      schedulerFailure = value;
    },
  };
}
