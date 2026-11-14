// SPDX-License-Identifier: Apache-2.0
import { z } from 'zod';

/** Exact predicted publication; a same-head replacement receipt is a new generation. */
export const predecessorPinSchema = z
  .object({
    submissionId: z.uuid(),
    head: z.string().regex(/^[0-9a-f]{64}$/),
    receiptId: z.uuid(),
  })
  .strict();
export const earlyResolutionSchema = z
  .object({
    predecessor: predecessorPinSchema,
    laneId: z.uuid(),
    originalHead: z.string().regex(/^[0-9a-f]{64}$/),
    startedAt: z.iso.datetime(),
    resolvedAt: z.iso.datetime().optional(),
  })
  .strict();
export type EarlyResolution = z.infer<typeof earlyResolutionSchema>;
/** One sample per observed predecessor receipt: id, outcome, resolution and remaining wait in ms.
 * The window follows the Automatic CI design's 50 retained outcomes. Unknown costs stay null. */
export const AUTOMATIC_CI_OUTCOME_WINDOW = 50; // Owner's Automatic CI design (bd0f850e).
export const earlyResolutionSamplesSchema = z
  .array(
    z.tuple([
      z.uuid(),
      z.boolean(),
      z.number().nonnegative().nullable(),
      z.number().nonnegative().nullable(),
    ]),
  )
  .max(AUTOMATIC_CI_OUTCOME_WINDOW);
export type EarlyResolutionSamples = z.infer<typeof earlyResolutionSamplesSchema>;
export function earlyResolutionChoice(
  mode: 'automatic' | 'on' | 'off' | undefined,
  samples: EarlyResolutionSamples = [],
) {
  const failureRate = samples.length ? samples.filter(s => !s[1]).length / samples.length : null;
  const known = samples.filter(s => s[2] !== null && s[3] !== null);
  const mean = (index: 2 | 3) =>
    known.length ? known.reduce((sum, s) => sum + s[index]!, 0) / known.length : null;
  const resolveMs = mean(2),
    waitSavedMs = mean(3);
  // Early work wastes one resolution when the prefix fails and saves the wait when it lands:
  // resolve early while failure * resolve < (1 - failure) * wait, so a longer wait tolerates more failures.
  const breakEven =
    resolveMs !== null && waitSavedMs !== null && resolveMs + waitSavedMs > 0
      ? waitSavedMs / (resolveMs + waitSavedMs)
      : null;
  const early =
    mode === 'on' ||
    (mode !== 'off' && (failureRate === null || breakEven === null || failureRate < breakEven));
  return {
    mode: mode ?? 'automatic',
    early,
    failureRate,
    resolveMs,
    waitSavedMs,
    breakEven,
    samples: samples.length,
    measuredCosts: known.length,
    reason:
      mode === 'off'
        ? 'owner-off'
        : mode === 'on'
          ? 'owner-on'
          : breakEven === null
            ? 'cold-start'
            : 'measured-break-even',
  };
}
