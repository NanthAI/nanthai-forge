// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Ferdinando Valsecchi
// The Plan screen's batch call (Item 65b0e706): one projectPlanningBatch:apply per action, retry-safe by its operation
// id, with the one Undo built from the reply (src/planning-batch.ts). Full Items and comments for a merge or split are
// read once at the moment of the action, never subscribed.
import type { ConvexReactClient } from 'convex/react';
import { makeFunctionReference } from 'convex/server';
import type { Id } from '../../../../convex/_generated/dataModel';
import { batchUndo, type BatchPut, type BatchResult, type BatchWrite } from '../../../../src/planning-batch';
import {
  readSelectedWorkRecord,
  readWorkRecord,
  workIndex,
  type WorkIndexWorkspace,
} from '../../hosted-work-index';

export const batchApply = makeFunctionReference<
  'mutation',
  {
    projectId: Id<'hostedProjects'>;
    operationId: string;
    writes: string;
    close?: true;
    atomic?: true;
    undoClose?: string;
  },
  string
>('projectPlanningBatch:apply');

export type BatchOptions = { operationId?: string; close?: true; atomic?: true; undoClose?: string };
export type RunBatch = (writes: readonly BatchWrite[], options?: BatchOptions) => Promise<BatchOutcome>;
export type BatchOutcome = {
  results: BatchResult[];
  undo: BatchPut[];
  undoClose?: string;
  detached?: number;
  pendingOperation?: string;
  /** Comments copied by the batch stay when it is undone (a comment is never deleted). */
  kept: number;
};

/** One call; the reply's per-Item results and the Undo that puts back what it changed. A retry of the same call
 * (the client resends on a dropped connection) is the same operation id, so nothing applies twice. */
export async function runBatch(
  apply: (args: {
    projectId: Id<'hostedProjects'>;
    operationId: string;
    writes: string;
    close?: true;
    atomic?: true;
    undoClose?: string;
  }) => Promise<string>,
  projectId: Id<'hostedProjects'>,
  writes: readonly BatchWrite[],
  { operationId = crypto.randomUUID(), ...options }: BatchOptions = {},
): Promise<BatchOutcome> {
  const reply = JSON.parse(
    await apply({ projectId, operationId, writes: JSON.stringify(writes), ...options }),
  ) as { results: BatchResult[]; undo?: BatchPut[]; detached?: number; pending?: true };
  if (options.close || options.undoClose)
    return {
      results: reply.results,
      undo: [],
      kept: 0,
      ...(reply.undo?.length ? { undoClose: operationId } : {}),
      ...(reply.detached ? { detached: reply.detached } : {}),
      ...(reply.pending ? { pendingOperation: operationId } : {}),
    };
  const { undo, kept } = batchUndo(writes, reply.results);
  return { results: reply.results, undo, kept };
}

export type FullItem = {
  id: string;
  version: number;
  kind: 'issue' | 'initiative';
  title: string;
  body: string;
  at?: string;
  author?: string;
  agent?: string;
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

export async function readItem(
  client: Pick<ConvexReactClient, 'query'>,
  projectId: Id<'hostedProjects'>,
  id: string,
  full = false,
): Promise<FullItem | null> {
  if (full) return (await readSelectedWorkRecord<FullItem>(client, projectId, 'planningItems', id)).value;
  const result = await client.query(workIndex.detail, {
    projectId,
    collection: 'planningItems',
    id,
    inlineItemOnly: true,
  });
  if (result.deferred) return null;
  if (!result.value) throw new Error('Item text is unavailable.');
  return JSON.parse(result.value) as FullItem;
}

export type InitiativeDetails = FullItem & { creator?: string | undefined };

/** Read About directly, using the detail's generation for any payload pages. For an edited Initiative,
 * replace the workspace read with its first version: a later body author may be someone else. */
export async function readInitiative(
  client: Pick<ConvexReactClient, 'query'>,
  projectId: Id<'hostedProjects'>,
  id: string,
): Promise<InitiativeDetails> {
  const { value: item, generationId } = await readSelectedWorkRecord<FullItem>(
    client,
    projectId,
    'planningItems',
    id,
  );
  if (item.version === 1) return { ...item, creator: item.author };
  const first = await client
    .query(workIndex.records, {
      projectId,
      generationId,
      collection: 'planningVersions',
      parentId: id,
      paginationOpts: { cursor: null, numItems: 1 },
    })
    .then(page =>
      page.generationId === generationId && page.page[0]
        ? (JSON.parse(page.page[0].value) as FullItem)
        : null,
    )
    .catch(() => null);
  return { ...item, creator: first?.version === 1 ? first.author : undefined };
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
        memberCommentsOnly: true,
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
