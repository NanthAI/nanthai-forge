// SPDX-License-Identifier: Apache-2.0
import { requireStoredRepositoryBinding } from './githubBindingAccess';
import { v } from 'convex/values';
import {
  query,
  mutation,
  guard,
  isDeviceIdentity,
  type QueryCtx,
  type MutationCtx,
  type ActionCtx,
} from './cliServer';
import { accessibleProject, activeOwnedProject } from './projectAuthority';
import { autonomyPolicy } from './autonomyFields';
import {
  effectivePolicy,
  policyWriteSchema,
  editedPolicy,
  type AcceptanceActor,
} from '../src/autonomy-policy';
import { invariant } from '../src/errors';
import { report } from './errors';
import { recordMutationReceipt } from './projectSelfMetricReceiptStore';
/** Device identity always uses agent authority; callers may explicitly downscope to it. */
export async function acceptanceActor(
  ctx: QueryCtx | MutationCtx | ActionCtx,
  agent = false,
): Promise<AcceptanceActor> {
  await guard(ctx, 'cli');
  const user = await ctx.auth.getUserIdentity();
  invariant(user, 'PROJECT_UNAVAILABLE', 'Sign in to accept source.');
  return { kind: agent || isDeviceIdentity(user) ? 'agent' : 'person', id: user.subject };
}
export const read = query({
  args: { projectId: v.id('hostedProjects') },
  returns: autonomyPolicy,
  handler: async (ctx, input) => {
    try {
      const user = await ctx.auth.getUserIdentity();
      invariant(user, 'PROJECT_UNAVAILABLE', 'Sign in to read project policy.');
      return effectivePolicy(await accessibleProject(ctx, input.projectId, user.subject));
    } catch (error) {
      return report(error);
    }
  },
});
export const set = mutation({
  args: { projectId: v.id('hostedProjects'), command: v.string() },
  returns: v.object({ operationId: v.string(), policy: autonomyPolicy }),
  handler: async (ctx, input) => {
    try {
      const user = await ctx.auth.getUserIdentity();
      invariant(user, 'PROJECT_UNAVAILABLE', 'Sign in to change project policy.');
      // Forge currently has owners/contributors, not a general maintainer role.
      const project = await activeOwnedProject(ctx, input.projectId, user.subject);
      let value: unknown;
      try {
        value = JSON.parse(input.command);
      } catch {
        invariant(false, 'BAD_ARGUMENT', 'Send a JSON policy command.');
      }
      const parsed = policyWriteSchema.safeParse(value);
      invariant(
        parsed.success,
        'BAD_ARGUMENT',
        'Send a set-policy command with its original operation UUID.',
      );
      const command = parsed.data,
        request = JSON.stringify(command),
        original = await ctx.db
          .query('projectPolicyChanges')
          .withIndex('by_project_and_operation', q =>
            q.eq('projectId', input.projectId).eq('operationId', command.operationId),
          )
          .unique();
      if (original) {
        invariant(
          original.actor === user.subject && original.request === request,
          'WORK_OPERATION_CHANGED',
          'Retry policy with its original values.',
        );
        return { operationId: command.operationId, policy: original.policy };
      }
      const previous = effectivePolicy(project);
      invariant(
        !command.expectedPolicy || JSON.stringify(command.expectedPolicy) === JSON.stringify(previous),
        'POLICY_CHANGED',
        'Project policy changed. Refresh it before editing.',
      );
      const policy = editedPolicy(previous, command);
      if (command.githubMirror && policy.githubMirror?.autoPush)
        await requireStoredRepositoryBinding(ctx, input.projectId, policy.githubMirror.repo);
      await ctx.db.patch(project._id, { autonomyPolicy: policy });
      await ctx.db.insert('projectPolicyChanges', {
        projectId: input.projectId,
        operationId: command.operationId,
        actor: user.subject,
        request,
        previous,
        policy,
        at: new Date().toISOString(),
      });
      await recordMutationReceipt(ctx, {
        projectId: input.projectId,
        actor: user.subject,
        operationId: command.operationId,
        action: 'set-policy',
      });
      return { operationId: command.operationId, policy };
    } catch (error) {
      return report(error);
    }
  },
});
