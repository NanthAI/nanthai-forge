// SPDX-License-Identifier: Apache-2.0
import assert from 'node:assert/strict';
import { batchesFixture, states } from './hosted-landing-batches-fixture.mjs';
import { syncFixture } from './hosted-sync-fixture.mjs';
import { compose } from './hosted-finish-fixture.mjs';

export async function drainReady(f) {
  for (let n = 0; ; n++) {
    const task = f.pending().find(task => !/LandingStall|CheckLease:expire/.test(task.name));
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
  { earlyResolve, history = 0, clean = false, disjoint = false, samples, thirdPredecessor = false } = {},
) {
  const f = await batchesFixture(t, {
    count: 0,
    batchMaxSize: 1,
    fileCount: 2,
    memberPaths: [
      [disjoint ? 'first.txt' : 'shared.txt', 'first-only.txt'],
      [disjoint ? 'second.txt' : 'shared.txt', 'second-only.txt'],
      [disjoint ? 'late.txt' : 'shared.txt', 'late-only.txt'],
    ],
    baselineFiles: [['shared.txt', 'alpha\nmiddle\nomega\n']],
    memberContents: [
      'alpha-a\nmiddle\nomega\n',
      'alpha\nmiddle\nomega-b\n',
      clean ? 'alpha\nlate middle\nomega\n' : 'alpha-c\nmiddle\nomega-c\n',
    ],
  });
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
  { resolveMs = 75000, beforeResolve, submit = true } = {},
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
    files.map(file =>
      file.path === 'shared.txt' ? f.c.file(file.path, 'alpha-ac\nmiddle\nomega-bc\n') : file,
    ),
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
