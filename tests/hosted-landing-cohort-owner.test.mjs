// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Ferdinando Valsecchi
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { batchesFixture, synthetic, states, batchStore } from './hosted-landing-batches-fixture.mjs';
import { drainReady } from './early-resolution-replay.mjs';
const prior = Object.fromEntries(Object.keys(synthetic).map(k => [k, process.env[k]]));
test.before(() => Object.assign(process.env, synthetic));
test.after(() => {
  for (const [k, v] of Object.entries(prior)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});
const budget = () => {
  const entry = JSON.parse(readFileSync(new URL('../src/speed-budgets.json', import.meta.url))).budgets.find(
    b => b.metric === 'cohortOwnerRecoveryMs',
  );
  assert(entry, 'central cohort recovery budget must exist');
  return entry.max;
};
for (const finishWake of ['failed', 'canceled', 'success'])
  for (const world of ['arrival', 'quiet'])
    test(`8c9b84fc: ${finishWake} cohort drive recovers within the compose bound (${world})`, async t => {
      const f = await batchesFixture(t, { count: 0 });
      const OriginalDate = Date,
        clock = Date.now;
      globalThis.Date = class extends OriginalDate {
        constructor(...args) {
          super(...(args.length ? args : [clock()]));
        }
        static now() {
          return clock();
        }
      };
      t.after(() => {
        globalThis.Date = OriginalDate;
      });
      await f.add(0);
      await f.add(1);
      await drainReady(f);
      const before = states(f)[0],
        key = { projectId: f.projectId, batchId: before.batchId };
      await f.transaction(
        'retry-cohort-after-main-race',
        {
          _handler: async ctx => {
            const { batch } = await batchStore.loadBatch(ctx, key);
            await batchStore.retryLandingBatch(ctx, key, batch);
          },
        },
        {},
      );
      const started = Date.now();
      const finish = [...f.tables.projectHostedFinishes.values()].find(r => r.submissionId === before.id);
      f.patch('_scheduled_functions', finish.wake.taskId, { state: { kind: finishWake } });
      if (world === 'arrival') {
        f.advanceClock(budget() - 1);
        await f.add(2);
      }
      const end = started + budget();
      for (let n = 0; n < 200; n++) {
        const task = f.pending().find(t => t.scheduledTime <= end && !/CheckLease:expire/.test(t.name));
        if (!task) break;
        await f.execute(task);
      }
      const current = (await f.current(before.id)).submission;
      assert(
        ['checking', 'ready', 'landed', 'terminal-failed'].includes(current.phase),
        JSON.stringify(current),
      );
      assert(Date.now() - started <= budget()); // test-signal: allow injected event clock; this is the five-minute recovery contract, not wall time
      const transitions = [...f.tables.projectHostedLandingObservations.values()].filter(
        r => r.submissionId === before.id,
      );
      assert(
        transitions.some(r => r.value.includes(`"finishWake":"${finishWake}"`)),
        'published stall names the lost driver',
      );
      t.diagnostic(JSON.stringify({ finishWake, world, recoveredMs: Date.now() - started }));
      for (let wave = 0; wave < 12; wave++) {
        const runs = f.runs().filter(r => r.status === 'queued');
        if (!runs.length) break;
        for (const run of runs) await f.rawChecks.pass(await f.rawChecks.activate(run.id));
        await drainReady(f);
      }
      const terminal = (await f.current(before.id)).submission;
      assert.equal(terminal.phase, 'landed');
      assert.equal(
        terminal.observation.stall.owner.finishWake,
        finishWake,
        'receipt retains its repaired owner',
      );
      assert.equal(f.pending().length, 0, 'settlement removes every recovery wake');
    });

test('8c9b84fc: a healthy live predecessor owns its follower without a repair or extra writes', async t => {
  const { conflictTrio } = await import('./early-resolution-replay.mjs');
  const { moduleUrl } = await import('./convex-module.mjs');
  const redrive = await import(moduleUrl('../convex/projectHostedLandingRedrive.ts'));
  const { f, lateEntry } = await conflictTrio(t, { earlyResolve: 'off' });
  const before = f.counts.length;
  const lost = await f.transaction(
    'probe-healthy-cohort-follower',
    {
      _handler: ctx =>
        redrive.redriveLanding(
          ctx,
          { projectId: f.projectId, submissionId: lateEntry.state.id },
          { probe: true },
        ),
    },
    {},
  );
  assert.deepEqual(lost, []);
  assert.equal(
    f.counts.slice(before).reduce((n, c) => n + c.writes, 0),
    0,
  );
});

test('8c9b84fc: unrelated queue progress cannot defer the entry first in line', async () => {
  const { hostedLandingStall } = await import('../dist/hosted-landing-stall.js');
  const at = '2026-01-01T00:00:00.000Z',
    now = Date.parse(at) + 900000;
  const state = {
    at,
    phase: 'queued',
    timing: { submittedAt: at },
    observation: { state: 'pending', pendingReason: 'queued', cause: null },
  };
  const queue = { owner: null, predecessor: null, lastProgressAt: new Date(now - 1000).toISOString() };
  assert.equal(hostedLandingStall(state, now, queue).lastProgressAt, at);
  assert.equal(
    hostedLandingStall(state, now, {
      ...queue,
      owner: 'check runner',
      predecessor: { id: 'older', phase: 'checking' },
    }),
    undefined,
  );
});
