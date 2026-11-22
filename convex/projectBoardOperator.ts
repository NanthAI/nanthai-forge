// SPDX-License-Identifier: Apache-2.0
// Operator stop switches for the agent board. Internal only: run with the deployment key, e.g.
//   npx convex run projectBoardOperator:setSwitch '{"scope":"global","off":true,"reason":"..."}'
// Every call writes a boardAudit row. Switches take effect on the next post or read. The account
// switch is the one suspend flag for every message channel (convex/accountLimits.ts).
import { v } from 'convex/values';
import { makeFunctionReference } from 'convex/server';
import { internalMutation, type MutationCtx } from './server';
import type { Id } from './_generated/dataModel';
import { invariant } from '../src/errors';
import { endAccountDevices } from './deviceEndAll';
import { endSessions } from './accountCloseSignIn';
import { isPublicProject } from './publicVisibility';

const scope = v.union(v.literal('global'), v.literal('project'), v.literal('account'));
const PURGE_PAGE = 200;

async function accountOf(ctx: MutationCtx, handle: string) {
  const account = await ctx.db
    .query('forgeAccounts')
    .withIndex('by_handle', q => q.eq('handle', handle))
    .unique();
  const owner =
    account?.owner ??
    (
      await ctx.db
        .query('accountHandles')
        .withIndex('by_handle', q => q.eq('handle', handle))
        .unique()
    )?.owner;
  invariant(owner, 'NOT_FOUND', `No account with handle ${handle}.`);
  return owner;
}

async function targetOf(
  ctx: MutationCtx,
  input: { scope: 'global' | 'project' | 'account'; projectId?: string; handle?: string },
) {
  if (input.scope === 'global') return { key: 'global', label: 'global' };
  if (input.scope === 'project') {
    const id = input.projectId && ctx.db.normalizeId('hostedProjects', input.projectId);
    invariant(id, 'BAD_ARGUMENT', 'projectId names no hosted project.');
    return { key: `project:${id}`, label: `project:${id}`, projectId: id };
  }
  invariant(input.handle, 'BAD_ARGUMENT', 'Name the account by handle.');
  const owner = await accountOf(ctx, input.handle);
  return { key: `account:${owner}`, label: `account:@${input.handle}`, owner };
}

/** Board off (global or one project) or posting suspended (one account); off:false undoes it. */
export const setSwitch = internalMutation({
  args: {
    scope,
    projectId: v.optional(v.string()),
    handle: v.optional(v.string()),
    off: v.boolean(),
    reason: v.string(),
  },
  returns: v.object({ key: v.string(), off: v.boolean() }),
  handler: async (ctx, input) => {
    invariant(input.reason.trim(), 'BAD_ARGUMENT', 'Give a reason; it is kept in the audit row.');
    const target = await targetOf(ctx, input);
    const now = Date.now();
    const row = await ctx.db
      .query('boardSwitches')
      .withIndex('by_key', q => q.eq('key', target.key))
      .unique();
    if (row) await ctx.db.patch(row._id, { off: input.off, at: now });
    else await ctx.db.insert('boardSwitches', { key: target.key, off: input.off, at: now });
    await ctx.db.insert('boardAudit', {
      action: input.off ? (input.scope === 'account' ? 'suspend' : 'off') : 'on',
      target: target.label,
      reason: input.reason,
      at: now,
    });
    if ('owner' in target && target.owner) {
      // The account switch stops every message channel at once (convex/accountLimits.ts). Suspending
      // also signs out its CLI devices and browser sessions; either way its public listing follows.
      if (input.off) {
        await endAccountDevices(ctx, target.owner, now);
        await endSessions(ctx, target.owner);
      }
      await relistAccount(ctx, target.owner, input.off, null);
    }
    return { key: target.label, off: input.off };
  },
});

const LISTING_PAGE = 100;
/** Unlists (suspend) or relists (lift) the account's public projects, one bounded page per
 * transaction; continues through the scheduler. Relisting re-applies each project's visibility. */
