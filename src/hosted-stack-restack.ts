// SPDX-License-Identifier: Apache-2.0
// Automatic restack of a stacked Lane onto its parent's newest saved head (Issue f61e9339).
import { z } from 'zod';
import { digest } from './portable-hash.js';

/** The overlap read's `stack` field: the parent saved newer work than this Lane is stacked on. */
export const stackHintSchema = z.object({
  laneId: z.string(),
  parentLaneId: z.string(),
  parentHead: z.string(),
  /** `ready`: the next save restacks; `conflict`: that restack conflicted, so nothing runs until the parent saves again. */
  restack: z.enum(['ready', 'conflict']),
});
export type StackHint = z.infer<typeof stackHintSchema>;

type Dispatch = (action: string, input: Record<string, unknown>) => Promise<{ result?: unknown }>;
const outcomeSchema = z.object({
  outcome: z.object({ status: z.string(), result: z.unknown().optional(), error: z.unknown().optional() }),
});
const syncedSchema = z.looseObject({
  status: z.enum(['up-to-date', 'merged', 'conflict', 'resolved']),
  lane: z.looseObject({ laneId: z.string(), head: z.string() }),
});
const short = (id: string) => id.slice(0, 8);
const syncCommand = (laneId: string) => `nforge agent . sync '{"laneId":"${laneId}"}'`;

/** One restack per (Lane, saved head, parent head): a retried save replays the same sync operation. */
export function restackOperationId(laneId: string, savedHead: string, parentHead: string) {
  const hex = digest(JSON.stringify(['stack-restack', laneId, savedHead, parentHead])).slice(0, 32);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-8${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

/**
 * After a completed save of a stacked Lane in its own checkout: when the parent saved newer work, run
 * the ordinary hosted sync with `cleanOnly`. Clean: the Lane head moves onto the parent's newest head
 * and the checkout applies it (the working copy equals the just-saved head, so nothing unsaved is at
 * stake). Conflict: nothing changes and the server marks that parent head, so later saves skip it.
 * Costs nothing unless the overlap read already returned `stack.restack: "ready"`.
 */
export async function restackAfterSave<
  R extends { result?: unknown; stack?: StackHint | undefined; restack?: Record<string, unknown> },
>(response: R, checkoutLaneId: string | undefined, dispatch: Dispatch): Promise<R> {
  const hint = response.stack;
  // The outcome replaces the hint: a receipt never shows both.
  const done = (restack: Record<string, unknown>) => {
    const value: Record<string, unknown> = { ...response, restack };
    delete value.stack;
    return value as R;
  };
  if (!hint || hint.restack !== 'ready' || hint.laneId !== checkoutLaneId) return response;
  const saved = outcomeSchema.safeParse(response.result);
  const savedHead =
    saved.success && saved.data.outcome.status === 'completed'
      ? (saved.data.outcome.result as { head?: unknown } | undefined)?.head
      : undefined;
  if (typeof savedHead !== 'string') return response;
  const base = { parentLaneId: hint.parentLaneId, parentHead: hint.parentHead, from: savedHead };
  const operationId = restackOperationId(hint.laneId, savedHead, hint.parentHead);
  let synced: { result?: unknown };
  try {
    synced = await dispatch('sync', {
      laneId: hint.laneId,
      cleanOnly: true,
      operationId,
      message: `Restack onto parent Lane ${short(hint.parentLaneId)} (head ${short(hint.parentHead)})`,
    });
  } catch (error) {
    const code = (error as { code?: unknown }).code;
    return done({
      status: 'failed',
      ...base,
      ...(typeof code === 'string' ? { code } : {}),
      message: error instanceof Error ? error.message.slice(0, 300) : 'Automatic restack failed.',
      next: `Your save is kept. Restack by hand: ${syncCommand(hint.laneId)}`,
    });
  }
  const value = synced.result as { source?: unknown; applied?: unknown } | undefined;
  const source = outcomeSchema.safeParse(value?.source ?? value);
  const outcome = source.success ? source.data.outcome : null;
  const result = outcome?.status === 'completed' ? syncedSchema.safeParse(outcome.result) : null;
  if (!result?.success)
    return done({
      status: outcome?.status === 'failed' ? 'failed' : 'in-progress',
      ...base,
      operationId,
      ...(outcome?.error ? { error: outcome.error } : {}),
      next:
        outcome?.status === 'failed'
          ? `Your save is kept. Restack by hand: ${syncCommand(hint.laneId)}`
          : `nforge agent . wait '{"operationIds":["${operationId}"]}'`,
    });
  if (result.data.status === 'conflict')
    return done({
      status: 'conflict',
      ...base,
      operationId,
      note: 'Restacking onto the parent would conflict, so nothing changed and later saves will not retry this parent head.',
      next: `Resolve when ready: ${syncCommand(hint.laneId)}`,
    });
  return done({
    status: 'restacked',
    ...base,
    head: result.data.lane.head,
    operationId,
    ...(value?.applied ? {} : { applied: false }),
    undo: `Your pre-restack head ${short(savedHead)} stays in lane-history {"laneId":"${hint.laneId}"}.`,
  });
}
