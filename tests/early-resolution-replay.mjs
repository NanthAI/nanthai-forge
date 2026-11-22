// SPDX-License-Identifier: Apache-2.0
import { storageClock } from './storage-clock.mjs';
import assert from 'node:assert/strict';
import { batchesFixture, states } from './hosted-landing-batches-fixture.mjs';
import { syncFixture } from './hosted-sync-fixture.mjs';
import { compose } from './hosted-finish-fixture.mjs';
import { metricAliasProjectionCounts } from './observer-projection-budget.mjs';

export async function drainReady(f, skip = () => false) {
  for (let n = 0; ; n++) {
    const task = f.pending().find(task => !/LandingStall|CheckLease:expire/.test(task.name) && !skip(task));
    if (!task) return;
    assert(n < 1000, 'finite event-driven queue drain');
    if (task.name === 'projectHostedConflictMerge:run') {
      const { moduleUrl } = await import('./convex-module.mjs');
      const merge = await import(moduleUrl('../convex/projectHostedConflictMerge.ts'));
      const conflicts = await import(moduleUrl('../convex/projectHostedConflicts.ts'));
      const { getFunctionName } = await import('convex/server');
      await merge.run._handler(
        {
          runQuery: (ref, args) => f.tx('trial-query', conflicts[getFunctionName(ref).split(':')[1]], args),
          runMutation: (ref, args) =>
            f.tx('trial-record', conflicts[getFunctionName(ref).split(':')[1]], args),
        },
        task.args[0],
      );
      f.patch('_scheduled_functions', task._id, { state: { kind: 'success' } });
    } else if (task.name === 'projectHostedEarlyResolutionRecovery:advance') {
      const { moduleUrl } = await import('./convex-module.mjs');
      const recovery = await import(moduleUrl('../convex/projectHostedEarlyResolutionRecovery.ts'));
      await f.tx('early-recovery-page', recovery.advance, task.args[0]);
      f.patch('_scheduled_functions', task._id, { state: { kind: 'success' } });
    } else await f.execute(task);
  }
}
export async function conflictTrio(
  t,
  {
    earlyResolve,
    history = 0,
    clean = false,
    disjoint = false,
    samples,
    thirdPredecessor = false,
    lateThird = false,
  } = {},
) {
  // Daily rows add a call at midnight. Compared replays start at the same fixed noon.
  storageClock(t);
  const f = await batchesFixture(t, {
    startAt: Date.UTC(2026, 10, 10, 12),
    count: 0,
    batchMaxSize: 1,
    fileCount: 2,
    memberPaths: [
      [disjoint ? 'first.txt' : 'shared.txt', 'first-only.txt'],
      [disjoint ? 'second.txt' : 'shared.txt', 'second-only.txt'],
      [disjoint ? 'late.txt' : 'shared.txt', 'late-only.txt'],
      lateThird ? 'shared.txt' : 'member-3',
    ],
    baselineFiles: [['shared.txt', 'alpha\nmiddle\nomega\n']],
    memberContents: [
      'alpha-a\nmiddle\nomega\n',
      'alpha\nmiddle\nomega-b\n',
      clean ? 'alpha\nlate middle\nomega\n' : 'alpha-c\nmiddle\nomega-c\n',
      lateThird ? 'alpha\nmiddle-d\nomega\n' : 'member 3',
    ],
  });
  const project = f.tables.hostedProjects.get(f.projectId);
  if (earlyResolve)
    f.patch('hostedProjects', f.projectId, {
      autonomyPolicy: {
        ...project.autonomyPolicy,
        acceptance: { ...project.autonomyPolicy.acceptance, earlyResolve },
      },
    });
  for (let i = 0; i < history; i++)
    f.insert('projectHostedAcceptances', {
      projectId: f.projectId,
      receiptId: `old-${i}`,
      submissionId: `old-${i}`,
      attemptId: `old-${i}`,
      sequence: i + 100,
      value: '{}',
    });
  const byIndex = [];
  for (const i of thirdPredecessor ? [0, 1, 3, 2] : [0, 1, 2]) {
    if (i === 2 && samples) {
      const queue = [...f.tables.projectHostedLandingQueues.values()][0];
      f.patch('projectHostedLandingQueues', queue._id, { earlyResolveSamples: JSON.stringify(samples) });
    }
    await f.add(i);
    byIndex[i] = f.entries.at(-1);
    await drainReady(f);
  }
  const s = await syncFixture({ store: { ...f.c, call: (name, fn, args) => f.tx(name, fn, args) } });
  const current = i => states(f).find(state => state.id === byIndex[i].state.id);
  const advice = (await f.current(byIndex[2].state.id)).wouldConflict;
  return { f, s, current, advice, lateEntry: byIndex[2] };
}
export async function resolveEarly(
  { f, s, advice, lateEntry },
  { resolveMs = 75000, beforeResolve, submit = true, resolvedContents = 'alpha-ac\nmiddle\nomega-bc\n' } = {},
) {
  const original = (lateEntry ?? f.entries[2]).lane;
  const { groupId: _group, ...predecessor } = advice.predecessor;
  void _group;
  const request = s.request('sync', {
    laneId: original.laneId,
    expected: s.pins(original),
    predecessor,
    target: { kind: 'main', head: f.currentMain().head, receiptId: f.currentMain().receipt.id },
  });
  const source = (await s.execute(request)).terminal.outcome.result;
  assert.equal(source.status, 'conflict', 'real sync engine retains the exact predicted-prefix conflict');
  const pending = (await s.readLane(source.lane.laneId)).entry;
  const files = JSON.parse(f.c.objects.get(pending.head)).files;
  const edited = await s.save(
    pending,
    files.map(file => (file.path === 'shared.txt' ? f.c.file(file.path, resolvedContents) : file)),
  );
  f.advanceClock(resolveMs);
  await beforeResolve?.();
  const result = (await s.execute(s.request('resolve', { laneId: edited.laneId, expected: s.pins(edited) })))
    .terminal.outcome.result;
  assert.equal(result.status, 'resolved');
  const lane = (await s.readLane(result.lane.laneId)).entry;
  if (!submit) return { lane, source, predecessor, original };
  const selection = f.c.selection([lane]);
  selection.request.expectedMain = { head: f.currentMain().head, receiptId: f.currentMain().receipt.id };
  const candidate = await compose(f.c, selection);
  const state = await f.enqueue(
    f.request({
      candidateId: candidate.id,
      expectedHead: candidate.result.head,
      expectedMain: selection.request.expectedMain,
      governanceVersion: 1,
      finish: { composeOperationId: selection.request.operationId, after: null },
    }),
  );
  await drainReady(f);
  return { state, lane, source, candidate, predecessor, original, selection };
}
export const totals = f => ({
  calls: f.counts.length,
  reads: f.counts.reduce((n, r) => n + r.documents, 0),
  writes: f.counts.reduce((n, r) => n + r.writes, 0),
  metricAliasWrites: f.counts.reduce((n, r) => n + metricAliasProjectionCounts(r).writes, 0),
  readBytes: f.counts.reduce((n, r) => n + r.readBytes, 0),
  writeBytes: f.counts.reduce((n, r) => n + r.writeBytes, 0),
});

