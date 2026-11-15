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
          failureRate: z.number().nullable().optional(),
          resolveMs: z.number().nullable().optional(),
          waitSavedMs: z.number().nullable().optional(),
          breakEven: z.number().nullable().optional(),
          samples: z.number().optional(),
          measuredCosts: z.number().optional(),
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
export type SyncRequiredAdvice = WouldConflict;

/** The accepted-main variant on a still-queued entry: main already took files this entry changes, so
 * the Lane syncs and lands again (Issue f7539ebb). An early predecessor decision instead returns
 * exact pinned sync guidance while the predecessor remains pending. */
export function syncRequiredAdvice(
  value: unknown,
  submission?: { phase?: string; observation?: { state?: string } } | null,
): SyncRequiredAdvice | undefined {
  if (submission && (submission.phase !== 'queued' || submission.observation?.state !== 'pending'))
    return undefined;
  const parsed = wouldConflictSchema.safeParse(value);
  return parsed.success && ('landedSubmissionId' in parsed.data || parsed.data.resolution?.early)
    ? parsed.data
    : undefined;
}

export const syncRequiredSummary = (advice: Pick<SyncRequiredAdvice, 'paths' | 'more'>) =>
  `main changed ${advice.paths.length + advice.more} file(s) this queued landing also changes (${advice.paths.join(', ')}${advice.more ? ', …' : ''})`;

/** Server-side guidance text, shared by the mark and every read that shows it. */
export const syncRequiredNext = (
  advice: Pick<WouldConflict, 'paths' | 'more' | 'laneId'> & { predecessor?: unknown; next?: string },
) =>
  advice.predecessor
    ? advice.next!
    : `SYNC_REQUIRED: ${syncRequiredSummary(advice)}. Do not keep waiting on this entry: run land --save ` +
      `${advice.laneId ? `{"laneId":"${advice.laneId}"} ` : 'in its Lane '}` +
      'now; it syncs main in, saves and lands again, superseding this entry.';

/** Shared continuation: sync the exact early predecessor, or land --save against accepted main.
 * Every client surface (wait, land, observe, MCP) returns the same action for the same advice. */
export function syncRequiredContinuation(
  root: string,
  advice: SyncRequiredAdvice,
  input: { laneId?: string | undefined; message?: string | null | undefined } = {},
) {
  if ('predecessor' in advice) {
    const { groupId: _group, ...predecessor } = advice.predecessor;
    void _group;
    const parameters = { ...(input.laneId ? { laneId: input.laneId } : {}), predecessor };
    const command = `nforge agent ${shellQuote(root)} sync ${shellQuote(JSON.stringify(parameters))}`;
    return {
      code: 'COMPOSITION_CONFLICT' as const,
      earlyResolution: true,
      next: { action: 'sync', ...parameters },
      command,
      nextCommand: command,
      inProgress: false,
      instruction: `${advice.next} Run command in this Lane checkout. Edit and resolve the returned conflict, then land --save; the exact predecessor head and receipt fence its check and acceptance.`,
    };
  }
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
