import { OwnerDecisionsPointer } from '../decisions/OwnerDecisionsPanel';
import { useGenerationFreshness } from '../ui/generation-freshness';
import { usePageCritical } from '../ui/page-critical';
import { ErrorToast } from '../ui/Toast';
// SPDX-License-Identifier: Apache-2.0
import { WorkReferenceContext, workReferences } from './WorkReferences';
import { initiativeLinks } from '../cockpit/scale-model';
import type { PlanningItem } from '../../../src/work-planning-types';
import { hostedHref } from './hosted-links';
export { hostedHref } from './hosted-links';
import { Activity } from './Activity';
import { activityItems } from './activity-model';
import { hostedFeed } from './coordination';
import { useMemo, useState } from 'react';
import { useUser } from '@clerk/react';
import { useConvex } from 'convex/react';
import { BriefSourceContext, hostedBriefs } from './brief';
import type { Id } from '../../../convex/_generated/dataModel';
import type {
  HostedLaneSummary,
  HostedViewSummary,
  HostedRunSummary,
} from '../../../src/work-hosted-summary';
import type { ActivityEvent, Session } from '../coordination-view';
import { useWorkRecords, type WorkIndexWorkspace, type IntentHeader } from '../hosted-work-index';
import { PageHead } from '../shell/Shell';
import { useNow } from '../shell/StatusBar';
import { Button } from '../ui/primitives';
import { useVisibleDecisions } from '../shell/visible-decisions';
import { useAttention } from '../shell/attention-context';
import { hostedAttention } from '../shell/Attention';
import { AwayStrip, AWAY_AFTER_MS, useLastVisit } from './AwayStrip';
import { FirstRun } from './FirstRun';
import { HostedAnswers } from './HostedAnswers';
import { InboxContext } from './DelegateSheet';
import { Ledger } from './Ledger';
import { laneFacts } from '../ui/lane-facts';
import {
  acceptedSince,
  answeredToday,
  awayFacts,
  startOfDay,
  publishedMoves,
  workingFacts,
  type ActivityCounts,
  type MoveRecord,
} from './now-model';
import { NowLayout, NowSituation } from './NowLayout';
import { useAnswers, useCoordination } from './coordination';
import { LaneList } from './LaneList';
import { type CockpitWork } from './model';
import { NeedsYou } from './NeedsYou';
import { Overlaps } from './Overlaps';
import { PanelBoundary, Sessions } from './Sessions';

const hostedLaneHref = (laneId: string) => hostedHref({ projectTab: 'lanes', lane: laneId });
/** Accepted shows today open and the six days before it as collapsed bands. */
const ACCEPTED_DAYS = 7;

type Records = CockpitWork & {
  planningItems?: readonly PlanningItem[];
  channelMoves?: readonly MoveRecord[];
};
type Live = {
  sessions: Session[];
  events: ActivityEvent[];
  eventsPaging?: { more: boolean; loading: boolean; loadMore: () => void };
  unacked: ActivityEvent[];
  unackedComplete: boolean;
  claims: { actor: string; sessionId?: string; paths: string[]; laneId?: string }[];
  sessionsLoading: boolean;
  sessionsComplete?: boolean;
  eventsComplete?: boolean;
  eventsLoading?: boolean;
  loadMoreEvents?: () => void;
  counts?: ActivityCounts;
};
type Answers = ReturnType<typeof useAnswers>;

