// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Ferdinando Valsecchi
// Loose ends details (Item fc1831eb): the one-time backfill of what new writes now keep current. Two bounded passes,
// each self-continuing, upserts only (a rerun writes nothing new):
//   projects: per project, the stored size on its live-line summary row (the open-Lane count is read, not stored);
//   lanes:    per open Lane that landed before and was saved again, the presence row's landed-before flag.
// A saves count and a check-pass stamp cannot be rebuilt (no record keeps them), so those rows stay "not recorded"
// until the Lane's next save; nothing is guessed. Cost, once: PROJECT_PAGE projects per run (a summary row and at most 8 size rows each) and LANE_PAGE overlap rows per run
// (one presence patch for a Lane that needs it); idle runs read nothing.
import { v } from 'convex/values';
import { internal } from './_generated/api';
import { internalMutation } from './server';
import { lineSummary } from './projectLiveLineStore';
import { projectBytes, type OpenSummary } from './projectLiveLineOpen';

const PROJECT_PAGE = 10;
const LANE_PAGE = 50;

export const backfill = internalMutation({
  args: {
    stage: v.optional(v.union(v.literal('projects'), v.literal('lanes'))),
    cursor: v.optional(v.union(v.string(), v.null())),
  },
  returns: v.object({ stage: v.string(), rows: v.number(), isDone: v.boolean() }),
  handler: async (ctx, input) => {
    const stage = input.stage ?? 'projects';
    const cursor = input.cursor ?? null;
    let rows = 0;
    let next: { stage: 'projects' | 'lanes'; cursor: string | null } | null = null;
    if (stage === 'projects') {
      const page = await ctx.db.query('hostedProjects').paginate({ cursor, numItems: PROJECT_PAGE });
      for (const project of page.page) {
        if (project.removal) continue;
        const old = await lineSummary(ctx.db, project._id);
        const value = (old ? JSON.parse(old.value) : {}) as OpenSummary & Record<string, unknown>;
        if (value.size) continue;
        value.size = { bytes: await projectBytes(ctx.db, project._id), at: Date.now() };
        rows++;
        const row = {
          kind: 'projectLiveLineSummary',
          sourceId: String(project._id),
          projectId: project._id,
          value: JSON.stringify(value),
        };
        if (old) await ctx.db.replace(old._id, row);
        else await ctx.db.insert('projectFinishReadRows', row);
      }
      next = page.isDone
        ? { stage: 'lanes', cursor: null }
        : { stage: 'projects', cursor: page.continueCursor };
    } else {
      const page = await ctx.db.query('projectHostedOverlapLanes').paginate({ cursor, numItems: LANE_PAGE });
      for (const lane of page.page) {
        if (!lane.open || !lane.landed || !lane.presenceRow) continue;
        const presence = await ctx.db.get(lane.presenceRow.id);
        if (!presence || presence.landedBefore) continue;
        await ctx.db.patch(presence._id, { landedBefore: true });
        rows++;
      }
      next = page.isDone ? null : { stage: 'lanes', cursor: page.continueCursor };
    }
    if (next) await ctx.scheduler.runAfter(0, internal.projectLooseEndBackfill.backfill, next);
    return { stage, rows, isDone: !next };
  },
});
