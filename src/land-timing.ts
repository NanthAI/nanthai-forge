// SPDX-License-Identifier: Apache-2.0
/** Step timing of one `land --save` submission, recorded in the submitting process: local clock
 * reads only, no I/O and no network. The first mark of a step wins, so replays inside the same
 * submitter keep the original times. A resumed submission (new process) times only its own part. */
export const LAND_INVOKED_ENV = 'FORGE_LAND_INVOKED_AT';

/** In order. Each duration is "from the previous recorded step to this one". */
const steps = [
  ['invoked', ''],
  ['started', 'spawn'],
  ['ready', 'connect'],
  ['saveStarted', 'select'],
  ['captured', 'capture'],
  ['uploaded', 'upload'],
  ['saveSubmitted', 'saveSubmit'],
  ['saved', 'saveJob'],
  ['gated', 'gates'],
  ['composed', 'compose'],
  ['submitted', 'submit'],
] as const;
export type LandStep = (typeof steps)[number][0];

let marks: Map<LandStep, number> | null = null;

/** Begin timing in the submitter; `invokedAt` is the epoch ms the user's command started. */
export function startLandTiming(invokedAt?: number) {
  marks = new Map([['invoked', Number.isFinite(invokedAt) ? invokedAt! : performance.timeOrigin]]);
  markLandStep('started', performance.timeOrigin);
}

/** No-op unless a land submission is being timed in this process. */
export function markLandStep(step: LandStep, at = Date.now()) {
  if (marks && !marks.has(step)) marks.set(step, at);
}

export type LandTiming = {
  invokedAt: string;
  submittedAt: string | null;
  totalMs: number | null;
  stepsMs: Record<string, number>;
};

export function landTiming(): LandTiming | null {
  if (!marks) return null;
  const invoked = marks.get('invoked')!,
    stepsMs: Record<string, number> = {};
  let previous = invoked;
  for (const [step, label] of steps.slice(1)) {
    const at = marks.get(step);
    if (at === undefined) continue;
    stepsMs[label] = Math.max(0, Math.round(at - previous));
    previous = at;
  }
  const submitted = marks.get('submitted');
  return {
    invokedAt: new Date(invoked).toISOString(),
    submittedAt: submitted === undefined ? null : new Date(submitted).toISOString(),
    totalMs: submitted === undefined ? null : Math.round(submitted - invoked),
    stepsMs,
  };
}

/** Local save work up to the final submit; the server adds submit-to-publication on its clock. */
export function saveTimingMs(at = Date.now()): number | undefined {
  const start = marks?.get('saveStarted');
  return start === undefined ? undefined : Math.max(0, Math.round(at - start));
}

/** One stderr line once this process submitted: "land: submitted in 12.3 s (spawn 0.4, ...)". */
export function landTimingLine(timing: LandTiming | null | undefined) {
  if (!timing || timing.totalMs === null) return null;
  const parts = Object.entries(timing.stepsMs).map(([label, ms]) => `${label} ${(ms / 1000).toFixed(1)}`);
  return `land: submitted in ${(timing.totalMs / 1000).toFixed(1)} s (${parts.join(', ')})`;
}
