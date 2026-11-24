// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Ferdinando Valsecchi
import { workRecordTable } from './projectWorkRecordTables';
import { v } from 'convex/values';
import { query, type QueryCtx } from './cliServer';
import type { Id } from './_generated/dataModel';
import { recordCaller } from './projectHostedFrictionStore';
import { latestItemIntentHead, legacyItemIntentHead } from './projectItemIntentHeads';
import { verifiedItemMembership } from './projectItemMembershipVersion';
import { recordPartition, selectedGeneration } from './projectWorkIndexStore';
import { isPlanningPrefix, isPlanningUuid, planningIdMaxCandidates } from '../src/planning-id';
import { canonicalPayload } from '../src/hosted-source-operation';
import { invariant } from '../src/errors';
import { report } from './errors';
import { accessibleProject, readProjectRole } from './projectAuthority';
import { readItemAuditHistory } from './projectPlanningAudit';
import { readBacklogWindowAudit } from './projectPlanningWindow';

/** Latest execution Intent status for each Issue, independent of earlier landings. No bodies. */
export const intentStates = query({
  args: { projectId: v.id('hostedProjects'), ids: v.array(v.string()) },
  returns: v.string(),
  handler: async (ctx, { projectId, ids }) => {
    try {
      const { project } = await recordCaller(ctx, projectId);
      invariant(ids.length <= 100, 'BAD_ARGUMENT', 'Read at most 100 Issues at a time.');
      const states: Record<string, string> = {};
      const select =
        project.itemLaneMembership === verifiedItemMembership ? latestItemIntentHead : legacyItemIntentHead;
      for (const id of new Set(ids)) {
        const head = await select(ctx, projectId, id);
        if (head && !head.status.startsWith('journal:')) states[id] = head.status;
      }
      return canonicalPayload(states);
    } catch (error) {
      return report(error);
    }
  },
});

/** Full ids of the planning items whose id starts with `prefix` (8+ hex characters): one range read
 * on the existing by_generation_and_collection_and_key index, at most one key past the candidate
 * limit. No scan, no search, no bodies; `more` says there are further matches. */
export const resolveId = query({
  args: { projectId: v.id('hostedProjects'), prefix: v.string() },
  returns: v.string(),
  handler: async (ctx, { projectId, prefix }) => {
    try {
      const { project } = await recordCaller(ctx, projectId);
      invariant(
        isPlanningPrefix(prefix) && prefix === prefix.toLowerCase(),
        'BAD_ARGUMENT',
        'prefix must be 8 to 35 lowercase hex characters.',
      );
      const generation = await selectedGeneration(ctx, project);
      invariant(generation, 'PROJECT_WORK_INDEX_MISSING', 'The Work index is unavailable.');
      const rows = await planningRootsWithPrefix(
        ctx,
        recordPartition(generation),
        prefix,
        planningIdMaxCandidates + 1,
      );
      return canonicalPayload({
        ids: rows.slice(0, planningIdMaxCandidates).map(row => row.key),
        more: rows.length > planningIdMaxCandidates,
      });
    } catch (error) {
      return report(error);
    }
  },
});

/** The same exact, bounded prefix lookup serves planning commands and the shelved Item page. */
export async function planningRootsWithPrefix(
  ctx: QueryCtx,
  partition: Id<'projectWorkGenerations'>,
  prefix: string,
  limit: number,
) {
  return ctx.db
    .query(await workRecordTable(ctx, partition, 'planningItems'))
    .withIndex('by_generation_and_collection_and_key', q =>
      q
        .eq('generationId', partition)
        .eq('collection', 'planningItems')
        .gte('key', prefix)
        .lt('key', `${prefix}\uffff`),
    )
    .take(limit);
}

/** Bounded, paged audit timeline for one planning Item (Item 1d51c91f). Members only; publicPeople maps actors. */
export const itemHistory = query({
  args: {
    projectId: v.id('hostedProjects'),
    itemId: v.string(),
    limit: v.optional(v.number()),
    cursor: v.optional(v.union(v.string(), v.null())),
  },
  returns: v.string(),
  handler: async (ctx, { projectId, itemId, limit, cursor }) => {
    try {
      const user = await ctx.auth.getUserIdentity();
      invariant(user, 'PROJECT_UNAVAILABLE', 'Sign in to read your Forge project.');
      const project = await accessibleProject(ctx, projectId, user.subject);
      invariant(
        await readProjectRole(ctx, project, user.subject),
        'PROJECT_UNAVAILABLE',
        'Item history is available to project members.',
      );
      invariant(isPlanningUuid(itemId), 'BAD_ARGUMENT', 'itemId: expected the full Item UUID.');
      const generation = await selectedGeneration(ctx, project);
      const partition = generation ? recordPartition(generation) : null;
      return canonicalPayload(await readItemAuditHistory(ctx, project, partition, { itemId, limit, cursor }));
    } catch (error) {
      return report(error);
    }
  },
});

/** Bounded backlog audit view: Items closed, reopened or changed in a UTC window, per Initiative or project-wide. */
export const windowHistory = query({
  args: {
    projectId: v.id('hostedProjects'),
    initiativeId: v.optional(v.string()),
    from: v.string(),
    until: v.optional(v.string()),
    change: v.optional(
      v.union(v.literal('all'), v.literal('closed'), v.literal('reopened'), v.literal('changed')),
    ),
    limit: v.optional(v.number()),
    cursor: v.optional(v.union(v.string(), v.null())),
  },
  returns: v.string(),
  handler: async (ctx, { projectId, initiativeId, from, until, change, limit, cursor }) => {
    try {
      const user = await ctx.auth.getUserIdentity();
      invariant(user, 'PROJECT_UNAVAILABLE', 'Sign in to read your Forge project.');
      const project = await accessibleProject(ctx, projectId, user.subject);
      invariant(
        await readProjectRole(ctx, project, user.subject),
        'PROJECT_UNAVAILABLE',
        'Backlog history is available to project members.',
      );
      if (initiativeId !== undefined)
        invariant(
          isPlanningUuid(initiativeId),
          'BAD_ARGUMENT',
          'initiativeId: expected the full Initiative UUID.',
        );
      const generation = await selectedGeneration(ctx, project);
      const partition = generation ? recordPartition(generation) : null;
      return canonicalPayload(
        await readBacklogWindowAudit(ctx, project, partition, {
          initiativeId,
          from,
          until,
          change,
          limit,
          cursor,
        }),
      );
    } catch (error) {
      return report(error);
    }
  },
});
