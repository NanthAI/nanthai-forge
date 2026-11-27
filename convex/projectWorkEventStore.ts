// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Ferdinando Valsecchi
// Provenance belongs to the retained primary version's body, never to another audit row.
import { journalIndexAt, requireJournal } from './projectJournalStore';
import type { Infer } from 'convex/values';
import type { hostedWorkEventDocument } from './schema';
import type { Doc, Id } from './_generated/dataModel';
import type { MutationCtx, QueryCtx } from './_generated/server';
import { journalCommandSchema } from '../src/work-intent-types';
import { hostedCommandSchema } from '../src/work-types';
import { metadataRequest } from '../src/work-metadata';
import { invariant } from '../src/errors';
import { commentPurged, planningPurged } from '../src/work-planning-put';
import { purgedFacts, verifyPurgedRow } from './projectWorkPurgedRows';
export type StoredWorkEvent = Infer<typeof hostedWorkEventDocument>;
export type WorkProvenance = Omit<StoredWorkEvent, '_id' | '_creationTime' | 'previousRevision'>;
export function eventDocument(row: Doc<'projectHostedRecordBodies'>): StoredWorkEvent {
  const identity = {
    _id: row._id,
    _creationTime: row._creationTime,
    ...(row.automatic === undefined ? {} : { automatic: row.automatic }),
    ...(row.baseBackupId === undefined ? {} : { baseBackupId: row.baseBackupId }),
  };
  if (row.purged !== undefined) {
    // The command-less envelope with a purge marker. Its purge is checked separately
    // (convex/projectWorkPurgedRows.ts), because that needs a read.
    invariant(
      row.operationId !== undefined &&
        row.revision !== undefined &&
        row.request !== undefined &&
        row.actor !== undefined &&
        row.at !== undefined &&
        row.command === undefined &&
        row.journalSegment === undefined &&
        row.journalCommand !== undefined,
      'INVALID_WORK_JOURNAL',
      'A purged Work row has an invalid envelope.',
    );
    purgedFacts(row.journalCommand, row.purged);
    return {
      ...identity,
      projectId: row.projectId,
      operationId: row.operationId,
      request: row.request,
      previousRevision: row.revision - 1,
      revision: row.revision,
      actor: row.actor,
      at: row.at,
      command: row.journalCommand,
      purged: row.purged,
    };
  }
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
  const command = hostedCommandSchema.safeParse(JSON.parse(row.command));
  invariant(
    command.success && command.data.action !== 'purged-planning-row',
    'INVALID_WORK_JOURNAL',
    'A retained Work event has an invalid command.',
  );
  invariant(
    metadataRequest(command.data) === row.request,
    'SOURCE_UNAVAILABLE',
    'Exact Work operation provenance is unavailable.',
  );
  return {
    ...identity,
    projectId: row.projectId,
    operationId: row.operationId,
    request: row.request,
    previousRevision: row.revision - 1,
    revision: row.revision,
    actor: row.actor,
    at: row.at,
    command: row.command,
  };
}
type EventToRetain = Omit<StoredWorkEvent, '_id' | '_creationTime' | 'previousRevision'>;

/** A Work command can have provenance without owning an immutable record version. Its bytes still belong
 * in the same event index as a command with a primary version. Purged facts carry no command or payload. */
export function eventBody(event: EventToRetain) {
  const { command, purged, ...provenance } = event;
  return {
    ...provenance,
    value: '',
    ...(purged === undefined ? { command } : { purged, journalCommand: command }),
  };
}

export async function retainWorkEvent(ctx: MutationCtx, event: EventToRetain) {
  const id = await ctx.db.insert('projectHostedRecordBodies', eventBody(event));
  return eventDocument((await ctx.db.get(id))!);
}

export async function findWorkEvent(
  ctx: QueryCtx | MutationCtx,
  projectId: Id<'hostedProjects'>,
  operationId: string,
  replay?: { command: string } | { authority: true },
): Promise<StoredWorkEvent | null> {
  const body = await ctx.db
    .query('projectHostedRecordBodies')
    .withIndex('by_project_and_operation', q => q.eq('projectId', projectId).eq('operationId', operationId))
    .unique();
  if (!body) return null;
  if (body.purged !== undefined)
    return purgedReplay(ctx, projectId, eventDocument({ ...body, journalSegment: undefined }), replay);
  if (!body.journalSegment) return eventDocument(body);
  if (replay && 'command' in replay) {
    const command = hostedCommandSchema.parse(JSON.parse(replay.command));
    invariant(
      metadataRequest(command) === body.request,
      'WORK_OPERATION_CHANGED',
      'Reconcile this operation’s original command.',
    );
    const facts = JSON.parse(body.journalCommand ?? '{}');
    const original = {
      ...command,
      ...(facts.intentIds ? { intentIds: facts.intentIds } : {}),
      ...(facts.restoredTopLevel ? { restoredTopLevel: true } : {}),
    };
    return eventDocument({ ...body, command: JSON.stringify(original) });
  }
  if (replay && 'authority' in replay)
    return {
      _id: body._id,
      _creationTime: body._creationTime,
      projectId: body.projectId,
      operationId: body.operationId!,
      request: body.request!,
      revision: body.revision!,
      previousRevision: body.revision! - 1,
      actor: body.actor!,
      at: body.at!,
      command: body.journalCommand!,
      ...(body.baseBackupId === undefined ? {} : { baseBackupId: body.baseBackupId }),
      ...(body.automatic === undefined ? {} : { automatic: body.automatic }),
    };
  const index = await journalIndexAt(ctx, projectId, 'events', body.revision!);
  invariant(index, 'SOURCE_UNAVAILABLE', 'Exact Work operation provenance is unavailable.');
  const segment = requireJournal(ctx, index);
  const original = (segment.tables.projectHostedRecordBodies ?? [])
    .map(text => JSON.parse(text))
    .find(
      row =>
        row.projectId === projectId &&
        row.operationId === operationId &&
        row.revision === body.revision &&
        row.request === body.request,
    );
  invariant(original, 'SOURCE_UNAVAILABLE', 'Exact Work operation provenance is unavailable.');
  return eventDocument(original);
}
/** An operation whose row was purged. A retry of the same inputs answers PLANNING_ITEM_PURGED; different inputs
 * under that operation id stay WORK_OPERATION_CHANGED. Only the authority read gets the envelope back. */
async function purgedReplay(
  ctx: QueryCtx | MutationCtx,
  projectId: Id<'hostedProjects'>,
  event: StoredWorkEvent,
  replay?: { command: string } | { authority: true },
): Promise<StoredWorkEvent> {
  const { itemId, commentId } = await verifyPurgedRow(ctx, projectId, { ...event, purged: event.purged! });
  if (replay && 'command' in replay) {
    const command = journalCommandSchema.parse(JSON.parse(replay.command));
    invariant(
      metadataRequest(command) === event.request,
      'WORK_OPERATION_CHANGED',
      'Reconcile this operation’s original command.',
    );
  }
  if (replay && 'authority' in replay) return event;
  throw commentId ? commentPurged(itemId, commentId, event.purged!) : planningPurged(itemId, event.purged);
}
