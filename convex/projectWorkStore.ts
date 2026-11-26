// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Ferdinando Valsecchi
import { readyJournalRecord } from './projectJournalWake';
import {
  eventDocument,
  findWorkEvent,
  type WorkProvenance,
  type StoredWorkEvent,
} from './projectWorkEventStore';
import type { MutationCtx } from './cliServer';
import type { Doc, Id } from './_generated/dataModel';
import { invariant } from '../src/errors';
import { independentIntentItem, recordHead, recordVersion, hostedRecordBody } from './projectHostedRecords';
import { hostedRecordIndex, hostedRecordValue } from '../src/hosted-records';
import { assembleIndexValue } from '../src/work-index-value';
import {
  journalRow,
  workStoreRecord,
  workStoreSources,
  type WorkStoreSource,
} from '../src/work-store-records';
import { advancePlanningTimes, pinnedPlanningTimes } from './projectPlanningTimes';
import { retainAuditVersion } from './projectPlanningAuditWindow';

type WorkStoreProject = Pick<Doc<'hostedProjects'>, '_id'>;
const pinRequired =
  'This Item has unproved planning times. Complete the planning-times backfill before advancing its record-store head.';

/** Store one record version unless it is already there. A version stored with other bytes is left
 * as it is and reported to the caller. */
export async function storeVersion(
  ctx: MutationCtx,
  project: WorkStoreProject,
  encoded: ReturnType<typeof hostedRecordValue>,
  provenance?: WorkProvenance,
  liveProjection = false,
): Promise<'copied' | 'same' | 'refreshed' | 'different'> {
  const projectId = project._id;
  const { record, ref } = encoded;
  const requirePin = record.kind === 'issue';
  const head = await recordHead(ctx, projectId, record.kind, record.id);
  // A live write beyond the selected head has no immutable version to open.
  // Copies and same-version writes still compare the exact version.
  const old =
    liveProjection && head && record.version > head.version
      ? null
      : await recordVersion(ctx, projectId, record.kind, record.id, record.version);
  // A purged version keeps its original digest while the index holds its tombstone: the purge vouches for it.
  if (old?.purged !== undefined) return 'same';
  if (old && (old.digest !== ref.digest || old.bytes !== ref.bytes)) return 'different';
  if (!old) {
    await insertVersion(ctx, projectId, encoded, head, provenance, undefined, liveProjection);
    return 'copied';
  }
  // A head stored before heads kept their value (and notes their own status) is brought up to date.
  const indexed = hostedRecordIndex(record),
    value = inlineValue(encoded);
  if (head?.recordId !== old._id || (head.value === value && head.status === indexed.status)) return 'same';
  // The immutable body digest matched. Rehydrating the same status can keep its proof.
  // A refresh must carry the same status and its proved planning times.
  invariant(
    !requirePin || (head.status === indexed.status && pinnedPlanningTimes(head)),
    'WORK_STALE',
    pinRequired,
  );
  await ctx.db.patch(head._id, {
    value,
    status: indexed.status,
  });
  if (old.status !== indexed.status) await ctx.db.patch(old._id, { status: indexed.status });
  return 'refreshed';
}

/** The head's inline value: the journal row the stored body reads back as. */
const inlineValue = ({ value }: ReturnType<typeof hostedRecordValue>) => {
  const record = JSON.parse(value);
  const row = journalRow(record);
  if (row === undefined) return undefined;
  // The parent already carries the Intent id. Do not bill for it again on every note read.
  if (record.kind === 'comment' && 'intentId' in (row as object)) {
    const note = { ...(row as Record<string, unknown>) };
    delete note.intentId;
    return JSON.stringify(note);
  }
  return JSON.stringify(row);
};

async function insertVersion(
  ctx: MutationCtx,
  projectId: Id<'hostedProjects'>,
  encoded: ReturnType<typeof hostedRecordValue>,
  head: Awaited<ReturnType<typeof recordHead>>,
  provenance?: WorkProvenance,
  planningItemId = head?.planningItemId,
  liveProjection = false,
) {
  const { record, ref, value } = encoded;
  invariant(record.kind !== 'candidate', 'BAD_ARGUMENT', 'Work metadata copies cannot publish a Candidate.');
  const planningTimes =
    record.kind === 'issue' ? advancePlanningTimes(record.item, head ?? undefined) : undefined;
  if (record.kind === 'issue') {
    invariant(
      !head || record.version > head.version,
      'WORK_STALE',
      'Copy missing Item versions in order before publishing the record-store history.',
    );
    invariant(planningTimes, 'WORK_STALE', pinRequired);
    // Historical backlog import uses the ordinary projection too. Its creation
    // must not backfill summaries or add per-Item writes to an import page.
    if (liveProjection && !(record.version === 1 && record.item.imported))
      await retainAuditVersion(ctx, projectId, head, record.item, provenance?.actor);
  }
  const indexed = { ...hostedRecordIndex(record), version: record.version },
    identity = { projectId, kind: record.kind, key: record.id };
  const bodyId = await ctx.db.insert(
    'projectHostedRecordBodies',
    provenance ? { ...provenance, value: '' } : { projectId, value },
  );
  const recordId = await ctx.db.insert('projectHostedRecords', {
    ...identity,
    ...indexed,
    bodyId,
    ...(provenance ? { inline: value } : {}),
    digest: ref.digest,
    bytes: ref.bytes,
  });
  const inline = inlineValue(encoded),
    pointer = {
      ...identity,
      ...indexed,
      recordId,
      ...(inline === undefined ? {} : { value: inline }),
      ...(planningItemId === undefined ? {} : { planningItemId }),
      ...(planningTimes === undefined ? {} : { planningTimes }),
    };
  if (!head) await ctx.db.insert('projectHostedRecordHeads', pointer);
  else if (head.version < record.version) {
    await readyJournalRecord(ctx, projectId, head.recordId, head.kind);
    await ctx.db.replace(head._id, pointer);
  }
}

