// SPDX-License-Identifier: Apache-2.0
import { WorkStatus } from './WorkStatus';
import type { Id } from '../../convex/_generated/dataModel';
import type { WorkData, HostedChannelMove, MetadataCommand } from '../../src/work-types';
import { useWorkRecords, useWorkRecord, type WorkIndexWorkspace } from './hosted-work-index';
import { Icon } from './WorkspaceUI';
import HostedChannels from './HostedChannels';
import { HostedReview } from './lane/HostedReview';

export default function IntentDelivery({
  projectId,
  workspace,
  intentId,
  data,
  channels,
  owner,
  editable,
  busy,
  act,
  selected,
  select,
}: {
  projectId: Id<'hostedProjects'>;
  workspace: WorkIndexWorkspace;
  intentId: string;
  data: Pick<WorkData, 'revision' | 'channelMoves' | 'hostedChannelMoves'>;
  channels: HostedChannelMove[];
  owner: boolean;
  editable: boolean;
  busy: boolean;
  act: (command: MetadataCommand) => Promise<unknown>;
  selected: string;
  select: (value: string) => void;
}) {
  const runs = useWorkRecords<WorkData['runs'][number]>(projectId, workspace, 'runs');
  const views = useWorkRecords<WorkData['views'][number]>(projectId, workspace, 'views', intentId);
  const view = useWorkRecord<WorkData['views'][number]>(projectId, workspace, 'views', selected);
  const lanes = useWorkRecords<WorkData['lanes'][number]>(projectId, workspace, 'lanes');
  if (selected)
    return view && view.intentId === intentId ? (
      <HostedReview
        key={view.id}
        projectId={projectId}
        workspace={workspace}
        view={view}
        channels={channels}
        owner={owner}
        editable={editable}
        busy={busy}
        act={act}
        lanes={lanes.records}
        views={views.records}
      />
    ) : (
      <p className="fx-loading" role="status">
        Reading View…
      </p>
    );
  const accepted = data.channelMoves.filter(move => views.records.some(item => item.id === move.viewId));
  return (
    <section>
      <h3>
        <Icon name="source-review" />
        Views
      </h3>
      <ul className="overview-list">
        {views.records.map(item => (
          <li key={item.id}>
            <button onClick={() => select(item.id)}>
              <Icon name="view" />
              View · {new Date(item.at).toLocaleString()}
              <WorkStatus status={item.status} />
            </button>
          </li>
        ))}
      </ul>
      {views.loading && <p role="status">Loading Views…</p>}
      {!views.loading && !views.records.length && <p>No Views recorded for this Intent.</p>}
      {owner && (
        <HostedChannels
          projectId={projectId}
          archiveSha256={workspace.backupDigest}
          data={{ ...data, channelMoves: accepted, views: views.records, runs: runs.records }}
          channels={channels}
          sourceLabels={Object.fromEntries(
            views.records.map(item => [item.id, `View from ${new Date(item.at).toLocaleString()}`]),
          )}
        />
      )}
    </section>
  );
}
