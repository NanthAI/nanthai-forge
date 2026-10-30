// SPDX-License-Identifier: Apache-2.0
import { minutesBetween, type MetricPeriod, type MetricRecords } from './self-metrics-types.js';
const causes = ['main-race', 'flake', 'conflict', 'cancel', 'supersede', 'stall', 'check-failed'] as const;
/** Elapsed lost time is submission/attempt time; runner time is execution time.
 * CHECK_FAILED alone never establishes a flake. Shared runs count once. */
export function calculateWaste(records: MetricRecords, period: MetricPeriod) {
  const inside = (at: string) =>
    Date.parse(at) >= Date.parse(period.from) && Date.parse(at) < Date.parse(period.to);
  const runIndex = new Map(records.runs.map(run => [run.id, run]));
  const submissions = new Map(records.submissions.map(row => [row.entryId, row]));
  const retries = new Map(
    records.submissions.filter(row => row.supersedes).map(row => [row.supersedes!, row]),
  );
  const attemptRuns = new Map(records.submissions.map(row => [row.attemptId, row.runIds]));
  const acceptedRuns = new Set(
    records.moves.flatMap(move => (move.attemptId ? (attemptRuns.get(move.attemptId) ?? []) : [])),
  );
  const seen = new Set<string>();
  const rows = [...records.submissions]
    .sort((a, b) => Number(!!b.mainRace) - Number(!!a.mainRace))
    .flatMap(row => {
      if (
        !inside(row.at) &&
        !inside(row.endedAt ?? '') &&
        !row.runIds.some(id => inside(runIndex.get(id)?.at ?? ''))
      )
        return [];
      const request = submissions.get(row.entryId) ?? row;
      const code = request.errorCode;
      const retry = retries.get(row.entryId);
      const lastProgress = [row.at, ...row.progressAt].sort().at(-1)!;
      const stalled =
        ['queued', 'checking', 'composing', 'ready'].includes(row.status) &&
        Date.parse(period.asOf ?? period.to) - Date.parse(lastProgress) >= 60 * 60000;
      const cause = row.mainRace
        ? 'main-race'
        : retry?.retryReason === 'flake'
          ? 'flake'
          : code === 'COMPOSITION_CONFLICT'
            ? 'conflict'
            : ['LANDING_CANCELLED', 'CANCELLED'].includes(code ?? '')
              ? 'cancel'
              : code === 'LANDING_SUPERSEDED'
                ? 'supersede'
                : row.retryCause === 'stall' || stalled
                  ? 'stall'
                  : code === 'CHECK_FAILED'
                    ? 'check-failed'
                    : null;
      if (!cause) return [];
      let runnerMinutes = 0,
        discardedPassedRunnerMinutes = 0,
        unknownRunnerRuns = 0;
      for (const id of row.runIds) {
        if (seen.has(id) || acceptedRuns.has(id)) continue;
        seen.add(id);
        const run = runIndex.get(id);
        if (!run || !inside(run.at)) continue;
        if (run.runnerMinutes === undefined) {
          unknownRunnerRuns++;
          continue;
        }
        runnerMinutes += run.runnerMinutes;
        if (run.status === 'passed') discardedPassedRunnerMinutes += run.runnerMinutes;
      }
      return [
        {
          id: row.id,
          entryId: row.entryId,
          cause,
          elapsedMinutes:
            minutesBetween(
              Date.parse(row.at) < Date.parse(period.from) ? period.from : row.at,
              row.endedAt
                ? Date.parse(row.endedAt) > Date.parse(period.to)
                  ? period.to
                  : row.endedAt
                : stalled
                  ? (period.asOf ?? period.to)
                  : undefined,
            ) ?? null,
          runnerMinutes,
          discardedPassedRunnerMinutes,
          unknownRunnerRuns,
        },
      ];
    });
  const recheckRuns = new Set(records.submissions.filter(row => row.recheck).flatMap(row => row.runIds));
  const rechecks = records.runs.filter(run => recheckRuns.has(run.id) && inside(run.at));
  const gaps = [
    ...(records.source?.kind === 'hosted' || records.source?.kind === 'joined'
      ? [
          'Waste uses retained attempt transitions and explicit outcome/retry codes within bounded context; unrecorded causes and missing execution/end times remain unknown.',
        ]
      : []),
  ];
  return {
    partial: !!gaps.length || rows.some(row => row.elapsedMinutes === null || row.unknownRunnerRuns > 0),
    gaps,
    mainRaceRecheckRuns: rechecks.length,
    mainRaceRecheckRunnerMinutes: rechecks.reduce((sum, run) => sum + (run.runnerMinutes ?? 0), 0),
    mainRaceScopedRecheckRuns: rechecks.filter(run => run.scopedRecheck).length,
    mainRaceScopedRecheckRunnerMinutes: rechecks
      .filter(run => run.scopedRecheck)
      .reduce((sum, run) => sum + (run.runnerMinutes ?? 0), 0),
    unknownRecheckRunnerRuns: rechecks.filter(run => run.runnerMinutes === undefined).length,
    byCause: causes.map(cause => {
      const selected = rows.filter(row => row.cause === cause);
      return {
        cause,
        attempts: selected.length,
        elapsedMinutes: selected.reduce((sum, row) => sum + (row.elapsedMinutes ?? 0), 0),
        unknownElapsedAttempts: selected.filter(row => row.elapsedMinutes === null).length,
        runnerMinutes: selected.reduce((sum, row) => sum + row.runnerMinutes, 0),
        discardedPassedRunnerMinutes: selected.reduce(
          (sum, row) => sum + row.discardedPassedRunnerMinutes,
          0,
        ),
        unknownRunnerRuns: selected.reduce((sum, row) => sum + row.unknownRunnerRuns, 0),
      };
    }),
    rows,
  };
}
