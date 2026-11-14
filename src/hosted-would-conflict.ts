// SPDX-License-Identifier: Apache-2.0
import { z } from 'zod';
import { shellQuote } from './shell-quote.js';

const detail = {
  laneId: z.uuid().optional(),
  paths: z.array(z.string()).max(10),
  more: z.number().int().nonnegative(),
  at: z.iso.datetime(),
  next: z.string(),
};
/** One existing advice channel: accepted-main overlap or a proven merge
 * conflict on an unaccepted predecessor. Neither variant settles a request. */
export const wouldConflictSchema = z.union([
  z
    .object({
      ...detail,
      landedSubmissionId: z.string(),
      /** The Lane this entry composed, when the mark could name it (older marks omit it). */
      laneId: z.uuid().optional(),
    })
    .strict(),
  z
    .object({
      ...detail,
      code: z.literal('COMPOSITION_CONFLICT'),
      resolution: z
        .object({
          early: z.boolean(),
          mode: z.enum(['automatic', 'on', 'off']),
          failureRate: z.number().nullable(),
          resolveMs: z.number().nullable(),
          waitSavedMs: z.number().nullable(),
          breakEven: z.number().nullable(),
          samples: z.number(),
          measuredCosts: z.number(),
          reason: z.string(),
        })
        .strict()
        .optional(),
      predecessor: z
        .object({
          groupId: z.uuid(),
          submissionId: z.uuid(),
          head: z.string().regex(/^[0-9a-f]{64}$/),
          receiptId: z.uuid(),
        })
        .strict(),
    })
    .strict(),
]);
export type WouldConflict = z.infer<typeof wouldConflictSchema>;
export type SyncRequiredAdvice = Extract<WouldConflict, { landedSubmissionId: string }>;

/** The accepted-main variant on a still-queued entry: main already took files this entry changes, so
 * the Lane syncs and lands again (Issue f7539ebb). The predecessor variant needs no agent action. */
export function syncRequiredAdvice(
  value: unknown,
  submission?: { phase?: string; observation?: { state?: string } } | null,
): SyncRequiredAdvice | undefined {
  if (submission && (submission.phase !== 'queued' || submission.observation?.state !== 'pending'))
    return undefined;
  const parsed = wouldConflictSchema.safeParse(value);
  return parsed.success && 'landedSubmissionId' in parsed.data ? parsed.data : undefined;
}

export const syncRequiredSummary = (advice: Pick<SyncRequiredAdvice, 'paths' | 'more'>) =>
  `main changed ${advice.paths.length + advice.more} file(s) this queued landing also changes (${advice.paths.join(', ')}${advice.more ? ', …' : ''})`;

/** Server-side guidance text, shared by the mark and every read that shows it. */
export const syncRequiredNext = (advice: Pick<SyncRequiredAdvice, 'paths' | 'more' | 'laneId'>) =>
  `SYNC_REQUIRED: ${syncRequiredSummary(advice)}. Do not keep waiting on this entry: run land --save ` +
  `${advice.laneId ? `{"laneId":"${advice.laneId}"} ` : 'in its Lane '}` +
  'now; it syncs main in, saves and lands again, superseding this entry.';

/** The one recovery for a sync-required entry: land --save of the same Lane, with the landing's
 * own commit message kept. Every client surface (wait, land, observe, MCP) returns this shape. */
export function syncRequiredContinuation(
  root: string,
  advice: SyncRequiredAdvice,
  input: { laneId?: string | undefined; message?: string | null | undefined } = {},
) {
  const laneId = advice.laneId ?? input.laneId;
  const parameters = {
    ...(laneId ? { laneId } : {}),
    ...(input.message ? { message: input.message } : {}),
  };
  const command = `nforge agent ${shellQuote(root)} land --save ${shellQuote(JSON.stringify(parameters))}`;
  return {
    code: 'SYNC_REQUIRED' as const,
    syncRequired: {
      paths: advice.paths,
      more: advice.more,
      landedSubmissionId: advice.landedSubmissionId,
      ...(laneId ? { laneId } : {}),
    },
    next: { action: 'land', save: true, ...parameters },
    command,
    nextCommand: command,
    inProgress: false,
    instruction:
      `SYNC_REQUIRED: ${syncRequiredSummary(advice)}. Stop waiting on this operation. Run command` +
      `${laneId ? '' : ' inside the Lane checkout'}: it syncs main in, saves and lands again, and ` +
      'the new landing supersedes this queued entry. Resolve any sync conflict it reports first.',
  };
}
