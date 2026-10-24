// SPDX-License-Identifier: Apache-2.0
import { report } from './errors';
import { v } from 'convex/values';
import { paginationOptsValidator } from 'convex/server';
import { internalQuery, type QueryCtx, type MutationCtx } from './_generated/server';
import type { Id } from './_generated/dataModel';
import { resourceKind, leaveKind } from './accountTypes';
import { invariant } from '../src/errors';

export type ResourceKind = 'project' | 'import' | 'secret' | 'agent' | 'team' | 'view' | 'interest';
export type LeaveKind = 'readers' | 'zones' | 'teams' | 'projects' | 'secrets';
export async function accountActor(ctx: QueryCtx | MutationCtx) {
  const user = await ctx.auth.getUserIdentity();
  invariant(user, 'ACCOUNT_UNAVAILABLE', 'Sign in to manage your Forge data.');
  return user.subject;
}
// Selected public metadata only. Immutable source, encrypted versions and bearer material stay with their resource owners.
export async function ownedMetadata(
  ctx: QueryCtx | MutationCtx,
  kind: ResourceKind,
  id: string,
  actor: string,
) {
  const table = {
    project: 'hostedProjects',
    import: 'imports',
    secret: 'secretObjects',
    agent: 'agentGrants',
    team: 'teams',
    view: 'savedViews',
    interest: 'projectInterests',
  } as const;
  if (!ctx.db.normalizeId(table[kind], id)) return null;
  if (kind === 'project') {
    const r = await ctx.db.get(id as Id<'hostedProjects'>);
    return r?.owner === actor
      ? {
          id: r._id,
          name: r.name,
          key: r.key,
          revision: r.revision,
          currentBackup: r.currentBackup,
          removal: r.removal ?? null,
        }
      : null;
  }
  if (kind === 'import') {
    const r = await ctx.db.get(id as Id<'imports'>);
    return r?.owner === actor && r.visibility === 'private'
      ? {
          id: r._id,
          repository: r.repository,
          ref: r.ref,
          phase: r.phase,
          generation: r.generation,
          removal: r.removal ?? null,
        }
      : null;
  }
  if (kind === 'secret') {
    const r = await ctx.db.get(id as Id<'secretObjects'>);
    return r?.owner === actor && !r.deleting
      ? {
          id: r._id,
          name: r.name,
          repository: r.repository,
          ref: r.ref,
          version: r.version,
          policyRevision: r.policyRevision,
          archiveRevision: r.archiveRevision ?? 0,
          archived: !!r.archived,
          disabled: r.disabled,
        }
      : null;
  }
  if (kind === 'agent') {
    const r = await ctx.db.get(id as Id<'agentGrants'>);
    return r?.owner === actor
      ? {
          id: r._id,
          name: r.name,
          importId: r.importId,
          sourceId: r.sourceId,
          gitHead: r.gitHead,
          files: r.files,
          tools: r.tools,
          expiresAt: r.expiresAt,
          revoked: r.revoked,
        }
      : null;
  }
  if (kind === 'team') {
    const r = await ctx.db.get(id as Id<'teams'>);
    return r?.owner === actor && !r.removal
      ? { id: r._id, name: r.name, creation: r._creationTime, removal: r.removal ?? null }
      : null;
  }
  if (kind === 'view') {
    const r = await ctx.db.get(id as Id<'savedViews'>);
    return r?.owner === actor ? { id: r._id, name: r.name, importId: r.importId, route: r.route } : null;
  }
  const r = await ctx.db.get(id as Id<'projectInterests'>);
  return r?.owner === actor
    ? {
        id: r._id,
        importId: r.importId,
        repository: r.repository,
        ref: r.ref,
        starred: r.starred,
        watching: r.watching,
        seenHead: r.seenHead,
        active: r.active,
        revision: r.revision,
      }
    : null;
}
export const page = internalQuery({
  args: { kind: resourceKind, paginationOpts: paginationOptsValidator },
  returns: v.any(),
  handler: async (ctx, { kind, paginationOpts }) => {
    try {
      const actor = await accountActor(ctx);
      const result =
        kind === 'project'
          ? await ctx.db
              .query('hostedProjects')
              .withIndex('by_owner', q => q.eq('owner', actor))
              .paginate(paginationOpts)
          : kind === 'import'
            ? await ctx.db
                .query('imports')
                .withIndex('by_owner_and_visibility', q => q.eq('owner', actor).eq('visibility', 'private'))
                .paginate(paginationOpts)
            : kind === 'secret'
              ? await ctx.db
                  .query('secretObjects')
                  .withIndex('by_owner_and_operationId', q => q.eq('owner', actor))
                  .paginate(paginationOpts)
              : kind === 'agent'
                ? await ctx.db
                    .query('agentGrants')
                    .withIndex('by_owner', q => q.eq('owner', actor))
                    .paginate(paginationOpts)
                : kind === 'team'
                  ? await ctx.db
                      .query('teams')
                      .withIndex('by_owner_and_operationId', q => q.eq('owner', actor))
                      .paginate(paginationOpts)
                  : kind === 'view'
                    ? await ctx.db
                        .query('savedViews')
                        .withIndex('by_owner', q => q.eq('owner', actor))
                        .paginate(paginationOpts)
                    : await ctx.db
                        .query('projectInterests')
                        .withIndex('by_owner_and_importId', q => q.eq('owner', actor))
                        .paginate(paginationOpts);
      const page = [];
      for (const r of result.page) {
        const metadata = await ownedMetadata(ctx, kind, r._id, actor);
        if (metadata) page.push(metadata);
      }
      return { page, isDone: result.isDone, continueCursor: result.continueCursor };
    } catch (e) {
      return report(e);
    }
  },
});
export const current = internalQuery({
  args: { kind: resourceKind, id: v.string() },
  returns: v.any(),
  handler: async (ctx, { kind, id }) => ownedMetadata(ctx, kind, id, await accountActor(ctx)),
});
export const incoming = internalQuery({
  args: { kind: leaveKind, paginationOpts: paginationOptsValidator, through: v.number() },
  returns: v.any(),
  handler: async (ctx, { kind, paginationOpts, through }) => {
    try {
      const actor = await accountActor(ctx),
        result =
          kind === 'readers'
            ? await ctx.db
                .query('importReaders')
                .withIndex('by_reader_and_importId', q => q.eq('reader', actor))
                .paginate(paginationOpts)
            : kind === 'zones'
              ? await ctx.db
                  .query('zoneReaders')
                  .withIndex('by_reader_and_zoneId', q => q.eq('reader', actor))
                  .paginate(paginationOpts)
              : kind === 'teams'
                ? await ctx.db
                    .query('teamMembers')
                    .withIndex('by_member_and_teamId', q => q.eq('member', actor))
                    .paginate(paginationOpts)
                : kind === 'projects'
                  ? await ctx.db
                      .query('projectContributors')
                      .withIndex('by_contributor', q => q.eq('contributor', actor))
                      .paginate(paginationOpts)
                  : await ctx.db
                      .query('secretGrants')
                      .withIndex('by_principal_and_discover_and_secretId', q => q.eq('principal', actor))
                      .paginate(paginationOpts);
      // Internal selection only: no hidden SecretObject name, identifier or count is returned by public inventory/receipts.
      const page = [];
      for (const r of result.page) {
        if (r._creationTime > through) continue;
        const parent =
          kind === 'readers'
            ? await ctx.db.get((r as { importId: Id<'imports'> }).importId)
            : kind === 'zones'
              ? await ctx.db.get((r as { zoneId: Id<'sourceZones'> }).zoneId)
              : kind === 'teams'
                ? await ctx.db.get((r as { teamId: Id<'teams'> }).teamId)
                : kind === 'projects'
                  ? await ctx.db.get((r as { projectId: Id<'hostedProjects'> }).projectId)
                  : await ctx.db.get((r as { secretId: Id<'secretObjects'> }).secretId);
        if (parent?.owner !== actor) page.push(r);
      }
      return { page, isDone: result.isDone, continueCursor: result.continueCursor };
    } catch (e) {
      return report(e);
    }
  },
});

