import { readTestContract } from '../lane/test-contract-api';
import type { IntentTestContract } from '../../../src/intent-test-contract';
import { planningVersionLabel } from '../../../src/work-planning-lifecycle';
import { usePlanningActors } from '../planning/usePlanningActors';
import type { AttributedPlanningItem } from '../planning/attribution';
import { usePageCritical } from '../ui/page-critical';
import { useAttention } from '../shell/attention-context';
// SPDX-License-Identifier: Apache-2.0
import type { ReactNode } from 'react';
import type { LifecycleParts } from '../lane/LifecycleParts';
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
import { type NoteRow } from './IntentDetail';
import { IntentListView } from './IntentList';
import { PlanningIntentPage } from '../PlanningIntents';
import type { PlanningAct } from '../WorkPlanning';
import { readWorkRecord } from '../hosted-work-index';
import { intentRows, type IntentStatus } from './model';

type EditableIntent = IntentHeader & {
  description?: string;
  updatedAt?: string;
  memberships?: { initiativeId: string }[];
};
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
  planningAct,
}: {
  planningAct?: PlanningAct;
  projectId: Id<'hostedProjects'>;
  workspace: WorkIndexWorkspace;
  intentId?: string;
  create?: (outcome: string, constraints: string) => Promise<string | null>;
  addNote?: (intentId: string, text: string, kind: 'comment' | 'decision') => Promise<string | null>;
  setStatus?: (intentId: string, status: Exclude<IntentStatus, 'proposed'>) => Promise<string | null>;
  addLane?: (intentId: string, name: string) => Promise<string | null>;
  combine?: (intentId: string, inputs: { laneId: string; head: string }[]) => Promise<string | null>;
}) {
  const now = useNow();
  const canonicalContract = useQuery(readTestContract, intentId ? { projectId, intentId } : 'skip');
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
  const selectedPlanning = planning.records.find(
    item => item.kind === 'issue' && (item.id === intentId || item.intentIds.includes(intentId ?? '')),
  );
  const planningComments = useWorkRecords<WorkData['planningComments'][number]>(
    projectId,
    workspace,
    'planningComments',
    selectedPlanning?.id ?? intentId,
    Boolean(intentId),
  );
  const planningVersions = useWorkRecords<PlanningItem>(
    projectId,
    workspace,
    'planningVersions',
    selectedPlanning?.id ?? intentId,
    Boolean(intentId),
  );
  const attributedVersions = usePlanningActors(projectId, workspace, planningVersions.records);
  const commentWrite = useRef<
    | Extract<import('../../../src/work-planning-types').PlanningWrite, { action: 'comment-planning-item' }>
    | undefined
  >(undefined);
  const addPlanningComment = async (id: string, text: string): Promise<string | null> => {
    const command =
      commentWrite.current?.text === text
        ? commentWrite.current
        : {
            action: 'comment-planning-item' as const,
            operationId: crypto.randomUUID(),
            itemId: selectedPlanning?.id ?? id,
            text,
            authorLabel: user?.fullName || user?.username || '',
          };
    commentWrite.current = command;
    try {
      const ack = await planningAct!(command);
      if (ack?.operationId !== command.operationId)
        return 'The request did not complete. Retry keeps its original operation.';
      commentWrite.current = undefined;
      return null;
    } catch (error) {
      return hostedError(error);
    }
  };
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
      intents: intents.records.map(intent => {
        if (!canonicalContract || intent.id !== intentId) return intent;
        const { contract } = JSON.parse(canonicalContract) as { contract: IntentTestContract | null };
        return { ...intent, testContracts: contract ? [contract] : [] };
      }),
      lanes: lanes.records,
      views: views.records,
      runs: runs.records,
      channelMoves: moves.records,
      notes: notes.records,
      planningComments: planningComments.records,
      planningVersions: attributedVersions,
    }),
    [
      planning.records,
      canonicalContract,
      intentId,
      intents.records,
      lanes.records,
      views.records,
      runs.records,
      moves.records,
      notes.records,
      planningComments.records,
      attributedVersions,
    ],
  );
  const lifecycle = null;
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
        {...(planningAct ? { addNote: addPlanningComment } : addNote ? { addNote } : {})}
        {...(setStatus ? { setStatus } : {})}
        lifecycle={lifecycle}
        planningAct={planningAct}
        loadPlanningItem={async item =>
          readWorkRecord<PlanningItem>(client, projectId, workspace, 'planningItems', item.id)
        }
        loadIntent={async id => readWorkRecord<IntentHeader>(client, projectId, workspace, 'intents', id)}
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
  planningAct,
  loadPlanningItem,
  loadIntent,
}: {
  lifecycle?: LifecycleParts | null;
  planningAct?: PlanningAct;
  loadPlanningItem?: (item: PlanningItem) => Promise<PlanningItem>;
  loadIntent?: (id: string) => Promise<IntentHeader>;
  events?: readonly ActivityEvent[];
  activityMore?: ReactNode;
  sendMessage?: (text: string, laneId?: string) => Promise<string | null>;
  preferenceScope?: string;
  records: CockpitWork & {
    planningItems?: readonly PlanningItem[];
    planningComments?: readonly WorkData['planningComments'][number][];
    planningVersions?: readonly AttributedPlanningItem[];
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
  setStatus?: (intentId: string, status: Exclude<IntentStatus, 'proposed'>) => Promise<string | null>;
  addLane?: (intentId: string, name: string) => Promise<string | null>;
  combine?: (intentId: string, inputs: { laneId: string; head: string }[]) => Promise<string | null>;
}) {
  const attention = useAttention();
  const rows = useMemo(
    () =>
      intentBoardFacts(
        intentRows(records.intents, withSessions(cockpitLanes(records, attention?.queue), sessions, now)),
        records,
        sessions,
      ),
    [records, sessions, now, attention?.queue],
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
    for (const version of records.planningVersions ?? [])
      timeline.push({
        id: `planning:${version.operationId}`,
        at: version.at,
        text: planningVersionLabel(
          version,
          records.planningVersions?.find(previous => previous.version === version.previousVersion),
        ),
        detail: [
          version.actorDisplayName && `by ${version.actorDisplayName}`,
          `version ${version.version}`,
          version.reason,
        ]
          .filter(Boolean)
          .join(' · '),
        glyph: 'file',
        tone: 'plain',
      });
    timeline.sort((a, b) => new Date(b.at).getTime() - new Date(a.at).getTime());
    const noteRows: NoteRow[] = [
      ...records.notes,
      ...(records.planningComments ?? []).map(comment => ({
        text: comment.text,
        kind: 'comment' as const,
        at: comment.at,
        ...(comment.authorLabel ? { actor: { name: comment.authorLabel, kind: 'human' as const } } : {}),
      })),
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
    const intent = (records.intents as readonly EditableIntent[]).find(intent => intent.id === intentId)!;
    const item = records.planningItems?.find(
      item => item.kind === 'issue' && (item.id === intentId || item.intentIds.includes(intentId)),
    );
    const memberships = intent.memberships?.map(link => link.initiativeId) ?? [];
    const initiatives = (records.planningItems ?? []).filter(group => group.kind === 'initiative');
    const planningItem = (full: EditableIntent): PlanningItem => ({
      id: full.id,
      operationId: '',
      request: '',
      version: 0,
      previousVersion: 0,
      kind: 'issue',
      title: full.outcome,
      body: full.description ?? full.constraints,
      status: full.status === 'completed' || full.status === 'abandoned' ? 'closed' : 'open',
      intentIds: [],
      at: full.updatedAt ?? full.createdAt,
      provenance: 'user-declared-local',
      ...(memberships[0] ? { initiativeId: memberships[0] } : {}),
    });
    return (
      <PlanningIntentPage
        item={item ?? planningItem(intent)}
        origin={records.planningVersions?.find(version => version.version === 1)}
        initiatives={initiatives}
        readOnly={!planningAct && !setStatus && !lifecycle}
        act={planningAct}
        lifecycle={lifecycle}
        loadItem={async () =>
          item && loadPlanningItem
            ? loadPlanningItem(item)
            : planningItem(loadIntent ? await loadIntent(intentId) : intent)
        }
        detail={{
          row,
          records,
          timeline,
          activityMore,
          base: intent.base,
          ...(sendMessage ? { sendMessage } : {}),
          ...(addLane ? { addLane: (name: string) => addLane(intentId, name) } : {}),
          ...(combine
            ? { combine: (inputs: { laneId: string; head: string }[]) => combine(intentId, inputs) }
            : {}),
          views: viewRows,
          notes: noteRows,
          planning: initiatives.filter(
            group =>
              group.intentIds.includes(intentId) ||
              memberships.includes(group.id) ||
              item?.initiativeId === group.id,
          ),
          now,
          laneHref,
          viewHref: hostedViewHref,
          reviewHref: id =>
            hostedHref({
              projectTab: 'intent',
              intent: intentId,
              intentTab: 'delivery',
              reviewView: id,
              classic: '1',
            }),
          ...(addNote
            ? { addNote: (text: string, kind: 'comment' | 'decision') => addNote(intentId, text, kind) }
            : {}),
          ...(setStatus && !lifecycle
            ? { setStatus: (status: Exclude<IntentStatus, 'proposed'>) => setStatus(intentId, status) }
            : {}),
          more: (
            <ButtonLink variant="ghost" href={classic({ intent: intentId, intentTab: 'discussion' })}>
              Discuss, plan and review
            </ButtonLink>
          ),
        }}
      />
    );
  };
  return <div className="fx">{body()}</div>;
}
