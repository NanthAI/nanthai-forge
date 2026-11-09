// SPDX-License-Identifier: Apache-2.0
import { v } from 'convex/values';
import { internalMutation, internalQuery } from './server';
import type { Doc, Id } from './_generated/dataModel';
import type { QueryCtx } from './_generated/server';
import { accountFor } from './urlIdentity';
import { hostedStartMain } from './projectHostedChannels';
import { historyChunk } from './projectHistoryFields';
import { historyLimit, historyPackPage } from './projectHistoryStore';
import { hostedAcceptanceSchema } from '../src/hosted-acceptance';
import { laneAuthor } from '../src/git-serve-lane-refs';
import { invariant } from '../src/errors';

/** Forge-built main commits (Issue 3bd4a8e9): on a project whose main has no GitHub mirror, the
 * first Git request after landings builds one commit per landing on top of the imported history
 * (or the last Forge commit) and stores them as one Forge pack row. Nothing runs at landing time. */
/** Landings one build reads; a longer backlog continues on the next Git request. */
export const mainBatch = 100;
/** One Git request builds; others list the stored refs (and the gap) until the lease ends. */
export const mainLeaseMs = 2 * 60 * 1000;
const historyRow = (ctx: QueryCtx, projectId: Id<'hostedProjects'>) =>
  ctx.db
    .query('projectHistory')
    .withIndex('by_project', q => q.eq('projectId', projectId))
    .unique();
const packRows = (ctx: QueryCtx, projectId: Id<'hostedProjects'>) =>
  ctx.db
    .query('projectHistoryPacks')
    .withIndex('by_project', q => q.eq('projectId', projectId))
    .take(historyPackPage);

/** Everything one build needs in one query: the landings after the last Forge commit (or the
 * import), their public authors, every pack's chunks and object set, and the Forge rows a
 * build may merge. `current` when main's head already is the newest stored commit. */
export const plan = internalQuery({
  args: { projectId: v.id('hostedProjects') },
  returns: v.any(),
  handler: async (ctx, { projectId }) => {
    const history = await historyRow(ctx, projectId);
    if (!history || history.status !== 'ready') return { status: 'unavailable' };
    const packs = await packRows(ctx, projectId);
    // Main commits go on the imported history; a project whose history came from its mirror
    // (catch-up packs) has commits for main only from that mirror.
    if (packs.some(pack => pack.source === 'catch-up')) return { status: 'unavailable' };
    const forge = packs.filter(pack => pack.source === 'forge');
    const last = forge.at(-1) ?? null;
    const head = (await hostedStartMain(ctx, projectId)).head;
    if ((last?.main?.state ?? history.importState) === head) return { status: 'current' };
    const rows = await ctx.db
      .query('projectHostedAcceptances')
      .withIndex('by_project_and_sequence', q =>
        last
          ? q.eq('projectId', projectId).gt('sequence', last.main!.sequence)
          : q.eq('projectId', projectId),
      )
      .take(mainBatch);
    const authors = new Map<string, string | null>();
    const landings = [];
    for (const row of rows) {
      const receipt = hostedAcceptanceSchema.parse(JSON.parse(row.value));
      if (!authors.has(receipt.actor.id))
        authors.set(receipt.actor.id, (await accountFor(ctx, receipt.actor.id))?.handle ?? null);
      landings.push({
        sequence: row.sequence,
        receiptId: receipt.id,
        state: receipt.candidate.head,
        viewId: receipt.candidate.id,
        at: receipt.at,
        ...(receipt.message !== undefined ? { message: receipt.message } : {}),
        ...(receipt.cohortMessages ? { cohortMessages: receipt.cohortMessages } : {}),
        author: laneAuthor(authors.get(receipt.actor.id) ?? null, receipt.agentRun),
      });
    }
    return {
      status: 'build',
      parent: last
        ? { commit: last.tip, state: last.main!.state, tree: last.main!.tree, listing: last.main!.listing }
        : { commit: history.importCommit, state: history.importState, tree: null, listing: null },
      landings,
      room: historyLimit(history) - history.bytes,
      // Newest first, as scans read them.
      packs: [...packs].reverse().map(pack => ({
        id: pack._id,
        tip: pack.tip,
        chunks: pack.chunks,
        objectSet: pack.objectSet ?? null,
      })),
      forge: forge.map(pack => ({ id: pack._id, tip: pack.tip, bytes: pack.bytes, chunks: pack.chunks })),
    };
  },
});

/** One build per main move: the lease (on the history row's catch-up slot) is taken once by
 * the request that builds; it ends with the recorded pack or after mainLeaseMs. */
