// SPDX-License-Identifier: Apache-2.0
// Rung 2 is a protocol regression signal, never a scored model benchmark.
export const MICRO = Object.freeze({
  workers: 3,
  tasks: [
    { id: 't19456', overlap: 'overlap:preview' },
    { id: 't22302', overlap: 'overlap:preview' },
    { id: 't27456', overlap: 'overlap:preview' },
    { id: 't23938', overlap: 'overlap:codex-client-tests' },
    { id: 't23766', overlap: 'overlap:codex-client-tests' },
  ],
  intervalMs: 6 * 60 * 60_000,
  dailyRuns: 4,
  factor: 1.5,
  convexBudgetUsd: 0.06,
});

/** Include failed/interrupted starts: failures consume the same approved run budget. */
export function microAdmission(starts, now = Date.now()) {
  const times = starts.map(Date.parse);
  if (times.some(t => !Number.isFinite(t) || t > now)) throw Error('Invalid admission history');
  const recent = times.filter(t => now - t < 24 * 60 * 60_000);
  const last = Math.max(-Infinity, ...times);
  const nextAt = Math.max(
    last + MICRO.intervalMs,
    recent.length >= MICRO.dailyRuns
      ? recent.sort((a, b) => b - a)[MICRO.dailyRuns - 1] + 24 * 60 * 60_000
      : 0,
  );
  return { admitted: now >= nextAt, nextAt: Number.isFinite(nextAt) ? new Date(nextAt).toISOString() : null };
}

const number = value => typeof value === 'number' && Number.isFinite(value) && value >= 0;
export function microProblems(result) {
  const problems = [];
  const tasks = Array.isArray(result.tasks) ? result.tasks : [];
  if (!number(result.wallSeconds)) problems.push('wall time missing');
  if (!result.convex?.valid || !number(result.convex?.costUsd)) problems.push('Convex coverage incomplete');
  if (
    !number(result.ci?.billedMinutes) ||
    !number(result.ci?.runs) ||
    result.ci?.unfinishedRuns !== 0 ||
    !(result.ci?.runs > 0)
  )
    problems.push('CI coverage incomplete');
  if (!result.pinsStable) problems.push('runtime pins changed or unreadable');
  if (tasks.length !== MICRO.tasks.length) problems.push('five tasks required');
  if (!result.scenario?.fixtureCommit || !result.scenario?.checkDefinition || !result.scenario?.runner)
    problems.push('workload identity missing');
  for (const { id } of MICRO.tasks) {
    const matches = tasks.filter(t => t.id === id);
    const task = matches[0];
    if (matches.length !== 1 || !task?.receiptId || !number(task.timeToMainSeconds))
      problems.push(`${id}: acceptance or measurement missing`);
  }
  return problems;
}

/** Missing measurements are unknown, never zero. A failed run cannot replace the baseline. */
export function compareMicro(result, baseline) {
  const problems = microProblems(result);
  const regressions = [];
  const compare = (metric, actual, previous) => {
    if (actual > previous * MICRO.factor) regressions.push({ metric, actual, baseline: previous });
  };
  if (baseline?.status !== 'unmeasured') {
    if (!baseline || microProblems(baseline).length) problems.push('stored baseline invalid');
    else {
      for (const key of ['fixtureCommit', 'checkDefinition', 'runner'])
        if (result.scenario?.[key] !== baseline.scenario[key]) problems.push(`workload changed: ${key}`);
      compare('wallSeconds', result.wallSeconds, baseline.wallSeconds);
      compare('convexUsd', result.convex?.costUsd, baseline.convex.costUsd);
      compare('checkRuns', result.ci?.runs, baseline.ci.runs);
      for (const task of Array.isArray(result.tasks) ? result.tasks : []) {
        const before = baseline.tasks.find(t => t.id === task.id);
        if (!before) continue;
        compare(`${task.id}.timeToMainSeconds`, task.timeToMainSeconds, before.timeToMainSeconds);
      }
    }
  }
  if (number(result.convex?.costUsd) && result.convex.costUsd > MICRO.convexBudgetUsd)
    problems.push('Convex run exceeds approved $0.06 budget');
  return {
    passed: problems.length === 0 && regressions.length === 0,
    problems,
    regressions,
    establishingBaseline: baseline?.status === 'unmeasured',
    nextStep:
      'Inspect the retained run and the latest landing-loop diff; fix the regressed metric in the same slice, then repeat rung 2 before relying on automatic CI or single-manifest changes.',
  };
}

/** Public summaries contain the benchmark project's usage, not shared deployment diagnostics. */
export function publicMicroResult(result) {
  const { reset: _reset, ...summary } = result;
  const { deploymentWide: _deploymentWide, ...convex } = result.convex ?? {};
  return { ...summary, convex };
}

/** Bounded workers join every started task, including after a sibling fails. */
export async function microWorkers(tasks, work) {
  let index = 0;
  const results = [];
  await Promise.all(
    Array.from({ length: MICRO.workers }, async () => {
      for (;;) {
        const task = tasks[index++];
        if (!task) return;
        try {
          results.push(await work(task));
        } catch {
          results.push({ id: task.id, error: 'Scripted task failed; inspect private task evidence' });
        }
      }
    }),
  );
  return results.sort((a, b) => a.id.localeCompare(b.id));
}

/** Each hot-file cluster starts together, after every workspace in it is ready. */
export async function microWaves(prepare, land) {
  const results = [];
  for (const tasks of [MICRO.tasks.slice(0, 3), MICRO.tasks.slice(3)]) {
    const prepared = await Promise.allSettled(tasks.map(prepare));
    if (prepared.some(entry => entry.status === 'rejected')) {
      results.push(
        ...tasks.map(task => ({ id: task.id, error: 'Cluster preparation failed; Lanes retained' })),
      );
      break;
    }
    const completed = await microWorkers(
      prepared.map(entry => entry.value),
      land,
    );
    results.push(...completed);
    if (completed.some(entry => entry.error)) break;
  }
  return results.sort((a, b) => a.id.localeCompare(b.id));
}
