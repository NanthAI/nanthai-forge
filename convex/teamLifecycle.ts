// SPDX-License-Identifier: Apache-2.0
import { v } from 'convex/values';
import { mutation, internalMutation, type MutationCtx } from './cliServer';
import type { Doc } from './_generated/dataModel';
import { internal } from './_generated/api';
import { invariant } from '../src/errors';
import { report } from './errors';
async function schedule(ctx: MutationCtx, team: Doc<'teams'>) {
  if (team.task) {
    const old = await ctx.db.system.get(team.task);
    if (old && ['pending', 'inProgress'].includes(old.state.kind)) return;
  }
  const task = await ctx.scheduler.runAfter(0, internal.teamLifecycle.purge, { id: team._id });
  await ctx.db.patch(team._id, { task });
}
export async function deleteTeam(
  ctx: MutationCtx,
  input: { id: Doc<'teams'>['_id']; operationId: string; expectedCreation: number },
) {
  invariant(
    /^[a-f0-9-]{36}$/i.test(input.operationId),
    'BAD_ARGUMENT',
    'Retain the original team operation UUID.',
  );
  const actor = (await ctx.auth.getUserIdentity())?.subject,
    team = await ctx.db.get(input.id);
  invariant(actor, 'ACCOUNT_UNAVAILABLE', 'Sign in to manage your Forge data.');
  if (!team || team.owner !== actor) return null;
  invariant(
    team._creationTime === input.expectedCreation,
    'ACCOUNT_OPERATION_CHANGED',
    'Reconcile the original team selection.',
  );
  if (team.removalOperation === input.operationId) {
    if (team.removal === 'deleting') await schedule(ctx, team);
    return null;
  }
  invariant(
    team._creationTime === input.expectedCreation && !team.removal,
    'ACCOUNT_CHANGED',
    'This selected team changed. Existing teams are preserved.',
  );
  await ctx.db.patch(team._id, { removal: 'deleting', removalOperation: input.operationId });
  await schedule(ctx, (await ctx.db.get(team._id))!);
  return null;
}
export const permanentlyDelete = mutation({
  args: { id: v.id('teams'), operationId: v.string(), expectedCreation: v.number() },
  returns: v.null(),
  handler: async (ctx, input) => {
    try {
      return await deleteTeam(ctx, input);
    } catch (e) {
      return report(e);
    }
  },
});
export const purge = internalMutation({
  args: { id: v.id('teams') },
  returns: v.null(),
  handler: async (ctx, { id }) => {
    const team = await ctx.db.get(id);
    if (team?.removal !== 'deleting') return null;
    for (const kind of ['teamMembers', 'teamImports'] as const) {
      const rows =
        kind === 'teamMembers'
          ? await ctx.db
              .query(kind)
              .withIndex('by_teamId_and_member', q => q.eq('teamId', id))
              .take(50)
          : await ctx.db
              .query(kind)
              .withIndex('by_teamId_and_importId', q => q.eq('teamId', id))
              .take(50);
      for (const row of rows) await ctx.db.delete(row._id);
      if (rows.length === 50) {
        await ctx.db.patch(id, { task: undefined });
        await schedule(ctx, (await ctx.db.get(id))!);
        return null;
      }
    }
    // Original owner/creation/removal operations are minimal history, not live membership or source access.
    await ctx.db.patch(id, { name: '', removal: 'deleted', task: undefined });
    return null;
  },
});
