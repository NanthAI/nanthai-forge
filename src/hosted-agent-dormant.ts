// SPDX-License-Identifier: Apache-2.0
import { z } from 'zod';
import { invariant } from './errors.js';
import type { HostedAgentSession } from './hosted-agent-transport.js';
import { parseHostedResponse } from './hosted-response.js';

const PAGE = 100;
/** A project with more dormant Lanes than this lists the first of them; a repeat reaches the rest as these close. */
const MAX_PAGES = 5;
const laneSchema = z
  .object({
    laneId: z.uuid(),
    intentId: z.uuid(),
    intent: z.string().nullable(),
    lastActivityAt: z.string(),
    abandonable: z.enum(['landed', 'empty']).nullable(),
    pinned: z.boolean(),
    indexed: z.boolean().nullable(),
  })
  .loose();
const pageSchema = z
  .object({ page: z.array(laneSchema), isDone: z.boolean(), continueCursor: z.string().nullable() })
  .loose();
const resultSchema = z
  .object({ results: z.array(z.object({ laneId: z.uuid(), result: z.string() }).strict()) })
  .strict();

/** `x abandon-dormant`: lists open Lanes idle past the project's dormantAfterDays and which of them hold
 * nothing unlanded. A dry run unless `apply`; then at most `limit` (25) Lanes change per call, the rest are
 * counted in `remaining`. Reads one bounded page per 100 dormant Lanes; idle costs nothing. */
export async function abandonDormantLanes(
  session: HostedAgentSession,
  authorityEpoch: number,
  command: { apply: boolean; limit: number },
) {
  const dormant: z.infer<typeof laneSchema>[] = [];
  let cursor: string | null = null,
    done = false;
  for (let pages = 0; pages < MAX_PAGES && !done; pages++) {
    const page: z.infer<typeof pageSchema> = parseHostedResponse(
      pageSchema,
      await session.query('projectHostedLiveLanes:list', { cursor, limit: PAGE, view: 'dormant' }),
    );
    dormant.push(...page.page);
    cursor = page.continueCursor;
    done = page.isDone;
  }
  const kept = dormant.filter(lane => !lane.abandonable || lane.pinned);
  const abandonable = dormant.filter(lane => lane.abandonable && !lane.pinned);
  const summary = (lane: z.infer<typeof laneSchema>) => ({
    laneId: lane.laneId,
    intent: lane.intent,
    lastActivityAt: lane.lastActivityAt,
    ...(lane.abandonable ? { abandonable: lane.abandonable } : {}),
    ...(lane.pinned ? { pinned: true } : { ...(lane.abandonable ? {} : { reason: 'has-saved-work' }) }),
  });
  const base = {
    dormant: dormant.length,
    abandonable: abandonable.map(summary),
    kept: kept.map(summary),
    ...(done ? {} : { more: true }),
  };
  if (!command.apply)
    return {
      phase: 'abandon-dormant',
      dryRun: true,
      ...base,
      next: abandonable.length
        ? `nforge x ROOT abandon-dormant '{"apply":true}' abandons ${Math.min(abandonable.length, command.limit)} of ${abandonable.length} (saved heads are kept; start --reopen undoes it).`
        : 'Nothing to abandon.',
    };
  const batch = abandonable.slice(0, command.limit);
  // Spare capacity indexes the dormant Lanes that stay open, so later reads skip them without reading their rows.
  const stamp = kept
    .filter(lane => !lane.pinned && lane.indexed === false)
    .slice(0, command.limit - batch.length);
  if (!batch.length && !stamp.length)
    return { phase: 'abandon-dormant', dryRun: false, ...base, abandoned: [], remaining: 0 };
  const done_ = parseHostedResponse(
    resultSchema,
    await session.mutation('projectHostedDormant:abandon', {
      authorityEpoch,
      abandon: batch.map(lane => lane.laneId),
      stamp: stamp.map(lane => lane.laneId),
    }),
  );
  invariant(
    done_.results.length === batch.length + stamp.length,
    'SOURCE_UNAVAILABLE',
    'The sweep reply differs.',
  );
  const abandoned = done_.results.filter(entry => entry.result === 'abandoned').map(entry => entry.laneId);
  return {
    phase: 'abandon-dormant',
    dryRun: false,
    ...base,
    abandoned,
    skipped: done_.results.filter(entry => !['abandoned', 'stamped'].includes(entry.result)),
    remaining: abandonable.length - abandoned.length,
    undo: 'start --reopen {laneId} brings back an abandoned Lane with its saved head.',
  };
}
