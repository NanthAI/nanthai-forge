// SPDX-License-Identifier: Apache-2.0
import { InitiativeConversation } from './planning/InitiativePage';
import { usePlanningActors } from './planning/usePlanningActors';
import { DetailsText } from './ui/DetailsText';
import { PlanningIntentPage } from './PlanningIntents';
import { Conversation } from './intents/IntentParts';
import { intentRows } from './intents/model';
import { cockpitLanes, type CockpitWork } from './cockpit/model';
import { intentViews } from './views/intent-views';
import { intentTimeline } from './intents/intent-timeline';
import { hostedHref } from './cockpit/HostedNow';
import { BriefSourceContext, hostedBriefs } from './cockpit/brief';
import { planningGroups } from './planning-rows';
import { useDestination } from './WorkspaceUI';
import { useUser } from '@clerk/react';
import { age } from './ui/status';
import type { PlanningLane } from './planning-rows';
import { useState, useEffect, useCallback, useMemo, useRef } from 'react';
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
      <DetailsText text={value.body} />
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
type Lifecycle = NonNullable<WorkData['intents'][number]['lifecycle']>[number];
function InitiativeLifecycle({
  projectId,
  workspace,
  id,
  loaded,
}: Pick<Context, 'projectId' | 'workspace'> & {
  id: string;
  loaded: (id: string, entries: Lifecycle[]) => void;
}) {
  const history = useWorkRecords<Lifecycle>(projectId, workspace, 'lifecycle', id);
  useEffect(() => {
    loaded(id, history.records);
  }, [id, loaded, history.records]);
  return null;
}

function PlannedIntentRoute({
  item,
  items,
  ...props
}: Context & { item: PlanningItem; items: PlanningItem[] }) {
  const client = useConvex();
  const { user } = useUser();
  const briefs = useMemo(() => hostedBriefs(client, props.projectId), [client, props.projectId]);
  const value = useResolvedWorkValue(props.projectId, props.workspace, 'planningItems', item);
  const history = useWorkRecords<PlanningItem>(props.projectId, props.workspace, 'planningVersions', item.id);
  const versions = usePlanningActors(props.projectId, props.workspace, history.records);
  const comments = useWorkRecords<WorkData['planningComments'][number]>(
    props.projectId,
    props.workspace,
    'planningComments',
    item.id,
  );
  const lanes = useWorkRecords<WorkData['lanes'][number]>(props.projectId, props.workspace, 'lanes');
  const views = useWorkRecords<WorkData['views'][number]>(props.projectId, props.workspace, 'views');
  const runs = useWorkRecords<WorkData['runs'][number]>(props.projectId, props.workspace, 'runs');
  const messages = useRef<
    | Extract<import('../../src/work-planning-types').PlanningWrite, { action: 'comment-planning-item' }>
    | undefined
  >(undefined);
  const intent = props.intents.find(intent => intent.id === item.id || item.intentIds.includes(intent.id));
  const work: CockpitWork = {
    intents: intent ? [intent] : [],
    lanes: lanes.records,
    views: views.records,
    runs: runs.records,
  };
  const source = intent ?? {
    id: item.id,
    outcome: item.title,
    constraints: item.body,
    status: item.status === 'closed' ? ('completed' as const) : ('active' as const),
    createdAt:
      versions.find(version => version.version === 1)?.at ?? (item.version === 1 ? item.at : undefined),
  };
  const row = intentRows([source], cockpitLanes(work))[0]!;
  const now = Date.now();
  const notes = comments.records.map(comment => ({
    text: comment.text,
    kind: 'comment' as const,
    at: comment.at,
    ...(comment.authorLabel ? { actor: { name: comment.authorLabel, kind: 'human' as const } } : {}),
  }));
  if (!value) return <p role="status">Loading Intent…</p>;
  const timeline = [
    ...versions.map(version => ({
      id: `planning:${version.operationId}`,
      at: version.at,
      tone: 'plain' as const,
      glyph: 'file' as const,
      text: version.version === 1 ? 'Planned' : version.status === 'closed' ? 'Done' : 'Details edited',
      detail: [version.actorDisplayName && `by ${version.actorDisplayName}`, `version ${version.version}`]
        .filter(Boolean)
        .join(' · '),
    })),
    ...(intent ? intentTimeline(work, intent.id) : []),
  ].sort((a, b) => new Date(b.at).getTime() - new Date(a.at).getTime());
  return (
    <BriefSourceContext.Provider value={briefs}>
      <PlanningIntentPage
        item={value}
        origin={versions.find(version => version.version === 1)}
        initiatives={items}
        readOnly={props.readOnly}
        busy={props.busy}
        act={props.act}
        loadItem={() =>
          readWorkRecord<PlanningItem>(client, props.projectId, props.workspace, 'planningItems', item.id)
        }
        detail={{
          row,
          views: intent ? intentViews(work, intent.id) : [],
          notes,
          planning: [],
          now,
          timeline,
          canStart: Boolean(intent),
          startIntentId: intent?.id,
          laneHref: id => hostedHref({ projectTab: 'lanes', lane: id }),
          conversation: (
            <Conversation
              notes={notes}
              now={now}
              laneHref={id => hostedHref({ projectTab: 'lanes', lane: id })}
              placeholder="Add to the conversation…"
              {...(!props.readOnly
                ? {
                    add: async (text: string) => {
                      const command =
                        messages.current?.text === text
                          ? messages.current
                          : {
                              action: 'comment-planning-item' as const,
                              operationId: crypto.randomUUID(),
                              itemId: item.id,
                              text,
                              authorLabel: user?.fullName || user?.username || '',
                            };
                      messages.current = command;
                      try {
                        const ack = await props.act(command);
                        if (ack?.operationId !== command.operationId)
                          return 'The request did not complete. Retry keeps its original operation.';
                        messages.current = undefined;
                        return null;
                      } catch (error) {
                        return (error as Error).message;
                      }
                    },
                  }
                : {})}
            />
          ),
        }}
      />
    </BriefSourceContext.Provider>
  );
}

