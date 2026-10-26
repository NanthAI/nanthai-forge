// SPDX-License-Identifier: Apache-2.0
// Pure experiment configuration and measurements; no network or subprocesses.
export const PAIRS = {
  P1: { forgeRunner: 'github-actions', forgeRunsOn: 'ubuntu-latest', ghRunsOn: 'ubuntu-latest', ghShards: 1 },
  P2: {
    forgeRunner: 'github-actions',
    forgeRunsOn: 'blacksmith-2vcpu-ubuntu-2404',
    ghRunsOn: 'blacksmith-2vcpu-ubuntu-2404',
    ghShards: 1,
  },
  P3: { forgeRunner: 'modal', ghRunsOn: 'blacksmith-2vcpu-ubuntu-2404', ghShards: 16 },
  P4: { sides: ['github'], ghRunsOn: 'ubuntu-latest', ghShards: 1 },
};
export function runnerPolicy(options, repo) {
  return {
    checks: {
      runner: options.forgeRunner,
      ...(options.forgeRunner === 'github-actions'
        ? { repo, runsOn: options.forgeRunsOn, shards: options.ghShards }
        : {}),
    },
  };
}
export function burstMetrics(changes, readyAt) {
  const landed = changes.filter(c => c.status === 'ok');
  const allLandedMs =
    landed.length === changes.length ? Math.max(...landed.map(c => c.landedAt)) - readyAt : null;
  const sum = field =>
    changes.every(c => Number.isFinite(c[field])) ? changes.reduce((n, c) => n + c[field], 0) : null;
  return {
    allLandedMs,
    landingsPerHour: allLandedMs > 0 ? (changes.length * 3600000) / allLandedMs : null,
    checksRun: sum('checksRun'),
    redMain: sum('redMain'),
    retries: sum('retries'),
  };
}
export function actionsCost(timing, jobs, label) {
  const billable = timing?.billable;
  const actionsBillableMinutes = billable
    ? Object.values(billable).reduce((n, v) => n + (v.total_ms ?? 0), 0) / 60000
    : null;
  return {
    actionsBillableMinutes,
    blacksmithMinutes:
      /blacksmith/i.test(label) && Array.isArray(jobs)
        ? jobs.reduce((n, j) => {
            const ms = Date.parse(j.completed_at) - Date.parse(j.started_at);
            return n + (Number.isFinite(ms) && ms > 0 ? Math.ceil(ms / 60000) : 0);
          }, 0)
        : null,
  };
}
