// SPDX-License-Identifier: Apache-2.0
// Shared queue-replay driver for the overtake and handoff replays (incidents 7d98c7da, c6b81429,
// 70a9bd2f, 43b51a5e).
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { batchesFixture, states } from '../hosted-landing-batches-fixture.mjs';
import { landingApi } from '../hosted-finish-fixture.mjs';
import { metricAliasProjectionCounts } from '../observer-projection-budget.mjs';
export const overlapBase = 'export const a = 0;\n// gap\nexport const b = 0;\n';
export const overlapEdits = [
  'export const a = 1;\n// gap\nexport const b = 0;\n',
  'export const a = 0;\n// gap\nexport const b = 1;\n',
];
export const receipts = f =>
  [...f.tables.projectHostedAcceptances.values()]
    .map(r => JSON.parse(r.value))
    .sort((a, b) => a.snapshot.revision - b.snapshot.revision);

/** Drive a wave of pre-queue-checked landings to the end. `duration(index, nth)` is the ticks the
 * nth check of entry `index` takes; `pick` chooses which due task runs next (scheduling order is not
 * fixed in a real deployment); `withdraws(index, nth)` withdraws the entry when that check is due
 * instead of passing it. Returns landing ticks, run counts and receipts by entry. */
export async function drive(
  t,
  {
    memberPaths,
    memberContents,
    baselineFiles = [],
    duration,
    pick = tasks => tasks[0],
    withdraws = () => false,
    unknownAdmissionRisk = false,
    ownerApprovalPaths,
    fixture = {},
    prepare,
    afterStep,
  },
) {
  const f = await batchesFixture(t, {
    batchMaxSize: null,
    admissionCheck: 'full',
    ...fixture,
    memberPaths,
    memberContents,
    baselineFiles,
    fileCount: 2,
    count: 0,
  });
  const entries = f.tables.hostedProjects.get(f.projectId).checkEntries;
  if (ownerApprovalPaths) {
    const policy = f.tables.hostedProjects.get(f.projectId).autonomyPolicy;
    f.patch('hostedProjects', f.projectId, {
      autonomyPolicy: { ...policy, acceptance: { ...policy.acceptance, ownerApprovalPaths } },
    });
  }
  for (let i = 0; i < memberPaths.length; i++) {
    if (unknownAdmissionRisk) f.patch('hostedProjects', f.projectId, { checkEntries: undefined });
    await f.add(i);
  }
  if (unknownAdmissionRisk) f.patch('hostedProjects', f.projectId, { checkEntries: entries });
  f.rawChecks.setPlanSelection(JSON.stringify({ scope: 'full', tests: [] }));
  const ids = f.entries.map(e => e.state.id);
  // `prepare(f, ids)` may reshape the queued rows once, before any check runs.
  await prepare?.(f, ids);
  const rows = () => [...f.tables.projectHostedLandingRequests.values()];
  const runOwner = run =>
    [...f.tables.projectHostedLandingAttempts.values()].find(
      row => JSON.parse(row.value).check?.runId === run.id,
    )?.submissionId;
  const owner = run =>
    rows().find(r => r.admission?.runId === run.id || r.runId === run.id)?.submissionId ?? runOwner(run);
  const due = new Map(),
    landedAt = new Map(),
    withdrawn = new Set(),
    runsOf = new Map(ids.map(id => [id, new Set()]));
  for (let tick = 0; states(f).some(s => s.phase !== 'landed' && s.phase !== 'terminal-failed'); tick++) {
    assert(tick < 20000, JSON.stringify(states(f).map(s => [s.sequence, s.phase])));
    for (const run of f.runs().filter(run => run.status === 'queued' && run.gate?.mode !== 'audit')) {
      const id = owner(run);
      if (withdrawn.has(id)) continue;
      runsOf.get(id)?.add(run.id);
      const nth = runsOf.get(id)?.size ?? 1;
      if (!due.has(run.id)) due.set(run.id, tick + duration(ids.indexOf(id), nth));
      if (due.get(run.id) > tick) continue;
      if (withdraws(ids.indexOf(id), nth)) {
        withdrawn.add(id);
        await f.transaction('replay-withdraw', landingApi.cancel, {
          projectId: f.projectId,
          request: JSON.stringify({ operationId: randomUUID(), authorityEpoch: 1, submissionId: id }),
        });
      } else await f.rawChecks.pass(await f.rawChecks.activate(run.id));
    }
    const tasks = f.pending().filter(t => !/MainAudit:start|LandingStall/.test(t.name));
    if (!tasks.length) {
      if (f.runs().some(run => run.status === 'queued' && run.gate?.mode !== 'audit')) continue;
      break;
    }
    const before = new Set(
      states(f)
        .filter(s => s.phase === 'landed')
        .map(s => s.id),
    );
    // `pick` may return null to hold every pending task for this tick (an interleaving replay).
    const task = pick(tasks, ids);
    if (!task) continue;
    await f.execute(task);
    // `afterStep(f, tick, task)` may inspect the queue after every executed task (invariant checks).
    await afterStep?.(f, tick, task);
    for (const s of states(f)) if (s.phase === 'landed' && !before.has(s.id)) landedAt.set(s.id, tick);
  }
  for (let step = 0; step < 100; step++) {
    const task = f.pending().find(task => !/MainAudit:start|LandingStall/.test(task.name));
    if (!task) break;
    await f.execute(task);
  }
  const byId = new Map(receipts(f).map(r => [r.submissionId, r]));
  const result = {
    ids,
    landedAt: ids.map(id => landedAt.get(id)),
    runs: ids.map(id => runsOf.get(id)?.size ?? 0),
    orderWaits: ids.map(id => byId.get(id)?.orderWaits ?? []),
    calls: f.counts.length,
    readBytes: f.counts.reduce((n, c) => n + c.readBytes, 0),
    writeBytes: f.counts.reduce((n, c) => n + c.writeBytes, 0),
    aliasWriteBytes: f.counts.reduce((n, c) => n + metricAliasProjectionCounts(c).writeBytes, 0),
    idle: f.pending().filter(task => !/MainAudit:start|LandingStall/.test(task.name)).length,
  };
  t.diagnostic(JSON.stringify({ ...result, ids: undefined, firstCheck: f.reuseDecisions }));
  assert(
    states(f).every(s => s.phase === (withdrawn.has(s.id) ? 'terminal-failed' : 'landed')),
    JSON.stringify(states(f).map(s => [s.sequence, s.phase])),
  );
  return result;
}
