// SPDX-License-Identifier: Apache-2.0
import { useRef, useState } from 'react';
import { useMutation, usePaginatedQuery } from 'convex/react';
import { api } from '../../../convex/_generated/api';
import type { Id } from '../../../convex/_generated/dataModel';
import type { CoordinationCommand } from '../../../src/coordination-types';
import type { ActivityEvent, Session } from '../coordination-view';
import { PendingWrite } from '../pending-write';
import { Conversation } from './Conversation';
import { Button } from '../ui/primitives';
/** A scoped thread remains reachable regardless of traffic on other Lanes. */
export function HostedConversation({
  projectId,
  laneId,
  intentId,
  viewId,
}: {
  projectId: Id<'hostedProjects'>;
  laneId?: string;
  intentId?: string;
  viewId?: string;
}) {
  const feed = usePaginatedQuery(
    api.projectCoordination.feed,
    { projectId, ...(laneId ? { laneId } : intentId ? { intentId } : {}) },
    { initialNumItems: 40 },
  );
  const people = usePaginatedQuery(api.projectCoordination.sessions, { projectId }, { initialNumItems: 30 });
  const publish = useMutation(api.projectCoordination.publish);
  const writer = useRef<PendingWrite<CoordinationCommand, unknown> | null>(null);
  writer.current ??= new PendingWrite(attempt => publish({ projectId, ...attempt }));
  const [error, setError] = useState('');
  return (
    <>
      <Conversation
        error={error}
        loading={feed.status === 'LoadingFirstPage'}
        draftKey={`${laneId}:${viewId ?? 'lane'}`}
        events={feed.results as ActivityEvent[]}
        sessions={people.results as Session[]}
        now={Date.now()}
        send={async text => {
          setError('');
          try {
            await writer.current!.send({
              kind: 'message',
              text: viewId ? `View ${viewId}: ${text}` : text,
              context: { ...(laneId ? { laneId } : {}), ...(intentId ? { intentId } : {}) },
            });
            return true;
          } catch (e) {
            setError((e as Error).message);
            return false;
          }
        }}
        more={
          feed.status === 'CanLoadMore' ? (
            <Button size="sm" variant="ghost" onClick={() => feed.loadMore(40)}>
              More messages
            </Button>
          ) : undefined
        }
      />
    </>
  );
}