/** Retain the Intent projection. A Lane-pinned Intent keeps its hosted bytes.
 * One live Work operation can append an immutable provenance version of those same bytes. */
export async function storeIntent(
  ctx: MutationCtx,
  projectId: Id<'hostedProjects'>,
  owner: string,
  value: unknown,
  provenance?: WorkProvenance,
  { createdIndependently = false, bound = false } = {},
): Promise<'copied' | 'same' | 'hosted'> {
  const id = (value as { id: string }).id;
  const head = await recordHead(ctx, projectId, 'intent', id);
  if (head) {
    const row = await ctx.db.get(head.recordId);
    const stored = row ? JSON.parse(await hostedRecordBody(ctx, row)) : null;
    if (!stored || (stored.base?.receiptId && !provenance)) return 'hosted';
    if (stored.base?.receiptId && provenance) {
      const encoded = hostedRecordValue({ ...stored, version: head.version + 1, at: provenance.at });
      await insertVersion(ctx, projectId, encoded, head, provenance);
      return 'copied';
    }
    const same = hostedRecordValue(workStoreRecord('intents', value, { owner, version: head.version }));
    if (same.ref.digest === row!.digest && same.ref.bytes === row!.bytes && !provenance) return 'same';
  }
  const encoded = hostedRecordValue(
    workStoreRecord('intents', value, { owner, version: head ? head.version + 1 : 0 }),
  );
  await insertVersion(
    ctx,
    projectId,
    encoded,
    head,
    provenance,
    head ? undefined : createdIndependently ? independentIntentItem : bound ? id : undefined,
  );
  return 'copied';
}

/** Store the Issue versions, comments, notes, Intents and lifecycle moves one Work command
 * projects, stored in the same mutation. Large values are joined from the payload parts of the same
 * projection. */
export async function storeProjection(
  ctx: MutationCtx,
  project: WorkStoreProject & Pick<Doc<'hostedProjects'>, 'owner'>,
  entries: { collection: string; key: string; parent: string; position: number; value: string }[],
  provenance?: WorkProvenance,
  createdIntentId?: string,
): Promise<StoredWorkEvent | null> {
  const { _id: projectId, owner } = project;
  const command = provenance ? JSON.parse(provenance.command) : null;
  const primary = !command
    ? null
    : command.action === 'note'
      ? 'notes'
      : command.action === 'intent'
        ? 'intents'
        : command.action === 'intent-status'
          ? entries.some(e => e.collection === 'lifecycle')
            ? 'lifecycle'
            : 'intents'
          : command.action === 'put-planning-item' || command.action === 'purge-planning-item'
            ? 'planningVersions'
            : 'planningComments';
  const items = new Set(entries.filter(e => e.collection === 'planningSearch').map(e => e.key));
  for (const entry of entries) {
    if (!(workStoreSources as readonly string[]).includes(entry.collection)) continue;
    const collection = entry.collection as WorkStoreSource,
      header = JSON.parse(entry.value);
    const value = header.payloadKey
      ? assembleIndexValue(
          collection,
          header,
          entries
            .filter(part => part.collection === `${collection}:payload` && part.parent === header.payloadKey)
            .sort((a, b) => a.position - b.position),
        )
      : header;
    const audit = collection === primary ? provenance : undefined;
    if (collection === 'intents')
      await storeIntent(ctx, projectId, owner, value, audit, {
        createdIndependently: entry.key === createdIntentId,
        // A same-id Intent is bound when its Item is written in this projection.
        bound: items.has(entry.key),
      });
    else {
      await storeVersion(ctx, project, hostedRecordValue(workStoreRecord(collection, value)), audit, true);
    }
  }
  if (!provenance) return null;
  const body = await ctx.db
    .query('projectHostedRecordBodies')
    .withIndex('by_project_and_operation', q =>
      q.eq('projectId', projectId).eq('operationId', provenance.operationId),
    )
    .unique();
  invariant(body, 'SOURCE_UNAVAILABLE', 'The primary Work version must retain its operation provenance.');
  if (body.journalSegment)
    return findWorkEvent(ctx, projectId, provenance.operationId, { command: provenance.command });
  return eventDocument(body);
}
