import { ErrorToast } from '../ui/Toast';
import { OwnerDecisionsContext, ownerDecisionLinks } from '../decisions/context';
import { queueStatus, queueFacts } from '../cockpit/queue-model';
import { hostedFreshness } from '../../../src/hosted-freshness';
import { GenerationFreshness } from '../ui/generation-freshness';
// SPDX-License-Identifier: Apache-2.0
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { useReadsAsleep } from '../live-reads';
import { AcceptedToast, type Accepted } from '../ui/signals';
import { acceptedSince, acceptanceArrival, type MoveRecord } from '../cockpit/now-model';
import { useQuery } from 'convex/react';
import type { Id } from '../../../convex/_generated/dataModel';
import { byAttention, cockpitLanes, type CockpitWork } from '../cockpit/model';
import {
  laneDecisions,
  needsFixDecisions,
  mainCheckDecisions,
  githubPushDecisions,
  quarantineDecisions,
} from '../cockpit/attention';
import { overlapCounts } from '../cockpit/overlap-model';
import {
  CoordinationContext,
  hostedDecisions,
  hostedOverlaps,
  useCoordination,
  withChangedFiles,
  withSessions,
} from '../cockpit/coordination';
import {
  WorkRecordsContext,
  useWorkRecords,
  useProjectedDecisions,
  workIndex,
  type WorkIndexWorkspace,
} from '../hosted-work-index';
import { WorkCountsContext } from './WorkHeader';
import { useNow } from './StatusBar';
import { AttentionContext as Context } from './attention-context';

