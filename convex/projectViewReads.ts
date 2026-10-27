import { hostedPaths, hostedJson } from '../src/hosted-paths';
import { actorSummary } from './projectActorNames';
// SPDX-License-Identifier: Apache-2.0
import { generationHead } from './projectWorkHead';
import { v } from 'convex/values';
import { paginationOptsValidator } from 'convex/server';
import { query, type QueryCtx } from './cliServer';
import type { Id } from './_generated/dataModel';
import { accessibleProject } from './projectAuthority';
import { selectedGeneration, recordPartition, record } from './projectWorkIndexStore';
import { invariant } from '../src/errors';
import { report } from './errors';
import type { whyNotes } from '../src/view-read-model';
import type { ViewReadModel } from '../src/view-read-model';
import type { FileProvenancePlan } from '../src/view-provenance-plan';

async function value(
  ctx: QueryCtx,
  partition: Id<'projectWorkGenerations'>,
  collection: string,
  key: string,
) {
  const row = await record(ctx, partition, collection, key);
  if (!row) return null;
  const header = JSON.parse(row.value);
  if (!header.payloadKey) return header;
  const parts = await ctx.db
    .query('projectWorkRecords')
    .withIndex('by_generation_and_collection_and_parent_and_position', q =>
      q
        .eq('generationId', partition)
        .eq('collection', `${collection}:payload`)
        .eq('parent', header.payloadKey),
    )
    .take(header.payloadParts);
  invariant(
    parts.length === header.payloadParts,
    'SOURCE_UNAVAILABLE',
    'Selected record payload is incomplete.',
  );
  return JSON.parse(parts.map(part => part.value).join(''));
}
const children = (
  ctx: QueryCtx,
  partition: Id<'projectWorkGenerations'>,
  collection: string,
  parent: string,
) =>
  ctx.db
    .query('projectWorkRecords')
    .withIndex('by_generation_and_collection_and_parent_and_position', q =>
      q.eq('generationId', partition).eq('collection', collection).eq('parent', parent),
    );