export default function HostedIndexedPlanning(
  props: Context & { exportHistory: () => Promise<PlanningExport> },
) {
  const client = useConvex();
  const { user } = useUser();
  const [selected] = useDestination('planningItem');
  const [histories, setHistories] = useState<Record<string, Lifecycle[]>>({});
  const scope = `${props.projectId}:${props.workspace.generationId}`;
  const loaded = useCallback(
    (id: string, entries: Lifecycle[]) =>
      setHistories(current => ({ ...current, [`${scope}:${id}`]: entries })),
    [scope],
  );
  const items = useWorkRecords<PlanningItem>(props.projectId, props.workspace, 'planningItems');
  const lanes = useWorkRecords<PlanningLane>(props.projectId, props.workspace, 'lanes');
  const comments = useWorkRecords<WorkData['planningComments'][number]>(
    props.projectId,
    props.workspace,
    'planningComments',
    selected,
    items.records.some(item => item.id === selected && item.kind === 'initiative'),
  );
  const origins = useWorkRecords<PlanningItem>(
    props.projectId,
    props.workspace,
    'planningVersions',
    selected,
    items.records.some(item => item.id === selected && item.kind === 'initiative'),
  );
  const attributedOrigins = usePlanningActors(props.projectId, props.workspace, origins.records);
  const data: PlanningData = {
    revision: props.workspace.revision,
    intents: props.intents,
    lanes: lanes.records,
    planningItems: items.records,
    planningComments: comments.records,
    hostedEvents: [],
  };
  const selectedGroup = planningGroups(items.records, props.intents, lanes.records).find(
    group => group.id === selected,
  );
  const timelineData: PlanningData = {
    ...data,
    intents: props.intents.map(intent => ({
      ...intent,
      lifecycle: histories[`${scope}:${intent.id}`] ?? intent.lifecycle,
    })),
  };
  const selectedIntent = items.records.find(item => item.id === selected && item.kind === 'issue');
  if (selectedIntent)
    return (
      <div className="fx">
        <PlannedIntentRoute key={selectedIntent.id} {...props} item={selectedIntent} items={items.records} />
      </div>
    );
  return (
    <>
      {selectedGroup?.item &&
        selectedGroup.rows.flatMap(row =>
          row.intentId
            ? [
                <InitiativeLifecycle
                  key={`${scope}:${row.intentId}`}
                  projectId={props.projectId}
                  workspace={props.workspace}
                  id={row.intentId}
                  loaded={loaded}
                />,
              ]
            : [],
        )}
      {items.loading && <p role="status">Loading planning items…</p>}
      <WorkPlanning
        intentId={props.intentId}
        timelineData={timelineData}
        initiativeOrigin={attributedOrigins.find(item => item.version === 1)}
        renderConversation={item => (
          <>
            {comments.loading && <p role="status">Loading conversation…</p>}
            <InitiativeConversation
              key={item.id}
              itemId={item.id}
              authorLabel={user?.fullName || user?.username || ''}
              data={data}
              busy={props.busy}
              readOnly={props.readOnly}
              act={props.act}
              commentContent={comment => (
                <CommentBody projectId={props.projectId} workspace={props.workspace} comment={comment} />
              )}
            />
          </>
        )}
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
