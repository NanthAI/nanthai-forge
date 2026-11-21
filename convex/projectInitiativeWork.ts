// SPDX-License-Identifier: Apache-2.0
import { v } from 'convex/values';
import { z } from 'zod';
import { canonicalPayload } from '../src/hosted-source-operation';
import { invariant } from '../src/errors';
import { isPlanningUuid } from '../src/planning-id';
import { query } from './cliServer';
import { report } from './errors';
import { readProjectRole } from './projectAuthority';
import { recordCaller } from './projectHostedFrictionStore';
import {
  cursorJson,
  ITEM_LANDINGS_PAGE,
  itemLandingHistory,
  landingHistoryCursor,
  type ItemLanding,
} from './projectItemLandingHistory';
import { itemWorkLandingDetails, planningWorkPage } from './projectItemWorkDetails';
import { itemIntentChain } from './projectIntentLandingNotes';
import { record, recordPartition, selectedGeneration } from './projectWorkIndexStore';

const ITEMS_PER_PAGE = 8;
const OPEN_LANES_COUNTED = 50;
const pageCursor = z.object({
  partition: z.string(),
  initiativeId: z.string(),
  position: z.number().int().min(0),
  history: landingHistoryCursor.optional(),
});

export const read = query({
  args: {
    projectId: v.id('hostedProjects'),
    initiativeId: v.string(),
    cursor: v.union(v.string(), v.null()),
  },
  returns: v.string(),
  handler: async (ctx, { projectId, initiativeId, cursor }) => {
    try {
      invariant(
        isPlanningUuid(initiativeId),
        'BAD_ARGUMENT',
        'initiativeId: expected the full Initiative UUID.',
      );
      const from = cursor === null ? null : pageCursor.safeParse(cursorJson(cursor));
      invariant(
        from === null || from.success,
        'BAD_ARGUMENT',
        'Restart this Initiative work read without a cursor.',
      );
      if (!(await ctx.auth.getUserIdentity())) return canonicalPayload({ role: false });
      const { actor, project } = await recordCaller(ctx, projectId);
      if (!(await readProjectRole(ctx, project, actor))) return canonicalPayload({ role: false });
      const generation = await selectedGeneration(ctx, project);
      if (!generation) return canonicalPayload({ role: false });
      const partition = recordPartition(generation);
      const previous = from?.data;
      invariant(
        !previous || (previous.partition === partition && previous.initiativeId === initiativeId),
        'WORK_STALE',
        'The plan changed. Reopen the Initiative to read its work.',
      );
      const root = await record(ctx, partition, 'planningSearch', initiativeId);
      const initiative = root && JSON.parse(root.value);
      if (
        initiative?.kind !== 'initiative' ||
        initiative.purged ||
        initiative.status === 'archived' ||
        initiative.status === 'deleted'
      )
        return canonicalPayload({ role: false });

      const items = await planningWorkPage(
        ctx.db.query('projectPlanningRecords').withIndex('by_planning_initiativeId_and_kind', q =>
          q
            .eq('generationId', partition)
            .eq('collection', 'planningSearch')
            .eq('planning.initiativeId', initiativeId)
            .eq('planning.kind', 'issue')
            .gte('position', previous?.position ?? 0),
        ),
        ITEMS_PER_PAGE,
      );
      let openLanes = 0;
      let openAtLeast = false;
      let remaining = ITEM_LANDINGS_PAGE;
      let next: z.infer<typeof pageCursor> | null = null;
      const receipts = new Map<string, ItemLanding>();
      for (const row of items.page) {
        const item = JSON.parse(row.value);
        if (item.purged || item.status === 'archived' || item.status === 'deleted') continue;
        const history = previous?.position === row.position ? previous.history : undefined;
        if (remaining === 0) {
          next = { partition, initiativeId, position: row.position };
          break;
        }
        const { intents } = await itemIntentChain(ctx, projectId, row.key);
        if (!history) {
          for (const intentId of intents) {
            const active = await ctx.db
              .query('projectHostedRecordHeads')
              .withIndex('by_project_and_kind_and_parent_and_status', q =>
                q.eq('projectId', projectId).eq('kind', 'lane').eq('parent', intentId).eq('status', 'active'),
              )
              .take(OPEN_LANES_COUNTED + 1);
            openLanes += Math.min(active.length, OPEN_LANES_COUNTED);
            openAtLeast ||= active.length > OPEN_LANES_COUNTED;
          }
        }
        const landings = await itemLandingHistory(ctx, projectId, intents, history ?? {}, remaining);
        for (const receipt of landings.rows) receipts.set(receipt.receiptId, receipt);
        remaining -= landings.used;
        if (landings.next) {
          next = { partition, initiativeId, position: row.position, history: landings.next };
          break;
        }
      }
      if (!next && items.more) next = { partition, initiativeId, position: items.page.at(-1)!.position + 1 };
      const landings = await itemWorkLandingDetails(ctx, projectId, [...receipts.values()], true);
      return canonicalPayload({
        role: true,
        openLanes,
        openAtLeast,
        landings: landings.map(({ receiptId }) => receiptId),
        files: [...new Set(landings.flatMap(({ paths }) => paths ?? []))],
        missingFiles: landings.filter(({ paths }) => paths === null).map(({ receiptId }) => receiptId),
        nextCursor: next ? JSON.stringify(next) : null,
      });
    } catch (error) {
      return report(error);
    }
  },
});
