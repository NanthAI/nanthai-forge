// SPDX-License-Identifier: Apache-2.0
import { digest } from '../src/state/hash';
import { ForgeError, invariant } from '../src/errors';
import type { z } from 'zod';
import type { hostedLaneSchema } from '../src/hosted-lane';
type HostedLane = z.infer<typeof hostedLaneSchema>;
/** A holder distinguishes sessions within an already authorized account. It is not a new grant. */
export function requireLaneHolder(lane: HostedLane, actor: string, sessionId?: string) {
  const holder = lane.holder;
  if (!holder?.sessionId) return; // Earlier Lanes remain readable and retain their existing authority.
  invariant(
    sessionId,
    'CLI_UPGRADE_REQUIRED',
    'Update Forge to send this Lane’s session identity. Local work is unchanged.',
  );
  if (holder.actor !== actor || holder.sessionId !== sessionId)
    throw new ForgeError(
      'WORK_STALE',
      `This Lane is held by ${holder.agent ?? 'another session'} since ${new Date(holder.since).toISOString()}. Your local edits and every save remain available. Open it with takeover:true to take over explicitly.`,
      undefined,
      {
        laneId: lane.id,
        head: lane.head,
        holder: { name: holder.agent ?? null, since: holder.since },
        action: 'open',
        takeover: true,
      },
    );
}

/** Browser references come from the live component session, not an asserted native app label. */
export async function laneSession(ctx: Pick<import('./server').QueryCtx, 'auth'>, declared?: string) {
  if (declared) return declared;
  const identity = await ctx.auth.getUserIdentity();
  return typeof identity?.forgeAuthSession === 'string'
    ? digest(`forge-browser:${identity.forgeAuthSession}`)
    : undefined;
}
