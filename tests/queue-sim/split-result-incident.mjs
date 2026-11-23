// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Ferdinando Valsecchi
import assert from 'node:assert/strict';
import { storageClock } from '../storage-clock.mjs';
import { batchesFixture, states } from '../hosted-landing-batches-fixture.mjs';

export async function splitResultIncident(t) {
  storageClock(t);
  const f = await batchesFixture(t, {
    memberPaths: ['src/one.ts', 'src/two.ts', 'src/three.ts', 'src/four.ts'],
    runner: {
      provider: 'github-actions',
      repository: 'synthetic/checks',
      runsOn: 'ubuntu-latest',
      environmentFingerprint: 'd'.repeat(64),
    },
  });
  while (!f.runs().length) await f.execute(f.pending()[0]);
  const [shared] = f.runs();
  await f.fail(shared.id, 'tests/unrelated.test.mjs');
  const failedAt = Date.parse(f.runs().find(run => run.id === shared.id).endedAt);
  const children = () => f.runs().filter(run => run.id !== shared.id);
  for (let tick = 0; children().length < 2; tick++) {
    assert(tick < 100, 'a failed cohort dispatches its children');
    await f.execute(f.pending()[0]);
  }
  const [stalled] = children();
  const members = [...f.tables.projectHostedLandingRequests.values()]
    .filter(row => row.runId === stalled.id)
    .map(row => row.submissionId);
  assert.equal(members.length, 2);
  for (const member of states(f).filter(state => members.includes(state.id))) {
    assert.equal(member.batchDiagnostic.sharedRunId, shared.id);
    assert.equal(member.batchDiagnostic.likelyCulprit, false);
  }
  for (const run of children())
    assert(
      f
        .pending()
        .some(
          task =>
            task.name === 'projectHostedActionsDirect:dispatch' &&
            task.args[0].runId === run.id &&
            task.scheduledTime <= failedAt + 60_000,
        ),
      'both split rechecks have dispatch tasks within one minute',
    );
  const activated = await f.rawChecks.activate(stalled.id, 12);
  const row = [...f.tables.projectHostedCheckRuns.values()].find(row => row.runId === stalled.id);
  // Model runner startup plus a sealed inbox whose uploader and completed event
  // never reached the report fold. Both members are waiting on the same execution.
  f.patch('projectHostedCheckRuns', row._id, {
    value: JSON.stringify({
      ...activated,
      status: 'running',
      actions: {
        confirm: null,
        watchdog: null,
        fence: activated.fence,
        outcome: 'accepted',
        reservedAt: Date.parse(activated.at),
        workflowSha: 'a'.repeat(40),
      },
    }),
    reportStorage: 'r2',
    resultBatch: { packed: true },
  });
  for (let tick = 0; tick < 100; tick++) {
    const task = f.pending().find(task => !task.args[0].stallRepair);
    if (!task || task.scheduledTime > Date.parse(stalled.at) + 17 * 60_000) break;
    await f.execute(task);
  }
  const repairs = f.pending().filter(task => task.args[0].stallRepair && task.args[0].runId === stalled.id);
  assert.equal(repairs.length, 1, 'the checking stall arms one result recovery for the shared run');
  assert.equal(repairs[0].args[0].fence, activated.fence, 'the original dispatch fence is retained');
  assert.ok(repairs[0].scheduledTime - Date.parse(stalled.at) < 17 * 60_000);
}
