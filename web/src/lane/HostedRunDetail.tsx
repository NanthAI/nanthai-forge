// SPDX-License-Identifier: Apache-2.0
import { useCallback } from 'react';
import { useAction } from 'convex/react';
import { api } from '../../../convex/_generated/api';
import type { Id } from '../../../convex/_generated/dataModel';
import type { WorkIndexWorkspace } from '../hosted-work-index';
import { useWorkRecord } from '../hosted-work-index';
import type { CheckRun } from '../../../src/work-types';
import LocalChecks from '../LocalChecks';
import { RunDetail, type DetailRun } from './RunDetail';
import type { LogPage } from './run-model';
export function HostedRunDetail({
  run,
  projectId,
  workspace,
}: {
  run: DetailRun;
  projectId: Id<'hostedProjects'>;
  workspace: WorkIndexWorkspace;
}) {
  const linkedId = new URLSearchParams(location.search).get('checkRun');
  const linked = useWorkRecord<CheckRun>(projectId, workspace, 'runs', linkedId ?? '');
  const linkedRun = linked?.viewId === run.viewId && linked?.head === run.head ? linked : null;
  const selected = linkedRun ?? run;
  const detail = useWorkRecord<CheckRun>(projectId, workspace, 'runs', selected.id);
  const log = useAction(api.projectViewActions.log);
  const read = useCallback(
    async (stream: 'stdout' | 'stderr', offset: number) =>
      JSON.parse(
        await log({
          projectId,
          generationId: workspace.generationId as Id<'projectWorkGenerations'>,
          runId: selected.id,
          stream,
          offset,
        }),
      ) as LogPage,
    [log, projectId, workspace.generationId, selected.id],
  );
  return (
    <RunDetail
      remote
      key={selected.id}
      superseded={selected.id !== run.id}
      run={detail ?? selected}
      read={read}
    >
      {workspace.capabilities.owner && detail && (
        <LocalChecks
          projectId={projectId}
          workspace={workspace}
          viewId={detail.viewId}
          head={detail.head}
          pinnedRun={detail}
        />
      )}
    </RunDetail>
  );
}
