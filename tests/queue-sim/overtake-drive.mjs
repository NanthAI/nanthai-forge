// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Ferdinando Valsecchi
// Shared queue-replay driver for the overtake and handoff replays (incidents 7d98c7da, c6b81429,
// 70a9bd2f, 43b51a5e).
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { batchesFixture, states } from '../hosted-landing-batches-fixture.mjs';
import { landingApi } from '../hosted-finish-fixture.mjs';
import { metricAliasProjectionCounts } from '../observer-projection-budget.mjs';
import { storageClock } from '../storage-clock.mjs';
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
 * instead of passing it. `arrives(index)` is the tick an entry is submitted (default 0; must not
 * decrease with the index). Returns landing ticks, run counts, the per-run log (`runTicks`: owner,
 * start tick, runner ticks, whether a landing used it), withdraw ticks and receipts by entry. */
export async function drive(
  t,
  {
    memberPaths,
    memberContents,
    baselineFiles = [],
    duration,
    pick = tasks => tasks[0],
    withdraws = () => false,
    arrives = () => 0,
    unknownAdmissionRisk = false,
    ownerApprovalPaths,
    fixture = {},
    prepare,
    afterStep,
  },
) {
  // Check passes, compose stamps and scheduled tasks use the same simulated time.
  storageClock(t);
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
  let arrived = 0;
  for (; arrived < memberPaths.length && arrives(arrived) <= 0; arrived++) {
    if (unknownAdmissionRisk) f.patch('hostedProjects', f.projectId, { checkEntries: undefined });
    await f.add(arrived);
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
    withdrawn = new Map(),
    runsOf = new Map(ids.map(id => [id, new Set()])),
    // Every check run by id: who started it, when, and when it stopped being queued (runner time).
    runLog = new Map();
  const open = () =>
    arrived < memberPaths.length ||
    states(f).some(s => s.phase !== 'landed' && s.phase !== 'terminal-failed');
  for (let tick = 0; open(); tick++) {
    assert(tick < 20000, JSON.stringify(states(f).map(s => [s.sequence, s.phase])));
    for (; arrived < memberPaths.length && arrives(arrived) <= tick; arrived++) {
      assert(arrives(arrived) >= arrives(arrived - 1), 'arrivals keep index order');
      const id = (await f.add(arrived)).id;
      ids.push(id);
      runsOf.set(id, new Set());
    }
    for (const [id, entry] of runLog)
      if (entry.ended === undefined && f.runs().find(run => run.id === id)?.status !== 'queued')
        entry.ended = tick;
    for (const run of f.runs().filter(run => run.status === 'queued' && run.gate?.mode !== 'audit')) {
      const id = owner(run);
      if (!runLog.has(run.id)) runLog.set(run.id, { owner: ids.indexOf(id), started: tick });
      if (withdrawn.has(id)) continue;
      runsOf.get(id)?.add(run.id);
      const nth = runsOf.get(id)?.size ?? 1;
      if (!due.has(run.id)) due.set(run.id, tick + duration(ids.indexOf(id), nth));
      if (due.get(run.id) > tick) continue;
      if (withdraws(ids.indexOf(id), nth)) {
        withdrawn.set(id, tick);
        await f.transaction('replay-withdraw', landingApi.cancel, {
          projectId: f.projectId,
          request: JSON.stringify({ operationId: randomUUID(), authorityEpoch: 1, submissionId: id }),
        });
      } else await f.rawChecks.pass(await f.rawChecks.activate(run.id));
    }
    const tasks = f.pending().filter(t => !/MainAudit:start|LandingStall/.test(t.name));
    if (!tasks.length) {
      if (f.runs().some(run => run.status === 'queued' && run.gate?.mode !== 'audit')) continue;
      if (arrived < memberPaths.length) continue;
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
  // A run is used when a landed entry's final attempt is bound to it; every other run was discarded.
  const usedRuns = new Set(
    rows()
      .filter(row => row.phase === 'landed')
      .map(row => row.runId)
      .filter(Boolean),
  );
  const runTicks = [...runLog].map(([id, entry]) => ({
    ...entry,
    ticks: (entry.ended ?? entry.started) - entry.started,
    used: usedRuns.has(id),
    status: f.runs().find(run => run.id === id)?.status,
  }));
  const result = {
    ids,
    landedAt: ids.map(id => landedAt.get(id)),
    withdrawnAt: ids.map(id => withdrawn.get(id)),
    runs: ids.map(id => runsOf.get(id)?.size ?? 0),
    runTicks,
    orderWaits: ids.map(id => byId.get(id)?.orderWaits ?? []),
    // What each landing's first-check proof carried its pass across (null: it landed on an exact check).
    proofs: ids.map(id => {
      const proof = byId.get(id)?.crossHeadProof;
      return proof && proof.algorithm !== 'exact-tree-v1'
        ? { algorithm: proof.algorithm, candidatePaths: proof.candidatePaths, mainPaths: proof.mainPaths }
        : null;
    }),
    // Every first-check decision in order: `proof`, or the refusal reason.
    firstCheck: [...f.reuseDecisions],
    calls: f.counts.length,
    readBytes: f.counts.reduce((n, c) => n + c.readBytes, 0),
    writeBytes: f.counts.reduce((n, c) => n + c.writeBytes, 0),
    aliasWriteBytes: f.counts.reduce((n, c) => n + metricAliasProjectionCounts(c).writeBytes, 0),
    idle: f.pending().filter(task => !/MainAudit:start|LandingStall/.test(task.name)).length,
  };
  t.diagnostic(JSON.stringify({ ...result, ids: undefined }));
  // A stranded entry says what it waits for (Item 273650ab: a circle of waits is readable at once).
  const sequenceOf = id => rows().find(row => row.submissionId === id)?.sequence;
  assert(
    states(f).every(s => s.phase === (withdrawn.has(s.id) ? 'terminal-failed' : 'landed')),
    JSON.stringify(
      states(f).map(s => {
        if (s.phase === 'landed') return [s.sequence, s.phase];
        const row = rows().find(r => r.submissionId === s.id);
        return [
          s.sequence,
          s.phase,
          { waitsFor: sequenceOf(row?.orderWait), reason: s.observation?.pendingReason },
        ];
      }),
    ),
  );
  return result;
}
