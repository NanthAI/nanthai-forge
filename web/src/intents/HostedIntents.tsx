import { usePageCritical } from '../ui/page-critical';
import { Breadcrumbs, workHref } from '../shell/Breadcrumbs';
// SPDX-License-Identifier: Apache-2.0
import type { ReactNode } from 'react';
import { OwnerLifecycle } from '../lane/OwnerLifecycle';
import { initiativeLinks } from '../cockpit/scale-model';
import type { PlanningItem } from '../../../src/work-planning-types';
import { intentBoardFacts } from './board-facts';
import { useUser } from '@clerk/react';
import { intentViews } from '../views/intent-views';
import { hostedViewHref } from '../views/links';
import { useMemo, useRef } from 'react';
import { PendingWrite } from '../pending-write';
import { hostedError } from '../snapshot';
import { hostedFeed } from '../cockpit/coordination';
import { intentTimeline, intentEvents } from './intent-timeline';
import { activityAuthor, eventContext, type ActivityEvent } from '../coordination-view';
import { go, useCreatedIntent } from './useCreatedIntent';
import { useConvex, useMutation, usePaginatedQuery, useQuery } from 'convex/react';
import { api } from '../../../convex/_generated/api';
import type { Id } from '../../../convex/_generated/dataModel';
import type { WorkData } from '../../../src/work-types';
import type { Session } from '../coordination-view';
import { BriefSourceContext, hostedBriefs } from '../cockpit/brief';
import { withSessions, usePresenceSessions } from '../cockpit/coordination';
import { hostedHref } from '../cockpit/HostedNow';
import type {
  HostedLaneSummary,
  HostedViewSummary,
  HostedRunSummary,
} from '../../../src/work-hosted-summary';
import { cockpitLanes, type CockpitWork } from '../cockpit/model';
import { useWorkRecords, type IntentHeader, type WorkIndexWorkspace } from '../hosted-work-index';
import { useNow } from '../shell/StatusBar';
import { Button, ButtonLink, Empty } from '../ui/primitives';
import { IntentDetailView, type NoteRow } from './IntentDetail';
import { IntentListView } from './IntentList';
import { intentRows, type IntentStatus } from './model';

const laneHref = (id: string) => hostedHref({ projectTab: 'lanes', lane: id });
const intentHref = (id: string) => hostedHref({ projectTab: 'intent', intent: id });
const openDelegate = (id: string) => go(hostedHref({ projectTab: 'intent', intent: id, delegate: '1' }));
const classic = (params: Record<string, string> = {}) =>
  hostedHref({ projectTab: 'intent', classic: '1', ...params });

