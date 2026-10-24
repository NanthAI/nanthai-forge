import { HostedConversation } from '../lane/HostedConversation';
import { ConversationScope } from '../lane/ConversationScope';
// SPDX-License-Identifier: Apache-2.0
import type { Id } from '../../../convex/_generated/dataModel';
import { useWorkRecords, type WorkIndexWorkspace } from '../hosted-work-index';
import type { HostedLaneSummary, HostedViewSummary } from '../../../src/work-hosted-summary';
import { hostedHref } from '../cockpit/HostedNow';
import { hostedViewHref } from './links';
import { useHostedViewSource } from './source';
import { ViewPage } from './ViewPage';
export function HostedView({
  projectId,
  workspace,
  viewId,
}: {
  projectId: Id<'hostedProjects'>;
  workspace: WorkIndexWorkspace;
  viewId: string;
}) {
  const lanes = useWorkRecords<HostedLaneSummary>(projectId, workspace, 'lanes');
  const views = useWorkRecords<HostedViewSummary>(projectId, workspace, 'views');
  const source = useHostedViewSource(projectId, workspace);
  return (
    <div className="fx">
      <ViewPage
        conversation={view => (
          <ConversationScope
            lanes={view.inputs.map(input => ({
              id: input.laneId,
              name: lanes.records.find(lane => lane.id === input.laneId)?.name ?? 'Lane',
            }))}
          >
            {laneId => (
              <HostedConversation
                projectId={projectId}
                {...(laneId ? { laneId } : {})}
                intentId={view.intentId}
                viewId={viewId}
              />
            )}
          </ConversationScope>
        )}
        viewNumber={id => {
          const view = views.records.find(v => v.id === id);
          return view
            ? views.records.filter(v => v.intentId === view.intentId).findIndex(v => v.id === id) + 1
            : undefined;
        }}
        laneName={id => lanes.records.find(l => l.id === id)?.name ?? 'Lane'}
        mapContext={{
          projectId,
          backupId: workspace.backupId,
          peers: lanes.records
            .filter(l => !['completed', 'abandoned'].includes(l.state))
            .map(l => ({ id: l.id, name: l.name, base: l.base, head: l.head })),
        }}
        viewId={viewId}
        source={source}
        laneHref={id => hostedHref({ projectTab: 'lanes', lane: id })}
        intentHref={id => hostedHref({ projectTab: 'intent', intent: id })}
        viewHref={hostedViewHref}
        reviewHref={(id, intentId) =>
          hostedHref({
            projectTab: 'intent',
            intent: intentId,
            classic: '1',
            intentTab: 'delivery',
            reviewView: id,
          })
        }
      />
    </div>
  );
}
