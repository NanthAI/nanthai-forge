// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Ferdinando Valsecchi
import { retainMembership } from './projectActorNames';
import { markLeftTeam } from './sealedSecretMarkers';
import { report } from './errors';
import { v } from 'convex/values';
import { internalMutation, type MutationCtx } from './server';
import type { Doc, Id } from './_generated/dataModel';
import { syncPersonOrder } from './accountProjectOrder';
import {
  accountActor,
  resourceMark,
  ownedMetadata,
  incomingCurrent,
  type ResourceKind,
  type LeaveKind,
} from './accountResources';
import { metadataBytes } from './accountMetadata';
import { deleteImport } from './lifecycle';
import { transition } from './projectLifecycle';
import { deleteTeam } from './teamLifecycle';
import { revokeAgent } from './agentGrants';
import { invariant } from '../src/errors';
import { digest } from '../src/state/hash';
import { accountItemState } from './accountTypes';

async function finish(
  ctx: MutationCtx,
  account: Doc<'accountOperations'>,
  item: Doc<'accountItems'>,
  state: 'completed' | 'changed',
) {
  await ctx.db.patch(item._id, { state });
  await ctx.db.patch(account._id, {
    pending: account.pending - 1,
    stage: 'running',
    ...(state === 'changed' ? { kept: (account.kept ?? 0) + 1 } : {}),
  });
}
async function leave(ctx: MutationCtx, item: Doc<'accountItems'>, actor: string) {
  if (item.kind === 'projects') {
    const row = await ctx.db.get(item.resourceId as Id<'projectContributors'>);
    if (row) await retainMembership(ctx, row.projectId, actor);
  } else if (item.kind === 'teams') {
    // Leaving a team ends the write it gave: marked for sealed-secret removal where nothing else gives it. A team
    // being deleted already gives none, and its purge reads only members still listed, so this marks now too.
    const row = await ctx.db.get(item.resourceId as Id<'teamMembers'>),
      team = row && (await ctx.db.get(row.teamId));
    if (row) await ctx.db.delete(row._id);
    if (team) await markLeftTeam(ctx, team, actor);
    return;
  } else if (item.kind === 'projectReaders') {
    // As the owner removing a reader does (projectReaders.setReader): their name is kept, the read goes, their
    // project order follows.
    const row = await ctx.db.get(item.resourceId as Id<'projectReaders'>);
    if (row) {
      await retainMembership(ctx, row.projectId, actor);
      await ctx.db.delete(row._id);
      await syncPersonOrder(ctx, row.projectId, actor);
    }
    return;
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
  // What is left is a reader or contributor row of the kind the item names.
  await ctx.db.delete(item.resourceId as Id<'importReaders'>);
}
// Selection, authority, child-operation start and personal cleanup share ONE transaction.
export const step = internalMutation({
  args: { operationId: v.string(), itemId: v.id('accountItems') },
  /** The item's state after this step. `started`: its removal is still running elsewhere; `mark` is the resource as
   * this step left it (accountData.watch compares against it). */
  returns: v.object({ state: accountItemState, mark: v.optional(v.string()) }),
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
      if (item.state === 'completed' || item.state === 'changed') return { state: item.state };
      if (item.state === 'pending') {
        const value = item.hidden
          ? await incomingCurrent(ctx, item.kind as LeaveKind, item.resourceId, actor)
          : await ownedMetadata(ctx, item.kind as ResourceKind, item.resourceId, actor);
        // Pinned at selection; checked in this transaction (no separate read from the action).
        if (!value || digest(metadataBytes(value)) !== item.pin) {
          await finish(ctx, account, item, 'changed');
          return { state: 'changed' as const };
        }
        if (item.hidden) {
          await leave(ctx, item, actor);
          await finish(ctx, account, item, 'completed');
          return { state: 'completed' as const };
        }
        if (item.kind === 'view' || item.kind === 'interest') {
          await ctx.db.delete(item.resourceId as Id<'savedViews'>);
          await finish(ctx, account, item, 'completed');
          return { state: 'completed' as const };
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
          { confirmed: true },
        );
        if ((await ctx.db.get(item.resourceId as Id<'hostedProjects'>))?.removal === 'deleted')
          await finish(ctx, account, item, 'completed');
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
      const state = (await ctx.db.get(item._id))!.state;
      return state === 'started'
        ? { state, mark: await resourceMark(ctx, item.kind as ResourceKind, item.resourceId) }
        : { state };
    } catch (e) {
      return report(e);
    }
  },
});
