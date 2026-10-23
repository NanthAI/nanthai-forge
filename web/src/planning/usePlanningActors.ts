// SPDX-License-Identifier: Apache-2.0
import { useMemo } from 'react';
import { useQueries } from 'convex/react';
import type { Id } from '../../../convex/_generated/dataModel';
import type { PlanningItem } from '../../../src/work-planning-types';
import { workIndex, type WorkIndexWorkspace } from '../hosted-work-index';
import type { AttributedPlanningItem } from './attribution';

/** Resolve only the recorded operations shown on this detail page, using current read authority. */
export function usePlanningActors(
  projectId: Id<'hostedProjects'>,
  workspace: WorkIndexWorkspace,
  versions: readonly PlanningItem[],
): AttributedPlanningItem[] {
  const queries = useMemo(
    () =>
      Object.fromEntries(
        versions
          .filter(version => version.operationId)
          .map(version => [
            version.operationId,
            {
              query: workIndex.detail,
              args: {
                projectId,
                generationId: workspace.generationId,
                collection: 'events',
                id: version.operationId,
              },
            },
          ]),
      ),
    [projectId, workspace.generationId, versions],
  );
  const results = useQueries(queries);
  return useMemo(
    () =>
      versions.map(version => {
        const result = results[version.operationId];
        if (result instanceof Error) throw result;
        const event =
          result?.generationId === workspace.generationId && result?.value
            ? (JSON.parse(result.value) as { actorDisplayName?: string })
            : null;
        return {
          ...version,
          ...(event?.actorDisplayName ? { actorDisplayName: event.actorDisplayName } : {}),
        };
      }),
    [versions, results, workspace.generationId],
  );
}
