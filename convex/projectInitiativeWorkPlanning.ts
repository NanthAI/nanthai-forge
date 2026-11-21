// SPDX-License-Identifier: Apache-2.0
import type { Doc, Id } from './_generated/dataModel';
import type { MutationCtx } from './_generated/server';
import { activeWorkRoot, createWorkSummary, requestWorkRebuild } from './projectInitiativeWorkStore';

type Root = Omit<Doc<'projectPlanningRecords'>, '_id' | '_creationTime'>;

/** Invalidate both groups only when membership changes. Batched planning
 * writes request at most one rebuild per Initiative in the selected partition. */
export function initiativeWorkPlanning() {
  const partitions = new Map<
    Id<'projectWorkGenerations'>,
    {
      projectId: Id<'hostedProjects'>;
      changed: Set<string>;
      created: Set<string>;
    }
  >();
  return {
    change(before: Root | null, after: Root | null) {
      const from = activeWorkRoot(before, 'issue')?.initiativeId;
      const to = before && activeWorkRoot(after, 'issue')?.initiativeId;
      const created = !before && activeWorkRoot(after, 'initiative');
      if (!created && ((!from && !to) || from === to)) return;
      const { generationId, projectId } = (before ?? after)!;
      let changes = partitions.get(generationId);
      if (!changes)
        partitions.set(generationId, (changes = { projectId, changed: new Set(), created: new Set() }));
      if (from) changes.changed.add(from);
      if (to) changes.changed.add(to);
      if (created) changes.created.add(created.id);
    },
    async flush(ctx: MutationCtx) {
      for (const [partition, { projectId, changed, created }] of partitions) {
        // A detached generation's import or cleanup must never invalidate live totals.
        const project = await ctx.db.get(projectId);
        if (project?.removal || !project?.work?.generationId) continue;
        const selected = await ctx.db.get(project.work.generationId);
        if (
          !selected ||
          (selected.recordsGenerationId ?? selected._id) !== partition ||
          selected.status !== 'ready'
        )
          continue;
        for (const initiativeId of changed)
          await requestWorkRebuild(ctx, { projectId, initiativeId }, partition);
        for (const initiativeId of created)
          if (!changed.has(initiativeId))
            await createWorkSummary(ctx, { projectId, initiativeId }, partition);
      }
      partitions.clear();
    },
  };
}
