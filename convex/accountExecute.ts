import { retainMembership } from './projectActorNames';
// SPDX-License-Identifier: Apache-2.0
import { report } from './errors';
import { v } from 'convex/values';
import { internalMutation, type MutationCtx } from './_generated/server';
import type { Doc, Id } from './_generated/dataModel';
import {
  accountActor,
  ownedMetadata,
  incomingCurrent,
  type ResourceKind,
  type LeaveKind,
} from './accountResources';
import { metadataBytes } from './accountMetadata';
import { deleteImport } from './lifecycle';
import { deleteSecret } from './secretLifecycle';
import { transition } from './projectLifecycle';
import { deleteTeam } from './teamLifecycle';
import { revokeAgent } from './agentGrants';
import { invariant } from '../src/errors';

async function finish(
  ctx: MutationCtx,
  account: Doc<'accountOperations'>,
  item: Doc<'accountItems'>,
  state: 'completed' | 'changed',
) {
  await ctx.db.patch(item._id, { state });
  await ctx.db.patch(account._id, { pending: account.pending - 1, stage: 'running' });
}
async function leave(ctx: MutationCtx, item: Doc<'accountItems'>, actor: string) {
  if (item.kind === 'secrets') {
    const row = await ctx.db.get(item.resourceId as Id<'secretGrants'>),
      object = row && (await ctx.db.get(row.secretId));
    if (object && !object.deleting) {
      const policyRevision = object.policyRevision + 1;
      await ctx.db.patch(object._id, { policyRevision });
      await ctx.db.insert('secretEvents', {
        secretId: object._id,
        actor,
        operationId: item.operationId,
        kind: 'grant',
        version: object.version,
        policyRevision,
        at: Date.now(),
        principal: actor,
        capabilities: [],
      });
    }
  } else if (item.kind === 'projects') {
    const row = await ctx.db.get(item.resourceId as Id<'projectContributors'>);
    if (row) await retainMembership(ctx, row.projectId, actor);
  } else if (item.kind === 'zones') {
    const row = await ctx.db.get(item.resourceId as Id<'zoneReaders'>),
      zone = row && (await ctx.db.get(row.zoneId));
    if (zone) {
      const update = { kind: 'reader' as const, reader: actor, present: false };
      await ctx.db.patch(zone._id, { revision: zone.revision + 1 });
      await ctx.db.insert('zoneChanges', {
        zoneId: zone._id,
        operationId: item.operationId,
        request: item.pin,
        previousRevision: zone.revision,
        revision: zone.revision + 1,
        at: Date.now(),
        update,
      });
    }
  }
  await ctx.db.delete(item.resourceId as Id<'secretGrants'>);
}
// Selection, authority, child-operation start and personal cleanup share ONE transaction.
export const step = internalMutation({
  args: { operationId: v.string(), itemId: v.id('accountItems'), observed: v.string() },
  returns: v.null(),
  handler: async (ctx, input) => {
    try {
      const actor = await accountActor(ctx),
        account = await ctx.db
          .query('accountOperations')
          .withIndex('by_owner_and_operation', q => q.eq('owner', actor).eq('operationId', input.operationId))
          .unique(),
        item = await ctx.db.get(input.itemId);
      invariant(
        account && account.stage !== 'preparing' && item?.accountId === account._id,
        'ACCOUNT_UNAVAILABLE',
        'This original data selection is unavailable.',
      );
      if (item.state === 'completed' || item.state === 'changed') return null;
      if (item.state === 'pending') {
        const value = item.hidden
          ? await incomingCurrent(ctx, item.kind as LeaveKind, item.resourceId, actor)
          : await ownedMetadata(ctx, item.kind as ResourceKind, item.resourceId, actor);
        if (!value || metadataBytes(value) !== input.observed) {
          await finish(ctx, account, item, 'changed');
          return null;
        }
        if (item.hidden) {
          await leave(ctx, item, actor);
          await finish(ctx, account, item, 'completed');
          return null;
        }
        if (item.kind === 'view' || item.kind === 'interest') {
          await ctx.db.delete(item.resourceId as Id<'savedViews'>);
          await finish(ctx, account, item, 'completed');
          return null;
        }
        await ctx.db.patch(item._id, { state: 'started' });
        await ctx.db.patch(account._id, { stage: 'running' });
      }
      const e = item.expected!;
      if (item.kind === 'project') {
        await transition(
          ctx,
          {
            projectId: item.resourceId as Id<'hostedProjects'>,
            operationId: item.operationId,
            expectedRevision: e.revision!,
          },
          'delete',
        );
        if ((await ctx.db.get(item.resourceId as Id<'hostedProjects'>))?.removal === 'deleted')
          await finish(ctx, account, item, 'completed');
      } else if (item.kind === 'secret') {
        const result = await deleteSecret(ctx, {
          id: item.resourceId as Id<'secretObjects'>,
          operationId: item.operationId,
          version: e.version!,
          policyRevision: e.policyRevision!,
          archiveRevision: e.archiveRevision!,
        });
        if (result.status === 'deleted') await finish(ctx, account, item, 'completed');
      } else if (item.kind === 'import') {
        await deleteImport(ctx, item.resourceId as Id<'imports'>);
        if (!(await ctx.db.get(item.resourceId as Id<'imports'>)))
          await finish(ctx, account, item, 'completed');
      } else if (item.kind === 'team') {
        await deleteTeam(ctx, {
          id: item.resourceId as Id<'teams'>,
          operationId: item.operationId,
          expectedCreation: e.creation!,
        });
        if ((await ctx.db.get(item.resourceId as Id<'teams'>))?.removal === 'deleted')
          await finish(ctx, account, item, 'completed');
      } else if (item.kind === 'agent') {
        if (await ctx.db.get(item.resourceId as Id<'agentGrants'>))
          await revokeAgent(ctx, item.resourceId as Id<'agentGrants'>);
        await finish(ctx, account, item, 'completed');
      }
      return null;
    } catch (e) {
      return report(e);
    }
  },
});
