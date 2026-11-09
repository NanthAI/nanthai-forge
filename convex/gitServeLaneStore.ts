// SPDX-License-Identifier: Apache-2.0
import { v } from 'convex/values';
import { internalMutation, internalQuery } from './server';
import type { MutationCtx, QueryCtx } from './_generated/server';
import type { Doc, Id } from './_generated/dataModel';
import { accountFor } from './urlIdentity';
import { historyChunk } from './projectHistoryFields';
import { resolveObjects } from './projectGithubMirrorObjects';
import { githubSyncCommitSchema } from '../src/github-sync-types';
import { laneAuthor } from '../src/git-serve-lane-refs';
import { ForgeError, invariant } from '../src/errors';

/** Lane refs over Git (Issue 09367fb2). Lane commits are built on the first Git fetch of a
 * saved head and cached here per Lane; saves never write Git objects. */
type Ctx = QueryCtx | MutationCtx;
/** Built Lane refs one listing reads (newest first), besides Lanes it names. */
export const laneRefPage = 50;

/** Lane refs are unlanded work: project members only (owner, contributors and readers it
 * granted), never an anonymous or signed-in stranger on a public project. */
export async function isMember(ctx: Ctx, project: Doc<'hostedProjects'>, actor: string) {
  if (!actor) return false;
  if (project.owner === actor) return true;
  const contributor = await ctx.db
    .query('projectContributors')
    .withIndex('by_project_and_contributor', q => q.eq('projectId', project._id).eq('contributor', actor))
    .unique();
  if (contributor) return true;
  return !!(await ctx.db
    .query('projectReaders')
    .withIndex('by_project_and_reader', q => q.eq('projectId', project._id).eq('reader', actor))
    .unique());
}
const laneRow = (ctx: Ctx, projectId: Id<'hostedProjects'>, laneId: string) =>
  ctx.db
    .query('projectHostedOverlapLanes')
    .withIndex('by_project_and_lane', q => q.eq('projectId', projectId).eq('laneId', laneId))
    .unique();
const commitRow = (ctx: Ctx, projectId: Id<'hostedProjects'>, laneId: string) =>
  ctx.db
    .query('projectGitLaneCommits')
    .withIndex('by_project_and_lane', q => q.eq('projectId', projectId).eq('laneId', laneId))
    .unique();
const current = (row: Doc<'projectGitLaneCommits'>, lane: Doc<'projectHostedOverlapLanes'> | null) =>
  !!lane?.open && lane.head === row.head && lane.baseReceiptId === row.baseReceiptId;

/** Most Lane commits a fetch looks up by its wants. */
export const wantLookups = 16;
/** Built commits of open Lanes whose saved head has not moved: for a ref listing the newest
 * page plus the Lanes it names, for a fetch the rows of its wanted commits. Each is one cache
 * row and one Lane row; a Lane not built yet is not listed. */
export async function laneRefs(
  ctx: Ctx,
  projectId: Id<'hostedProjects'>,
  input: { list: boolean; named: string[]; commits: string[] },
) {
  const rows = input.list
    ? await ctx.db
        .query('projectGitLaneCommits')
        .withIndex('by_project', q => q.eq('projectId', projectId))
        .order('desc')
        .take(laneRefPage)
    : [];
  const add = (row: Doc<'projectGitLaneCommits'> | null) => {
    if (row && !rows.some(seen => seen._id === row._id)) rows.push(row);
  };
  for (const laneId of input.named) add(await commitRow(ctx, projectId, laneId));
  for (const commit of input.commits.slice(0, wantLookups))
    add(
      (
        await ctx.db
          .query('projectGitLaneCommits')
          .withIndex('by_project_and_commit', q => q.eq('projectId', projectId).eq('commit', commit))
          .take(1)
      )[0] ?? null,
    );
  const refs = [];
  for (const row of rows)
    if (current(row, await laneRow(ctx, projectId, row.laneId)))
      refs.push({
        laneId: row.laneId,
        commit: row.commit,
        pack: row.pack ? { tip: row.commit, ...row.pack } : null,
      });
  return refs;
}

/** The parent of a Lane commit: main's Git commit for the Lane's base, as main's GitHub
 * mirror published it (the exact receipt first, else another publication of that State). */
async function baseCommit(ctx: Ctx, projectId: Id<'hostedProjects'>, lane: Doc<'projectHostedOverlapLanes'>) {
  const parse = (mapping: string | null | undefined) => {
    const value = mapping ? githubSyncCommitSchema.parse(JSON.parse(mapping)) : null;
    return value?.state === lane.baseHead ? value : null;
  };
  const jobs = [
    ...(await ctx.db
      .query('projectGithubMirrorJobs')
      .withIndex('by_project_and_receipt', q =>
        q.eq('projectId', projectId).eq('receiptId', lane.baseReceiptId),
      )
      .take(4)),
    ...(await ctx.db
      .query('projectGithubMirrorJobs')
      .withIndex('by_project_and_state', q => q.eq('projectId', projectId).eq('state', lane.baseHead))
      .order('desc')
      .take(8)),
  ];
  for (const job of jobs) {
    const value = job.status === 'done' && !job.inbound ? parse(job.mapping) : null;
    if (value) return value;
  }
  const mirror = await ctx.db
    .query('projectGithubMirrors')
    .withIndex('by_project', q => q.eq('projectId', projectId))
    .unique();
  return parse(mirror?.mapping);
}