export async function incomingCurrent(
  ctx: QueryCtx | MutationCtx,
  kind: LeaveKind,
  id: string,
  actor: string,
) {
  const table = {
    readers: 'importReaders',
    zones: 'zoneReaders',
    teams: 'teamMembers',
    projects: 'projectContributors',
    secrets: 'secretGrants',
  } as const;
  if (!ctx.db.normalizeId(table[kind], id)) return null;
  if (kind === 'readers') {
    const r = await ctx.db.get(id as Id<'importReaders'>);
    return r?.reader === actor && (await ctx.db.get(r.importId))?.owner !== actor ? r : null;
  }
  if (kind === 'zones') {
    const r = await ctx.db.get(id as Id<'zoneReaders'>);
    return r?.reader === actor && (await ctx.db.get(r.zoneId))?.owner !== actor ? r : null;
  }
  if (kind === 'teams') {
    const r = await ctx.db.get(id as Id<'teamMembers'>);
    return r?.member === actor && (await ctx.db.get(r.teamId))?.owner !== actor ? r : null;
  }
  if (kind === 'projects') {
    const r = await ctx.db.get(id as Id<'projectContributors'>);
    return r?.contributor === actor && (await ctx.db.get(r.projectId))?.owner !== actor ? r : null;
  }
  const r = await ctx.db.get(id as Id<'secretGrants'>);
  return r?.principal === actor && (await ctx.db.get(r.secretId))?.owner !== actor ? r : null;
}
export const relation = internalQuery({
  args: { kind: leaveKind, id: v.string() },
  returns: v.any(),
  handler: async (ctx, { kind, id }) => incomingCurrent(ctx, kind, id, await accountActor(ctx)),
});
