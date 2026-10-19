// SPDX-License-Identifier: Apache-2.0
import { age } from './ui/status';
import { useState } from 'react';
import { ActionPanel } from './WorkspaceUI';
import { useConvex } from 'convex/react';
import type { Id } from '../../convex/_generated/dataModel';
import type { HostedEvent, PlanningItem, WorkData } from '../../src/work-types';
import {
  WorkPlanning,
  PlanningThread,
  type PlanningData,
  type PlanningExport,
  type PlanningAct,
} from './WorkPlanning';
import {
  useWorkRecords,
  useWorkRecord,
  useResolvedWorkValue,
  readWorkRecord,
  type WorkIndexWorkspace,
  type IntentHeader,
} from './hosted-work-index';

type Context = {
  projectId: Id<'hostedProjects'>;
  workspace: WorkIndexWorkspace;
  intents: IntentHeader[];
  readOnly?: boolean;
  busy: boolean;
  act: PlanningAct;
  intentId?: string;
};
function Provenance({
  projectId,
  workspace,
  operationId,
}: Pick<Context, 'projectId' | 'workspace'> & { operationId: string }) {
  const [open, setOpen] = useState(false);
  const event = useWorkRecord<HostedEvent>(projectId, open ? workspace : null, 'events', operationId);
  return (
    <ActionPanel className="item-provenance" onChange={setOpen} title="Entry provenance">
      <p>User-declared planning record. Discussion names are supplied labels.</p>
      {event && (
        <p>
          Server-recorded actor <code>{event.actor}</code> · operation <code>{event.id}</code> · {event.at}.
          An exported observation does not authenticate offline authorship.
        </p>
      )}
    </ActionPanel>
  );
}
function ItemBody({
  projectId,
  workspace,
  item,
  open,
}: Pick<Context, 'projectId' | 'workspace' | 'intents'> & { item: PlanningItem; open: boolean }) {
  const value = useResolvedWorkValue(projectId, workspace, 'planningItems', item, open);
  return value ? (
    <>
      <p>{value.body}</p>
    </>
  ) : (
    <p role="status">Loading item…</p>
  );
}
function CommentBody({
  projectId,
  workspace,
  comment,
}: Pick<Context, 'projectId' | 'workspace'> & { comment: WorkData['planningComments'][number] }) {
  const value = useResolvedWorkValue(projectId, workspace, 'planningComments', comment);
  return value ? (
    <>
      <small>
        {value.authorLabel || '—'} · <time title={value.at}>{age(value.at, Date.now())}</time>
      </small>
      <p>{value.text}</p>
    </>
  ) : (
    <p role="status">Loading discussion entry…</p>
  );
}
function Version({
  projectId,
  workspace,
  version,
}: Pick<Context, 'projectId' | 'workspace'> & { version: PlanningItem }) {
  const value = useResolvedWorkValue(projectId, workspace, 'planningVersions', version);
  return value ? (
    <div>
      <p>
        Version {value.version}: {value.title} · {value.status} · {value.at}
      </p>
      <p>{value.body}</p>
      <p className="provenance">
        Intent IDs: {value.intentIds.join(', ') || 'None'} · Initiative: {value.initiativeId ?? 'None'}
      </p>
      <Provenance projectId={projectId} workspace={workspace} operationId={value.operationId} />
    </div>
  ) : (
    <p role="status">Loading version…</p>
  );
}
function ItemHistory({
  projectId,
  workspace,
  intents,
  item,
  busy,
  readOnly,
  act,
  open,
}: Context & { item: PlanningItem; open: boolean }) {
  const versions = useWorkRecords<PlanningItem>(projectId, workspace, 'planningVersions', item.id, open);
  const comments = useWorkRecords<WorkData['planningComments'][number]>(
    projectId,
    workspace,
    'planningComments',
    item.id,
    true,
  );
  const data: PlanningData = {
    revision: workspace.revision,
    intents,
    planningItems: versions.records,
    planningComments: comments.records,
    hostedEvents: [],
  };
  const provenance = (operationId: string) => (
    <Provenance projectId={projectId} workspace={workspace} operationId={operationId} />
  );
  return (
    <>
      {open && (
        <div className="planning-detail-history">
          {versions.loading && <p role="status">Loading history…</p>}
          {versions.records.map(value => (
            <Version key={value.version} projectId={projectId} workspace={workspace} version={value} />
          ))}
        </div>
      )}
      {comments.loading && <p role="status">Loading discussion…</p>}
      <PlanningThread
        itemId={item.id}
        data={data}
        busy={busy}
        readOnly={readOnly}
        act={act}
        provenance={provenance}
        commentContent={comment => (
          <CommentBody projectId={projectId} workspace={workspace} comment={comment} />
        )}
      />
    </>
  );
}
export default function HostedIndexedPlanning(
  props: Context & { exportHistory: () => Promise<PlanningExport> },
) {
  const client = useConvex();
  const items = useWorkRecords<PlanningItem>(props.projectId, props.workspace, 'planningItems');
  const lanes = useWorkRecords<{ intentId: string }>(props.projectId, props.workspace, 'lanes');
  const data: PlanningData = {
    revision: props.workspace.revision,
    intents: props.intents,
    lanes: lanes.records,
    planningItems: items.records,
    planningComments: [],
    hostedEvents: [],
  };
  return (
    <>
      {items.loading && <p role="status">Loading planning items…</p>}
      <WorkPlanning
        intentId={props.intentId}
        data={data}
        readOnly={props.readOnly}
        busy={props.busy}
        act={props.act}
        exportHistory={props.exportHistory}
        loadItem={id =>
          readWorkRecord<PlanningItem>(client, props.projectId, props.workspace, 'planningItems', id)
        }
        renderBody={(item, open) => (
          <ItemBody
            projectId={props.projectId}
            workspace={props.workspace}
            intents={props.intents}
            item={item}
            open={open}
          />
        )}
        provenance={operationId => (
          <Provenance projectId={props.projectId} workspace={props.workspace} operationId={operationId} />
        )}
        renderDetails={(item, open) => <ItemHistory {...props} item={item} open={open} />}
      />
    </>
  );
}
