// SPDX-License-Identifier: Apache-2.0
// Descriptive statistics only: extrema are observed bounds, not confidence intervals.
export function quantile(values, p) {
  const xs = values.filter(Number.isFinite).sort((a, b) => a - b);
  if (!xs.length) return null;
  const i = (xs.length - 1) * p;
  const lo = Math.floor(i);
  return xs[lo] + (xs[Math.ceil(i)] - xs[lo]) * (i - lo);
}

export function describe(values) {
  const xs = values.filter(Number.isFinite);
  return {
    n: xs.length,
    min: xs.length ? Math.min(...xs) : null,
    max: xs.length ? Math.max(...xs) : null,
    mean: xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null,
    median: quantile(xs, 0.5),
  };
}

export const metrics = {
  wallSeconds: ['Wall to all landed', 's'],
  timeToMainMedianSeconds: ['Time to main: cell median', 's'],
  timeToMainMaxSeconds: ['Time to main: cell max', 's'],
  observedTimeToMainMedianSeconds: ['Observed time to main: all landed median (includes task flags)', 's'],
  observedTimeToMainMaxSeconds: ['Observed time to main: all landed max (includes task flags)', 's'],
  prepSeconds: ['Prep: sum of task prep', 's'],
  prepMedianSeconds: ['Prep: task median', 's'],
  ciBilledMinutes: ['Billed CI', 'min'],
  ciJobs: ['CI jobs', 'jobs'],
  cachedInputTokens: ['Cached input', 'tokens'],
  uncachedInputTokens: ['Uncached input', 'tokens'],
  cacheWriteTokens: ['Cache creation input', 'tokens'],
  outputTokens: ['Output (includes reasoning)', 'tokens'],
  reasoningOutputTokens: ['Reasoning output (subset)', 'tokens'],
  turns: ['Agent turns', 'turns'],
  reworkTurns: ['Causal recovery turns', 'turns'],
  reworkCachedInputTokens: ['Recovery cached input', 'tokens'],
  reworkUncachedInputTokens: ['Recovery uncached input', 'tokens'],
  reworkCacheWriteTokens: ['Recovery cache creation', 'tokens'],
  reworkOutputTokens: ['Recovery output', 'tokens'],
  reworkTokens: ['Recovery tokens: all input + output', 'tokens'],
  landed: ['Landed', 'tasks', 'higher'],
  strict: ['Strict oracle passes', 'tasks', 'higher'],
  lenient: ['Lenient oracle score', 'fraction', 'higher'],
  convexUsd: ['Covered Convex cost', 'USD'],
  finishToMainP50Seconds: ['Forge submit-to-main p50', 's'],
  finishToMainP90Seconds: ['Forge submit-to-main p90', 's'],
  finishToMainMeanSeconds: ['Forge submit-to-main mean', 's'],
  mainRaceRecheckRuns: ['Forge main-race rechecks', 'runs'],
  mainRaceRecheckRunnerMinutes: ['Forge main-race recheck runner', 'min'],
  conflictElapsedMinutes: ['Forge conflict-attributed attempt time', 'min'],
  reuseAcceptances: ['Forge reuse acceptances', 'tasks', 'higher'],
  mainCheckFailures: ['Forge main check failures', 'checks'],
};

// Positive means favorable to the treatment. A zero reference has an absolute delta but
// no percentage; neither 0/0 nor a reduction from a zero reference is silently called 0%.
function gain(reference, treatment, higher) {
  if (!Number.isFinite(reference) || !Number.isFinite(treatment))
    return { reference: reference ?? null, treatment: treatment ?? null, improvement: null, percent: null };
  const improvement = higher ? treatment - reference : reference - treatment;
  return { reference, treatment, improvement, percent: reference ? (100 * improvement) / reference : null };
}

export function gains(reference, treatment, metric) {
  const higher = metrics[metric][2] === 'higher';
  return {
    median: gain(reference?.median, treatment?.median, higher),
    mean: gain(reference?.mean, treatment?.mean, higher),
    floor: gain(reference?.[higher ? 'max' : 'min'], treatment?.[higher ? 'min' : 'max'], higher),
    ceiling: gain(reference?.[higher ? 'min' : 'max'], treatment?.[higher ? 'max' : 'min'], higher),
  };
}

export function aggregate(cells) {
  const groups = new Map();
  for (const cell of cells) {
    const key = `${cell.kind} N=${cell.N} ${cell.arm}`;
    const list = groups.get(key) ?? [];
    list.push(cell);
    groups.set(key, list);
  }
  return [...groups]
    .sort(([a], [b]) => a.localeCompare(b, 'en', { numeric: true }))
    .map(([key, list]) => {
      const times = list.flatMap(c => c.taskTimes.map(t => t.seconds));
      const observedTimes = list.flatMap(c => (c.observedTaskTimes ?? []).map(t => t.seconds));
      const scopes = Object.fromEntries(
        ['perCell', 'perLanding'].map(scope => [
          scope,
          Object.fromEntries(Object.keys(metrics).map(m => [m, describe(list.map(c => c[scope][m]))])),
        ]),
      );
      return {
        key,
        kind: list[0].kind,
        N: list[0].N,
        arm: list[0].arm,
        cells: list.length,
        cellIds: list.map(c => c.cellId),
        reps: list.map(c => c.rep),
        ...scopes,
        pooledTimeToMain: {
          n: times.length,
          p50: quantile(times, 0.5),
          p90: quantile(times, 0.9),
          max: describe(times).max,
        },
        observedPooledTimeToMain: {
          n: observedTimes.length,
          p50: quantile(observedTimes, 0.5),
          p90: quantile(observedTimes, 0.9),
          max: describe(observedTimes).max,
        },
      };
    });
}

export function compareGroups(groups, referenceGroups = groups, sameSeries = true) {
  const out = [];
  for (const group of groups) {
    if (sameSeries && !group.arm.startsWith('forge')) continue;
    const reference = referenceGroups.find(
      g => g.kind === group.kind && g.N === group.N && g.arm === (sameSeries ? 'github' : group.arm),
    );
    if (!reference) continue;
    out.push({
      kind: group.kind,
      N: group.N,
      arm: group.arm,
      referenceArm: reference.arm,
      ...Object.fromEntries(
        ['pooledTimeToMain', 'observedPooledTimeToMain'].map(key => [
          `${key}Gains`,
          Object.fromEntries(
            ['p50', 'p90', 'max'].map(q => [q, gain(reference[key][q], group[key][q], false)]),
          ),
        ]),
      ),
      ...Object.fromEntries(
        ['perCell', 'perLanding'].map(scope => [
          scope,
          Object.fromEntries(
            Object.keys(metrics).map(m => [m, gains(reference[scope][m], group[scope][m], m)]),
          ),
        ]),
      ),
    });
  }
  return out;
}
