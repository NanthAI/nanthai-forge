// SPDX-License-Identifier: Apache-2.0
import { useAttention } from './attention-context';
import { useGenerationFreshness } from '../ui/generation-freshness';
import { HostedFreshnessLine } from './HostedFreshnessLine';
import { useMemo } from 'react';
import { useUser } from '@clerk/react';
import { useConvexConnectionState, useQuery } from 'convex/react';
import type { Id } from '../../../convex/_generated/dataModel';
import type { HostedRunSummary } from '../../../src/work-hosted-summary';
import { useWorkRecords, workIndex, type WorkIndexWorkspace } from '../hosted-work-index';
import type { MoveRecord } from '../cockpit/now-model';
import { ChannelStrip, LiveStatus } from './StatusBar';
import { latestAcceptedMain, selectedMain } from './main-model';
import { latestRun } from '../cockpit/model';

/**
 * The hosted project's Channel strip: where main is, who moved it and its check. Reads the Work index
 * the project pages already prepared; until then it shows only the connection state.
 */
export function HostedStrip({ projectId }: { projectId: Id<'hostedProjects'> }) {
  const freshness = useGenerationFreshness();
  const attention = useAttention();
  const viewer = useUser().user?.id;
  const value = useQuery(workIndex.workspace, { projectId });
  const workspace = useMemo(() => (value ? (JSON.parse(value) as WorkIndexWorkspace) : null), [value]);
  const moves = useWorkRecords<MoveRecord & { head: string }>(projectId, workspace, 'hostedChannels');
  const localMoves = useWorkRecords<MoveRecord & { head: string }>(projectId, workspace, 'channelMoves');
  const channels = useWorkRecords<{ name: string; head: string }>(projectId, workspace, 'channels');
  const runs = useWorkRecords<HostedRunSummary>(projectId, workspace, 'runs');
  const connection = useConvexConnectionState();
  const selected = selectedMain(channels.records, moves.records, workspace?.sourceKind);
  const main =
    selected &&
    latestAcceptedMain(
      workspace?.sourceKind === 'native'
        ? [...moves.records, ...localMoves.records]
        : [...localMoves.records, ...moves.records],
      selected,
    );
  const run = main && latestRun(runs.records, main.viewId);
  const by =
    main?.actor && main.actor === viewer
      ? 'you'
      : (main?.actorDisplayName ?? main?.acceptedBy?.name ?? undefined);
  const live = freshness.behind ? null : (
    <LiveStatus
      {...(connection.isWebSocketConnected || !connection.hasEverConnected ? {} : { error: 'offline' })}
    />
  );
  return (
    <ChannelStrip
      queue={workspace?.landingWorker ? attention?.pending : undefined}
      {...(selected ? { head: selected.head } : {})}
      {...(main ? { at: main.at } : {})}
      {...(run ? { check: run.status } : {})}
      {...(by ? { by: { name: by } } : {})}
      {...(main?.automatic ? { automatic: true } : {})}
      pending={!workspace || moves.initialLoading || localMoves.initialLoading || channels.initialLoading}
      stale={freshness.behind ? freshness.asOf : undefined}
      freshness={<HostedFreshnessLine />}
      live={live}
    />
  );
}
