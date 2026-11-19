// SPDX-License-Identifier: Apache-2.0
import { checkPin } from '../src/hosted-check';
import type { HostedLandingState } from '../src/hosted-landing';
import type { StatsDay, StatsLanding } from '../src/stats-estimate';

/** One complete provider page. Missing/unfinished intervals remain unknown; skipped
 * or never-started cancelled jobs consumed no runner. All jobs bind the same run. */
export function cancelledJobUsage(body: unknown, executionId: string) {
  const page = body as {
    total_count?: number;
    jobs?: {
      id?: number;
      run_id?: number;
      run_attempt?: number;
      status?: string;
      conclusion?: string | null;
      started_at?: string | null;
      completed_at?: string | null;
    }[];
  } | null;
  if (!page || !Array.isArray(page.jobs) || page.total_count !== page.jobs.length) return null;
  const seen = new Set<number>();
  let seconds = 0;
  const intervals: [number, number][] = [];
  for (const job of page.jobs) {
    if (
      !Number.isSafeInteger(job.id) ||
      seen.has(job.id!) ||
      String(job.run_id) !== executionId ||
      job.run_attempt !== 1 ||
      job.status !== 'completed'
    )
      return null;
    seen.add(job.id!);
    let duration = 0;
    if (job.conclusion !== 'skipped' && job.started_at) {
      const start = Date.parse(job.started_at),
        end = Date.parse(job.completed_at ?? '');
      if (!Number.isFinite(start) || !Number.isFinite(end) || end < start) return null;
      duration = (end - start) / 1000;
    } else if (job.conclusion !== 'skipped' && job.conclusion !== 'cancelled') return null;
    seconds += duration;
    intervals.push([job.id!, duration]);
  }
  intervals.sort((a, b) => a[0] - b[0]);
  const summary = { executionId, intervals };
  return { seconds, receipt: { sha256: checkPin(summary), size: JSON.stringify(summary).length } };
}

/** A presentation/budget overlay, never written into queue state. Known lower
 * bounds remain on the canonical row while cancelled provider usage is pending. */
export function pendingRunnerState<T extends HostedLandingState | null>(state: T, pending = 0): T {
  if (!state || pending <= 0) return state;
  const { discardedRunnerSeconds: _lowerBound, ...counts } = state.counts ?? {};
  void _lowerBound;
  return {
    ...state,
    counts: { ...counts, discardedRunnerUnknown: 'superseded-check-execution-unreported' },
  } as T;
}

const priced = (l: StatsLanding) => l.runnerSeconds !== null && l.discardedRunnerSeconds !== null;
const contribution = (l: StatsLanding, field: 'runnerSeconds' | 'discardedRunnerSeconds') =>
  priced(l) ? l[field]! : 0;
/** Additive correction only: retain the day's original queue replay, ordering,
 * medians and elapsed-time distributions, so an unknown -> known price never
 * needs a day rebuild. */
export function adjustClosedRunnerDay(
  day: StatsDay,
  before: StatsLanding,
  after: StatsLanding,
  reruns = 0,
): StatsDay {
  const deltaPriced = Number(priced(after)) - Number(priced(before));
  const deltaCounted = Number(after.attempts !== null) - Number(before.attempts !== null);
  const deltaFirst = Number(after.attempts === 1) - Number(before.attempts === 1);
  const runner = {
    ...day.runner,
    priced: day.runner.priced + deltaPriced,
    unknown: day.runner.unknown - deltaPriced,
    acceptedSeconds:
      day.runner.acceptedSeconds +
      contribution(after, 'runnerSeconds') -
      contribution(before, 'runnerSeconds'),
    discardedSeconds:
      day.runner.discardedSeconds +
      contribution(after, 'discardedRunnerSeconds') -
      contribution(before, 'discardedRunnerSeconds'),
  };
  const firstTry = {
    counted: day.firstTry.counted + deltaCounted,
    first: day.firstTry.first + deltaFirst,
  };
  const who = day.who.map(([name, n, first, counted]) =>
    name === (after.who ?? '')
      ? ([name, n, first + deltaFirst, counted + deltaCounted] as [string, number, number, number])
      : ([name, n, first, counted] as [string, number, number, number]),
  );
  // The GitHub side is priced per window from run counts (src/stats-estimate.ts#statsWindow), and Forge's side from
  // every run's own row, so a late price changes only the landed-path tallies here; the replay stays as closed.
  void reruns;
  return { ...day, runner, firstTry, who };
}
