// SPDX-License-Identifier: Apache-2.0
'use node';
import { randomUUID } from 'node:crypto';
import type { ActionCtx } from './_generated/server';
import type { Id } from './_generated/dataModel';
import { internal } from './_generated/api';
import { longActionExpired } from '../src/long-action';

export async function runPublication(
  ctx: ActionCtx,
  input: { projectId: Id<'hostedProjects'>; owner: string; operationId: string; request: string },
  run: () => Promise<Id<'projectBackups'> | { pending: true; progress: string }>,
) {
  const attemptId = randomUUID(),
    started = Date.now();
  while (true) {
    const claim: { claimed: boolean; receipt: Id<'projectBackups'> | null } = await ctx.runMutation(
      internal.projectPublicationAttempt.claim,
      { ...input, attemptId },
    );
    if (claim.receipt) return claim.receipt;
    if (claim.claimed) break;
    if (longActionExpired(started))
      return {
        pending: true as const,
        progress: JSON.stringify({ phase: 'publication-wait', done: 0, total: 1 }),
      };
    await new Promise(resolve => setTimeout(resolve, 1000));
  }
  try {
    return await run();
  } finally {
    // A committed receipt remains authoritative even if cleanup loses its reply.
    await ctx
      .runMutation(internal.projectPublicationAttempt.release, {
        projectId: input.projectId,
        owner: input.owner,
        operationId: input.operationId,
        attemptId,
      })
      .catch(() => {});
  }
}
