import type { PaginationResult } from 'convex/server';
import { inventoryPage } from './inventoryPage';
import { action } from './cliServer';
// SPDX-License-Identifier: Apache-2.0
import { v } from 'convex/values';
import { paginationOptsValidator, paginationResultValidator } from 'convex/server';
import {
  query,
  mutation,
  internalQuery,
  internalMutation,
  type MutationCtx,
  type QueryCtx,
} from './cliServer';
import type { Doc, Id } from './_generated/dataModel';
import { internal } from './_generated/api';
import { agentDocument, agentFields, agentTool } from './schema';
import { trackArtifact } from './artifacts';
import { invariant } from '../src/errors';
import { report } from './errors';

async function grantOwner(ctx: QueryCtx | MutationCtx, id: Id<'agentGrants'>, owner: string | undefined) {
  const grant = await ctx.db.get(id);
  invariant(owner && grant?.owner === owner, 'AGENT_UNAVAILABLE', 'This agent grant is unavailable.');
  return grant;
}
async function authorized(ctx: MutationCtx, tokenHash: string, tool?: string) {
  const grant = await ctx.db
    .query('agentGrants')
    .withIndex('by_tokenHash', q => q.eq('tokenHash', tokenHash))
    .unique();
  invariant(
    grant && !grant.revoked && grant.expiresAt > Date.now(),
    'AGENT_UNAVAILABLE',
    'This agent grant is unavailable.',
  );
  const job = await ctx.db.get(grant.importId);
  invariant(
    job &&
      !job.removal &&
      job.owner === grant.owner &&
      (job.artifactKey === grant.artifactKey ||
        (await ctx.db
          .query('importArtifacts')
          .withIndex('by_importId_and_artifactKey', q =>
            q.eq('importId', grant.importId).eq('artifactKey', grant.artifactKey),
          )
          .unique())),
    'AGENT_UNAVAILABLE',
    'This agent grant is unavailable.',
  );
  invariant(
    tool === undefined || grant.tools.includes(tool as (typeof grant.tools)[number]),
    'AGENT_TOOL_DENIED',
    'This grant does not allow that tool.',
  );
  return grant;
}
async function event(
  ctx: MutationCtx,
  grant: Doc<'agentGrants'>,
  kind: 'create' | 'revoke' | 'expire' | 'describe' | 'read',
  actor: string,
  tool?: string,
) {
  await ctx.db.insert('agentEvents', {
    agentId: grant._id,
    actor,
    kind,
    at: Date.now(),
    ...(tool ? { tool: tool as (typeof grant.tools)[number] } : {}),
  });
}
export const created = internalQuery({
  args: { owner: v.string(), operationId: v.string() },
  returns: v.union(agentDocument, v.null()),
  handler: (ctx, { owner, operationId }) =>
    ctx.db
      .query('agentGrants')
      .withIndex('by_owner_and_operationId', q => q.eq('owner', owner).eq('operationId', operationId))
      .unique(),
});
export const owned = internalQuery({
  args: { id: v.id('agentGrants'), owner: v.string() },
  returns: agentDocument,
  handler: async (ctx, { id, owner }) => {
    try {
      return await grantOwner(ctx, id, owner);
    } catch (error) {
      return report(error);
    }
  },
});
export const issue = internalMutation({
  args: agentFields,
  returns: agentDocument,
  handler: async (ctx, input) => {
    try {
      const old = await ctx.db
        .query('agentGrants')
        .withIndex('by_owner_and_operationId', q =>
          q.eq('owner', input.owner).eq('operationId', input.operationId),
        )
        .unique();
      if (old) {
        invariant(
          old.request === input.request,
          'AGENT_OPERATION_CHANGED',
          'Retain the original grant request after an unknown outcome.',
        );
        return old;
      }
      const job = await ctx.db.get(input.importId);
      invariant(
        job && !job.removal && job.owner === input.owner && job.artifactKey === input.artifactKey,
        'AGENT_SOURCE_CHANGED',
        'The import changed; choose its source snapshot explicitly.',
      );
      invariant(input.expiresAt > Date.now(), 'BAD_ARGUMENT', 'Choose a future expiry.');
      await trackArtifact(ctx, input.importId, input.artifactKey);
      const id = await ctx.db.insert('agentGrants', input),
        grant = (await ctx.db.get(id))!;
      await event(ctx, grant, 'create', input.owner);
      await ctx.scheduler.runAt(input.expiresAt, internal.agentGrants.expire, { id });
      return grant;
    } catch (error) {
      return report(error);
    }
  },
});
export const authorize = internalMutation({
  args: { tokenHash: v.string(), tool: v.optional(v.string()) },
  returns: agentDocument,
  handler: async (ctx, { tokenHash, tool }) => {
    try {
      return await authorized(ctx, tokenHash, tool);
    } catch (error) {
      return report(error);
    }
  },
});
export const finish = internalMutation({
  args: { tokenHash: v.string(), tool: v.optional(v.string()) },
  returns: v.null(),
  handler: async (ctx, { tokenHash, tool }) => {
    try {
      const grant = await authorized(ctx, tokenHash, tool);
      await event(ctx, grant, tool === undefined ? 'describe' : 'read', `agent:${grant._id}`, tool);
      return null;
    } catch (error) {
      return report(error);
    }
  },
});
export const expire = internalMutation({
  args: { id: v.id('agentGrants') },
  returns: v.null(),
  handler: async (ctx, { id }) => {
    const grant = await ctx.db.get(id);
    if (grant && !grant.revoked && grant.expiresAt <= Date.now()) {
      await ctx.db.patch(id, { revoked: true });
      await event(ctx, grant, 'expire', 'forge:expiry');
    }
    return null;
  },
});
export async function revokeAgent(ctx: MutationCtx, id: Id<'agentGrants'>) {
  const grant = await grantOwner(ctx, id, (await ctx.auth.getUserIdentity())?.subject);
  if (!grant.revoked) {
    await ctx.db.patch(id, { revoked: true });
    await event(ctx, grant, 'revoke', grant.owner);
  }
  return null;
}
export const revoke = mutation({
  args: { id: v.id('agentGrants') },
  returns: v.null(),
  handler: async (ctx, { id }) => {
    try {
      return await revokeAgent(ctx, id);
    } catch (error) {
      return report(error);
    }
  },
});
const item = v.object({
  id: v.id('agentGrants'),
  name: v.string(),
  owner: v.string(),
  importId: v.id('imports'),
  operationId: v.string(),
  repository: v.optional(v.string()),
  sourceId: v.string(),
  gitHead: v.string(),
  files: v.array(v.string()),
  tools: v.array(agentTool),
  expiresAt: v.number(),
  revoked: v.boolean(),
});
export const listRows = internalQuery({
  args: { paginationOpts: paginationOptsValidator },
  returns: paginationResultValidator(item),
  handler: async (ctx, { paginationOpts }) => {
    const user = await ctx.auth.getUserIdentity();
    if (!user) return { page: [], isDone: true, continueCursor: '' };
    const result = await ctx.db
      .query('agentGrants')
      .withIndex('by_owner', q => q.eq('owner', user.subject))
      .order('desc')
      .paginate(paginationOpts);
    return {
      ...result,
      page: await Promise.all(
        result.page.map(async grant => {
          const job = await ctx.db.get(grant.importId);
          return {
            id: grant._id,
            name: grant.name,
            owner: grant.owner,
            importId: grant.importId,
            operationId: grant.operationId,
            ...(job?.owner === user.subject && !job.removal ? { repository: job.repository } : {}),
            sourceId: grant.sourceId,
            gitHead: grant.gitHead,
            files: grant.files,
            tools: grant.tools,
            expiresAt: grant.expiresAt,
            revoked: grant.revoked,
          };
        }),
      ),
    };
  },
});
export const list = action({
  args: { paginationOpts: paginationOptsValidator },
  returns: paginationResultValidator(item),
  handler: (
    ctx,
    args,
  ): Promise<
    PaginationResult<
      Pick<
        Doc<'agentGrants'>,
        | 'name'
        | 'owner'
        | 'importId'
        | 'operationId'
        | 'sourceId'
        | 'gitHead'
        | 'files'
        | 'tools'
        | 'expiresAt'
        | 'revoked'
      > & { id: Id<'agentGrants'>; repository?: string }
    >
  > => inventoryPage(ctx, 'agentGrants:listRows', args),
});
export const audit = query({
  args: { id: v.id('agentGrants'), paginationOpts: paginationOptsValidator },
  returns: paginationResultValidator(
    v.object({ at: v.number(), actor: v.string(), kind: v.string(), tool: v.optional(v.string()) }),
  ),
  handler: async (ctx, { id, paginationOpts }) => {
    try {
      await grantOwner(ctx, id, (await ctx.auth.getUserIdentity())?.subject);
      const result = await ctx.db
        .query('agentEvents')
        .withIndex('by_agentId', q => q.eq('agentId', id))
        .order('desc')
        .paginate(paginationOpts);
      return {
        ...result,
        page: result.page.map(({ at, actor, kind, tool }) => ({
          at,
          actor,
          kind,
          ...(tool ? { tool } : {}),
        })),
      };
    } catch (error) {
      return report(error);
    }
  },
});

export async function purgeAgentGrants(ctx: MutationCtx, importId: Id<'imports'>): Promise<boolean> {
  const grants = await ctx.db
    .query('agentGrants')
    .withIndex('by_importId', q => q.eq('importId', importId))
    .take(20);
  let remaining = grants.length === 20;
  for (const grant of grants) {
    await trackArtifact(ctx, importId, grant.artifactKey);
    const events = await ctx.db
      .query('agentEvents')
      .withIndex('by_agentId', q => q.eq('agentId', grant._id))
      .take(50);
    for (const row of events) await ctx.db.delete(row._id);
    if (events.length === 50) remaining = true;
    else await ctx.db.delete(grant._id);
  }
  return remaining;
}