/** Hosted Intents in the cockpit design. Edits open the classic hosted screens, which own hosted revisions. */
export default function HostedIntents({
  projectId,
  workspace,
  intentId,
  create,
  addNote,
  setStatus,
  addLane,
  combine,
}: {
  projectId: Id<'hostedProjects'>;
  workspace: WorkIndexWorkspace;
  intentId?: string;
  create?: (outcome: string, constraints: string) => Promise<string | null>;
  addNote?: (intentId: string, text: string, kind: 'comment' | 'decision') => Promise<string | null>;
  setStatus?: (intentId: string, status: IntentStatus) => Promise<string | null>;
  addLane?: (intentId: string, name: string) => Promise<string | null>;
  combine?: (intentId: string, inputs: { laneId: string; head: string }[]) => Promise<string | null>;
}) {
  const now = useNow();
  const ownerStatus = useQuery(api.ownerAcceptance.status, {
    projectId,
    viewId: intentId ?? '',
    channel: 'lifecycle',
  });
  const { user } = useUser();
  const intents = useWorkRecords<IntentHeader>(projectId, workspace, 'intents');
  const lanes = useWorkRecords<HostedLaneSummary>(projectId, workspace, 'lanes');
  const views = useWorkRecords<HostedViewSummary>(projectId, workspace, 'views');
  const runs = useWorkRecords<HostedRunSummary>(projectId, workspace, 'runs');
  const planning = useWorkRecords<PlanningItem>(projectId, workspace, 'planningItems');
  const moves = useWorkRecords<WorkData['channelMoves'][number]>(projectId, workspace, 'channelMoves');
  const notes = useWorkRecords<WorkData['intents'][number]['notes'][number]>(
    projectId,
    workspace,
    'notes',
    intentId,
    Boolean(intentId),
  );
  usePageCritical('Work', {
    intents: !intents.initialLoading,
    lanes: !lanes.initialLoading,
    views: !views.initialLoading,
    runs: !runs.initialLoading,
    planning: !planning.initialLoading,
    moves: !moves.initialLoading,
  });
  const sessions = usePresenceSessions(projectId);
  const feed = usePaginatedQuery(api.projectCoordination.feed, intentId ? { projectId, intentId } : 'skip', {
    initialNumItems: 100,
  });
  const publish = useMutation(api.projectCoordination.publish);
  const writer = useRef<PendingWrite<
    import('../../../src/coordination-types').CoordinationCommand,
    unknown
  > | null>(null);
  writer.current ??= new PendingWrite(attempt => publish({ projectId, ...attempt }));
  const sendMessage = async (text: string, laneId?: string): Promise<string | null> => {
    try {
      await writer.current!.send({
        kind: 'message',
        text,
        context: { intentId: intentId!, ...(laneId ? { laneId } : {}) },
      });
      return null;
    } catch (error) {
      return hostedError(error);
    }
  };
  const client = useConvex();
  const briefs = useMemo(() => hostedBriefs(client, projectId), [client, projectId]);
  const records = useMemo(
    () => ({
      planningItems: planning.records,
      intents: intents.records,
      lanes: lanes.records,
      views: views.records,
      runs: runs.records,
      channelMoves: moves.records,
      notes: notes.records,
    }),
    [
      planning.records,
      intents.records,
      lanes.records,
      views.records,
      runs.records,
      moves.records,
      notes.records,
    ],
  );
  return (
    <BriefSourceContext.Provider value={briefs}>
      <HostedIntentsView
        preferenceScope={`hosted:${user?.id ?? 'signed-out'}:${projectId}`}
        records={records}
        events={feed.results as ActivityEvent[]}
        activityMore={
          feed.status === 'CanLoadMore' || feed.status === 'LoadingMore' ? (
            <Button
              variant="ghost"
              size="sm"
              disabled={feed.status === 'LoadingMore'}
              onClick={() => feed.loadMore(100)}
            >
              {feed.status === 'LoadingMore' ? 'Reading activity…' : 'Earlier activity'}
            </Button>
          ) : undefined
        }
        sendMessage={sendMessage}
        sessions={sessions.results as Session[]}
        now={now}
        intentId={intentId}
        loading={
          sessions.status !== 'Exhausted' ||
          intents.loading ||
          (Boolean(intentId) && (lanes.loading || views.loading || runs.loading || moves.loading))
        }
        {...(create ? { create } : {})}
        {...(addLane ? { addLane } : {})}
        {...(combine ? { combine } : {})}
        {...(addNote ? { addNote } : {})}
        {...(setStatus && ownerStatus && !ownerStatus.native ? { setStatus } : {})}
        {...(ownerStatus?.native
          ? {
              lifecycle: (intent: IntentHeader) => (
                <OwnerLifecycle
                  key={intent.id}
                  projectId={projectId}
                  collection="intents"
                  id={intent.id}
                  head={intent.base}
                  state={intent.status}
                  editable={workspace.capabilities.owner}
                />
              ),
            }
          : {})}
      />
    </BriefSourceContext.Provider>
  );
}

