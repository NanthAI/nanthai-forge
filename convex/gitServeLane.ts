// SPDX-License-Identifier: Apache-2.0
'use node';
import { v } from 'convex/values';
import { internalAction, type ActionCtx } from './_generated/server';
import { internal } from './_generated/api';
import type { Id } from './_generated/dataModel';
import { storeSourceBytes } from './projectSourceBytes';
import { r2Config, r2Key } from './r2';
import { deleteR2Object } from './r2Operations';
import { digest } from '../src/portable-hash';
import { published } from '../src/hosted-github-mirror';
import { gitHash } from '../src/hosted-github-git';
import { laneCommitBytes, type PackObject } from '../src/git-lane-objects';
import { TreeWork, packListing, readR2, stepIds, storePack, type Alias, type Chunk } from './gitServeTrees';

/** Builds one Lane's Git commit (Issue 09367fb2) the way main's GitHub mirror writes main's:
 * the same published paths, LFS pointers and gitlinks, so the base tree must equal the tree
 * the mirror recorded for the parent commit (checked, never assumed). Git ids come from the
 * alias object, else from the parent commit's trees in the stored history packs (Issue
 * 3bd4a8e9); bytes are read only for blobs the Lane changed and blobs neither knows. */
/** Base blobs missing from the alias object past which the parent's trees are read from the
 * history packs instead of the files. */
export const listingThreshold = 32;
type Plan = {
  status: 'build';
  lane: { head: string; baseHead: string; baseReceiptId: string };
  parent: { commit: string; tree: string; legacy: boolean };
  author: { name: string; email: string };
  aliases: Chunk | null;
  /** History packs' chunks, newest pack first. */
  packs?: Chunk[][];
};

export async function buildLane(ctx: ActionCtx, projectId: Id<'hostedProjects'>, laneId: string, plan: Plan) {
  const started = Date.now();
  const stored = plan.aliases ? await readR2(projectId, plan.aliases.sha256) : null;
  const storedAliases = new Map<string, Alias>(
    stored ? Object.entries(JSON.parse(stored.toString('utf8'))) : [],
  );
  const work = new TreeWork(ctx, projectId, new Map(storedAliases));
  const { lane, parent } = plan;
  const [base, head] = await work.states([lane.baseHead, lane.head]);
  const baseFiles = base!.files.filter(published(parent.legacy ? 'legacy' : 'tracked'));
  const headFiles = head!.files.filter(published('tracked'));
  let aliasesMissing = 0;
  const before = work.metric.readBlobs;
  const baseStep = await work.base(baseFiles, parent.tree, {
    threshold: listingThreshold,
    scan: async () => {
      const found = await packListing(projectId, plan.packs ?? [], parent.tree);
      work.metric.packScanned = found.scanned;
      return found.listing;
    },
    code: 'GIT_LANE_TREE',
    message: `Forge's tree for this Lane's base differs from main's published Git commit ${parent.commit.slice(0, 12)}; no Lane ref was made.`,
  });
  if (!work.metric.listing) aliasesMissing = work.metric.readBlobs - before;
  const headStep = await work.next(baseStep, headFiles);

  // The pack: the commit, the trees and the blobs the parent commit lacks.
  let objects: PackObject[] = [];
  let commit = parent.commit;
  let pack: { chunks: Chunk[]; bytes: number; objects: number } | undefined;
  if (headStep.tree.root !== baseStep.tree.root) {
    const commitBytes = laneCommitBytes({
      tree: headStep.tree.root,
      parent: parent.commit,
      author: plan.author,
      at: head!.at,
      message: head!.message,
      laneId,
      state: lane.head,
    });
    commit = gitHash('commit', commitBytes);
    objects = [{ type: 'commit', bytes: commitBytes }, ...(await work.objects(headStep, stepIds(baseStep)))];
    const stored = await storePack(ctx, projectId, objects);
    pack = { chunks: stored.chunks, bytes: stored.bytes, objects: stored.objects };
  }
  // Aliases of these two States only, so the object stays about two States in size.
  const aliases = work.aliases;
  const used = [...new Set([...baseFiles, ...headFiles].map(file => file.blob))].filter(blob =>
    aliases.has(blob),
  );
  const kept = Object.fromEntries(used.map(blob => [blob, aliases.get(blob)!]));
  let aliasPin: Chunk | undefined;
  if (!plan.aliases || used.some(blob => storedAliases.get(blob)?.join() !== aliases.get(blob)!.join())) {
    const bytes = Buffer.from(JSON.stringify(kept));
    aliasPin = { sha256: digest(bytes), size: bytes.length };
    await storeSourceBytes(ctx, projectId, bytes, aliasPin);
  }
  const { discard } = await ctx.runMutation(internal.gitServeLaneStore.record, {
    projectId,
    laneId,
    head: lane.head,
    baseReceiptId: lane.baseReceiptId,
    commit,
    parent: parent.commit,
    ...(pack ? { pack } : {}),
    ...(aliasPin ? { aliases: aliasPin } : {}),
  });
  for (const sha256 of new Set(discard))
    await deleteR2Object(r2Config(), r2Key(projectId, sha256)).catch(() => {});
  console.log(
    `FORGE_GIT_LANE_METRIC ${JSON.stringify({ projectId, files: headFiles.length, objects: objects.length, packBytes: pack?.bytes ?? 0, ms: Date.now() - started, aliasesMissing, ...work.metric })}`,
  );
  return commit;
}

/** One build per Lane head; a cached head returns at once. */
export const build = internalAction({
  args: { projectId: v.id('hostedProjects'), laneId: v.string() },
  returns: v.string(),
  handler: async (ctx, { projectId, laneId }): Promise<string> => {
    const plan = await ctx.runQuery(internal.gitServeLaneStore.plan, { projectId, laneId });
    if (plan.status === 'cached') return plan.commit as string;
    return buildLane(ctx, projectId, laneId, plan as Plan);
  },
});
