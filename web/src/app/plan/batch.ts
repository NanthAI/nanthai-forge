// SPDX-License-Identifier: Apache-2.0
// The Plan screen's batch call (Item 65b0e706): one projectPlanningBatch:apply per action, retry-safe by its operation
// id, with the one Undo built from the reply (src/planning-batch.ts). Full Items and comments for a merge or split are
// read once at the moment of the action, never subscribed.
import type { ConvexReactClient } from 'convex/react';
import { makeFunctionReference } from 'convex/server';
import type { Id } from '../../../../convex/_generated/dataModel';
import { batchUndo, type BatchPut, type BatchResult, type BatchWrite } from '../../../../src/planning-batch';
import { readWorkRecord, workIndex, type WorkIndexWorkspace } from '../../hosted-work-index';

export const batchApply = makeFunctionReference<
  'mutation',
  { projectId: Id<'hostedProjects'>; operationId: string; writes: string },
  string
>('projectPlanningBatch:apply');

export type RunBatch = (writes: readonly BatchWrite[]) => Promise<BatchOutcome>;
export type BatchOutcome = {
  results: BatchResult[];
  undo: BatchPut[];
  /** Comments copied by the batch stay when it is undone (a comment is never deleted). */
  kept: number;
};

/** One call; the reply's per-Item results and the Undo that puts back what it changed. A retry of the same call
 * (the client resends on a dropped connection) is the same operation id, so nothing applies twice. */
export async function runBatch(
  apply: (args: { projectId: Id<'hostedProjects'>; operationId: string; writes: string }) => Promise<string>,
  projectId: Id<'hostedProjects'>,
  writes: readonly BatchWrite[],
): Promise<BatchOutcome> {
  const reply = JSON.parse(
    await apply({ projectId, operationId: crypto.randomUUID(), writes: JSON.stringify(writes) }),
  ) as { results: BatchResult[] };
  const { undo, kept } = batchUndo(writes, reply.results);
  return { results: reply.results, undo, kept };
}

export type FullItem = {
  id: string;
  version: number;
  kind: 'issue' | 'initiative';
  title: string;
  body: string;
  intentIds?: string[];
  relations?: { kind: 'depends-on' | 'duplicate-of' | 'related'; id: string }[];
  initiativeId?: string | null;
  parentId?: string | null;
  type?: string | null;
};
export type ItemComment = {
  id: string;
  itemId: string;
  text: string;
  at: string;
  authorLabel: string;
  system?: boolean;
};

async function workspace(client: Pick<ConvexReactClient, 'query'>, projectId: Id<'hostedProjects'>) {
  const value = await client.query(workIndex.workspace, { projectId });
  if (!value) throw new Error('The plan is still being prepared; try again in a moment.');
  return JSON.parse(value) as WorkIndexWorkspace;
}

/** The selected Items in full (body, Lane links), one read each, for a merge or a split. */
export async function readItems(
  client: Pick<ConvexReactClient, 'query'>,
  projectId: Id<'hostedProjects'>,
  ids: readonly string[],
) {
  const ws = await workspace(client, projectId);
  return Promise.all(ids.map(id => readWorkRecord<FullItem>(client, projectId, ws, 'planningItems', id)));
}

/** Each duplicate's comments, one page of 50 each (a longer thread is named, not copied in part silently). */
export async function readComments(
  client: Pick<ConvexReactClient, 'query'>,
  projectId: Id<'hostedProjects'>,
  ids: readonly string[],
) {
  const ws = await workspace(client, projectId);
  const pages = await Promise.all(
    ids.map(parentId =>
      client.query(workIndex.records, {
        projectId,
        generationId: ws.generationId,
        collection: 'planningComments',
        parentId,
        paginationOpts: { cursor: null, numItems: 50 },
      }),
    ),
  );
  return {
    comments: pages.flatMap(page => page.page.map(row => JSON.parse(row.value) as ItemComment)),
    more: ids.filter((_, index) => !pages[index]!.isDone),
  };
}
