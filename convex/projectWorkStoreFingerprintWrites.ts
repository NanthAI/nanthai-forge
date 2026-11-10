// SPDX-License-Identifier: Apache-2.0
import type { MutationCtx } from './_generated/server';
import type { Doc, Id } from './_generated/dataModel';
import type { HostedRecordRef } from '../src/hosted-records';

/** Migration telemetry stops once every eligible command owns retained versions. Reader rollback
 * alone does not restart it; removing a primary writer invalidates coverage in setMode first. */
export const workStoreMigrationActive = (
  project: Pick<Doc<'hostedProjects'>, 'workStore' | 'workStoreWriters'>,
) =>
  Boolean(project.workStore) &&
  !['note', 'intent', 'intent-status', 'planning'].every(action =>
    project.workStoreWriters?.some(writer => writer === action),
  );

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
  const row = await ctx.db
    .query('projectWorkRecords')
    .withIndex('by_generation_and_collection_and_key', q =>
      q.eq('generationId', partition).eq('collection', collection).eq('key', key),
    )
    .unique();
  const entry = { value: JSON.stringify(value), position };
  if (row) {
    if (row.value !== entry.value || row.position !== position) await ctx.db.patch(row._id, entry);
    return;
  }
  await ctx.db.insert('projectWorkRecords', {
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
