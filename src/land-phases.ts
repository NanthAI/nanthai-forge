// SPDX-License-Identifier: Apache-2.0
export const landingPhaseNames = [
  'queued',
  'composing',
  'dispatching',
  'ci-running',
  'recording-accepting',
  'accepted',
  'main-audit',
  'github-mirror-push',
] as const;
export type LandingPhaseName = (typeof landingPhaseNames)[number];
export type PhaseTime = string | 'unknown';
export type LandingPhase = {
  phase: LandingPhaseName;
  state: 'pending' | 'running' | 'completed';
  startedAt: PhaseTime;
  endedAt: PhaseTime;
  durationMs: number | 'unknown';
};
export type Counts = { done: number; total: number };
export type PhaseRecords = {
  queuedAt?: string | undefined;
  selectedAt?: string | undefined;
  dispatchAt?: string | undefined;
  ciAt?: string | undefined;
  checkedAt?: string | undefined;
  acceptedAt?: string | undefined;
  current: LandingPhaseName;
  waitingOn?: string | undefined;
  queue?: { position: number | 'unknown'; total: number | 'unknown'; waitingOn: string };
  progress?: { jobs?: Counts; shards?: Counts; files?: Counts } | undefined;
  audit?: { startedAt?: string | undefined; endedAt?: string | undefined; waitingOn?: string };
  mirror?: {
    startedAt?: string | undefined;
    endedAt?: string | undefined;
    waitingOn?: string;
    completed?: boolean;
  };
  outcome?: string | undefined;
};
export type LandingPhases = ReturnType<typeof deriveLandingPhases>;
const timestamp = (value?: string) => (value && Number.isFinite(Date.parse(value)) ? value : 'unknown');
export function phaseDuration(start?: string, end?: string): number | 'unknown' {
  if (timestamp(start) === 'unknown' || timestamp(end) === 'unknown') return 'unknown';
  const elapsed = Date.parse(end!) - Date.parse(start!);
  return elapsed >= 0 ? elapsed : 'unknown';
}
export function deriveLandingPhases(records: PhaseRecords) {
  const bounds: [LandingPhaseName, string | undefined, string | undefined][] = [
    ['queued', records.queuedAt, records.selectedAt],
    ['composing', records.selectedAt, records.dispatchAt],
    ['dispatching', records.dispatchAt, records.ciAt],
    ['ci-running', records.ciAt, records.checkedAt],
    ['recording-accepting', records.checkedAt, records.acceptedAt],
    ['accepted', records.acceptedAt, records.acceptedAt],
    ...(records.audit
      ? [
          ['main-audit', records.audit.startedAt, records.audit.endedAt] as [
            LandingPhaseName,
            string | undefined,
            string | undefined,
          ],
        ]
      : []),
    ...(records.mirror
      ? [
          ['github-mirror-push', records.mirror.startedAt, records.mirror.endedAt] as [
            LandingPhaseName,
            string | undefined,
            string | undefined,
          ],
        ]
      : []),
  ];
  const current = landingPhaseNames.indexOf(records.current);
  const timeline: LandingPhase[] = bounds.map(([phase, start, end]) => ({
    phase,
    state:
      end || (phase === 'github-mirror-push' && records.mirror?.completed)
        ? 'completed'
        : landingPhaseNames.indexOf(phase) < current
          ? 'completed'
          : phase === records.current
            ? 'running'
            : 'pending',
    startedAt: timestamp(start),
    endedAt: timestamp(end),
    durationMs: phaseDuration(start, end),
  }));
  return {
    current: records.current,
    ...(records.outcome ? { outcome: records.outcome } : {}),
    ...(records.queue ? { queue: records.queue } : {}),
    ...(records.progress ? { progress: records.progress } : {}),
    ...(records.waitingOn ? { waitingOn: records.waitingOn } : {}),
    ...(records.current === 'main-audit' && records.audit?.waitingOn
      ? { waitingOn: records.audit.waitingOn }
      : {}),
    ...(records.current === 'github-mirror-push' && records.mirror?.waitingOn
      ? { waitingOn: records.mirror.waitingOn }
      : {}),
    timeline,
  };
}
const median = (values: number[]) => {
  values.sort((a, b) => a - b);
  const middle = Math.floor(values.length / 2);
  return values.length % 2 ? values[middle]! : (values[middle - 1]! + values[middle]!) / 2;
};
/** Recent completed owner landings only; absent boundaries never contribute zeroes. */
export function landingEta(phases: LandingPhases, history: LandingPhases[], now = Date.now(), limit = 20) {
  const samples = history.slice(-limit);
  if (!samples.length || (phases.outcome && phases.outcome !== 'accepted')) return;
  const remaining = phases.timeline.filter(item => item.state !== 'completed');
  if (!remaining.length) return;
  const phaseMedianMs: Partial<Record<LandingPhaseName, number>> = {};
  let remainingMs = 0;
  for (const phase of remaining) {
    if (phase.phase === 'accepted') continue;
    const durations = samples.flatMap(sample =>
      sample.timeline.flatMap(item =>
        item.phase === phase.phase && typeof item.durationMs === 'number' ? [item.durationMs] : [],
      ),
    );
    // A partial ETA would hide unknown remaining work.
    if (!durations.length) return;
    const duration = median(durations);
    phaseMedianMs[phase.phase] = duration;
    const elapsed =
      phase.state === 'running' && phase.startedAt !== 'unknown'
        ? Math.max(0, now - Date.parse(phase.startedAt))
        : 0;
    const shards = phases.progress?.shards;
    const jobs = phases.progress?.jobs;
    remainingMs +=
      phase.phase === 'ci-running' && phase.state === 'running' && shards && shards.total > 0
        ? duration *
          Math.max(
            (shards.total - shards.done) / shards.total,
            jobs && jobs.total > 0 ? (jobs.total - jobs.done) / jobs.total : 0,
          )
        : Math.max(0, duration - elapsed);
  }
  return {
    label: 'estimate' as const,
    remainingMs: Math.round(remainingMs),
    samples: samples.length,
    historyLimit: limit,
    phaseMedianMs,
  };
}
export function phaseSummary(phases: LandingPhases) {
  return phases.timeline
    .map(
      item =>
        `${item.phase}=${item.durationMs === 'unknown' ? 'unknown' : `${Math.round(item.durationMs / 1000)}s`}`,
    )
    .join(', ');
}