export function hostedAttention(
  records: CockpitWork,
  live: {
    githubAutoPush?: import('../../../src/github-sync-types').GithubAutoPush;
    sessions: Parameters<typeof hostedDecisions>[1];
    events: Parameters<typeof withChangedFiles>[1];
    unacked: Parameters<typeof hostedDecisions>[0];
    claims: Parameters<typeof hostedOverlaps>[0];
  },
  now: number,
) {
  const pending = queueStatus(records);
  const queue = pending
    ? queueFacts(
        pending,
        records.repairNotices,
        new Map(
          records.intents.flatMap(intent => intent.handoffs ?? []).map(handoff => [handoff.laneId, handoff]),
        ),
      )
    : undefined;
  const lanes = byAttention(
    withChangedFiles(withSessions(cockpitLanes(records, queue), live.sessions, now), live.events),
  );
  const overlaps = hostedOverlaps(live.claims, live.sessions, lanes, live.events);
  const decisions = [
    ...githubPushDecisions(live.githubAutoPush),
    ...mainCheckDecisions(records.runs),
    ...quarantineDecisions(records.runs),
    ...hostedDecisions(live.unacked, live.sessions, lanes, records),
    ...laneDecisions(lanes, overlapCounts(overlaps)),
    ...needsFixDecisions(records.needsFix ?? [], records.intents),
  ];
  return { lanes, overlaps, decisions, pending, queue, notices: records.repairNotices ?? [] };
}
export function HostedAttention({
  projectId,
  children,
}: {
  projectId: Id<'hostedProjects'>;
  children: ReactNode;
}) {
  const raw = useQuery(workIndex.workspace, { projectId });
  const workspace = useMemo(() => (raw ? (JSON.parse(raw) as WorkIndexWorkspace) : null), [raw]);
  const ownerDecisions = useProjectedDecisions(projectId, workspace);
  const intents = useWorkRecords<CockpitWork['intents'][number]>(projectId, workspace, 'intents');
  const lanes = useWorkRecords<CockpitWork['lanes'][number]>(projectId, workspace, 'lanes');
  const views = useWorkRecords<CockpitWork['views'][number]>(projectId, workspace, 'views');
  const runs = useWorkRecords<CockpitWork['runs'][number]>(projectId, workspace, 'runs');
  const githubPush = useWorkRecords<import('../../../src/github-sync-types').GithubAutoPush>(
    projectId,
    workspace,
    'githubAutoPush',
  );
  // The Channel strip and Work pages read these on nearly every project page: one subscription each.
  const channelMoves = useWorkRecords<unknown>(projectId, workspace, 'channelMoves');
  const hasLandingEntries = workspace?.counts?.landingEntries !== undefined;
  const hasLandingBatches = workspace?.counts?.landingBatches !== undefined;
  const landingEntries = useWorkRecords<NonNullable<CockpitWork['landingEntries']>[number]>(
    projectId,
    workspace,
    'landingEntries',
    undefined,
    hasLandingEntries,
  );
  const landingBatches = useWorkRecords<NonNullable<CockpitWork['landingBatches']>[number]>(
    projectId,
    workspace,
    'landingBatches',
    undefined,
    hasLandingBatches,
  );
  const hostedChannels = useWorkRecords<unknown>(projectId, workspace, 'hostedChannels');
  const channels = useWorkRecords<unknown>(projectId, workspace, 'channels');
  const live = useCoordination(projectId);
  const now = useNow();
  const value = useMemo(
    () =>
      hostedAttention(
        {
          revision: workspace?.revision,
          needsFix: workspace?.needsFix,
          intents: intents.records,
          lanes: lanes.records,
          views: views.records,
          runs: runs.records,
          channelMoves: channelMoves.records as NonNullable<CockpitWork['channelMoves']>,
          ...(hasLandingEntries && landingEntries.complete && (!hasLandingBatches || landingBatches.complete)
            ? { landingEntries: landingEntries.records, landingBatches: landingBatches.records }
            : {}),
          ...(workspace?.landingWorker ? { landingWorker: workspace.landingWorker } : {}),
          ...(workspace?.repairNotices ? { repairNotices: workspace.repairNotices } : {}),
        },
        { ...live, githubAutoPush: githubPush.records[0] },
        now,
      ),
    [
      workspace,
      hasLandingEntries,
      hasLandingBatches,
      channelMoves.records,
      landingEntries.records,
      landingEntries.complete,
      landingBatches.records,
      landingBatches.complete,
      intents.records,
      lanes.records,
      views.records,
      runs.records,
      githubPush.records,
      live.sessions,
      live.events,
      live.claims,
      live.unacked,
      now,
    ],
  );
  const arrivals = useMemo(
    () =>
      acceptedSince(
        {
          moves: channelMoves.records as MoveRecord[],
          views: views.records,
          runs: runs.records,
          lanes: lanes.records,
          intents: intents.records,
        },
        0,
      ),
    [channelMoves.records, views.records, runs.records, lanes.records, intents.records],
  );
  const settled = channelMoves.complete && views.complete && lanes.complete;
  const asleep = useReadsAsleep();
  const observedAcceptances = useRef<Set<string> | null>(null);
  const liveSince = useRef(Date.now());
  const wasQuiet = useRef(false);
  const [arrival, setArrival] = useState<Accepted | null>(null);
  const clearArrival = useCallback(() => setArrival(null), []);
  useEffect(() => {
    const quiet = asleep || document.visibilityState !== 'visible';
    if (quiet || wasQuiet.current) liveSince.current = Date.now();
    wasQuiet.current = quiet;
    if (!settled) return;
    const observed = acceptanceArrival(observedAcceptances.current, arrivals, liveSince.current, quiet);
    observedAcceptances.current = observed.seen;
    if (observed.arrival)
      setArrival({
        title: observed.arrival.title,
        channel: 'main',
        ...(observed.arrival.diff ? { add: observed.arrival.diff.add, del: observed.arrival.diff.del } : {}),
      });
  }, [arrivals, settled, asleep]);
  const counts = workspace?.counts;
  return (
    <GenerationFreshness.Provider value={workspace?.freshness ?? null}>
      {ownerDecisions.error && <ErrorToast>{ownerDecisions.error}</ErrorToast>}
      <AcceptedToast accepted={arrival} onClose={clearArrival} />
      <div className={hostedFreshness(workspace?.freshness).behind ? 'fx-hosted-behind' : undefined}>
        <WorkCountsContext.Provider
          value={{
            ...(counts?.intents !== undefined ? { intents: counts.intents } : {}),
            ...(counts?.lanes !== undefined ? { lanes: counts.lanes } : {}),
            ...(counts?.views !== undefined ? { views: counts.views } : {}),
            ...(counts?.decisions !== undefined ? { decisions: counts.decisions } : {}),
            ...(workspace?.capabilities.planning &&
            workspace.capabilities.owner &&
            counts?.planningItems !== undefined
              ? { planning: counts.planningItems }
              : {}),
          }}
        >
          <WorkRecordsContext.Provider
            value={{
              projectId,
              generationId: workspace?.generationId ?? '',
              collections: {
                intents,
                lanes,
                views,
                runs,
                channelMoves,
                landingEntries,
                landingBatches,
                hostedChannels,
                channels,
              },
            }}
          >
            <CoordinationContext.Provider value={live}>
              <OwnerDecisionsContext.Provider
                value={{
                  records: ownerDecisions.records,
                  loading: ownerDecisions.loading,
                  unavailable: !!ownerDecisions.error,
                  intents: intents.records,
                  now,
                  links: ownerDecisionLinks,
                }}
              >
                <Context.Provider value={value}>{children}</Context.Provider>
              </OwnerDecisionsContext.Provider>
            </CoordinationContext.Provider>
          </WorkRecordsContext.Provider>
        </WorkCountsContext.Provider>
      </div>
    </GenerationFreshness.Provider>
  );
}