/** What one build needs, in one query: the Lane's head and base, the parent commit and its
 * GitHub tree, the public author and the alias object. */
export const plan = internalQuery({
  args: { projectId: v.id('hostedProjects'), laneId: v.string() },
  returns: v.any(),
  handler: async (ctx, { projectId, laneId }) => {
    const lane = await laneRow(ctx, projectId, laneId);
    invariant(lane?.open, 'GIT_LANE_UNAVAILABLE', `Lane ${laneId} is not an open Lane of this project.`);
    const cached = await commitRow(ctx, projectId, laneId);
    if (cached && current(cached, lane)) return { status: 'cached', commit: cached.commit };
    const parent = await baseCommit(ctx, projectId, lane);
    if (!parent)
      throw new ForgeError(
        'GIT_LANE_BASE_UNPUBLISHED',
        `Lane ${laneId} starts from a main State (${lane.baseHead.slice(0, 12)}) that has no Git commit yet. Sync the Lane to current main, or retry once main's mirror has published it.`,
      );
    const history = await ctx.db
      .query('projectHistory')
      .withIndex('by_project', q => q.eq('projectId', projectId))
      .unique();
    const account = await accountFor(ctx, lane.actor);
    return {
      status: 'build',
      lane: { head: lane.head, baseHead: lane.baseHead, baseReceiptId: lane.baseReceiptId },
      parent: { commit: parent.commit, tree: parent.tree, legacy: parent.publication !== 'tracked' },
      author: laneAuthor(account?.handle ?? null, lane.agent),
      aliases: history?.laneAliases ?? null,
    };
  },
});

/** Source objects for a build; the HTTP action checked membership before the build ran. */
export const resolve = internalQuery({
  args: { projectId: v.id('hostedProjects'), digests: v.array(v.string()) },
  returns: v.string(),
  handler: async (ctx, input) => resolveObjects(ctx, input.projectId, input.digests),
});

/** Closed-Lane rows one record removes, oldest first, with their R2 packs. */
const pruneWindow = 16;
const chunkSet = (row: Doc<'projectGitLaneCommits'> | null) =>
  row?.pack?.chunks.map(chunk => chunk.sha256) ?? [];
/** Records a build unless the Lane moved meanwhile. Returns the R2 objects nothing references
 * any more: a replaced pack and alias object, and packs of closed Lanes (bounded window). */
export const record = internalMutation({
  args: {
    projectId: v.id('hostedProjects'),
    laneId: v.string(),
    head: v.string(),
    baseReceiptId: v.string(),
    commit: v.string(),
    parent: v.string(),
    pack: v.optional(v.object({ chunks: v.array(historyChunk), bytes: v.number(), objects: v.number() })),
    aliases: v.optional(historyChunk),
  },
  returns: v.object({ recorded: v.boolean(), discard: v.array(v.string()) }),
  handler: async (ctx, input) => {
    const { aliases, ...fields } = input;
    const discard: string[] = [];
    const history = await ctx.db
      .query('projectHistory')
      .withIndex('by_project', q => q.eq('projectId', input.projectId))
      .unique();
    if (aliases && history && history.laneAliases?.sha256 !== aliases.sha256) {
      if (history.laneAliases) discard.push(history.laneAliases.sha256);
      await ctx.db.patch(history._id, { laneAliases: aliases });
    } else if (aliases && !history) discard.push(aliases.sha256);
    const lane = await laneRow(ctx, input.projectId, input.laneId);
    const existing = await commitRow(ctx, input.projectId, input.laneId);
    const recorded = !!lane?.open && lane.head === input.head && lane.baseReceiptId === input.baseReceiptId;
    if (!recorded) discard.push(...chunkSet({ pack: input.pack } as Doc<'projectGitLaneCommits'>));
    else if (existing?.commit !== input.commit) {
      discard.push(...chunkSet(existing));
      if (existing) await ctx.db.replace(existing._id, { ...fields, at: Date.now() });
      else await ctx.db.insert('projectGitLaneCommits', { ...fields, at: Date.now() });
    }
    const oldest = await ctx.db
      .query('projectGitLaneCommits')
      .withIndex('by_project', q => q.eq('projectId', input.projectId))
      .take(pruneWindow);
    for (const row of oldest) {
      if (row.laneId === input.laneId || (await laneRow(ctx, input.projectId, row.laneId))?.open) continue;
      discard.push(...chunkSet(row));
      await ctx.db.delete(row._id);
    }
    return { recorded, discard };
  },
});