/** Current project authority is checked in this query, including every page. */
export const read = query({
  args: {
    projectId: v.id('hostedProjects'),
    generationId: v.optional(v.id('projectWorkGenerations')),
    action: v.union(v.literal('view'), v.literal('provenance'), v.literal('views')),
    viewId: v.optional(v.string()),
    laneId: v.optional(v.string()),
    file: v.optional(v.string()),
    paginationOpts: paginationOptsValidator,
  },
  returns: v.string(),
  handler: async (ctx, input): Promise<string> => {
    try {
      const user = await ctx.auth.getUserIdentity();
      invariant(user, 'PROJECT_UNAVAILABLE', 'Sign in to read project Views.');
      const project = await accessibleProject(ctx, input.projectId, user.subject),
        generation = await selectedGeneration(ctx, project);
      invariant(
        generation && (!input.generationId || generation._id === input.generationId),
        'WORK_STALE',
        'Refresh the current hosted Work generation.',
      );
      const head = await generationHead(ctx, generation);
      const partition = recordPartition(generation);
      const acceptances = async (model: ViewReadModel) => {
        const rows = await children(ctx, partition, 'viewAcceptances', model.viewId).order('desc').take(1);
        const accepted = await Promise.all(
          rows.map(async row => {
            const move = JSON.parse(await actorSummary(ctx, project._id, row.value));
            const local = await record(ctx, partition, 'channelMoves', move.id);
            const receipt = local ? JSON.parse(local.value) : null;
            return { ...move, canonical: receipt?.status === 'accepted' && receipt.head === move.head };
          }),
        );
        return hostedPaths({ ...model, accepted, ...(accepted.length ? { status: 'accepted' } : {}) });
      };
      if (input.action === 'views') {
        invariant(
          input.laneId && (await record(ctx, partition, 'lanes', input.laneId)),
          'NOT_FOUND',
          'Lane not found.',
        );
        const page = await children(ctx, partition, 'laneViews', input.laneId)
          .order('desc')
          .paginate(input.paginationOpts);
        const items = await Promise.all(
          page.page.map(async row => acceptances(await value(ctx, partition, 'laneViews', row.key))),
        );
        return hostedJson({
          generationId: generation._id,
          revision: head.revision,
          laneId: input.laneId,
          items,
          nextCursor: page.isDone ? null : page.continueCursor,
        });
      }
      invariant(input.viewId, 'BAD_ARGUMENT', 'Select a View.');
      const model = await value(ctx, partition, 'viewDetails', input.viewId);
      invariant(model, 'NOT_FOUND', 'View not found.');
      const stats = model.head
        ? await value(ctx, partition, 'diffstats', `${model.base}:${model.head}`)
        : null;
      let plans: FileProvenancePlan[], nextCursor: string | null;
      if (input.file !== undefined) {
        const plan = await value(ctx, partition, 'viewFiles', `${input.viewId}:${input.file}`);
        plans = plan ? [plan] : [];
        nextCursor = null;
      } else {
        const page = await children(ctx, partition, 'viewFiles', input.viewId).paginate(input.paginationOpts);
        plans = await Promise.all(page.page.map(row => value(ctx, partition, 'viewFiles', row.key)));
        nextCursor = page.isDone ? null : page.continueCursor;
      }
      const why = new Map<
        string,
        { intentId: string; outcome: string | null; notes: ReturnType<typeof whyNotes>; notesMore: boolean }
      >();
      for (const intentId of new Set([
        ...model.whyIntentIds,
        ...plans.flatMap(file => file.contributors.map(c => c.intentId)),
      ])) {
        const intent = await value(ctx, partition, 'intents', intentId);
        const notes = await children(ctx, partition, 'notes', intentId).take(101);
        why.set(intentId, {
          intentId,
          outcome: intent?.outcome ?? null,
          notesMore: notes.length > 100,
          notes: notes
            .slice(0, 100)
            .map(row => ({ id: row.key, ...JSON.parse(row.value) }))
            .map(note => ({
              id: note.id,
              kind: note.kind,
              excerpt: note.text.slice(0, 500),
              at: note.at,
              ...(note.anchor ? { anchor: note.anchor } : {}),
            })),
        });
      }
      const digests = new Set(
        plans
          .flatMap(file => [
            file.before?.blob,
            file.after?.blob,
            ...file.contributors.flatMap(c => c.saves.flatMap(s => [s.before?.blob, s.after?.blob])),
          ])
          .filter((id): id is string => !!id),
      );
      const blobPins = await Promise.all(
        [...digests].map(blob => value(ctx, partition, 'sourceBlobs', blob)),
      );
      const runs =
        input.action === 'view'
          ? (await children(ctx, partition, 'runs', input.viewId).order('desc').take(101)).map(row =>
              JSON.parse(row.value),
            )
          : undefined;
      const backup = await ctx.db.get(generation.backupId);
      invariant(
        backup?.projectId === input.projectId,
        'PROJECT_UNAVAILABLE',
        'Source checkpoint is unavailable.',
      );
      return hostedJson({
        generationId: generation._id,
        revision: head.revision,
        backupId: generation.backupId,
        sourceTransport: backup.transport,
        ...(await acceptances(model)),
        changes: stats,
        files: {
          total: model.fileCount,
          items: plans.map(file => ({
            ...file,
            why: [...new Set([...model.whyIntentIds, ...file.contributors.map(c => c.intentId)])].map(id => {
              const context = why.get(id)!;
              return {
                ...context,
                notes: context.notes.filter(note => !note.anchor || note.anchor.file === file.path),
              };
            }),
          })),
          nextCursor,
        },
        blobPins,
        ...(runs ? { runs: runs.slice(0, 100), runsMore: runs.length > 100 } : {}),
        relatedRecords: {
          acceptances: { collection: 'viewAcceptances', parentId: input.viewId },
          runs: { collection: 'runs', parentId: input.viewId },
          notes: [...why.keys()].map(intentId => ({ collection: 'notes', parentId: intentId })),
        },
      });
    } catch (error) {
      return report(error);
    }
  },
});
