// SPDX-License-Identifier: Apache-2.0
import { z } from 'zod';
import type { HostedLandingState } from './hosted-landing.js';

/** Regression ladder rung 1 (45f49fb7): each landing's own timing, compared with the
 * project's 7-day median. Thresholds are documented in docs/agents/regression-ladder.md;
 * change both together. */
export const LANDING_SPEED_BASELINE = {
  /** Baseline: median of the previous full 7 UTC days, today excluded. */
  windowDays: 7,
  /** Fewer baseline samples than this: no alert (a new or quiet project has no baseline). */
  minBaselineSamples: 10,
  /** Sustained: the median of the last 3 landings today is over the threshold, so one slow
   * landing never alerts. */
  sustainedLandings: 3,
  /** Threshold = max(median * ratio, median + floorMinutes). */
  ratio: 1.5,
  floorMinutes: { toMain: 5, check: 2 },
  /** Retained samples per project (about 6 KB). */
  maxSamples: 400,
} as const;
export type LandingSpeedMetric = 'toMain' | 'check';
const METRICS: LandingSpeedMetric[] = ['toMain', 'check'];
const LABEL: Record<LandingSpeedMetric, string> = {
  toMain: 'time to main (submit to commit)',
  check: 'check minutes (check reserved to check ended)',
};
/** What the owner does next, named in every alert. */
const NEXT: Record<LandingSpeedMetric, string> = {
  toMain:
    'Next: run `nforge metrics ROOT --text` for waste by cause and main-race re-checks; ' +
    'if queue or compose gaps grew, run the landing-loop dry micro-bench (regression ladder rung 2) on the latest landing-loop change.',
  check:
    'Next: run `nforge metrics ROOT --text` for check minutes and flaky files; ' +
    'compare the slowest test files with the previous week and the latest change to the verify script or check runner.',
};

const minute = 60_000,
  day = 86_400_000;
const sampleSchema = z.tuple([z.number().int(), z.number().nullable(), z.number().nullable()]);
export const landingSpeedStateSchema = z
  .object({
    schema: z.literal(1),
    /** [settledAt ms, time-to-main minutes, check minutes], oldest first. */
    samples: z.array(sampleSchema),
    /** UTC day of the last alert per metric: at most one alert per metric per day. */
    alerted: z.object({ toMain: z.string().optional(), check: z.string().optional() }).strict(),
  })
  .strict();
export type LandingSpeedState = z.infer<typeof landingSpeedStateSchema>;
export type LandingSpeedSample = { at: number; toMain: number | null; check: number | null };
export type LandingSpeedAlert = {
  metric: LandingSpeedMetric;
  baselineMinutes: number;
  baselineLandings: number;
  currentMinutes: number;
  thresholdMinutes: number;
};

const span = (from?: string, to?: string) => {
  if (!from || !to) return null;
  const value = (Date.parse(to) - Date.parse(from)) / minute;
  return Number.isFinite(value) && value >= 0 ? Math.round(value * 10) / 10 : null;
};
/** Data already on the landed state: no extra read. Missing stamps leave that metric unknown. */
export function landingSpeedSample(state: HostedLandingState): LandingSpeedSample | null {
  const timing = state.timing;
  const at = Date.parse(timing?.committedAt ?? timing?.settledAt ?? '');
  if (!timing || !Number.isFinite(at)) return null;
  return {
    at,
    toMain: span(timing.submittedAt, timing.committedAt),
    check: span(timing.checkReservedAt, timing.ciEndedAt),
  };
}

export function median(values: number[]) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b),
    middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle]! : (sorted[middle - 1]! + sorted[middle]!) / 2;
}
const round = (value: number) => Math.round(value * 10) / 10;

/** Pure: append one landing, trim to the window, and return any alert it raises. */
export function observeLandingSpeed(
  previous: LandingSpeedState | null,
  sample: LandingSpeedSample,
  now = sample.at,
): { state: LandingSpeedState; alerts: LandingSpeedAlert[] } {
  const config = LANDING_SPEED_BASELINE;
  const today = now - (now % day),
    dayName = new Date(today).toISOString().slice(0, 10),
    from = today - config.windowDays * day;
  const samples = [...(previous?.samples ?? []), [sample.at, sample.toMain, sample.check] as const]
    .filter(([at]) => at >= from)
    .sort((a, b) => a[0] - b[0])
    .slice(-config.maxSamples)
    .map(([at, toMain, check]) => [at, toMain, check] as [number, number | null, number | null]);
  const alerted = { ...previous?.alerted };
  const alerts: LandingSpeedAlert[] = [];
  for (const [index, metric] of METRICS.entries()) {
    if (alerted[metric] === dayName) continue;
    const known = samples.flatMap(row =>
      row[index + 1] === null ? [] : [[row[0], row[index + 1]!] as const],
    );
    const baselineValues = known.filter(([at]) => at < today).map(([, value]) => value);
    const recent = known.slice(-config.sustainedLandings);
    if (baselineValues.length < config.minBaselineSamples) continue;
    if (recent.length < config.sustainedLandings || recent.some(([at]) => at < today)) continue;
    const latest = recent.map(([, value]) => value);
    const baseline = median(baselineValues)!,
      current = median(latest)!;
    const threshold = round(Math.max(baseline * config.ratio, baseline + config.floorMinutes[metric]));
    if (current <= threshold) continue;
    alerted[metric] = dayName;
    alerts.push({
      metric,
      baselineMinutes: round(baseline),
      baselineLandings: baselineValues.length,
      currentMinutes: round(current),
      thresholdMinutes: threshold,
    });
  }
  return { state: { schema: 1, samples, alerted }, alerts };
}

/** The owner-facing message: what regressed, against which baseline, and the next step. */
export function landingSpeedAlertMessage(alert: LandingSpeedAlert, project: string) {
  const config = LANDING_SPEED_BASELINE;
  return {
    subject: `[Forge] Landing ${alert.metric === 'toMain' ? 'time to main' : 'check minutes'} regressed: ${project}`,
    text: [
      `Landing speed regressed on ${project}: ${LABEL[alert.metric]} median of the last ${config.sustainedLandings} landings today is ${alert.currentMinutes} min.`,
      `Baseline: 7-day median ${alert.baselineMinutes} min over ${alert.baselineLandings} landings; alert threshold ${alert.thresholdMinutes} min (x${config.ratio} or +${config.floorMinutes[alert.metric]} min, whichever is larger).`,
      NEXT[alert.metric],
      'This alert repeats at most once a day per metric.',
    ].join('\n'),
  };
}
