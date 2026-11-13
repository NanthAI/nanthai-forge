// SPDX-License-Identifier: Apache-2.0
// Event-driven production queue, composition, check completion and audit controllers.
// Inputs retain relative arrivals only; source bodies use independent synthetic lines.
import assert from 'node:assert/strict';
import { batchesFixture, states } from './hosted-landing-batches-fixture.mjs';

export const median = values => {
  const sorted = [...values].sort((a, b) => a - b);
  const i = Math.floor(sorted.length / 2);
  return sorted.length ? (sorted.length % 2 ? sorted[i] : (sorted[i - 1] + sorted[i]) / 2) : null;
};
export async function replayAdmission(t, cell, { admissionCheck = 'full', red = [], history = 0 } = {}) {
  const paths = [...new Set(cell.entries.flatMap(e => e.files))];
  const lines = Array.from({ length: cell.entries.length * 3 }, (_, i) => `line ${i}\n`);
  const f = await batchesFixture(t, {
    count: 0,
    admissionCheck,
    batchMaxSize: null,
    fileCount: 2,
    runAudits: true,
    memberPaths: cell.entries.map((e, i) => [...e.files, `tests/change-${i}.test.mjs`]),
    baselineFiles: paths.map(path => [path, lines.join('')]),
    memberContents: cell.entries.map((_, i) =>
      lines.map((line, n) => (n === i * 3 ? `change ${i}\n` : line)).join(''),
    ),
  });
  // The shared fixture advances Date.now. Audit cadence and acceptance records
  // also construct Date objects: both APIs must observe the same fake clock.
  const OriginalDate = Date;
  const clock = Date.now;
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
  f.rawChecks.setPlanSelection(JSON.stringify({ scope: 'full', tests: [] }));
  for (let i = 0; i < history; i++)
    f.insert('projectHostedAcceptances', {
      projectId: f.projectId,
      receiptId: `history-${i}`,
      submissionId: `history-${i}`,
      attemptId: `history-${i}`,
      sequence: i + 100,
      value: '{"unrelated":"retained history"}',
    });
  const started = Date.now(),
    due = new Map(),
    ledger = new Map(),
    landed = new Map(),
    isolated = new Map();
  const failed = new Set(red);
  const files = head => JSON.parse(f.c.objects.get(head)).files;
  const contains = (head, i) => files(head).some(file => file.path === `tests/change-${i}.test.mjs`);
  const members = run =>
    cell.entries
      .map((_, i) => i)
      .filter(i => contains(run.request.expectedHead, i) && !contains(run.candidate.base.head, i));
  const activeTasks = () => f.pending().filter(task => !/LandingStall|CheckLease:expire/.test(task.name));
  let next = 0,
    deferredAudits = 0;
  for (let step = 0; step < 10000; step++) {
    const now = Date.now() - started;
    for (const run of f.runs()) {
      const item = ledger.get(run.id);
      if (item && !['queued', 'running'].includes(run.status) && item.endMs === undefined) item.endMs = now;
    }
    while (next < cell.entries.length && cell.entries[next].submitMs <= now) await f.add(next++);
    for (const run of f.runs().filter(r => r.status === 'queued' && !ledger.has(r.id))) {
      const indexes = members(run);
      const audit = run.gate?.mode === 'audit';
      assert(audit || indexes.length, 'non-audit check includes submitted source');
      const duration = audit
        ? median(cell.entries.map(e => e.checkMs))
        : Math.max(...indexes.map(i => cell.entries[i].checkMs));
      ledger.set(run.id, {
        id: run.id,
        startMs: Date.now() - started,
        duration,
        audit,
        members: indexes,
        admission: [...f.tables.projectHostedLandingRequests.values()].some(
          row => row.admission?.runId === run.id,
        ),
      });
      due.set(run.id, Date.now() + duration);
      await f.rawChecks.activate(run.id);
    }
    for (const run of f.runs().filter(r => r.status === 'running' && due.get(r.id) <= Date.now())) {
      const culprit = red.find(i => contains(run.request.expectedHead, i));
      if (culprit !== undefined) {
        await f.rawChecks.callback(f.rawChecks.shard(run, 0, 'failed'));
        await f.rawChecks.callback(
          f.rawChecks.complete(run, 'failed', {
            contractReports: {
              [`tests/change-${culprit}.test.mjs`]: {
                failed: true,
                durationMs: 1,
                firstError: 'synthetic red change',
              },
            },
          }),
        );
      } else await f.rawChecks.pass(run);
      due.delete(run.id);
    }
    for (const state of states(f)) {
      const index = f.entries.findIndex(e => e.state.id === state.id);
      if (state.phase === 'landed' && !landed.has(index)) {
        assert(!failed.has(index), 'red source never accepts');
        landed.set(index, Date.now() - started);
      }
      if (state.phase === 'terminal-failed') {
        assert(failed.has(index), `only injected red may fail: ${JSON.stringify(state.error)}`);
        assert.equal(state.error.code, 'CHECK_FAILED');
        if (!isolated.has(index)) isolated.set(index, Date.now() - started);
      }
    }
    const tasks = activeTasks();
    const running = f.runs().filter(r => r.status === 'running');
    if (
      next === cell.entries.length &&
      landed.size + isolated.size === cell.entries.length &&
      !tasks.length &&
      !running.length
    )
      break;
    if (
      next === cell.entries.length &&
      landed.size + isolated.size === cell.entries.length &&
      !running.length &&
      tasks.every(task => task.name === 'projectHostedMainAudit:start' && task.scheduledTime > Date.now())
    ) {
      deferredAudits = tasks.length;
      break; // Retain future cadence work, rather than charging tomorrow's audit to this wave.
    }
    const time = Math.min(
      tasks[0]?.scheduledTime ?? Infinity,
      next < cell.entries.length ? started + cell.entries[next].submitMs : Infinity,
      ...running.map(run => due.get(run.id) ?? Infinity),
    );
    assert(Number.isFinite(time), 'pending landing has an owned scheduled event');
    f.advanceClock(Math.max(0, time - Date.now()));
    if (tasks[0] && tasks[0].scheduledTime <= Date.now()) await f.execute(tasks[0]);
    assert(step < 9999, 'bounded replay, no polling');
  }
  const runs = f.runs();
  const charged = [...ledger.values()].map(item => {
    const run = runs.find(r => r.id === item.id);
    // A canceled run is billed only until its cancellation, not its planned service end.
    const elapsed =
      run.status === 'cancelled'
        ? Math.max(0, Math.min(item.duration, (item.endMs ?? Date.now() - started) - item.startMs))
        : item.duration;
    return { ...item, id: undefined, elapsed, status: run.status };
  });
  const latencies = [...landed].map(([i, at]) => at - cell.entries[i].submitMs);
  const ttm = [...landed].map(([i, at]) => at - (cell.entries[i].dispatchMs ?? cell.entries[i].submitMs));
  const isolation = [...isolated].map(([i, at]) => at - cell.entries[i].submitMs);
  const result = {
    checks: charged.length,
    ciMinutes: charged.reduce((n, r) => n + Math.ceil(r.elapsed / 60000), 0),
    ciSeconds: charged.reduce((n, r) => n + r.elapsed / 1000, 0),
    audits: charged.filter(r => r.audit).length,
    auditWakes: f.auditWakes.length,
    deferredAudits,
    wallMs: Math.max(...landed.values()),
    allSettledMs: Date.now() - started,
    ttmMedianMs: median(ttm),
    ttmMaxMs: Math.max(...ttm),
    submitMedianMs: median(latencies),
    submitMaxMs: Math.max(...latencies),
    submitMeanMs: latencies.reduce((a, b) => a + b, 0) / latencies.length,
    isolationMedianMs: median(isolation),
    isolationMaxMs: isolation.length ? Math.max(...isolation) : null,
    redBeforeQueue: charged.filter(r => r.admission && r.status === 'failed').length,
    redQueueRuns: charged.filter(r => !r.admission && r.status === 'failed').length,
    calls: f.counts.length,
    documentsRead: f.counts.reduce((n, c) => n + c.documents, 0),
    documentsWritten: f.counts.reduce((n, c) => n + c.writes, 0),
    readBytes: f.counts.reduce((n, c) => n + c.readBytes, 0),
    writeBytes: f.counts.reduce((n, c) => n + c.writeBytes, 0),
    idle: activeTasks().length - deferredAudits,
    landed: [...landed],
    isolated: [...isolated],
    ledger: charged,
  };
  assert.equal(landed.size, cell.entries.length - red.length);
  assert.equal(isolated.size, red.length);
  assert.equal(result.idle, 0);
  return result;
}
