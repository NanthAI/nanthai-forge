// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { auditCadence } from '../dist/landing-audit-cadence.js';
import { policyPreset } from '../dist/autonomy-policy.js';
import { audit, auditFixture, state } from './hosted-main-audit-fixture.mjs';
import { storageClock } from './storage-clock.mjs';
import { moduleUrl } from './convex-module.mjs';

const minute = 60_000;
const fixtureStart = Date.UTC(2026, 10, 10, 12);
const readStatus = f => f.call('auditStatus', audit.status, { projectId: f.projectId }).then(JSON.parse);
const report = f => JSON.parse(f.row().audit.coverage);
const seedHistory = (f, red, landings = 50) =>
  f.patch('projectHostedMainAudits', f.row()._id, {
    window: [
      {
        audit: { verdict: 'green', auditedLandings: landings },
        ...(red ? { red: { age: 0, count: red, drill: 0 } } : {}),
      },
    ],
  });

for (const [threshold, red] of [
  [1, null],
  [3, 3],
  [5, 0],
]) {
  test(`automatic k=${threshold} starts the first immediately and wakes on the next threshold`, async t => {
    storageClock(t);
    let now = fixtureStart;
    t.mock.method(Date, 'now', () => now);
    const f = await auditFixture();
    await f.land('full');
    if (red !== null) seedHistory(f, red);
    const initial = await readStatus(f);
    assert.equal(initial.cadence.effective.landings, threshold);
    const first = await f.land();
    assert.equal(f.pending().length, 1);
    assert.equal(f.pending()[0].scheduledTime, now);
    await f.tick(f.pending()[0]);
    assert.equal(report(f).reason, 'after-idle');
    assert.equal(report(f).firstSequence, first.receipt.snapshot.revision);
    now += 30_000;
    await f.terminal();
    for (let i = 1; i <= threshold; i++) {
      now += 10_000;
      await f.land();
      assert.equal(f.pending().length, 1);
      assert.equal(f.pending()[0].scheduledTime <= now, i === threshold);
    }
    await f.tick(f.pending()[0]);
    const selected = report(f);
    assert.equal(selected.reason, 'landing-threshold');
    assert.equal(selected.landings, threshold);
    assert.equal(selected.throughSequence, threshold + 2);
    assert.equal(selected.cadence.effective.landings, threshold);
    await f.terminal();
    assert.equal(f.pending().length, 0);
    assert.equal(f.row().unaudited.count, 0);
    const observed = await readStatus(f);
    assert.equal(observed.coverage.max, threshold);
    assert.equal(observed.coverage.shareAboveThreshold, 0);
    assert.equal(observed.coverage.latest.throughSequence, threshold + 2);
  });
}

test('the oldest outstanding landing triggers at the clamped median and idle schedules nothing', async t => {
  storageClock(t);
  let now = fixtureStart;
  t.mock.method(Date, 'now', () => now);
  const f = await auditFixture();
  await f.land('full');
  seedHistory(f, 0);
  f.patch('projectHostedMainAudits', f.row()._id, {
    lastAuditStartAt: now,
    coverageSamples: [
      { landings: 4, threshold: 5, wallMs: 3 * minute },
      { landings: 5, threshold: 5, wallMs: 5 * minute },
    ],
  });
  assert.equal((await readStatus(f)).cadence.signal.medianWallMs, 4 * minute);
  assert.equal(f.pending().length, 0);
  now += 20_000;
  const oldest = now;
  await f.land();
  assert.equal(f.pending()[0].scheduledTime, oldest + 4 * minute);
  now += minute;
  await f.land();
  assert.equal(f.pending()[0].scheduledTime, oldest + 4 * minute);
  await f.tick(f.pending()[0]);
  assert.equal(report(f).reason, 'oldest-wait');
  assert.equal(report(f).landings, 2);
  assert.equal(Date.parse(report(f).startedAt), oldest + 4 * minute);
  const clamped = auditCadence(undefined, null, [], [{ landings: 1, threshold: 1, wallMs: 30 * minute }]);
  assert.equal(clamped.automatic.minutes, 15);
});

