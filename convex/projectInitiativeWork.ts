// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Ferdinando Valsecchi
import { getDocumentSize, v } from 'convex/values';
import { canonicalPayload } from '../src/hosted-source-operation';
import { invariant } from '../src/errors';
import { isPlanningUuid } from '../src/planning-id';
import { query } from './cliServer';
import { report } from './errors';
import { readProjectRole } from './projectAuthority';
import { recordCaller } from './projectHostedFrictionStore';
import { recordHead } from './projectHostedRecords';
import { visibleLifecycleRecord } from './projectHostedLifecycleOverlay';
import { initiativeWorkIdentity } from './projectInitiativeWorkFields';
import { activeWorkRoot, initiativeWorkSummary, itemWorkRoot } from './projectInitiativeWorkStore';
import { record, recordPartition, selectedGeneration } from './projectWorkIndexStore';

const OPEN_LANES_COUNTED = 200;
const ITEM_LOOKUP_BATCH = 8;
const ITEM_LOOKUP_BYTES = 5 * 1024 * 1024;

export const read = query({
  args: initiativeWorkIdentity,
  returns: v.string(),
  handler: async (ctx, { projectId, initiativeId }) => {
    try {
      invariant(
        isPlanningUuid(initiativeId),
        'BAD_ARGUMENT',
        'initiativeId: expected the full Initiative UUID.',
      );
      if (!(await ctx.auth.getUserIdentity())) return canonicalPayload({ role: false });
      const { actor, project } = await recordCaller(ctx, projectId);
      if (!(await readProjectRole(ctx, project, actor))) return canonicalPayload({ role: false });
      const generation = await selectedGeneration(ctx, project);
      if (!generation) return canonicalPayload({ role: false });
      const partition = recordPartition(generation);
      const root = await record(ctx, partition, 'planningSearch', initiativeId);
      if (!activeWorkRoot(root, 'initiative')) return canonicalPayload({ role: false });

      const [summary, lanes] = await Promise.all([
        initiativeWorkSummary(ctx, { projectId, initiativeId }),
        ctx.db
          .query('projectHostedRecordHeads')
          .withIndex('by_project_and_kind_and_status', q =>
            q.eq('projectId', projectId).eq('kind', 'lane').eq('status', 'active'),
          )
          .take(OPEN_LANES_COUNTED + 1),
      ]);
      const sampled = lanes.slice(0, OPEN_LANES_COUNTED);
      const intents = await Promise.all(
        [...new Set(sampled.map(row => row.parent))].map(id => recordHead(ctx, projectId, 'intent', id)),
      );
      const itemIds = new Map(
        intents.flatMap(head => {
          // A pre-link root used its Item ID as the Intent ID.
          const id = head && (head.planningItemId ?? head.key);
          return id ? [[head.key, id] as const] : [];
        }),
      );
      const items = [...new Set(itemIds.values())];
      const inInitiative = new Set<string>();
      let readBytes = 0;
      let checkedItems = 0;
      // Legacy search roots may be close to the 1 MiB document limit. Reserve
      // room for a full batch before issuing its indexed probes.
      while (checkedItems < items.length && readBytes < ITEM_LOOKUP_BYTES) {
        const ids = items.slice(checkedItems, checkedItems + ITEM_LOOKUP_BATCH);
        const rows = await Promise.all(ids.map(id => itemWorkRoot(ctx, partition, id)));
        for (const [index, row] of rows.entries()) {
          if (!row) continue;
          readBytes += getDocumentSize(row);
          if (activeWorkRoot(row, 'issue')?.initiativeId === initiativeId) inInitiative.add(ids[index]!);
        }
        checkedItems += ids.length;
      }
      const open = sampled.filter(lane => inInitiative.has(itemIds.get(lane.parent) ?? ''));
      const effective = await Promise.all(
        open.map(async lane => {
          if (lane.pinned) return true;
          const overlay = await visibleLifecycleRecord(ctx, projectId, lane.key);
          return overlay?.pointer.baseRecordId !== lane.recordId || overlay.row.status === 'active';
        }),
      );
      const totals = summary?.partition === partition && !summary.stale ? summary : null;
      return canonicalPayload({
        role: true,
        openLanes: effective.filter(Boolean).length,
        openAtLeast: lanes.length > OPEN_LANES_COUNTED || checkedItems < items.length,
        landings: totals?.landings ?? null,
        files: totals?.files ?? null,
        missingFiles: totals?.missing ?? 0,
      });
    } catch (error) {
      return report(error);
    }
  },
});
