// SPDX-License-Identifier: Apache-2.0
// Pre-queue Lane checks (docs/pre-queue-checks.md): the runner contract on two
// providers and the synthetic 12-Lane queue, before (admission off) and after.
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { batchesFixture, states, synthetic } from './hosted-landing-batches-fixture.mjs';
import { moduleUrl } from './convex-module.mjs';
const admission = await import(moduleUrl('../convex/projectHostedLandingAdmission.ts'));
// A machine runner's registration signs its output with a trusted key (synthetic here).
const env = {
  ...synthetic,
  FORGE_HOSTED_CHECK_KEY_ID: 'SYNTHETIC',
  FORGE_HOSTED_CHECK_KEY_SYNTHETIC: 'synthetic-prequeue',
};
const prior = Object.fromEntries(Object.keys(env).map(k => [k, process.env[k]]));
test.before(() => Object.assign(process.env, env));
test.after(() => {
  for (const [k, v] of Object.entries(prior)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});
/** A full check takes about 22 minutes on the current runner (wave 1, 2026-11-05). */
const CHECK_MINUTES = 22;
// The policy default: no admissionCheck setting means the pre-queue Lane check.
const full = { admissionCheck: 'default', batchMaxSize: null };
const selfHosted = {
  provider: 'self-hosted',
  machineId: randomUUID(),
  environmentFingerprint: 'd'.repeat(64),
  platform: { os: 'linux', arch: 'x64' },
};
const files = (f, head) => JSON.parse(f.c.objects.get(head)).files.map(file => file.path);
const landed = f => states(f).filter(s => s.phase === 'landed').length;
const rows = f => [...f.tables.projectHostedLandingRequests.values()];
const isAdmission = (f, run) =>
  f.entries.some(e =>
    [0, 1, 2].some(n => admission.admissionOperationId(e.state.id, n) === run.request.operationId),
  );
/** Every queued run ends at once, CHECK_MINUTES later: one round of parallel runner work.
 * A run fails its member's own test when its Candidate contains a red member file. */
async function round(f, red) {
  const queued = f.runs().filter(r => r.status === 'queued');
  if (!queued.length) return false;
  f.advanceClock(CHECK_MINUTES * 60_000);
  for (const run of queued) {
    const culprit = red.find(path => files(f, run.request.expectedHead).includes(path));
    if (culprit) await f.fail(run.id, `tests/${culprit}.test.mjs`);
    else await f.rawChecks.pass(await f.rawChecks.activate(run.id));
  }
  await f.drain();
  return true;
}

for (const [name, runner] of [
  ['GitHub Actions', undefined],
  ['a self-hosted runner', selfHosted],
])
  test(`runner contract on ${name}: the configured check runs before the queue and a red change never enters`, async t => {
    const f = await batchesFixture(t, { ...full, count: 3, ...(runner ? { runner } : {}) });
    const lane = f.runs();
    assert.equal(lane.length, 3, 'every arrival starts its own Lane check at once');
    for (const run of lane) {
      assert.equal(run.configuration.provider, runner?.provider ?? 'github-actions');
      assert.equal(run.request.expectedConfiguration, f.rawChecks.configuration.digest);
      assert.notEqual(run.gate?.mode, 'scoped', 'the configured check, not the affected set');
    }
    assert(
      rows(f).every(r => r.admitting && !r.orderLive && !r.runnable && !r.batchable),
      'not in the queue',
    );
    while (await round(f, ['member-1']));
    const red = states(f).find(s => s.id === f.entries[1].state.id);
    assert.equal(red.phase, 'terminal-failed');
    assert.equal(red.error.code, 'CHECK_FAILED');
    assert.equal(red.batchId, undefined, 'it never joined a cohort');
    assert.equal(landed(f), 2);
    const queueRuns = f.runs().filter(r => !isAdmission(f, r));
    assert(
      queueRuns.every(r => !files(f, r.request.expectedHead).includes('member-1')),
      'no queue check contains the red change',
    );
    assert.equal(f.pending().length, 0, 'idle after settling: no timers or polling');
  });

test('a Lane check that ends without a failing test restarts twice, then enters unadmitted', async t => {
  const f = await batchesFixture(t, { ...full, count: 1 });
  for (let i = 0; i < 3; i++) {
    const run = f.runs().at(-1);
    await f.rawChecks.callback(
      f.rawChecks.complete(await f.rawChecks.activate(run.id), 'runner-unavailable'),
    );
    await f.drain();
  }
  const [row] = rows(f);
  assert.equal(f.runs().filter(r => isAdmission(f, r)).length, 3, 'one check and two restarts');
  assert.equal(row.admission.status, 'unavailable');
  assert.equal(row.admission.retries, 2);
  while (await round(f, []));
  assert.equal(landed(f), 1, 'unknown is not red');
});

test('an admitted change lands on its own Lane run when main is unchanged', async t => {
  const f = await batchesFixture(t, { ...full, count: 1 });
  while (await round(f, []));
  assert.equal(landed(f), 1);
  assert.equal(f.runs().length, 1, 'the Lane run is the acceptance evidence');
  assert.equal(rows(f)[0].admission.reuse, 'tried');
});

// Synthetic 12-Lane wave: 12 changes arrive together, 3 are red (the 2026-10-30
// first-check failure prior is 0.3). Before: deferred cohort checks (today's
// default). After: pre-queue Lane checks. Runs are fake; only queue mechanics are real.
async function wave(t, options, red) {
  const f = await batchesFixture(t, { count: 12, batchMaxSize: null, ...options });
  let rounds = 0;
  await f.drain();
  while (await round(f, red)) rounds++;
  const runs = f.runs();
  const queueRuns = runs.filter(r => !isAdmission(f, r));
  const members = r => {
    const base = new Set(files(f, r.candidate.base.head));
    return files(f, r.request.expectedHead).filter(path => /^member-\d+$/.test(path) && !base.has(path));
  };
  const redIn = r => members(r).some(path => red.includes(path));
  const receipts = new Set(
    [...f.tables.projectHostedAcceptances.values()].map(r => JSON.parse(r.value).check?.runId),
  );
  // Superseded: a queue run whose verdict neither landed a change nor ended one red
  // change alone (thrown-away queue work). A passing Lane run that admitted a change
  // but was not reused is counted apart: it is the pre-queue tier's own cost.
  const useful = r => receipts.has(r.id) || (r.status === 'failed' && members(r).length === 1 && redIn(r));
  const superseded = queueRuns.filter(r => !useful(r));
  const laneUnused = runs.filter(r => isAdmission(f, r) && !useful(r));
  const n = landed(f);
  // Wall time is runner time: each round is one parallel CHECK_MINUTES step.
  const hours = (rounds * CHECK_MINUTES) / 60;
  return {
    landed: n,
    terminal: states(f).filter(s => s.phase === 'terminal-failed').length,
    rounds,
    runs: runs.length,
    queueRuns: queueRuns.length,
    redInQueue: queueRuns.filter(redIn).length,
    redInQueueRate: +(queueRuns.filter(redIn).length / Math.max(1, queueRuns.length)).toFixed(2),
    landingsPerHour: +(n / hours).toFixed(1),
    supersededPerLanding: +(superseded.length / n).toFixed(2),
    cancelled: runs.filter(r => r.status === 'cancelled').length,
    unusedLaneRunsPerLanding: +(laneUnused.length / n).toFixed(2),
    checkMinutesPerLanding: Math.round((runs.length * CHECK_MINUTES) / n),
    convexCallsPerLanding: +(f.counts.length / n).toFixed(1),
  };
}
test('synthetic 12-Lane wave: red-in-queue, landings per hour and superseded runs, before and after', async t => {
  const red = ['member-1', 'member-5', 'member-9'];
  const before = await wave(t, { admissionCheck: false }, red);
  const after = await wave(t, { admissionCheck: 'default' }, red);
  t.diagnostic(JSON.stringify({ before, after }));
  assert.equal(before.landed, 9);
  assert.equal(after.landed, 9);
  assert.equal(after.terminal, 3);
  assert(before.redInQueue > 0, 'today every red change is first found in the queue');
  assert.equal(after.redInQueue, 0, 'no red change reaches a queue check');
  assert(after.landingsPerHour > before.landingsPerHour);
  assert(after.supersededPerLanding < before.supersededPerLanding, 'no queue run is thrown away');
  assert(
    after.checkMinutesPerLanding <= before.checkMinutesPerLanding,
    'no extra runner minutes per landing',
  );
});

test('a single Lane pays no extra runner minutes: its pre-queue run is the landing check', async t => {
  const solo = async admissionCheck => {
    const f = await batchesFixture(t, { count: 1, batchMaxSize: null, admissionCheck });
    let rounds = 0;
    await f.drain();
    while (await round(f, [])) rounds++;
    assert.equal(landed(f), 1);
    assert.equal(f.pending().length, 0, 'idle after landing');
    return {
      runs: f.runs().length,
      rounds,
      runnerMinutes: f.runs().length * CHECK_MINUTES,
      calls: f.counts.length,
    };
  };
  const before = await solo(false);
  const after = await solo('default');
  t.diagnostic(JSON.stringify({ before, after }));
  assert.equal(after.runs, before.runs, 'one run either way');
  assert.equal(after.runnerMinutes, before.runnerMinutes);
  assert.equal(after.rounds, 1);
});