export async function resolveAccepted({ f, s }, submissionId, { resolveMs = 75000 } = {}) {
  const { moduleUrl } = await import('./convex-module.mjs');
  const records = await import(moduleUrl('../convex/projectHostedRecords.ts'));
  const store = await import(moduleUrl('../convex/projectHostedLandingStore.ts'));
  const state = (await f.current(submissionId)).submission;
  const attempt = await f.transaction(
    'read-terminal-conflict-pins',
    {
      _handler: ctx => store.loadLandingAttempt(ctx, { projectId: f.projectId, attemptId: state.attemptId }),
    },
    {},
  );
  const record = await f.transaction(
    'read-terminal-conflict',
    {
      _handler: ctx =>
        records.readHostedRecord(ctx, {
          projectId: f.projectId,
          actor: 'owner',
          kind: 'candidate',
          key: attempt.candidate.id,
        }),
    },
    {},
  );
  const candidate = JSON.parse(record.value);
  const source = (
    await s.execute(
      s.request('resolution', { candidateId: candidate.id, conflicts: candidate.result.conflicts }),
    )
  ).terminal.outcome.result;
  const pending = (await s.readLane(source.lane.laneId)).entry;
  const files = JSON.parse(f.c.objects.get(pending.head)).files;
  const edited = await s.save(
    pending,
    files.map(file =>
      file.path === 'shared.txt' ? f.c.file(file.path, 'alpha-ac\nmiddle\nomega-bc\n') : file,
    ),
  );
  f.advanceClock(resolveMs);
  const result = (await s.execute(s.request('resolve', { laneId: edited.laneId, expected: s.pins(edited) })))
    .terminal.outcome.result;
  const lane = (await s.readLane(result.lane.laneId)).entry;
  const selection = f.c.selection([lane]);
  selection.request.expectedMain = { head: f.currentMain().head, receiptId: f.currentMain().receipt.id };
  const composed = await compose(f.c, selection);
  const next = await f.enqueue(
    f.request({
      candidateId: composed.id,
      expectedHead: composed.result.head,
      expectedMain: selection.request.expectedMain,
      governanceVersion: 1,
      finish: { composeOperationId: selection.request.operationId, after: null },
    }),
  );
  await drainReady(f);
  return { state: next, lane };
}

