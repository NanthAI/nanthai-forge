import { hostedFreshness } from '../../../src/hosted-freshness';
import { GenerationFreshness } from '../ui/generation-freshness';
// SPDX-License-Identifier: Apache-2.0
import { useMemo, type ReactNode } from 'react';
import { useQuery } from 'convex/react';
import type { Id } from '../../../convex/_generated/dataModel';
import { byAttention, cockpitLanes, type CockpitWork } from '../cockpit/model';
import {
  laneDecisions,
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
import { WorkRecordsContext, useWorkRecords, workIndex, type WorkIndexWorkspace } from '../hosted-work-index';
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
  const lanes = byAttention(
    withChangedFiles(withSessions(cockpitLanes(records), live.sessions, now), live.events),
  );
  const overlaps = hostedOverlaps(live.claims, live.sessions, lanes, live.events);
  const decisions = [
    ...githubPushDecisions(live.githubAutoPush),
    ...mainCheckDecisions(records.runs),
    ...quarantineDecisions(records.runs),
    ...hostedDecisions(live.unacked, live.sessions, lanes, records),
    ...laneDecisions(lanes, overlapCounts(overlaps)),
  ];
  return { lanes, overlaps, decisions };
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
  const hostedChannels = useWorkRecords<unknown>(projectId, workspace, 'hostedChannels');
  const channels = useWorkRecords<unknown>(projectId, workspace, 'channels');
  const live = useCoordination(projectId);
  const now = useNow();
  const value = useMemo(
    () =>
      hostedAttention(
        { intents: intents.records, lanes: lanes.records, views: views.records, runs: runs.records },
        { ...live, githubAutoPush: githubPush.records[0] },
        now,
      ),
    [
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
  const counts = workspace?.counts;
  return (
    <GenerationFreshness.Provider value={workspace?.freshness ?? null}>
      <div className={hostedFreshness(workspace?.freshness).behind ? 'fx-hosted-behind' : undefined}>
        <WorkCountsContext.Provider
          value={{
            ...(counts?.intents !== undefined ? { intents: counts.intents } : {}),
            ...(counts?.lanes !== undefined ? { lanes: counts.lanes } : {}),
            ...(counts?.views !== undefined ? { views: counts.views } : {}),
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
              collections: { intents, lanes, views, runs, channelMoves, hostedChannels, channels },
            }}
          >
            <CoordinationContext.Provider value={live}>
              <Context.Provider value={value}>{children}</Context.Provider>
            </CoordinationContext.Provider>
          </WorkRecordsContext.Provider>
        </WorkCountsContext.Provider>
      </div>
    </GenerationFreshness.Provider>
  );
}
