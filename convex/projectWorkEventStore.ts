// SPDX-License-Identifier: Apache-2.0
// Provenance belongs to the retained primary version's body, never to another audit row.
import { journalIndexAt, requireJournal } from './projectJournalStore';
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
  replay?: { command: string } | { authority: true },
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
  if (!body) return null;
  if (!body.journalSegment) return eventDocument(body);
  if (replay && 'command' in replay) {
    const command = metadataCommandSchema.parse(JSON.parse(replay.command));
    invariant(
      metadataRequest(command) === body.request,
      'WORK_OPERATION_CHANGED',
      'Reconcile this operation’s original command.',
    );
    const facts = JSON.parse(body.journalCommand ?? '{}');
    const original = { ...command, ...(facts.intentIds ? { intentIds: facts.intentIds } : {}) };
    return eventDocument({ ...body, command: JSON.stringify(original) });
  }
  if (replay && 'authority' in replay)
    return {
      ...body,
      command: body.journalCommand!,
      previousRevision: body.revision! - 1,
    } as StoredWorkEvent;
  const index = await journalIndexAt(ctx, projectId, 'events', body.revision!);
  invariant(index, 'SOURCE_UNAVAILABLE', 'Exact Work operation provenance is unavailable.');
  const segment = requireJournal(ctx, index);
  const original = (segment.tables.projectHostedRecordBodies ?? [])
    .map(text => JSON.parse(text))
    .find(row => row._id === body._id);
  invariant(original, 'SOURCE_UNAVAILABLE', 'Exact Work operation provenance is unavailable.');
  return eventDocument(original);
}
