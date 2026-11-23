// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Ferdinando Valsecchi
/** Step timing of one `land --save` submission, recorded in the submitting process: local clock
 * reads only, no I/O and no network. The first mark of a step wins, so replays inside the same
 * submitter keep the original times. A resumed submission (new process) times only its own part. */
export const LAND_INVOKED_ENV = 'FORGE_LAND_INVOKED_AT';
export const LAND_HELD_MS_ENV = 'FORGE_LAND_HELD_MS';
export const MAX_LANDING_HOLD_MS = 86_400_000;

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
/** The compose's server phases, from the reply or progress it already returned (no call). */
let composePhases: ComposePhases | null = null;
const phaseNames = ['startup', 'read', 'compute', 'write', 'convex'] as const;
type ComposePhases = Record<(typeof phaseNames)[number], number>;

/** Begin timing in the submitter; `invokedAt` is the epoch ms the user's command started. */
export function startLandTiming(invokedAt?: number) {
  const invoked = Number.isFinite(invokedAt) ? invokedAt! : performance.timeOrigin;
  marks = new Map([['invoked', invoked]]);
  composePhases = null;
  markLandStep('started', Math.max(performance.timeOrigin, invoked));
}

/** No-op unless a land submission is being timed in this process. */
export function markLandStep(step: LandStep, at = Date.now()) {
  if (marks && !marks.has(step)) marks.set(step, at);
}

/** Where the `compose` step went on the server (friction c5e80d46: a 419 s compose had no split). */
export type LandComposeTiming = {
  /** The compose's source phases summed over its steps (startup includes runtime start). */
  phasesMs: ComposePhases;
  slowest: (typeof phaseNames)[number];
  /** At least this much of the step ran outside the server's phases (upload, submit, dispatch,
   * queue): the step minus the phases' sum, which overlap, so a lower bound. */
  outsideMs: number;
};
export type LandTiming = {
  invokedAt: string;
  submittedAt: string | null;
  totalMs: number | null;
  heldMs?: number;
  stepsMs: Record<string, number>;
  compose?: LandComposeTiming;
};

/** Keep the compose's server phases from a value it returned or a progress it observed: the
 * source phase summary on its `state` (`sourceTiming`). Fields only; no-op unless timing a land.
 * The first compose's phases win, like its step marks, so a later attempt (a land that syncs and
 * lands again) never pairs its phases with the first compose's duration. */
export function noteLandCompose(value: unknown) {
  if (!marks || composePhases || !value || typeof value !== 'object') return;
  const timing = (value as { state?: { sourceTiming?: unknown } }).state?.sourceTiming as
    | Record<string, unknown>
    | undefined;
  if (!timing || typeof timing !== 'object') return;
  const phases = {} as ComposePhases;
  for (const name of phaseNames) {
    const ms = timing[`${name}Ms`];
    if (typeof ms !== 'number' || !Number.isFinite(ms) || ms < 0) return;
    phases[name] = Math.round(ms);
  }
  composePhases = phases;
}

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
  const compose = composeTiming(stepsMs.compose);
  return {
    invokedAt: new Date(invoked).toISOString(),
    submittedAt: submitted === undefined ? null : new Date(submitted).toISOString(),
    totalMs: submitted === undefined ? null : Math.round(submitted - invoked),
    stepsMs,
    ...(compose ? { compose } : {}),
  };
}
function composeTiming(stepMs: number | undefined): LandComposeTiming | undefined {
  if (!composePhases || stepMs === undefined) return undefined;
  const phases = composePhases;
  const slowest = phaseNames.reduce((a, b) => (phases[b] > phases[a] ? b : a));
  const sum = phaseNames.reduce((total, name) => total + phases[name], 0);
  return { phasesMs: { ...phases }, slowest, outsideMs: Math.max(0, stepMs - sum) };
}

/** Local save work up to the final submit; the server adds submit-to-publication on its clock. */
export function saveTimingMs(at = Date.now()): number | undefined {
  const start = marks?.get('saveStarted');
  return start === undefined ? undefined : Math.max(0, Math.round(at - start));
}

/** One stderr line once this process submitted: "land: submitted in 12.3 s (spawn 0.4, ...)". */
export function landTimingLine(timing: LandTiming | null | undefined) {
  if (!timing || timing.totalMs === null) return null;
  const s = (ms: number) => (ms / 1000).toFixed(1);
  const parts = Object.entries(timing.stepsMs).map(([label, ms]) => `${label} ${s(ms)}`);
  const compose = timing.compose
    ? `; compose on the server: ${phaseNames.map(name => `${name} ${s(timing.compose!.phasesMs[name])}`).join(', ')} (slowest ${timing.compose.slowest}), at least ${s(timing.compose.outsideMs)} outside it`
    : '';
  return `land: submitted in ${s(timing.totalMs)} s (${parts.join(', ')})${compose}`;
}
