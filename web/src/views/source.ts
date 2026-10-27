// SPDX-License-Identifier: Apache-2.0
import { useCallback } from 'react';
import { useConvex, type ConvexReactClient } from 'convex/react';
import type { FunctionArgs } from 'convex/server';
import { api as hosted } from '../../../convex/_generated/api';
import type { Id } from '../../../convex/_generated/dataModel';
import type { WorkIndexWorkspace } from '../hosted-work-index';
import type { ReadSource } from './model';
export function useHostedViewSource(
  projectId: Id<'hostedProjects'>,
  workspace: WorkIndexWorkspace,
): ReadSource {
  const client = useConvex();
  return useCallback(
    async ({ cursor, offset: _offset, ...request }) => {
      void _offset;
      const args = {
        projectId,
        generationId: workspace.generationId as Id<'projectWorkGenerations'>,
        ...request,
        paginationOpts: { cursor: cursor ?? null, numItems: 30 },
      };
      return readHostedView(client, args);
    },
    [client, projectId, workspace.generationId, workspace.revision],
  );
}

/** Optional display computation must not hide a still-accessible View. */
export async function readHostedView(
  client: Pick<ConvexReactClient, 'query' | 'action'>,
  args: FunctionArgs<typeof hosted.projectViewActions.read>,
) {
  const { lines, ...selection } = args;
  const raw = lines
    ? await client.action(hosted.projectViewActions.read, args)
    : await client.query(hosted.projectViewReads.read, selection);
  const result = JSON.parse(raw);
  if (args.action === 'view' && !args.paginationOpts.cursor && result.head && !result.changes) {
    try {
      result.changes = JSON.parse(
        await client.action(hosted.projectViewDiffstats.compute, {
          projectId: args.projectId,
          generationId: result.generationId,
          viewId: args.viewId!,
        }),
      );
    } catch {
      // A fresh authorized read preserves metadata availability without serving
      // an earlier access decision after revocation or a generation change.
      return JSON.parse(await client.query(hosted.projectViewReads.read, selection));
    }
  }
  return result;
}