async function relistAccount(ctx: MutationCtx, owner: string, suspended: boolean, cursor: string | null) {
  const page = await ctx.db
    .query('projectPublic')
    .withIndex('by_owner_and_listed', q => q.eq('owner', owner).eq('listed', suspended))
    .paginate({ cursor, numItems: LISTING_PAGE });
  for (const row of page.page) {
    if (suspended) await ctx.db.patch(row._id, { listed: false });
    else if (isPublicProject(await ctx.db.get(row.projectId))) await ctx.db.patch(row._id, { listed: true });
  }
  if (!page.isDone)
    await ctx.scheduler.runAfter(0, makeFunctionReference<'mutation'>('projectBoardOperator:relist'), {
      owner,
      suspended,
      cursor: page.continueCursor,
    });
}
export const relist = internalMutation({
  args: { owner: v.string(), suspended: v.boolean(), cursor: v.string() },
  returns: v.null(),
  handler: async (ctx, input) => {
    // A switch flipped again meanwhile wins: stop this continuation.
    const row = await ctx.db
      .query('boardSwitches')
      .withIndex('by_key', q => q.eq('key', `account:${input.owner}`))
      .unique();
    if (Boolean(row?.off) === input.suspended)
      await relistAccount(ctx, input.owner, input.suspended, input.cursor);
    return null;
  },
});

/** Delete a project's or an account's message bodies, 200 per transaction, continuing through
 * the scheduler until none are left. Evidence metadata (no bodies) is kept. */
export const purge = internalMutation({
  args: {
    scope: v.union(v.literal('project'), v.literal('account')),
    projectId: v.optional(v.string()),
    handle: v.optional(v.string()),
    reason: v.string(),
    auditId: v.optional(v.id('boardAudit')),
  },
  returns: v.object({ deleted: v.number(), done: v.boolean() }),
  handler: async (ctx, input) => {
    invariant(input.reason.trim(), 'BAD_ARGUMENT', 'Give a reason; it is kept in the audit row.');
    const target = await targetOf(ctx, input);
    const auditId =
      input.auditId ??
      (await ctx.db.insert('boardAudit', {
        action: 'purge',
        target: target.label,
        reason: input.reason,
        at: Date.now(),
        detail: JSON.stringify({ deleted: 0, done: false }),
      }));
    const rows =
      'projectId' in target && target.projectId
        ? await ctx.db
            .query('projectBoardMessages')
            .withIndex('by_project_and_id', q => q.eq('projectId', target.projectId!))
            .take(PURGE_PAGE)
        : await ctx.db
            .query('projectBoardMessages')
            .withIndex('by_author_and_at', q => q.eq('author', (target as { owner: string }).owner))
            .take(PURGE_PAGE);
    const perProject = new Map<Id<'hostedProjects'>, number>();
    for (const row of rows) {
      await ctx.db.delete(row._id);
      perProject.set(row.projectId, (perProject.get(row.projectId) ?? 0) + 1);
    }
    for (const [projectId, count] of perProject) {
      const counter = await ctx.db
        .query('projectBoardProjects')
        .withIndex('by_project', q => q.eq('projectId', projectId))
        .unique();
      if (counter) await ctx.db.patch(counter._id, { live: Math.max(0, counter.live - count) });
    }
    const audit = await ctx.db.get(auditId);
    const total =
      (audit?.detail ? (JSON.parse(audit.detail) as { deleted: number }).deleted : 0) + rows.length;
    const done = rows.length < PURGE_PAGE;
    await ctx.db.patch(auditId, { detail: JSON.stringify({ deleted: total, done }) });
    if (!done)
      await ctx.scheduler.runAfter(0, makeFunctionReference<'mutation'>('projectBoardOperator:purge'), {
        ...input,
        auditId,
      });
    return { deleted: rows.length, done };
  },
});