/** Zero-service event clock; the real queue, source merge/resolve, check callbacks and acceptance run.
 * Relative service costs mirror the earlier replay harness's 180s check; 75s resolution is the
 * rounded observed preview recovery. The second predecessor owns two check quanta of remaining wait. */
export async function replayConflictTrio(
  t,
  { earlyResolve, history = 0, clean = false, disjoint = false } = {},
) {
  const trio = await conflictTrio(t, { earlyResolve, history, clean, disjoint });
  const { f } = trio;
  const started = Date.now(),
    due = new Map(),
    ledger = new Map();
  let selected = f.entries[2].state.id,
    resolutions = 0;
  const reserve = async () => {
    for (const run of f.runs().filter(r => r.status === 'queued' && !due.has(r.id))) {
      const duration =
        run.request.expectedHead === trio.advice?.predecessor.head ||
        (clean && run.request.expectedHead === f.runs()[1]?.request.expectedHead)
          ? 360000
          : 180000;
      due.set(run.id, Date.now() + duration);
      ledger.set(run.id, { duration, reservedAt: Date.now() - started });
      await f.rawChecks.activate(run.id);
    }
  };
  await reserve();
  if (trio.advice?.resolution?.early) {
    selected = (await resolveEarly(trio)).state.id;
    resolutions++;
  }
  for (let step = 0; step < 100; step++) {
    await reserve();
    const current = (await f.current(selected)).submission;
    if (current.phase === 'landed')
      return {
        lateTaskMs: Date.now() - started,
        resolutions,
        checks: f.runs().length,
        ...totals(f),
        idle: f.pending().length,
        receipt: current.acceptance,
      };
    if (current.phase === 'terminal-failed') {
      assert.equal(current.error.code, 'COMPOSITION_CONFLICT');
      selected = (await resolveAccepted(trio, selected)).state.id;
      resolutions++;
      continue;
    }
    const running = f.runs().filter(r => r.status === 'running');
    const next = Math.min(...running.map(r => due.get(r.id)));
    assert(Number.isFinite(next), 'pending trio is owned by a check event');
    f.advanceClock(next - Date.now());
    for (const run of running.filter(r => due.get(r.id) <= Date.now())) await f.rawChecks.pass(run);
    await drainReady(f);
  }
  assert.fail('bounded conflict trio replay');
}

/** Retained pre-guard clean-sync State, not a route offered by the current publisher. Source
 * bytes come from the real synthetic merge; hydrate only the historical record shape to replay
 * incidents and immutable-attempt recovery after upgrading an already affected project. */
