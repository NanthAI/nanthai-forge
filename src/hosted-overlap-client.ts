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
});
/** Advice never changes a save receipt; observation failures remain explicitly unknown. */
export async function readHostedOverlapAdvice(
  transport: Pick<HostedAgentTransport, 'query'>,
  laneId: string,
) {
  try {
    return advice.parse(await transport.query('projectHostedOverlaps:read', { laneId }));
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
