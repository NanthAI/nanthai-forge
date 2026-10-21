// SPDX-License-Identifier: Apache-2.0
'use node';
import { randomUUID } from 'node:crypto';
import type { ActionCtx } from './_generated/server';
import type { Id } from './_generated/dataModel';
import { internal } from './_generated/api';
import { invariant } from '../src/errors';

export async function runPublication(
  ctx: ActionCtx,
  input: { projectId: Id<'hostedProjects'>; owner: string; operationId: string; request: string },
  run: () => Promise<Id<'projectBackups'>>,
) {
  const attemptId = randomUUID(),
    started = Date.now();
  while (true) {
    invariant(
      Date.now() - started < 570_000,
      'WORK_BUSY',
      'The original publication is still running. Retry the same operation to receive its result.',
    );
    const claim: { claimed: boolean; receipt: Id<'projectBackups'> | null } = await ctx.runMutation(
      internal.projectPublicationAttempt.claim,
      { ...input, attemptId },
    );
    if (claim.receipt) return claim.receipt;
    if (claim.claimed) break;
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
