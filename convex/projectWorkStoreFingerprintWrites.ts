// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Ferdinando Valsecchi
import { workRecordTable } from './projectWorkRecordTables';
import type { MutationCtx } from './_generated/server';
import type { Doc, Id } from './_generated/dataModel';
import type { HostedRecordRef } from '../src/hosted-records';

const primaryWriters = ['note', 'intent', 'intent-status', 'planning'] as const;

/** Migration telemetry stops once every eligible command owns retained versions. Reader rollback
 * alone does not restart it; removing a primary writer invalidates coverage in setMode first. */
export const workStoreMigrationActive = (
  project: Pick<Doc<'hostedProjects'>, 'workStore' | 'workStoreWriters'>,
) =>
  Boolean(project.workStore) &&
  !primaryWriters.every(action => project.workStoreWriters?.some(writer => writer === action));

/** The Work store fields of a project born under server authority with no Work commands yet
 * (Item c0af6cfa, F2): the record store with every writer primary, the mode the dogfood project
 * runs, so no new project starts journal-only or dual. They are the fields `setMode` leaves after
 * `records` plus all writers at that revision; set in the birth transaction's existing patch. */
export const bornRecordStore = (revision: number) => ({
  workStore: 'records' as const,
  workStoreWriters: [...primaryWriters],
  workStoreCutoverRevision: revision,
  workStoreEventWindows: [{ revision, storeFirst: true }],
});

/** Kept dependency-free so canonical record writes never import their own readers. */
export async function writeFingerprint(
  ctx: MutationCtx,
  projectId: Id<'hostedProjects'>,
  partition: Id<'projectWorkGenerations'>,
  collection: string,
  key: string,
  position: number,
  value: unknown,
) {
  // Read and insert in the same table (fingerprints are `_workStore*` collections: projectWorkDataRecords).
  const table = await workRecordTable(ctx, partition, collection);
  const row = await ctx.db
    .query(table)
    .withIndex('by_generation_and_collection_and_key', q =>
      q.eq('generationId', partition).eq('collection', collection).eq('key', key),
    )
    .unique();
  const entry = { value: JSON.stringify(value), position };
  if (row) {
    if (row.value !== entry.value || row.position !== position) await ctx.db.patch(row._id, entry);
    return;
  }
  await ctx.db.insert(table, {
    projectId,
    generationId: partition,
    collection,
    key,
    parent: '',
    ...entry,
  });
}

export async function fingerprintHostedIntent(
  ctx: MutationCtx,
  project: Doc<'hostedProjects'>,
  ref: HostedRecordRef,
  position: number,
  status: string,
) {
  if (!workStoreMigrationActive(project) || !project.work?.generationId) return;
  const generation = await ctx.db.get(project.work.generationId);
  if (!generation) return;
  await writeFingerprint(
    ctx,
    project._id,
    generation.recordsGenerationId ?? generation._id,
    '_workStoreHeads:intent',
    ref.key,
    position,
    {
      key: ref.key,
      ref,
      ...(!status.startsWith('journal:') ? { hosted: true } : {}),
    },
  );
}