/** Pure hosted Now: recorded Work plus live coordination, in reading order decisions · work · people. */
export function HostedNowView({
  now,
  records,
  live,
  loading,
  ack,
  newIntent,
  laneHref = hostedLaneHref,
  example,
  viewer,
  project = 'hosted',
  activity = false,
  showFirstRun = true,
}: {
  /** Renders a labelled example instead of the project's Now (no project actions). */
  example?: string;
  activity?: boolean;
  showFirstRun?: boolean;
  now: number;
  records: Records;
  live: Live;
  loading: boolean;
  ack: Pick<Answers, 'acknowledge' | 'reply' | 'busy' | 'error' | 'retrying'> &
    Partial<Pick<Answers, 'tell' | 'publish'>>;
  newIntent: () => void;
  laneHref?: (laneId: string) => string;
  /** The signed-in account id, to say "you" and count the viewer's answers. */
  viewer?: string;
  project?: string;
}) {
  const shared = useAttention();
  const freshness = useGenerationFreshness();
  const attention = useMemo(
    () => shared ?? hostedAttention(records, live, now),
    [shared, records, live, now],
  );
  const { lanes, overlaps, decisions } = attention;
  const open = lanes.filter(lane => lane.open);
  const { shown } = useVisibleDecisions(decisions);
  const accepted = (since: number) =>
    acceptedSince(
      {
        moves: records.channelMoves ?? [],
        views: records.views,
        runs: records.runs,
        lanes: records.lanes,
        intents: records.intents,
        ...(viewer ? { viewer } : {}),
      },
      since,
    ).filter(
      row => !loading || row.intentTitle || records.lanes.some(lane => lane.id === row.laneId && lane.name),
    );
  const week = accepted(startOfDay(now - (ACCEPTED_DAYS - 1) * 86_400_000));
  const todayStart = startOfDay(now);
  const today = week.filter(row => Date.parse(row.at) >= todayStart);
  const facts = useMemo(
    () => laneFacts(records, lanes, now, freshness.value !== null),
    [records, lanes, now, freshness.value],
  );
  const reviewHref = (id: string) => hostedHref({ projectTab: 'intent', reviewView: id });
  const lastVisit = useLastVisit(example ? 'example' : project, now);
  const [dismissed, setDismissed] = useState(false);
  const awayFor = lastVisit && !example && !dismissed ? now - lastVisit : 0;
  const away = awayFor >= AWAY_AFTER_MS ? awayFacts(lastVisit!, accepted(lastVisit!), lanes) : [];
  const laneName = (id: string) => lanes.find(lane => lane.id === id)?.name;
  const working = workingFacts(
    live.sessions,
    undefined,
    now,
    lanes.filter(lane => !lane.open).map(lane => lane.id),
  );
  const empty = !loading && records.intents.length === 0;
  if (activity)
    return (
      <Activity
        complete={live.eventsComplete ?? true}
        loading={live.eventsLoading ?? false}
        loadMore={live.loadMoreEvents}
        items={activityItems(
          {
            ...records,
            ...(attention.pending ? { pendingStatus: attention.pending } : {}),
            repairNotices: attention.notices,
          },
          accepted(0),
          decisions,
          hostedFeed(live.events, live.sessions, records.lanes, live.events.length),
        )}
        decisions={shown.length}
        now={now}
        nowHref={hostedHref({ projectTab: 'overview' })}
        laneHref={laneHref}
        viewHref={id => hostedHref({ projectTab: 'intent', reviewView: id })}
      />
    );
  return (
    <WorkReferenceContext.Provider
      value={workReferences(records, {
        Lane: laneHref,
        Intent: id => hostedHref({ projectTab: 'intent', intent: id }),
        Candidate: id => hostedHref({ projectTab: 'intent', viewId: id }),
      })}
    >
      <div className="fx-page">
        <NowLayout
          title={example ? `Now · example for ${example}` : 'Now'}
          situation={
            <NowSituation
              firstRun={empty}
              facts={{
                decisions: shown.length,
                open: open.filter(
                  lane => !lane.accepted && (facts.get(lane.id)?.tone ?? lane.tone) !== 'stale',
                ).length,
                acceptedToday: today.length,
                overlaps: overlaps.length,
                working,
              }}
            />
          }
          actions={
            !example && (
              <Button variant="primary" size="lg" icon="plus" aria-label="New Intent" onClick={newIntent}>
                New Intent
              </Button>
            )
          }
          away={
            away.length > 0 && (
              <AwayStrip
                hours={Math.round(awayFor / 3_600_000)}
                facts={away}
                onDismiss={() => setDismissed(true)}
              />
            )
          }
          {...(empty && !example && showFirstRun ? { first: <FirstRun newIntent={newIntent} /> } : {})}
          needs={
            <>
              <NeedsYou
                items={decisions}
                now={now}
                complete={live.unackedComplete}
                {...(answeredToday(live.events, viewer, startOfDay(now))
                  ? { answered: answeredToday(live.events, viewer, startOfDay(now))! }
                  : {})}
                {...(working.total ? { quiet: `${working.total} working.` } : {})}
                href={item => (item.laneId ? laneHref(item.laneId) : undefined)}
                answers={(item, { notNow }) => (
                  <HostedAnswers
                    item={item}
                    ack={ack}
                    laneHref={laneHref}
                    viewHref={id =>
                      hostedHref({
                        projectTab: 'intent',
                        intentTab: 'delivery',
                        classic: '1',
                        intent: records.views.find(view => view.id === id)?.intentId ?? '',
                        reviewView: id,
                      })
                    }
                    notNow={notNow}
                  />
                )}
              />
              {ack.error && <ErrorToast>{ack.error}</ErrorToast>}
            </>
          }
          changing={
            <>
              <LaneList
                initiatives={initiativeLinks(records.planningItems ?? [])}
                lanes={lanes}
                facts={facts}
                viewHref={reviewHref}
                now={now}
                loading={loading}
                href={lane => laneHref(lane.id)}
              />
              <OwnerDecisionsPointer />
              <Overlaps
                rows={overlaps}
                laneHref={laneHref}
                {...(ack.tell ? { tell: (target, path) => ack.tell!(target, path) } : {})}
              />
            </>
          }
          people={
            <PanelBoundary title="Who's working">
              <Sessions
                {...(ack.publish ? { send: ack.publish } : {})}
                sessions={live.sessions}
                endedLaneIds={lanes.filter(lane => !lane.open).map(lane => lane.id)}
                now={now}
                loading={live.sessionsLoading}
                laneName={laneName}
                laneHref={laneHref}
                {...(viewer ? { viewer } : {})}
              />
            </PanelBoundary>
          }
          accepted={
            <Ledger
              rows={week}
              empty={loading ? 'Reading accepted work…' : undefined}
              now={now}
              laneHref={laneHref}
              viewHref={reviewHref}
              historyHref={hostedHref({ projectTab: 'coordination' })}
            />
          }
        />
      </div>
    </WorkReferenceContext.Provider>
  );
}

