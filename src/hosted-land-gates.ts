// SPDX-License-Identifier: Apache-2.0
// Pure: also runs in the Convex non-Node runtime.
import { z } from 'zod';
import { ForgeError } from './errors.js';

/** Server half of `preflight: require` (Issue 029138ef). The CLI judges preflight before compose
 * (src/agent-default-gates.ts); the server refuses a new agent landing that does not carry that
 * result for every Lane head it lands, so an older or hand-written client cannot skip it by
 * omission. Preflight runs on the agent's machine and is never uploaded, so the server requires the
 * reported result for the landed head; it cannot prove the tests ran. */

const hash = z.string().regex(/^[0-9a-f]{64}$/);
export const PREFLIGHT_RESULTS = [
  'passed',
  'environment',
  'incomplete',
  'advised',
  'unavailable',
  /** Nothing selected to run for this head. */
  'none',
  /** The Lane was landed from a folder that is not its checkout: nothing local to test. */
  'no-checkout',
] as const;
export type PreflightResult = (typeof PREFLIGHT_RESULTS)[number];
/** The finish gate's preflight advisory as the one word the server records ('none': nothing ran
 * or nothing was selected). */
export const preflightResult = (advisory: unknown): PreflightResult => {
  const status = (advisory as { status?: unknown } | undefined)?.status;
  return PREFLIGHT_RESULTS.includes(status as PreflightResult) ? (status as PreflightResult) : 'none';
};
export const landGateEntrySchema = z
  .object({
    laneId: z.uuid(),
    head: hash,
    preflight: z.enum(PREFLIGHT_RESULTS),
    saveMs: z.number().int().nonnegative().optional(),
    preflightMs: z.number().int().nonnegative().optional(),
  })
  .strict();
/** Landings of more Lanes than this are judged on their first 20 (an Intent rarely has more). */
export const GATED_LANES = 20;
export const landGatesSchema = z.object({ lanes: z.array(landGateEntrySchema).max(GATED_LANES) }).strict();
export type LandGates = z.infer<typeof landGatesSchema>;
export type LandGateEntry = z.infer<typeof landGateEntrySchema>;

export const parseLandGates = (text: string | undefined): LandGates | null => {
  if (text === undefined) return null;
  try {
    return landGatesSchema.parse(JSON.parse(text));
  } catch {
    throw new ForgeError('BAD_ARGUMENT', 'gates: send the land gate result the CLI computed.');
  }
};

/** Timing on the existing gate argument, independent of whether preflight is required. A multi-Lane
 * landing records the longest known save/preflight; absent stamps stay unknown. No I/O. */
export function landGateTiming(text: string | undefined) {
  let gates: LandGates | null;
  try {
    gates = parseLandGates(text);
  } catch {
    // Only enforceLandGates judges policy. Optional metrics never add a refusal.
    return {};
  }
  const lanes = gates?.lanes ?? [];
  const timing: { saveMs?: number; preflightMs?: number } = {};
  for (const key of ['saveMs', 'preflightMs'] as const) {
    const values = lanes.flatMap(lane => (lane[key] === undefined ? [] : [lane[key]!]));
    if (values.length) timing[key] = Math.max(...values);
  }
  return Object.keys(timing).length
    ? { ms: [timing.saveMs ?? null, timing.preflightMs ?? null] as [number | null, number | null] }
    : {};
}

/** The refusal finishGates would give, for the Lanes and heads the landing composed (none: the
 * landing named no composition of the caller's). Same code and next step as the CLI. */
export function landGateRefusal(input: {
  preflight: 'off' | 'advise' | 'require';
  lanes: { laneId: string; head: string }[];
  gates: LandGates | null;
}): ForgeError | null {
  if (input.preflight !== 'require') return null;
  if (!input.lanes.length)
    return new ForgeError(
      'PREFLIGHT_REQUIRED',
      'This agent landing names no Lane composition of yours, so project preflight: require cannot judge it. Land with the current nforge CLI from the Lane checkout: land --save.',
    );
  for (const lane of input.lanes.slice(0, GATED_LANES))
    if (!input.gates?.lanes.some(entry => entry.laneId === lane.laneId && entry.head === lane.head))
      return new ForgeError(
        'PREFLIGHT_REQUIRED',
        `Run the affected tests for saved head ${lane.head.slice(0, 12)} of Lane ${lane.laneId} first: nforge agent ROOT preflight '${JSON.stringify({ laneId: lane.laneId })}'. Then land again with the current nforge CLI (project preflight: require; the server needs the CLI's result for this head).`,
      );
  return null;
}
