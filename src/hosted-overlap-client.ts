// SPDX-License-Identifier: Apache-2.0
import { z } from 'zod';
import { hostedActionError } from './hosted-action-error.js';
import type { HostedAgentTransport } from './hosted-agent-transport.js';
import { presenceSchema } from './hosted-presence-client.js';
import { boardDeliverySchema } from './hosted-board.js';
import { parseHostedResponse } from './hosted-response.js';
import { stackHintSchema } from './hosted-stack-restack.js';
import { exactConflictsSchema } from './hosted-conflict-notice.js';

const advice = z.object({
  behindMain: z.object({
    head: z.string().optional(),
    baseHead: z.string().optional(),
    baseSequence: z.number().nullable().optional(),
    commits: z.number().nullable(),
    conflictingPaths: z.array(z.string()),
    more: z.number(),
    coverage: z.string(),
    /** One line, only when >= N landings touched the Lane's saved paths since its base (Issue 8dfede85). */
    nudge: z.string().optional(),
  }),
  /** The Lane's saved base-to-head paths, when asked (paths:true) and current. */
  changedPaths: z.object({ paths: z.array(z.string()), complete: z.boolean() }).optional(),
  /** Related open Lanes, when asked (presence, capability presenceVersion) by a write member. */
  presence: presenceSchema.optional(),
  /** Board notes since the client's cursor, when asked (board:{after}) and any arrived. */
  board: boardDeliverySchema.optional(),
  /** A stacked Lane whose parent saved newer work (Issue f61e9339): the next save restacks when `ready`. */
  stack: stackHintSchema.optional(),
  /** Exact conflicts a trial merge of saved files found (flip 4, Issue 853fcde3). */
  conflicts: exactConflictsSchema.optional(),
  /** D2 (Issue 1eb42254): build on an admitted peer's pending head instead of repairing a conflict later. */
  stackOffer: z
    .looseObject({
      peerLaneId: z.string(),
      submissionId: z.string(),
      mode: z.enum(['offer', 'auto']),
      command: z.string(),
      text: z.string(),
    })
    .optional(),
});
/** Advice never changes a save receipt; observation failures remain explicitly unknown. */
export async function readHostedOverlapAdvice(
  transport: Pick<HostedAgentTransport, 'query'>,
  laneId: string,
  paths = false,
  items?: number,
  presence?: { since?: number },
  board?: { after: number },
  /** Declared scope of a fresh Lane (start scope.paths); sent only to servers with overlap-scope. */
  scope?: string[],
) {
  try {
    return parseHostedResponse(
      advice,
      await transport.query('projectHostedOverlaps:read', {
        laneId,
        ...(paths ? { paths: true } : {}),
        ...(items ? { items } : {}),
        ...(presence ? { presence } : {}),
        ...(board ? { board } : {}),
        ...(scope?.length ? { scope } : {}),
      }),
    );
  } catch (error) {
    const safe = hostedActionError(error, 'overlap observation');
    if (['PROJECT_UNAVAILABLE', 'AUTH_REQUIRED', 'FORBIDDEN', 'SOURCE_AUTHORITY_CHANGED'].includes(safe.code))
      throw safe;
    return {
      behindMain: { commits: null, conflictingPaths: [], more: 0, coverage: 'unavailable' },
    };
  }
}
