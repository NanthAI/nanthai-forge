// SPDX-License-Identifier: Apache-2.0
import { useMutation } from 'convex/react';
import { useRef, useState } from 'react';
import { api } from '../../../convex/_generated/api';
import type { Id } from '../../../convex/_generated/dataModel';
import { PendingWrite } from '../pending-write';
import { hostedError } from '../snapshot';

/** One mutation for every selected notice. Unknown results retain both batch and answer UUIDs. */
export function useOverlapAnswers(projectId: Id<'hostedProjects'>, viewerName = 'you') {
  const append = useMutation(api.projectHostedOverlapAcks.append);
  type Batch = {
    answers: {
      operationId: string;
      laneId: string;
      noticeId: string;
      choice: 'accept-order';
      text: string;
    }[];
  };
  const writes = useRef(new Map<string, PendingWrite<Batch, string>>());
  const [error, setError] = useState('');
  const acknowledgeOverlaps = async (laneId: string, noticeIds: string[]) => {
    const key = JSON.stringify([projectId, laneId, [...new Set(noticeIds)].sort()]);
    let write = writes.current.get(key);
    if (!write) {
      write = new PendingWrite(({ operationId, command }) =>
        append({ projectId, request: JSON.stringify({ operationId, ...command }) }),
      );
      writes.current.set(key, write);
    }
    const command = write.pending?.command ?? {
      answers: [...new Set(noticeIds)].map(noticeId => ({
        operationId: crypto.randomUUID(),
        laneId,
        noticeId,
        choice: 'accept-order' as const,
        text: `Acknowledged from Now by ${viewerName}`,
      })),
    };
    setError('');
    try {
      await write.send(command);
      return true;
    } catch (error) {
      setError(hostedError(error));
      return false;
    }
  };
  return { acknowledgeOverlaps, error };
}
