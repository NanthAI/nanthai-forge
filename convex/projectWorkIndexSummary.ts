// SPDX-License-Identifier: Apache-2.0
import type { QueryCtx } from './_generated/server';
import type { Doc } from './_generated/dataModel';
import { record, recordPartition } from './projectWorkIndexStore';
import { sourceMembership } from './projectSourceMembership';
import { actorSummary } from './projectActorNames';
export async function hostedMain(ctx: QueryCtx, generation: Doc<'projectWorkGenerations'>) {
  const partition = recordPartition(generation);
  const hosted = await record(ctx, partition, 'hostedChannels', 'main');
  const local = hosted ?? (await record(ctx, partition, 'channels', 'main'));
  return local ? (JSON.parse(local.value).head as string) : null;
}
/** Current Channel membership reuses immutable closures and legacy positive pairs. */
export async function cockpitSummary(
  ctx: QueryCtx,
  project: Doc<'hostedProjects'>,
  generation: Doc<'projectWorkGenerations'>,
  collection: string,
  value: string,
  main: string | null,
  actors?: Map<string, Promise<string | undefined>>,
) {
  if (collection.endsWith(':payload')) return value;
  let result = await actorSummary(ctx, project._id, value, actors);
  if (collection === 'lanes' || collection === 'views' || collection === 'runs') {
    const row = JSON.parse(result),
      head = row.head as string | undefined,
      partition = recordPartition(generation);
    const lane = collection === 'lanes';
    let included: boolean | null = !main ? (lane ? null : true) : head === main ? true : null;
    if (main && head && included === null) {
      const descendant = lane ? main : head;
      const ancestor = lane ? head : main;
      included = await sourceMembership(ctx, partition, descendant, ancestor);
    }
    result = JSON.stringify({ ...row, main: { head: main, included } });
  }
  if (collection === 'views') {
    const row = JSON.parse(result);
    const [latest] = await ctx.db
      .query('projectWorkRecords')
      .withIndex('by_generation_and_collection_and_parent_and_position', q =>
        q
          .eq('generationId', recordPartition(generation))
          .eq('collection', 'viewAcceptances')
          .eq('parent', row.id),
      )
      .order('desc')
      .take(1);
    if (latest)
      result = JSON.stringify({
        ...row,
        viewStatus: 'accepted',
        acceptance: JSON.parse(await actorSummary(ctx, project._id, latest.value, actors)),
      });
  }
  return result;
}
