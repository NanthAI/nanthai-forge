// SPDX-License-Identifier: Apache-2.0
'use node';

import { v } from 'convex/values';
import { internal } from './_generated/api';
import type { Doc } from './_generated/dataModel';
import { internalAction } from './_generated/server';
import type { JournalIndex } from '../src/journal-segment';
import { getJournalSegment } from './projectJournalObject';
import { archivedEventItem, archivedRecordTarget, type ArchiveTarget } from './projectPlanningArchiveIndex';
import type { ArchiveBackfillPage } from './projectPlanningArchiveBackfill';

function eventTarget(row: Doc<'projectHostedRecordBodies'>) {
  if (!row.operationId || !row.command || row.purged) return undefined;
  let command;
  try {
    command = JSON.parse(row.command);
  } catch {
    return undefined; // The full-scan selector skips malformed legacy commands too.
  }
  return command && archivedEventItem(row.operationId, command);
}

export const run = internalAction({
  args: { projectId: v.id('hostedProjects') },
  returns: v.object({
    done: v.boolean(),
    advanced: v.boolean(),
    segments: v.number(),
    gets: v.number(),
    bytes: v.number(),
  }),
  handler: async (
    ctx,
    { projectId },
  ): Promise<{ done: boolean; advanced: boolean; segments: number; gets: number; bytes: number }> => {
    const ref = internal.projectPlanningArchiveBackfill;
    const { from, next, entries }: ArchiveBackfillPage = await ctx.runQuery(ref.page, { projectId });
    if (!from) return { done: true, advanced: false, segments: 0, gets: 0, bytes: 0 };
    let gets = 0;
    let bytes = 0;
    const verified: { key: string; targets: ArchiveTarget[] }[] = [];
    for (let at = 0; at < entries.length; at += 8) {
      const batch = await Promise.all(
        entries.slice(at, at + 8).map(async ({ key, index: text }) => {
          const index: JournalIndex = JSON.parse(text);
          const segment = await getJournalSegment(projectId, index);
          for (const pointer of [index.pointer, ...(index.parts ?? [])]) {
            gets++;
            bytes += pointer.size;
          }
          const targets = from.legacyRecords
            ? (segment.tables.projectHostedRecords ?? []).flatMap(text => {
                const target = archivedRecordTarget(JSON.parse(text));
                return target ? [target] : [];
              })
            : (segment.tables.projectHostedRecordBodies ?? []).flatMap(text => {
                const itemId = eventTarget(JSON.parse(text));
                return itemId ? [{ kind: 'events' as const, itemId }] : [];
              });
          return { key, targets };
        }),
      );
      verified.push(...batch);
    }
    const advanced = await ctx.runMutation(ref.commit, { projectId, from, next, entries: verified });
    return { done: advanced && next === null, advanced, segments: entries.length, gets, bytes };
  },
});