test('a burst behind the active audit uses newest main and records its actual range above k', async t => {
  storageClock(t);
  let now = fixtureStart;
  t.mock.method(Date, 'now', () => now);
  const f = await auditFixture();
  const green = await f.land('full');
  seedHistory(f, 3);
  await f.land();
  await f.tick(f.pending()[0]);
  const running = f.currentRun();
  const span = [];
  for (let i = 0; i < 6; i++) {
    now += 15_000;
    span.push(await f.land());
  }
  assert.equal(f.currentRun().id, running.id);
  assert.equal(f.currentRun().cancelRequested, false);
  assert.equal(f.pending().length, 0);
  assert.equal(f.row().lastGreen.runId, green.run.id, 'the active audit is not a reuse donor');
  await f.terminal();
  assert.equal(f.row().lastGreen.runId, running.id);
  assert.equal(f.pending().length, 1);
  assert.equal(f.pending()[0].scheduledTime, now);
  await f.tick(f.pending()[0]);
  assert.equal(f.currentRun().request.expectedHead, span.at(-1).receipt.candidate.head);
  const coverage = report(f);
  assert.equal(coverage.firstSequence, span[0].receipt.snapshot.revision);
  assert.equal(coverage.throughSequence, span.at(-1).receipt.snapshot.revision);
  assert.equal(coverage.reason, 'landing-threshold');
  assert.equal(coverage.cadence.effective.landings, 3);
  assert.equal(coverage.landings, 6);
  await f.terminal('failed');
  assert.equal((await readStatus(f)).result, 'failed');
  const observed = await readStatus(f);
  assert.deepEqual(
    [
      observed.coverage.p50,
      observed.coverage.p90,
      observed.coverage.max,
      observed.coverage.shareAboveThreshold,
    ],
    [1, 6, 6, 0.5],
  );
  assert.equal(f.pending().length, 0, 'no idle rerun after the red covers all accepted landings');
});

test('a full-check failure while an audit runs makes the next pending span immediate', async t => {
  storageClock(t);
  const f = await auditFixture();
  await f.land('full');
  seedHistory(f, 0);
  await f.land();
  await f.tick(f.pending()[0]);
  const next = await f.land();
  await f.run('fullFailure', ctx =>
    state.onGateRunTerminal(ctx, { ...next.run, status: 'failed', gate: { mode: 'full' } }),
  );
  assert.equal(f.pending().length, 0);
  await f.terminal();
  assert.equal(f.pending()[0].scheduledTime, fixtureStart);
  await f.tick(f.pending()[0]);
  assert.equal(report(f).reason, 'failed-full-check');
});

test('set-policy reschedules existing audit debt and reports the automatic choice beside the override', async t => {
  storageClock(t);
  const f = await auditFixture();
  const autonomy = await import(moduleUrl('../convex/projectAutonomy.ts'));
  f.patch('hostedProjects', f.projectId, { autonomyPolicy: policyPreset('trusted') });
  await f.land('full');
  seedHistory(f, 0);
  f.patch('projectHostedMainAudits', f.row()._id, { lastAuditStartAt: fixtureStart });
  await f.land();
  assert.equal(f.pending()[0].scheduledTime, fixtureStart + 2 * minute);
  const command = JSON.stringify({
    action: 'set-policy',
    operationId: randomUUID(),
    mainAudit: { cadence: 'every-landing' },
  });
  const args = { projectId: f.projectId, command };
  await assert.rejects(
    f.call('setAuditCadence', autonomy.set, args, 'outside'),
    error => error.data?.code === 'PROJECT_UNAVAILABLE',
  );
  const receipt = await f.call('setAuditCadence', autonomy.set, args);
  assert.deepEqual(await f.call('setAuditCadence', autonomy.set, args), receipt);
  assert.equal(receipt.policy.preset, 'trusted', 'cadence preserves the named preset and its landing pins');
  assert.equal(f.pending().length, 1);
  assert.equal(f.pending()[0].scheduledTime, fixtureStart);
  const observed = await readStatus(f);
  assert.deepEqual(observed.cadence.override, { cadence: 'every-landing' });
  assert.equal(observed.cadence.automatic.landings, 5);
  assert.match(observed.cadence.automaticHint, /Automatic picks 5/);
});

