// SPDX-License-Identifier: Apache-2.0
import assert from 'node:assert/strict';
import { batchesFixture, states } from '../hosted-landing-batches-fixture.mjs';
export const median = values => {
  const sorted = [...values].sort((a, b) => a - b),
    n = sorted.length;
  return n ? (sorted[Math.floor((n - 1) / 2)] + sorted[Math.ceil((n - 1) / 2)]) / 2 : null;
};
const percentile = (values, p) =>
  [...values].sort((a, b) => a - b)[Math.max(0, Math.ceil(values.length * p) - 1)] ?? null;
const terminal = state => ['landed', 'terminal-failed'].includes(state.phase);

/** Calibration driver. Source text is synthetic: each task edits its own line
 * of each recorded path. Therefore observed textual conflict/recovery is NOT
 * reconstructed merely from overlapping paths. The output must qualify against
 * observations before it can become a regression baseline. */
export async function replayTrace(t, trace) {
  assert(trace.coverage.complete, `Incomplete trace: ${trace.coverage.missing.join(', ')}`);
  const tasks = [...trace.tasks].sort((a, b) => a.submittedAt - b.submittedAt);
  const base = tasks.map((_, i) => `// task ${i}: base`).join('\n') + '\n';
  const f = await batchesFixture(t, {
    count: 0,
    fileCount: 2,
    batching: 'default',
    batchMaxSize: null,
    memberPaths: tasks.map(task => task.paths),
    baselineFiles: [...new Set(tasks.flatMap(task => task.paths))].map(path => [path, base]),
    memberContents: tasks.map((_, i) => base.replace(`task ${i}: base`, `task ${i}: changed`)),
  });
  const start = Date.now(),
    ids = new Map(),
    due = new Map(),
    landed = new Map(),
    uses = new Map();
  const samples = trace.checks.filter(check => check.members.length);
  let arrived = 0,
    ciMinutes = 0,
    checks = 0;
  const now = () => (Date.now() - start) / 1000;
  for (let step = 0; step < 4000; step++) {
    for (const run of f
      .runs()
      .filter(r => ['queued', 'running'].includes(r.status) && r.gate?.mode !== 'audit')) {
      if (due.has(run.id)) continue;
      const owners = [...f.tables.projectHostedLandingAttempts.values()]
        .filter(row => JSON.parse(row.value).check?.runId === run.id)
        .map(row => ids.get(row.submissionId))
        .filter(Boolean);
      const candidates = samples.filter(sample => sample.members.some(task => owners.includes(task)));
      assert(candidates.length, 'Replay lacks a check sample for this group');
      const index = Math.max(0, ...owners.map(id => uses.get(id) ?? 0));
      const sample = candidates[Math.min(index, candidates.length - 1)];
      for (const id of owners) uses.set(id, (uses.get(id) ?? 0) + 1);
      due.set(run.id, { at: now() + sample.wallSeconds, sample });
    }
    const waiting = f.runs().filter(r => ['queued', 'running'].includes(r.status) && due.has(r.id));
    const nextRun = waiting.sort((a, b) => due.get(a.id).at - due.get(b.id).at)[0];
    const scheduled = f.pending()[0];
    const arrivalAt = tasks[arrived]?.submittedAt ?? Infinity;
    const runAt = nextRun ? due.get(nextRun.id).at : Infinity;
    const taskAt = scheduled ? (scheduled.scheduledTime - start) / 1000 : Infinity;
    const nextAt = Math.min(arrivalAt, runAt, taskAt);
    if (!Number.isFinite(nextAt)) {
      assert.equal(arrived, tasks.length, 'all recorded tasks arrived');
      assert(states(f).every(terminal), 'all entries settled');
      break;
    }
    f.advanceClock(Math.max(0, (nextAt - now()) * 1000));
    if (arrivalAt <= runAt && arrivalAt <= taskAt) {
      const state = await f.add(arrived);
      ids.set(state.id, tasks[arrived++].task);
    } else if (runAt <= taskAt) {
      const { sample } = due.get(nextRun.id);
      const active = nextRun.status === 'queued' ? await f.rawChecks.activate(nextRun.id) : nextRun;
      if (sample.outcome === 'passed') await f.rawChecks.pass(active);
      else await f.rawChecks.callback(f.rawChecks.complete(active, sample.outcome));
      ciMinutes += sample.billedMinutes;
      checks++;
    } else await f.execute(scheduled);
    for (const state of states(f))
      if (state.phase === 'landed' && !landed.has(ids.get(state.id))) landed.set(ids.get(state.id), now());
    assert(step < 3999, 'Replay exceeded bounded steps');
  }
  const recomposes = tasks.map(task => {
    const id = [...ids].find(([, name]) => name === task.task)?.[0];
    return Math.max(
      0,
      new Set(
        [...f.tables.projectHostedLandingAttempts.values()]
          .filter(row => row.submissionId === id)
          .map(row => JSON.parse(row.value).candidate.id),
      ).size - 1,
    );
  });
  const times = tasks
    .filter(task => task.counted !== false)
    .map(task => {
      assert(landed.has(task.task), `Replay did not land ${task.task}`);
      return landed.get(task.task) - task.dispatchedAt;
    });
  return {
    timeToMainMedianSeconds: median(times),
    timeToMainP90Seconds: percentile(times, 0.9),
    timeToMainMaxSeconds: Math.max(...times),
    wallSeconds: Math.max(...landed.values()),
    ciBilledMinutes: ciMinutes,
    recomposes: recomposes.reduce((a, b) => a + b, 0),
    recomposesMax: Math.max(...recomposes),
    checkRuns: checks,
  };
}
