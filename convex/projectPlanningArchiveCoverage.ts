// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Ferdinando Valsecchi
import type { Doc } from './_generated/dataModel';
import type { MutationCtx, QueryCtx } from './_generated/server';
import { canonicalPayload } from '../src/hosted-source-operation';
import { digest } from '../src/state/hash';
import { receiptRow } from './projectJournalMaintenance';
import { planningArchiveIndexVersion, type planningArchiveBackfillProgress } from './projectJournalFields';

const operationId = 'planning-archive-coverage';
export type ArchiveCoverage = {
  eventRevision: number;
  ready?: true;
  progress?: typeof planningArchiveBackfillProgress.type;
};
type ArchiveCoverageReceipt = ArchiveCoverage & { indexVersion: number };

export function hasProjectArchiveCoverage(project: Doc<'hostedProjects'>) {
  return project.planningArchiveBackfill !== undefined || project.planningArchiveEventRevision !== undefined;
}

/** Only the purge and archive maintenance paths read this receipt. */
export async function readArchiveCoverage(ctx: QueryCtx, project: Doc<'hostedProjects'>) {
  const row = await receiptRow(ctx, project._id, operationId);
  const progress = project.planningArchiveBackfill;
  const stored: ArchiveCoverageReceipt = row
    ? JSON.parse(row.envelope)
    : {
        indexVersion: planningArchiveIndexVersion,
        ...(progress && 'mode' in progress ? { progress } : {}),
        eventRevision: 0,
      };
  const state: ArchiveCoverage = {
    ...(stored.indexVersion === planningArchiveIndexVersion && {
      ...(stored.ready && { ready: true }),
      ...(stored.progress && { progress: stored.progress }),
    }),
    // Moving coverage clears the project counter. A still-running older publisher can start it again.
    eventRevision: stored.eventRevision + (project.planningArchiveEventRevision ?? 0),
  };
  return { row, state };
}

export async function saveArchiveCoverage(
  ctx: MutationCtx,
  project: Doc<'hostedProjects'>,
  row: Doc<'projectJournalReceipts'> | null,
  state: ArchiveCoverage,
) {
  const envelope = canonicalPayload({ ...state, indexVersion: planningArchiveIndexVersion });
  const fields = { projectId: project._id, operationId, hash: digest(envelope), envelope };
  if (row) await ctx.db.replace(row._id, fields);
  else await ctx.db.insert('projectJournalReceipts', fields);
  if (hasProjectArchiveCoverage(project))
    await ctx.db.patch(project._id, {
      planningArchiveBackfill: undefined,
      planningArchiveEventRevision: undefined,
    });
}
