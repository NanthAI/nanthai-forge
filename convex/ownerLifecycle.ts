// SPDX-License-Identifier: Apache-2.0
import { sourceAuthority, requireSourceAuthority } from '../src/hosted-source-authority';
import { v } from 'convex/values';
import { z } from 'zod';
import { mutation } from './cliServer';
import { owned, find, isNativeOwner } from './ownerAcceptance';
import { acceptanceRequestDocument } from './ownerAcceptanceFields';
import { selectedGeneration, record, recordPartition } from './projectWorkIndexStore';
import { acceptanceActor } from './projectAutonomy';
import { ownerLifecycleSchema } from '../src/owner-lifecycle-schema';
import { invariant } from '../src/errors';
import { report } from './errors';
export const request = mutation({
  args: { projectId: v.id('hostedProjects'), operationId: v.string(), command: v.string() },
  returns: acceptanceRequestDocument,
  handler: async (ctx, input) => {
    try {
      const { project, requester } = await owned(ctx, input.projectId);
      invariant(
        await isNativeOwner(ctx, input.projectId),
        'UNSUPPORTED',
        'Lifecycle actions run on this project’s canonical native owner.',
      );
      const authority = sourceAuthority(project);
      requireSourceAuthority(project, { mode: 'native-owner', epoch: authority.epoch });
      const actor = await acceptanceActor(ctx);
      const old = await find(ctx, input.projectId, input.operationId);
      if (old) {
        invariant(
          old.lifecycle === input.command && old.requester === requester && old.actorKind === actor.kind,
          'WORK_OPERATION_CHANGED',
          'Replay the original lifecycle request.',
        );
        return old;
      }
      invariant(
        z.uuid().safeParse(input.operationId).success,
        'BAD_ARGUMENT',
        'Use an original operation UUID.',
      );
      const command = ownerLifecycleSchema.parse(JSON.parse(input.command));
      invariant(
        command.action !== 'abandon' || command.reason.trim(),
        'BAD_ARGUMENT',
        'Give a reason for abandoning.',
      );
      const generation = await selectedGeneration(ctx, project);
      invariant(generation, 'WORK_STALE', 'Load current Work first.');
      const row = await record(ctx, recordPartition(generation), command.collection, command.id);
      const target = row ? JSON.parse(row.value) : null;
      invariant(
        target &&
          (target.head ?? target.base) === command.expectedHead &&
          (target.state ?? target.status) === command.expectedState,
        'WORK_STALE',
        'Lane or Intent changed. Refresh before requesting this action.',
      );
      const id = await ctx.db.insert('ownerAcceptanceRequests', {
        projectId: input.projectId,
        operationId: input.operationId,
        lifecycle: input.command,
        authorityEpoch: authority.epoch,
        ownerId: project.key,
        requester,
        actorKind: actor.kind,
        viewId: command.id,
        head: command.expectedHead,
        expectedMain: null,
        channel: 'lifecycle',
        createdAt: Date.now(),
        state: 'requested',
        receipt: null,
      });
      return (await ctx.db.get(id))!;
    } catch (error) {
      return report(error);
    }
  },
});
