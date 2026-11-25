// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Ferdinando Valsecchi
import test from 'node:test';
import assert from 'node:assert/strict';
import { batchesFixture, states, synthetic } from './hosted-landing-batches-fixture.mjs';
import { moduleUrl } from './convex-module.mjs';
const redrive = await import(moduleUrl('../convex/projectHostedLandingRedrive.ts'));

const environment = { ...synthetic, CONVEX_CLOUD_URL: 'https://synthetic-outage.convex.cloud' };
const prior = Object.fromEntries(Object.keys(environment).map(k => [k, process.env[k]]));
test.before(() => Object.assign(process.env, environment));
test.after(() => {
  for (const [k, v] of Object.entries(prior)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

const terminal = s => s.phase === 'landed' || s.phase === 'terminal-failed';
/** Pass every check and run steps until the entry is Ready (settling). */
async function untilReady(f) {
  for (let tick = 0; states(f)[0].phase !== 'ready'; tick++) {
    assert(tick < 200, states(f)[0].phase);
    for (const run of f.runs().filter(run => run.status === 'queued'))
      await f.rawChecks.pass(await f.rawChecks.activate(run.id));
    await f.execute(f.pending()[0]);
  }
}

/** Issue 72d50375: a write outage (OCC exhaustion, a platform incident) fails a scheduled
 * settlement step or stall alarm. Convex does not retry it and the row keeps pointing at the
 * failed task. */
test('without a re-drive a failed settlement step strands a passed landing (the bug this guards)', async t => {
  const f = await batchesFixture(t, { count: 1, batching: false, requestCheck: true });
  await untilReady(f);
  let lost = 0;
  for (let task = f.pending()[0]; task; task = f.pending()[0]) {
    f.advanceClock(Math.max(0, task.scheduledTime - Date.now()));
    f.patch('_scheduled_functions', task._id, { state: { kind: 'failed' } });
    lost++;
  }
  assert(lost > 0);
  const [state] = states(f);
  assert.equal(state.phase, 'ready', 'the passed entry waits to settle');
  assert(
    !f.pending().some(task => task.args[0]?.submissionId === state.id),
    'nothing is left to drive it: the stall shape of c329d191',
  );
  // The re-drive replays exactly the lost steps, and only once.
  const first = JSON.parse(
    await f.transaction('redrive', redrive.redrive, { projectId: f.projectId, submissionId: state.id }),
  );
  assert(first.redriven.includes('finish'), JSON.stringify(first));
  const again = JSON.parse(
    await f.transaction('redrive', redrive.redrive, { projectId: f.projectId, submissionId: state.id }),
  );
  assert.deepEqual(again.redriven, [], 'a repeated re-drive schedules nothing new');
  await f.drain();
  assert.equal(states(f)[0].phase, 'landed');
  assert(states(f).every(terminal));
});