test('replayed continuous arrivals use fewer audits and keep red detection within the cadence bound', async t => {
  storageClock(t);
  const origin = fixtureStart;
  let now = origin;
  t.mock.method(Date, 'now', () => now);
  async function replay(cadence, firstRed) {
    now = origin;
    const f = await auditFixture();
    f.patch('hostedProjects', f.projectId, {
      autonomyPolicy: { ...policyPreset('trusted'), mainAudit: { cadence } },
    });
    await f.land('full');
    seedHistory(f, 0);
    const countedFrom = f.counts.length;
    const began = performance.now();
    const arrivals = Array.from({ length: 22 }, (_, i) => origin + 40_000 * i);
    const runWallMs = 80_000;
    let landed = 0;
    let audits = 0;
    let ends = Infinity;
    let donorMisses = 0;
    while (arrivals.length || f.pending().length || ends !== Infinity) {
      const wake = f.pending()[0];
      const next = Math.max(now, Math.min(arrivals[0] ?? Infinity, wake?.scheduledTime ?? Infinity, ends));
      now = next;
      if (arrivals[0] === now) {
        arrivals.shift();
        landed++;
        await f.land();
        donorMisses += Number(!f.row().lastGreen);
      }
      if (ends === now) {
        const coverage = report(f);
        const red = firstRed !== null && coverage.throughSequence >= firstRed + 1;
        await f.terminal(red ? 'failed' : 'passed');
        if (red) return { audits, landed, donorMisses, detectedAt: now - origin };
        ends = Infinity;
      }
      const due = f.pending()[0];
      if (due?.scheduledTime <= now) {
        assert.equal(ends, Infinity, 'the next audit never overlaps the last');
        await f.tick(due);
        audits++;
        ends = now + runWallMs;
      }
    }
    assert.equal(f.row().unaudited.count, 0);
    const counts = f.counts.slice(countedFrom);
    return {
      audits,
      landed,
      donorMisses,
      calls: counts.length,
      documentsRead: counts.reduce((n, row) => n + row.documents, 0),
      documentsWritten: counts.reduce((n, row) => n + row.writes, 0),
      readBytes: counts.reduce((n, row) => n + row.readBytes, 0),
      writeBytes: counts.reduce((n, row) => n + row.writeBytes, 0),
      elapsedMs: performance.now() - began,
    };
  }
  const baseline = await replay('every-landing', null);
  const automatic = await replay('automatic', null);
  assert.equal(automatic.landed, baseline.landed);
  assert(automatic.audits < baseline.audits);
  assert.equal(automatic.donorMisses, baseline.donorMisses);
  const firstRed = 7;
  const redBaseline = await replay('every-landing', firstRed);
  const redAutomatic = await replay('automatic', firstRed);
  const firstRedAt = (firstRed - 1) * 40_000;
  assert(redAutomatic.detectedAt - firstRedAt <= 2 * minute + 80_000);
  assert(redAutomatic.detectedAt - redBaseline.detectedAt <= 2 * minute);
  t.diagnostic(JSON.stringify({ baseline, automatic, redBaseline, redAutomatic, firstRedAt }));
});