export async function retainLegacyCleanSync({ f, s, original, predecessor }) {
  const { moduleUrl } = await import('./convex-module.mjs');
  const records = await import(moduleUrl('../convex/projectHostedRecords.ts'));
  const finishes = await import(moduleUrl('../convex/projectHostedLaneFinish.ts'));
  const before = await s.readLane(original.laneId);
  const request = s.request('sync', {
    laneId: original.laneId,
    expected: s.pins(original),
    predecessor,
    target: { kind: 'main', head: f.currentMain().head, receiptId: f.currentMain().receipt.id },
  });
  const executed = await s.execute(request);
  const output = JSON.parse(executed.output.manifest).result;
  assert.equal(output.status, 'merged', 'legacy fixture uses a real clean three-way merge');
  const sync = JSON.parse(
    [...f.tables.projectHostedSyncs.values()].find(r => r.operationId === request.operationId).value,
  );
  if (executed.terminal.outcome.result.status === 'up-to-date')
    await f.transaction(
      'retain-synthetic-pre-upgrade-clean-sync',
      {
        _handler: async ctx => {
          await ctx.db.insert('projectHostedStates', {
            projectId: f.projectId,
            head: output.state.sha256,
            size: output.state.size,
            input: JSON.parse(executed.output.manifest).input.sha256,
            jobId: executed.output.jobId,
            output: executed.output.output.sha256,
          });
          const lane = {
            ...before.record,
            head: output.state.sha256,
            version: before.record.version + 1,
            sourceVersion: before.record.sourceVersion + 1,
            stack: sync.work.stackAfter,
            earlyResolution: sync.work.earlyResolution,
          };
          await records.writeHostedRecord(ctx, {
            projectId: f.projectId,
            actor: 'owner',
            authorityEpoch: 1,
            expectedVersion: before.record.version,
            ownerOnly: true,
            record: lane,
          });
          const parent = [...f.tables.projectHostedLandingRequests.values()].find(
            r => r.submissionId === predecessor.submissionId,
          );
          await ctx.db.patch(parent._id, {
            earlyResolveWatch: JSON.stringify(predecessor),
            earlyResolveDependents: true,
          });
          await finishes.supersedeLaneFinishes(ctx, {
            projectId: f.projectId,
            laneId: original.laneId,
            head: lane.head,
          });
        },
      },
      {},
    );
  return (await s.readLane(original.laneId)).entry;
}

/** The third group arrives after advice picked its prefix but before the resolved author
 * resubmits. Its middle-line edit merges with both original predecessors and the resolution. */
export async function replayLinearConflictTrio(t) {
  const trio = await conflictTrio(t, { lateThird: true });
  const { f } = trio;
  const started = Date.now(),
    due = new Map();
  const reserve = async () => {
    for (const run of f.runs().filter(r => r.status === 'queued' && !due.has(r.id))) {
      const duration = run.request.expectedHead === trio.advice.predecessor.head ? 360000 : 180000;
      due.set(run.id, Date.now() + duration);
      await f.rawChecks.activate(run.id);
    }
  };
  await reserve();
  const resolved = await resolveEarly(trio, {
    beforeResolve: async () => {
      await f.add(3);
      await drainReady(f);
    },
  });
  for (let n = 0; n < 30; n++) {
    await reserve();
    const state = (await f.current(resolved.state.id)).submission;
    if (state.phase === 'landed') {
      const attempts = [...f.tables.projectHostedLandingAttempts.values()]
        .map(r => JSON.parse(r.value))
        .filter(a => a.submissionId === state.id);
      const childChecks = [...new Set(attempts.flatMap(a => (a.check ? [a.check.runId] : [])))];
      const accepted = attempts.find(a => a.id === state.attemptId);
      return {
        lateTaskMs: Date.now() - started,
        childChecks,
        acceptedCheck: accepted.check.runId,
        checks: f.runs().length,
        idle: f.pending().length,
        ...totals(f),
      };
    }
    assert.notEqual(state.phase, 'terminal-failed', JSON.stringify(state));
    const running = f.runs().filter(r => r.status === 'running');
    const next = Math.min(...running.map(r => due.get(r.id)));
    assert(Number.isFinite(next), 'linear replay stays event-owned');
    f.advanceClock(Math.max(0, next - Date.now()));
    for (const run of running.filter(r => due.get(r.id) <= Date.now())) await f.rawChecks.pass(run);
    await drainReady(f);
  }
  assert.fail('bounded linear train replay');
}
