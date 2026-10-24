// SPDX-License-Identifier: Apache-2.0
import { useCallback } from 'react';
import { useConvex } from 'convex/react';
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
      const raw = request.lines
        ? await client.action(hosted.projectViewActions.read, args)
        : await client.query(hosted.projectViewReads.read, args);
      return JSON.parse(raw);
    },
    [client, projectId, workspace.generationId, workspace.revision],
  );
}
