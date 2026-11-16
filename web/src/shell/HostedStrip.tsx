// SPDX-License-Identifier: Apache-2.0
import { useViewerHandle } from './viewer';
import { useAttention } from './attention-context';
import { useConvexConnectionState } from 'convex/react';
import type { Id } from '../../../convex/_generated/dataModel';
import { ChannelStrip, LiveStatus } from './StatusBar';
import { useLiveLine } from './use-live-line';

/**
 * The hosted project's Channel strip: where main is, who moved it and its check. Shares the bounded Lane line
 * feed; it never subscribes to Work history or check progress.
 */
export function HostedStrip({ projectId }: { projectId: Id<'hostedProjects'> }) {
  const attention = useAttention();
  const viewer = useViewerHandle();
  const line = useLiveLine(projectId);
  const connection = useConvexConnectionState();
  const main = line?.main;
  const by = main?.actor && main.actor === viewer ? 'you' : main?.actor;
  const live = (
    <LiveStatus
      {...(connection.isWebSocketConnected || !connection.hasEverConnected ? {} : { error: 'offline' })}
    />
  );
  return (
    <ChannelStrip
      queue={attention?.pending}
      {...(main ? { head: main.head } : {})}
      {...(main ? { at: main.at } : {})}
      {...(main?.check ? { check: main.check } : {})}
      {...(by ? { by: { name: by } } : {})}
      {...(main?.automatic ? { automatic: true } : {})}
      pending={!line}
      live={live}
    />
  );
}
