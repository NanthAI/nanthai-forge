// SPDX-License-Identifier: Apache-2.0
import type { QueryCtx } from './_generated/server';
import type { Doc } from './_generated/dataModel';
import type { HostedFreshness } from '../src/hosted-freshness';
import { recordPartition } from './projectWorkIndexStore';

/** Constant-size indexed reads. B5 observations can lead the selected source generation. */
export async function projectFreshness(
  ctx: QueryCtx,
  project: Doc<'hostedProjects'>,
  generation: Doc<'projectWorkGenerations'>,
  backup: Doc<'projectBackups'>,
): Promise<HostedFreshness> {
  const [machine, reports, uploads, stages, syncEvents] = await Promise.all([
    ctx.db
      .query('ownerAcceptanceMachines')
      .withIndex('by_project_owner', q => q.eq('projectId', project._id).eq('ownerId', project.key))
      .unique(),
    ctx.db
      .query('projectWorkRecords')
      .withIndex('by_generation_and_collection_and_position', q =>
        q.eq('generationId', recordPartition(generation)).eq('collection', 'ownerSyncOperations'),
      )
      .order('desc')
      .take(1),
    ctx.db
      .query('projectBackups')
      .withIndex('by_project', q => q.eq('projectId', project._id))
      .order('desc')
      .take(1),
    ctx.db
      .query('projectWorkGenerations')
      .withIndex('by_project_and_returnAt', q => q.eq('projectId', project._id).gt('returnAt', ''))
      .order('desc')
      .take(1),
    ctx.db
      .query('projectWorkEvents')
      .withIndex('by_project_and_revision', q =>
        q.eq('projectId', project._id).eq('revision', generation.initialRevision + 1),
      )
      .take(1),
  ]);
  const upload = uploads[0],
    stage = stages[0],
    report = reports[0];
  // Ready staging still has publication pending. Obsolete stages older than selected source don't count.
  const pendingStage =
    stage?.returnOperationId &&
    stage.backupId !== backup._id &&
    stage.initialRevision >= generation.initialRevision;
  const pendingUpload =
    upload && upload._id !== backup._id && upload.preview?.revision >= generation.initialRevision;
  const returned =
    syncEvents[0] && JSON.parse(syncEvents[0].command).action === 'source-return' ? syncEvents[0] : null;
  const time = returned ? Date.parse(returned.at) : backup.archiveReceipt?.at;
  return {
    syncedAt: time !== undefined && Number.isFinite(time) ? time : null,
    sourceRevision: generation.initialRevision + (returned ? 1 : 0),
    mainHead: backup.preview?.channels?.find(channel => channel.name === 'main')?.head ?? null,
    machine: machine
      ? { name: machine.name, reportedAt: machine.lastSeen, mainHead: machine.mainHead }
      : null,
    ownerReport: report ? { reportedAt: report._creationTime, revision: report.position } : null,
    push: pendingStage
      ? { startedAt: stage._creationTime, pending: 'Publishing source and Work' }
      : pendingUpload
        ? {
            startedAt: upload._creationTime,
            pending:
              upload.status === 'uploading' ? 'Uploading source and Work' : 'Publishing source and Work',
          }
        : null,
  };
}
