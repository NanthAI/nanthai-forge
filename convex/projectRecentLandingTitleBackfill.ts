// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Ferdinando Valsecchi
import { getDocumentSize, v } from 'convex/values';
import { internalMutation } from './server';
import { landingMessageText } from './projectHostedLandingMessageBody';
import { lineSummary } from './projectLiveLineStore';
import { recentLandingReceipts } from './projectRecentLandings';
import { recentLandingTitle, type RecentLandingTitle } from './projectRecentLandingTitles';
import type { HostedAcceptance } from '../src/hosted-acceptance';

/** One project per transaction, never scheduled. Acceptance and repair update the same summary
 * transactionally. Replays keep the projected titles and make no write once the window is complete. */
export const page = internalMutation({
  args: { cursor: v.union(v.string(), v.null()) },
  returns: v.object({
    cursor: v.union(v.string(), v.null()),
    projectId: v.union(v.id('hostedProjects'), v.null()),
    receipts: v.number(),
    titled: v.number(),
    messageReads: v.number(),
    receiptBytes: v.number(),
    summaryBytesBefore: v.number(),
    summaryBytesAfter: v.number(),
    patched: v.boolean(),
  }),
  handler: async (ctx, { cursor }) => {
    const page = await ctx.db
      .query('hostedProjects')
      .withIndex('by_creation_time', q => q)
      .paginate({ cursor, numItems: 1 });
    const project = page.page[0];
    const result = {
      cursor: page.isDone ? null : page.continueCursor,
      projectId: project?._id ?? null,
      receipts: 0,
      titled: 0,
      messageReads: 0,
      receiptBytes: 0,
      summaryBytesBefore: 0,
      summaryBytesAfter: 0,
      patched: false,
    };
    if (!project || project.removal) return result;
    const rows = await recentLandingReceipts(ctx.db, project._id);
    if (!rows.length) return result;
    const old = await lineSummary(ctx.db, project._id);
    const value = old ? JSON.parse(old.value) : {};
    const titles: RecentLandingTitle[] = value.recentTitles ?? [];
    const known = new Map(titles);
    const recentTitles = await Promise.all(
      rows.map(async (row): Promise<RecentLandingTitle> => {
        result.receiptBytes += getDocumentSize(row);
        if (known.has(row.receiptId)) return [row.receiptId, known.get(row.receiptId) ?? null];
        const receipt = JSON.parse(row.value) as HostedAcceptance;
        if (receipt.messageRef !== undefined) result.messageReads++;
        return [row.receiptId, recentLandingTitle(await landingMessageText(ctx, project._id, receipt))];
      }),
    );
    result.receipts = rows.length;
    result.titled = recentTitles.filter(([, title]) => title !== null).length;
    result.summaryBytesBefore = old ? getDocumentSize(old) : 0;
    result.summaryBytesAfter = result.summaryBytesBefore;
    if (JSON.stringify(recentTitles) === JSON.stringify(titles)) return result;
    const next = {
      kind: 'projectLiveLineSummary',
      sourceId: String(project._id),
      projectId: project._id,
      value: JSON.stringify({ ...value, recentTitles }),
    };
    if (old) await ctx.db.patch(old._id, { value: next.value });
    else await ctx.db.insert('projectFinishReadRows', next);
    result.summaryBytesAfter = getDocumentSize(old ? { ...old, ...next } : next);
    result.patched = true;
    return result;
  },
});