/** Pure hosted Intents list/detail using the same summaries as the live screen. */
export function HostedIntentsView({
  preferenceScope,
  records,
  sessions,
  now,
  intentId,
  loading = false,
  create,
  addNote,
  setStatus,
  addLane,
  combine,
  lifecycle,
  events = [],
  activityMore,
  sendMessage,
}: {
  lifecycle?: (intent: IntentHeader) => ReactNode;
  events?: readonly ActivityEvent[];
  activityMore?: ReactNode;
  sendMessage?: (text: string, laneId?: string) => Promise<string | null>;
  preferenceScope?: string;
  records: CockpitWork & {
    planningItems?: readonly PlanningItem[];
    intents: readonly IntentHeader[];
    channelMoves: readonly WorkData['channelMoves'][number][];
    notes: readonly NoteRow[];
  };
  sessions: readonly Session[];
  now: number;
  intentId?: string;
  loading?: boolean;
  create?: (outcome: string, constraints: string) => Promise<string | null>;
  addNote?: (intentId: string, text: string, kind: 'comment' | 'decision') => Promise<string | null>;
  setStatus?: (intentId: string, status: IntentStatus) => Promise<string | null>;
  addLane?: (intentId: string, name: string) => Promise<string | null>;
  combine?: (intentId: string, inputs: { laneId: string; head: string }[]) => Promise<string | null>;
}) {
  const rows = useMemo(
    () =>
      intentBoardFacts(
        intentRows(records.intents, withSessions(cockpitLanes(records), sessions, now)),
        records,
        sessions,
      ),
    [records, sessions, now],
  );
  const awaitCreated = useCreatedIntent(records.intents, openDelegate);
  const body = () => {
    if (!intentId)
      return (
        <IntentListView
          initiatives={initiativeLinks(records.planningItems ?? [])}
          key={preferenceScope}
          {...(preferenceScope ? { preferenceScope } : {})}
          rows={rows}
          countsKnown={!loading}
          now={now}
          intentHref={intentHref}
          {...(create
            ? {
                create: async (outcome: string, constraints: string, delegate?: boolean) => {
                  const problem = await create(outcome, constraints);
                  if (!problem && delegate) awaitCreated(outcome);
                  return problem;
                },
              }
            : {})}
        />
      );
    if (loading)
      return (
        <div className="fx-page fx-intent-page fx-view-placeholder" aria-busy="true">
          <h1>Intent</h1>
          <p className="fx-loading" role="status">
            Reading Intent…
          </p>
        </div>
      );
    const row = rows.find(item => item.id === intentId);
    if (!row)
      return (
        <div className="fx-page">
          <Empty glyph="intent" title={loading ? 'Reading Intent…' : 'Intent not found'}>
            <a href={hostedHref({ projectTab: 'intent' })}>All Intents</a>
          </Empty>
        </div>
      );
    const viewRows = intentViews(records, intentId);
    const scopedEvents = intentEvents(records, intentId, events);
    const timeline = intentTimeline(
      records,
      intentId,
      hostedFeed(scopedEvents, sessions, records.lanes, scopedEvents.length),
    );
    const noteRows: NoteRow[] = [
      ...records.notes,
      ...scopedEvents.flatMap(event => {
        if (event.command.kind !== 'message') return [];
        const context = eventContext(event, scopedEvents);
        const lane = records.lanes.find(lane => lane.id === context.laneId);
        return [
          {
            text: event.command.text,
            kind: 'comment' as const,
            at: new Date(event.at).toISOString(),
            actor: {
              name: activityAuthor(event, [...sessions]),
              kind: event.command.sessionId ? ('agent' as const) : ('human' as const),
            },
            ...(lane ? { lane: { id: lane.id, name: lane.name } } : {}),
          },
        ];
      }),
    ].map(note => ({
      text: note.text,
      kind: note.kind,
      at: note.at,
      ...('actor' in note && note.actor ? { actor: note.actor } : {}),
      ...('lane' in note && note.lane ? { lane: note.lane } : {}),
    }));
    return (
      <IntentDetailView
        row={row}
        records={records}
        timeline={timeline}
        activityMore={activityMore}
        base={(records.intents as readonly IntentHeader[]).find(intent => intent.id === intentId)?.base}
        {...(sendMessage ? { sendMessage } : {})}
        {...(addLane ? { addLane: (name: string) => addLane(intentId, name) } : {})}
        {...(combine
          ? { combine: (inputs: { laneId: string; head: string }[]) => combine(intentId, inputs) }
          : {})}
        views={viewRows}
        notes={noteRows}
        planning={[]}
        now={now}
        laneHref={laneHref}
        viewHref={hostedViewHref}
        reviewHref={id =>
          hostedHref({
            projectTab: 'intent',
            intent: intentId,
            intentTab: 'delivery',
            reviewView: id,
            classic: '1',
          })
        }
        back={<Breadcrumbs items={[{ label: row.outcome, href: workHref({ intent: row.id }) }]} />}
        {...(addNote
          ? { addNote: (text: string, kind: 'comment' | 'decision') => addNote(intentId, text, kind) }
          : {})}
        {...(setStatus && !lifecycle
          ? { setStatus: (status: IntentStatus) => setStatus(intentId, status) }
          : {})}
        more={
          <>
            {lifecycle?.((records.intents as readonly IntentHeader[]).find(i => i.id === intentId)!)}
            <ButtonLink variant="ghost" href={classic({ intent: intentId, intentTab: 'discussion' })}>
              Discuss, plan and review
            </ButtonLink>
          </>
        }
      />
    );
  };
  return <div className="fx">{body()}</div>;
}
