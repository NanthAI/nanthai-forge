// SPDX-License-Identifier: Apache-2.0
import type { QueryCtx, MutationCtx } from './_generated/server';
import type { Id } from './_generated/dataModel';
import { workRecordLookup } from './projectWorkRecordTables';
import { writeLineMain } from './projectLiveLineStore';

type Db = QueryCtx['db'];
/** Compatibility with the native Work index. Publication freezes only the exact
 * accepted-main display, so later Work revisions cannot invalidate the live feed. */
export async function legacyLineMain(
  db: Db,
  projectId: Id<'hostedProjects'>,
  generationId: Id<'projectWorkGenerations'>,
) {
  const generation = await db.get(generationId);
  if (!generation || generation.projectId !== projectId || generation.status !== 'ready') return null;
  const partition = generation.recordsGenerationId ?? generation._id;
  const [channel, hosted] = await Promise.all([
    workRecordLookup({ db }, partition, 'channels', 'main'),
    workRecordLookup({ db }, partition, 'hostedChannels', 'main'),
  ]);
  const native = JSON.parse(generation.metadata).sourceKind === 'native';
  const selected = native ? (channel ?? hosted) : (hosted ?? channel);
  if (!selected) return null;
  const selectedValue = JSON.parse(selected.value);
  const head = selectedValue.head as string;
  const move =
    typeof selectedValue.moveId === 'string'
      ? await workRecordLookup({ db }, partition, 'channelMoves', selectedValue.moveId)
      : (
          await db
            .query('projectWorkRecords')
            .withIndex('by_generation_and_collection_and_parent_and_position', q =>
              q.eq('generationId', partition).eq('collection', 'channelMoves').eq('parent', 'main'),
            )
            .order('desc')
            .take(1)
        )[0];
  const local = move ? JSON.parse(move.value) : null;
  const remote = hosted ? JSON.parse(hosted.value) : null;
  const accepted = (native ? [local, remote] : [remote, local]).find(
    value =>
      value?.channel === 'main' &&
      value.head === head &&
      (value.status === undefined || value.status === 'accepted'),
  );
  if (!accepted) return { head };
  const [run] = accepted.viewId
    ? await db
        .query('projectWorkRecords')
        .withIndex('by_generation_and_collection_and_parent_and_position', q =>
          q.eq('generationId', partition).eq('collection', 'runs').eq('parent', accepted.viewId),
        )
        .order('desc')
        .take(1)
    : [];
  return {
    head,
    ...(accepted.at ? { at: accepted.at as string } : {}),
    ...(accepted.actor || accepted.acceptedBy?.name
      ? { actor: (accepted.actor || accepted.acceptedBy.name) as string }
      : {}),
    ...(accepted.automatic ? { automatic: true } : {}),
    ...(run ? { check: JSON.parse(run.value).status as string } : {}),
  };
}
export async function publishLegacyLineMain(
  db: MutationCtx['db'],
  projectId: Id<'hostedProjects'>,
  generationId: Id<'projectWorkGenerations'>,
) {
  const main = await legacyLineMain(db, projectId, generationId);
  if (main) await writeLineMain({ db }, projectId, main);
}
