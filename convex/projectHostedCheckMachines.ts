// SPDX-License-Identifier: Apache-2.0
import { v } from 'convex/values';
import { z } from 'zod';
import { mutation, type QueryCtx, type MutationCtx } from './cliServer';
import type { Id } from './_generated/dataModel';
import { checkCaller, beginCheckOperation, completeCheckOperation } from './projectHostedCheckStore';
import { canonicalPayload } from '../src/hosted-source-operation';
import { invariant } from '../src/errors';
import { report } from './errors';

export const macMachine = (ctx: QueryCtx | MutationCtx, projectId: Id<'hostedProjects'>, machineId: string) =>
  ctx.db
    .query('projectHostedCheckWorkers')
    .withIndex('by_project_and_machine', q => q.eq('projectId', projectId).eq('machineId', machineId))
    .unique();

export async function requireMacMachine(
  ctx: QueryCtx | MutationCtx,
  projectId: Id<'hostedProjects'>,
  machineId: string,
) {
  const machine = await macMachine(ctx, projectId, machineId);
  invariant(
    machine && machine.revokedAt === undefined,
    'MAC_MACHINE_REVOKED',
    `Mac machine ${machineId} has no active registration.`,
  );
  return machine;
}

/** Owner-requested revocation changes future evidence decisions, never history.
 * The original operation safely replays; registering a new session cannot clear it. */
export const revoke = mutation({
  args: { projectId: v.id('hostedProjects'), request: v.string() },
  returns: v.string(),
  handler: async (ctx, input) => {
    try {
      const request = z
        .object({
          operationId: z.uuid(),
          authorityEpoch: z.number().safe().nonnegative(),
          machineId: z.uuid(),
        })
        .strict()
        .parse(JSON.parse(input.request));
      const { actor, project } = await checkCaller(ctx, input.projectId);
      invariant(
        actor === project.owner,
        'PROJECT_UNAVAILABLE',
        'Only the project owner can revoke its runner.',
      );
      const operation = await beginCheckOperation(ctx, {
        projectId: input.projectId,
        actor,
        operationId: request.operationId,
        expected: { authorityEpoch: request.authorityEpoch },
        payload: request,
      });
      if (operation.replayed) return canonicalPayload(operation.operation.terminal?.outcome);
      const machine = await macMachine(ctx, input.projectId, request.machineId);
      invariant(machine, 'NOT_FOUND', `Mac machine ${request.machineId} is not registered.`);
      const result = { machineId: request.machineId, revokedAt: machine.revokedAt ?? Date.now() };
      await ctx.db.patch(machine._id, { revokedAt: result.revokedAt });
      await completeCheckOperation(ctx, operation.operation, result);
      return canonicalPayload({ status: 'completed', result });
    } catch (error) {
      return report(error);
    }
  },
});