function LiveNow({
  projectId,
  workspace,
  newIntent,
  activity,
  initialChannelId,
}: {
  activity?: boolean;
  initialChannelId?: string;
  projectId: Id<'hostedProjects'>;
  workspace: WorkIndexWorkspace;
  newIntent: () => void;
}) {
  const now = useNow();
  const intents = useWorkRecords<IntentHeader>(projectId, workspace, 'intents');
  const lanes = useWorkRecords<HostedLaneSummary>(projectId, workspace, 'lanes');
  const views = useWorkRecords<HostedViewSummary>(projectId, workspace, 'views');
  const runs = useWorkRecords<HostedRunSummary>(projectId, workspace, 'runs');
  const planning = useWorkRecords<PlanningItem>(projectId, workspace, 'planningItems');
  const hostedMoves = useWorkRecords<MoveRecord>(projectId, workspace, 'hostedChannelMoves');
  const localMoves = useWorkRecords<MoveRecord>(projectId, workspace, 'channelMoves');
  const live = useCoordination(projectId);
  usePageCritical('Now', {
    intents: !intents.initialLoading,
    lanes: !lanes.initialLoading,
    views: !views.initialLoading,
    runs: !runs.initialLoading,
    planning: !planning.initialLoading,
    hostedMoves: !hostedMoves.initialLoading,
    localMoves: !localMoves.initialLoading,
    inbox: !live.initialLoading,
  });
  const ack = useAnswers(projectId);
  const { user } = useUser();
  const records = useMemo(
    () => ({
      planningItems: planning.records,
      intents: intents.records,
      lanes: lanes.records,
      views: views.records,
      runs: runs.records,
      // Both are accepted source published to this hosted index.
      channelMoves: publishedMoves(localMoves.records, hostedMoves.records, initialChannelId),
    }),
    [
      planning.records,
      intents.records,
      lanes.records,
      views.records,
      runs.records,
      hostedMoves.records,
      localMoves.records,
      initialChannelId,
    ],
  );
  const client = useConvex();
  const briefs = useMemo(() => hostedBriefs(client, projectId), [client, projectId]);
  return (
    <BriefSourceContext.Provider value={briefs}>
      <InboxContext.Provider value={ack.message}>
        <HostedNowView
          activity={activity}
          showFirstRun={!initialChannelId}
          now={now}
          records={records}
          live={live}
          loading={
            intents.loading ||
            lanes.loading ||
            views.loading ||
            runs.loading ||
            hostedMoves.loading ||
            localMoves.loading
          }
          ack={ack}
          newIntent={newIntent}
          project={projectId}
          {...(user?.id ? { viewer: user.id } : {})}
        />
      </InboxContext.Provider>
    </BriefSourceContext.Provider>
  );
}

/** Hosted Now. Reads the project's Work index and its live coordination queries. */
export default function HostedNow(props: {
  activity?: boolean;
  initialChannelId?: string;
  projectId: Id<'hostedProjects'>;
  workspace: WorkIndexWorkspace | null;
  newIntent: () => void;
}) {
  return (
    <div className="fx">
      {props.workspace ? (
        <LiveNow
          activity={props.activity}
          initialChannelId={props.initialChannelId}
          projectId={props.projectId}
          workspace={props.workspace}
          newIntent={props.newIntent}
        />
      ) : (
        <div className="fx-page">
          <PageHead title="Now" summary="Reading project Work…" />
        </div>
      )}
    </div>
  );
}