for (const [name, starts, chosen, measured] of [
  ['high refusal rate', [false, true, undefined, false], 4, { evaluated: 3, refusals: 2, unevaluated: 1 }],
  [
    'only unevaluated starts',
    [undefined, undefined, undefined],
    5,
    { evaluated: 0, refusals: 0, unevaluated: 3 },
  ],
]) {
  test(`automatic cadence snapshots compact donor metrics at the audit start: ${name}`, async t => {
    storageClock(t);
    let now = fixtureStart;
    t.mock.method(Date, 'now', () => now);
    const f = await auditFixture();
    await f.land('full');
    seedHistory(f, 0);
    const metrics = await import(moduleUrl('../convex/projectMetricReadProjection.ts'));
    starts.forEach((auditDonor, index) => {
      const runId = randomUUID();
      f.insert('projectFinishReadRows', {
        kind: metrics.metricRunKind,
        projectId: f.projectId,
        sourceId: runId,
        runId,
        sourceCreatedAt: now - index - 1,
        value: JSON.stringify({ id: runId, started: true, auditDonor }),
      });
    });
    await f.land();
    await f.tick(f.pending()[0]);
    assert.deepEqual(f.row().donorSignal, measured);
    assert.equal(report(f).cadence.effective.landings, 5, 'receipt pins the policy that armed its wake');
    const next = await readStatus(f);
    assert.equal(next.cadence.effective.landings, chosen);
    assert.equal(next.cadence.signal.donors.stepdown, chosen < 5);
    now += 30_000;
    await f.terminal();
    for (let i = 1; i <= chosen; i++) {
      now += 1000;
      await f.land();
      assert.equal(f.pending()[0].scheduledTime <= now, i === chosen);
    }
    await f.tick(f.pending()[0]);
    assert.equal(report(f).cadence.effective.landings, chosen);
    assert.equal(report(f).landings, chosen);
  });
}

test('a reduced verdict releases the slot for newer landings whose age deadline passed', async t => {
  storageClock(t);
  let now = fixtureStart;
  t.mock.method(Date, 'now', () => now);
  const f = await auditFixture();
  await f.land('full');
  seedHistory(f, 0);
  await f.land();
  await f.tick(f.pending()[0]);
  now += 10_000;
  const next = await f.land();
  now += 3 * minute;
  const active = f.currentRun();
  await f.terminal('passed', { ...active, gate: { ...active.gate, effective: 'docs' } });
  assert.equal(f.pending()[0].scheduledTime, now);
  await f.tick(f.pending()[0]);
  assert.equal(f.currentRun().request.expectedHead, next.receipt.candidate.head);
  assert.equal(report(f).reason, 'oldest-wait');
});

test('a cadence edit preserves a reserved retry, and an exhausted retry releases newer work', async t => {
  storageClock(t);
  let now = fixtureStart;
  t.mock.method(Date, 'now', () => now);
  const f = await auditFixture();
  await f.land();
  await f.tick(f.pending()[0]);
  const original = f.currentRun().id;
  await f.terminal('runner-unavailable');
  const retry = f.pending()[0];
  assert.equal(retry.args[0].retry, true);
  const autonomy = await import(moduleUrl('../convex/projectAutonomy.ts'));
  const operationId = randomUUID();
  const changed = await f.call('changeCadenceDuringRetry', autonomy.set, {
    projectId: f.projectId,
    command: JSON.stringify({ action: 'set-policy', operationId, mainAudit: { cadence: 'every-landing' } }),
  });
  assert.equal(changed.policy.preset, 'custom', 'the unconfigured project retains its custom preset');
  assert.equal(f.pending()[0]._id, retry._id);
  await f.tick(retry);
  assert.notEqual(f.currentRun().id, original);
  now += 5_000;
  const later = await f.land();
  await f.terminal('runner-unavailable');
  assert.equal(f.pending()[0].args[0].retry, undefined);
  assert.equal(f.pending()[0].scheduledTime, now);
  await f.tick(f.pending()[0]);
  assert.equal(f.currentRun().request.expectedHead, later.receipt.candidate.head);
});

test('the first cohort audit records the accepted range before the final member', async t => {
  storageClock(t);
  const f = await auditFixture();
  const first = await f.land('docs');
  await f.land('docs');
  const last = await f.land('contract', { firstSequence: first.receipt.snapshot.revision });
  await f.tick(f.pending()[0]);
  assert.equal(f.currentRun().request.expectedHead, last.receipt.candidate.head);
  assert.equal(report(f).firstSequence, first.receipt.snapshot.revision);
  assert.equal(report(f).throughSequence, last.receipt.snapshot.revision);
  assert.equal(report(f).landings, 3);
});
