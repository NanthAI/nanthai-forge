// SPDX-License-Identifier: Apache-2.0
// Provenance belongs to the retained primary version's body, never to another audit row.
import type { Doc, Id } from './_generated/dataModel';
import type { MutationCtx, QueryCtx } from './_generated/server';
import { metadataCommandSchema } from '../src/work-intent-types';
import { metadataRequest } from '../src/work-metadata';
import { invariant } from '../src/errors';
export type StoredWorkEvent = Omit<Doc<'projectWorkEvents'>, '_id'> & {
  _id: Id<'projectWorkEvents'> | Id<'projectHostedRecordBodies'>;
};
export type WorkProvenance = Omit<StoredWorkEvent, '_id' | '_creationTime' | 'previousRevision'>;
export function eventDocument(row: Doc<'projectHostedRecordBodies'>): StoredWorkEvent {
  invariant(
    row.operationId !== undefined &&
      row.revision !== undefined &&
      row.request !== undefined &&
      row.actor !== undefined &&
      row.at !== undefined &&
      row.command !== undefined,
    'SOURCE_UNAVAILABLE',
    'Exact Work operation provenance is unavailable.',
  );
  const command = metadataCommandSchema.parse(JSON.parse(row.command));
  invariant(
    metadataRequest(command) === row.request,
    'SOURCE_UNAVAILABLE',
    'Exact Work operation provenance is unavailable.',
  );
  return {
    _id: row._id,
    _creationTime: row._creationTime,
    projectId: row.projectId,
    operationId: row.operationId,
    request: row.request,
    previousRevision: row.revision - 1,
    revision: row.revision,
    actor: row.actor,
    at: row.at,
    command: row.command,
    ...(row.baseBackupId ? { baseBackupId: row.baseBackupId } : {}),
  };
}
export async function findWorkEvent(
  ctx: QueryCtx | MutationCtx,
  projectId: Id<'hostedProjects'>,
  operationId: string,
): Promise<StoredWorkEvent | null> {
  const old = await ctx.db
    .query('projectWorkEvents')
    .withIndex('by_project_and_operation', q => q.eq('projectId', projectId).eq('operationId', operationId))
    .unique();
  if (old) return old;
  const body = await ctx.db
    .query('projectHostedRecordBodies')
    .withIndex('by_project_and_operation', q => q.eq('projectId', projectId).eq('operationId', operationId))
    .unique();
  return body ? eventDocument(body) : null;
}
