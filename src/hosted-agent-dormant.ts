// SPDX-License-Identifier: Apache-2.0
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import { invariant } from './errors.js';
import { clientCacheRoot } from './root-paths.js';
import { HostedCheckoutCache } from './hosted-checkout-cache.js';
import { ConvexLaneTransport } from './hosted-lane-transport.js';
import { parseNativeState } from './state/format.js';
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
    head: z.string(),
    lastActivityAt: z.string(),
    abandonable: z.enum(['landed', 'empty']).nullable(),
    /** Paths the Lane changed and the bytes it ends with, when its overlap row holds the complete list. */
    changes: z
      .array(
        z.object({ path: z.string(), after: z.object({ blob: z.string(), mode: z.string() }).nullable() }),
      )
      .optional(),
    pinned: z.boolean(),
    indexed: z.boolean().nullable(),
  })
  .loose();
const pageSchema = z
  .object({ page: z.array(laneSchema), isDone: z.boolean(), continueCursor: z.string().nullable() })
  .loose();
/** Every path the Lane changed holds exactly the Lane's bytes on main (a deleted path is absent there).
 * A Lane with no changes left to land counts: nothing unlanded remains. */
export const onMainProof = (
  changes: NonNullable<z.infer<typeof laneSchema>['changes']>,
  main: ReadonlyMap<string, { blob: string; mode: string }>,
) =>
  changes.every(change => {
    const file = main.get(change.path);
    return change.after === null
      ? !file
      : !!file && file.blob === change.after.blob && file.mode === change.after.mode;
  });
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
  // Saved work no receipt names: compare the changed paths with main's bytes (one State read, only
  // when some Lane has a complete change list to compare).
  const onMain = new Set<string>();
  const candidates = dormant.filter(lane => !lane.abandonable && !lane.pinned && lane.changes);
  if (candidates.length) {
    const head = (await session.main()).head;
    const cache = new HostedCheckoutCache(
      clientCacheRoot(session.root),
      new ConvexLaneTransport(session.exchange),
    );
    await cache.ensure([head]);
    const files = new Map(
      parseNativeState(readFileSync(join(cache.objects, head))).files.map(file => [file.path, file] as const),
    );
    for (const lane of candidates) if (onMainProof(lane.changes!, files)) onMain.add(lane.laneId);
  }
  const kept = dormant.filter(lane => (!lane.abandonable && !onMain.has(lane.laneId)) || lane.pinned);
  const abandonable = dormant.filter(lane => (lane.abandonable || onMain.has(lane.laneId)) && !lane.pinned);
  const classOf = (lane: z.infer<typeof laneSchema>) =>
    lane.abandonable ?? (onMain.has(lane.laneId) ? ('on-main' as const) : null);
  const summary = (lane: z.infer<typeof laneSchema>) => ({
    laneId: lane.laneId,
    intent: lane.intent,
    lastActivityAt: lane.lastActivityAt,
    ...(classOf(lane) ? { abandonable: classOf(lane) } : {}),
    ...(lane.pinned ? { pinned: true } : { ...(classOf(lane) ? {} : { reason: 'has-saved-work' }) }),
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
      abandon: batch.filter(lane => lane.abandonable).map(lane => lane.laneId),
      onMain: batch.filter(lane => !lane.abandonable).map(lane => ({ laneId: lane.laneId, head: lane.head })),
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