export const claim = internalMutation({
  args: { projectId: v.id('hostedProjects'), head: v.string() },
  returns: v.boolean(),
  handler: async (ctx, { projectId, head }) => {
    const row = await historyRow(ctx, projectId);
    if (!row || row.status !== 'ready') return false;
    const now = Date.now();
    if (row.catchUp && row.catchUp.until > now) return false;
    await ctx.db.patch(row._id, { catchUp: { tip: `main:${head}`, until: now + mainLeaseMs } });
    return true;
  },
});

const pin = historyChunk;
/** Records one Forge pack (replacing the Forge rows it merged) unless another build recorded
 * first; returns the R2 objects nothing references any more. Object sets computed for older
 * packs are kept on their rows. */
export const record = internalMutation({
  args: {
    projectId: v.id('hostedProjects'),
    /** The tip the build started from: the last Forge pack's, or the import commit. */
    parent: v.string(),
    pack: v.object({
      tip: v.string(),
      chunks: v.array(pin),
      bytes: v.number(),
      objects: v.number(),
      packSha1: v.string(),
      objectSet: pin,
      main: v.object({ state: v.string(), tree: v.string(), sequence: v.number(), listing: pin }),
    }),
    merged: v.array(v.id('projectHistoryPacks')),
    /** Every commit the pack adds, oldest first: Lanes based on their States build on them. */
    commits: v.array(
      v.object({ state: v.string(), commit: v.string(), tree: v.string(), sequence: v.number() }),
    ),
    objectSets: v.array(v.object({ id: v.id('projectHistoryPacks'), objectSet: pin })),
  },
  returns: v.object({ recorded: v.boolean(), discard: v.array(v.string()), bytes: v.number() }),
  handler: async (ctx, input) => {
    const { projectId, pack } = input;
    const history = await historyRow(ctx, projectId);
    const rows = await packRows(ctx, projectId);
    const last = rows.filter(row => row.source === 'forge').at(-1);
    const fresh = [...pack.chunks, pack.objectSet, pack.main.listing].map(chunk => chunk.sha256);
    // Object sets of older packs hold whatever this build records.
    const unused: string[] = [];
    for (const { id, objectSet } of input.objectSets) {
      const row = rows.find(row => row._id === id);
      if (row && !row.objectSet) await ctx.db.patch(id, { objectSet });
      else if (row?.objectSet?.sha256 !== objectSet.sha256) unused.push(objectSet.sha256);
    }
    if (!history || history.status !== 'ready' || (last?.tip ?? history.importCommit) !== input.parent)
      return { recorded: false, discard: [...fresh, ...unused], bytes: history?.bytes ?? 0 };
    const merged = input.merged.map(id => rows.find(row => row._id === id && row.source === 'forge'));
    invariant(
      merged.every(row => row),
      'GIT_MAIN_CHANGED',
      'The Forge packs to merge changed; retry the Git request.',
    );
    const freed = merged.reduce((sum, row) => sum + row!.bytes, 0);
    invariant(
      history.bytes - freed + pack.bytes <= historyLimit(history),
      'HISTORY_OVER_LIMIT',
      "Forge's commits for main's landings would pass this project's history limit; the project owner can raise it (history limit).",
    );
    const discard: string[] = [];
    for (const row of merged as Doc<'projectHistoryPacks'>[]) {
      discard.push(...[...row.chunks, ...(row.framed ?? [])].map(chunk => chunk.sha256));
      if (row.objectSet) discard.push(row.objectSet.sha256);
      if (row.trees) discard.push(row.trees.sha256);
      if (row.main) discard.push(row.main.listing.sha256);
      await ctx.db.delete(row._id);
    }
    await ctx.db.insert('projectHistoryPacks', {
      projectId,
      tip: pack.tip,
      haves: [input.parent],
      chunks: pack.chunks,
      bytes: pack.bytes,
      objects: pack.objects,
      packSha1: pack.packSha1,
      source: 'forge',
      objectSet: pack.objectSet,
      main: pack.main,
      at: Date.now(),
    });
    for (const commit of input.commits)
      await ctx.db.insert('projectGitMainCommits', { projectId, ...commit });
    const bytes = history.bytes - freed + pack.bytes;
    await ctx.db.patch(history._id, {
      bytes,
      packs: history.packs - merged.length + 1,
      catchUp: undefined,
      updatedAt: Date.now(),
    });
    const kept = new Set(fresh);
    return { recorded: true, discard: [...discard.filter(sha => !kept.has(sha)), ...unused], bytes };
  },
});
