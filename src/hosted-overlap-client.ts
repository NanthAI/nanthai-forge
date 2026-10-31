// SPDX-License-Identifier: Apache-2.0
import { z } from 'zod';
import { hostedActionError } from './hosted-action-error.js';
import type { HostedAgentTransport } from './hosted-agent-transport.js';

const advice = z.object({
  unacknowledgedOverlaps: z.object({
    laneId: z.string().optional(),
    head: z.string().optional(),
    count: z.number().nullable(),
    coverage: z.string(),
    items: z.array(
      z.looseObject({ noticeId: z.string(), file: z.string(), lanes: z.array(z.string()), text: z.string() }),
    ),
  }),
  behindMain: z.object({
    head: z.string().optional(),
    baseHead: z.string().optional(),
    baseSequence: z.number().nullable().optional(),
    commits: z.number().nullable(),
    conflictingPaths: z.array(z.string()),
    more: z.number(),
    coverage: z.string(),
  }),
  /** The Lane's saved base-to-head paths, when asked (paths:true) and current. */
  changedPaths: z.object({ paths: z.array(z.string()), complete: z.boolean() }).optional(),
});
/** Advice never changes a save receipt; observation failures remain explicitly unknown. */
export async function readHostedOverlapAdvice(
  transport: Pick<HostedAgentTransport, 'query'>,
  laneId: string,
  paths = false,
  items?: number,
) {
  try {
    return advice.parse(
      await transport.query('projectHostedOverlaps:read', {
        laneId,
        ...(paths ? { paths: true } : {}),
        ...(items ? { items } : {}),
      }),
    );
  } catch (error) {
    const safe = hostedActionError(error, 'overlap observation');
    if (['PROJECT_UNAVAILABLE', 'AUTH_REQUIRED', 'FORBIDDEN', 'SOURCE_AUTHORITY_CHANGED'].includes(safe.code))
      throw safe;
    return {
      unacknowledgedOverlaps: { count: null, items: [], coverage: 'unavailable' },
      behindMain: { commits: null, conflictingPaths: [], more: 0, coverage: 'unavailable' },
    };
  }
}

/** The delivery record behind metric 5.4. Best effort: a missing record is a gap, never a failed action. */
export async function recordHostedOverlapDelivery(
  transport: Pick<HostedAgentTransport, 'mutation'>,
  laneId: string,
  surface: string,
  found: Awaited<ReturnType<typeof readHostedOverlapAdvice>>,
) {
  const overlaps = found.unacknowledgedOverlaps;
  if (!overlaps.items.length || !overlaps.head || !overlaps.count) return;
  try {
    await transport.mutation('projectHostedOverlapDeliveries:record', {
      request: JSON.stringify({
        laneId,
        head: overlaps.head,
        surface,
        count: overlaps.count,
        coverage: overlaps.coverage,
        items: overlaps.items.slice(0, 5).map(item => ({ noticeId: item.noticeId, file: item.file })),
      }),
    });
  } catch {
    /* Older servers have no delivery endpoint. */
  }
}
