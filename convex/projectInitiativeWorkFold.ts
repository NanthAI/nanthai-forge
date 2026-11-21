// SPDX-License-Identifier: Apache-2.0
import { makeFunctionReference } from 'convex/server';
import { v } from 'convex/values';
import type { HostedAcceptance } from '../src/hosted-acceptance';
import type { QueryCtx } from './_generated/server';
import type { Id } from './_generated/dataModel';
import { internalMutation } from './server';
import { acceptanceRow } from './projectHostedAcceptanceStore';
import { hostedRecordBody, recordVersion } from './projectHostedRecords';
import { candidateLandingPaths, landingFileCandidate } from './projectItemWorkDetails';
import {
  activeWorkRoot,
  foldWorkReceipt,
  initiativeWorkSummary,
  itemWorkRoot,
  workCounts,
  WORK_PATHS_PAGE,
} from './projectInitiativeWorkStore';
import { recordPartition, selectedGeneration } from './projectWorkIndexStore';

export async function initiativeLandingPaths(
  ctx: QueryCtx,
  projectId: Id<'hostedProjects'>,
  receiptId: string,
  commit: string,
) {
  const row = await acceptanceRow(ctx, { projectId, receiptId });
  const receipt = row && (JSON.parse(row.value) as HostedAcceptance);
  if (!receipt || receipt.candidate.head !== commit) return null;
  const source = landingFileCandidate(receipt, true);
  const candidate = await recordVersion(ctx, projectId, 'candidate', source.id, 0);
  return candidate && !candidate.purged
    ? candidateLandingPaths(JSON.parse(await hostedRecordBody(ctx, candidate)), source.head)
    : null;
}

const resumeFold = makeFunctionReference<'mutation'>('projectInitiativeWorkFold:fold');
// Leave room for Candidate and membership data even with near-1 MiB legacy Item rows.
const ITEM_PAGE = 12;

export const fold = internalMutation({
  args: {
    projectId: v.id('hostedProjects'),
    receiptId: v.string(),
    commit: v.string(),
    itemIds: v.array(v.string()),
    offset: v.optional(v.number()),
  },
  returns: v.null(),
  handler: async (ctx, input) => {
    const { projectId, receiptId, commit, itemIds, offset = 0 } = input;
    const project = await ctx.db.get(projectId);
    const generation = project && !project.removal && (await selectedGeneration(ctx, project));
    if (!generation) return null;
    const partition = recordPartition(generation);
    const end = Math.min(offset + ITEM_PAGE, itemIds.length);
    const items = await Promise.all(itemIds.slice(offset, end).map(id => itemWorkRoot(ctx, partition, id)));
    const groups = new Set(items.map(row => activeWorkRoot(row, 'issue')?.initiativeId));
    let evidence: ReturnType<typeof initiativeLandingPaths> | undefined;
    const paths = () => (evidence ??= initiativeLandingPaths(ctx, projectId, receiptId, commit));
    let remaining = WORK_PATHS_PAGE;
    let next = end;
    for (const initiativeId of groups) {
      if (!initiativeId) continue;
      const scope = { projectId, initiativeId };
      const summary = await initiativeWorkSummary(ctx, scope);
      // The backfill includes all committed notes through the clear phase.
      // An uninitialized Initiative also includes these notes on its first backfill.
      if (!summary || summary.partition !== partition || summary.rebuild?.phase === 'clear') continue;
      if (remaining === 0) {
        next = offset;
        break;
      }
      const counts = workCounts(summary);
      const { used, pending } = await foldWorkReceipt(ctx, scope, counts, receiptId, paths, remaining);
      remaining -= used;
      if (
        counts.landings !== summary.landings ||
        counts.files !== summary.files ||
        counts.missing !== summary.missing
      )
        await ctx.db.patch(summary._id, { summary: { ...counts, partition, stale: summary.stale } });
      if (pending) {
        next = offset;
        break;
      }
    }
    if (next < itemIds.length) await ctx.scheduler.runAfter(0, resumeFold, { ...input, offset: next });
    return null;
  },
});
